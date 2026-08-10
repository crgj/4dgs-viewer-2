import * as pc from 'playcanvas';

export type StereoDisplayMode = 'sbs' | 'column-interlaced' | 'anaglyph';

type FullscreenDocument = Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
    webkitFullscreenElement?: Element | null;
};

type FullscreenElement = HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
};

const DEFAULT_EYE_SEPARATION = 0.064;
const MIN_EYE_SEPARATION = 0;
const MAX_EYE_SEPARATION = 0.5;
const STORAGE_KEY = '4dgs-viewer.stereo.eyeSeparation';

export class StereoViewController {
    private leftEye: pc.Entity | null = null;
    private rightEye: pc.Entity | null = null;
    private compositeCamera: pc.Entity | null = null;
    private compositeEntity: pc.Entity | null = null;
    private compositeLayer: pc.Layer | null = null;
    private compositeMaterial: pc.Material | null = null;
    private leftTexture: pc.Texture | null = null;
    private rightTexture: pc.Texture | null = null;
    private leftTarget: pc.RenderTarget | null = null;
    private rightTarget: pc.RenderTarget | null = null;
    private targetWidth = 0;
    private targetHeight = 0;
    private active = false;
    private mode: StereoDisplayMode = 'sbs';
    private primaryCameraWasEnabled = true;
    private primaryPostEffectsWereEnabled = true;
    private recoveryGeneration = 0;
    private fullscreenOwned = false;
    private eyeSeparation = DEFAULT_EYE_SEPARATION;
    private brightness = 0;
    private contrast = 1;
    private exposure = 1;
    private readonly eyeOffset = new pc.Vec3();
    private readonly leftPosition = new pc.Vec3();
    private readonly rightPosition = new pc.Vec3();
    private readonly sbsButton = document.getElementById('enter-stereo-view') as HTMLButtonElement | null;
    private readonly columnInterlacedButton = document.getElementById('enter-column-interlaced-view') as HTMLButtonElement | null;
    private readonly anaglyphButton = document.getElementById('enter-anaglyph-view') as HTMLButtonElement | null;
    private readonly controls = document.getElementById('stereo-controls');
    private readonly modeValue = document.getElementById('stereo-mode-value');
    private readonly separationInput = document.getElementById('stereo-eye-separation') as HTMLInputElement | null;
    private readonly separationValue = document.getElementById('stereo-eye-separation-value');
    private readonly playbackButton = document.getElementById('stereo-play-pause') as HTMLButtonElement | null;
    private readonly fullscreenButton = document.getElementById('stereo-fullscreen') as HTMLButtonElement | null;
    private readonly exitButton = document.getElementById('stereo-exit') as HTMLButtonElement | null;

    constructor(
        private readonly app: pc.Application,
        private readonly primaryCamera: pc.Entity,
        private readonly onEnter?: () => void,
        private readonly onTogglePlayback?: () => void,
        private readonly isPlaybackRunning?: () => boolean,
        private readonly onActiveChanged?: (active: boolean, mode: StereoDisplayMode) => void
    ) {
        this.eyeSeparation = this.readStoredEyeSeparation();
        this.bindUI();
        this.app.on('prerender', this.syncStereoView, this);
        document.addEventListener('fullscreenchange', this.syncFullscreenButton);
        document.addEventListener('webkitfullscreenchange', this.syncFullscreenButton as EventListener);
        window.addEventListener('keydown', this.handleKeyDown, true);
    }

    private bindUI() {
        if (this.separationInput) {
            this.separationInput.min = String(MIN_EYE_SEPARATION);
            this.separationInput.max = String(MAX_EYE_SEPARATION);
            this.separationInput.value = String(this.eyeSeparation);
            this.separationInput.addEventListener('input', () => {
                this.setEyeSeparation(Number(this.separationInput?.value));
            });
        }

        this.updateSeparationOutput();
        this.sbsButton?.addEventListener('click', () => this.enter('sbs'));
        this.columnInterlacedButton?.addEventListener('click', () => this.enter('column-interlaced'));
        this.anaglyphButton?.addEventListener('click', () => this.enter('anaglyph'));
        this.playbackButton?.addEventListener('click', () => {
            this.onTogglePlayback?.();
            window.requestAnimationFrame(() => this.syncPlaybackButton());
        });
        this.exitButton?.addEventListener('click', () => this.exit());
        this.fullscreenButton?.addEventListener('click', () => void this.toggleFullscreen());
    }

    private createEyeCamera(name: string, priorityOffset: number) {
        const source = this.primaryCamera.camera;
        if (!source) throw new Error('Stereo view requires a primary camera component.');

        const entity = new pc.Entity(name);
        entity.addComponent('camera', {
            aspectRatio: this.getFullFrameAspectRatio(),
            aspectRatioMode: pc.ASPECT_MANUAL,
            clearColor: source.clearColor.clone(),
            clearColorBuffer: source.clearColorBuffer,
            clearDepthBuffer: source.clearDepthBuffer,
            clearStencilBuffer: source.clearStencilBuffer,
            farClip: source.farClip,
            fov: source.fov,
            frustumCulling: source.frustumCulling,
            horizontalFov: source.horizontalFov,
            layers: [...source.layers],
            nearClip: source.nearClip,
            orthoHeight: source.orthoHeight,
            priority: source.priority + priorityOffset,
            projection: source.projection,
            rect: new pc.Vec4(0, 0, 1, 1),
            scissorRect: new pc.Vec4(0, 0, 1, 1)
        });
        this.app.root.addChild(entity);
        return entity;
    }

    private ensureCompositeLayer() {
        if (this.compositeLayer) return;
        // #WDD-gpt  2026-08-04 - 独立合成层在双眼完整画幅之后输出 Half-SBS 或红青立体图
        this.compositeLayer = new pc.Layer({
            name: 'StereoComposite',
            opaqueSortMode: pc.SORTMODE_NONE,
            transparentSortMode: pc.SORTMODE_NONE
        });
        this.app.scene.layers.push(this.compositeLayer);
    }

    private ensureEyeCameras() {
        if (!this.leftEye) this.leftEye = this.createEyeCamera('StereoLeftEye', 0);
        if (!this.rightEye) this.rightEye = this.createEyeCamera('StereoRightEye', 1);
    }

    private ensureCompositePass() {
        if (!this.compositeLayer) return;

        if (!this.compositeMaterial) {
            const shader = new pc.Shader(this.app.graphicsDevice, {
                name: 'StereoCompositeShader',
                attributes: {
                    vertex_position: pc.SEMANTIC_POSITION,
                    vertex_texCoord0: pc.SEMANTIC_TEXCOORD0
                },
                vshader: `
                    attribute vec3 vertex_position;
                    attribute vec2 vertex_texCoord0;
                    varying vec2 vUv;

                    void main(void) {
                        gl_Position = vec4(vertex_position, 1.0);
                        vUv = vertex_texCoord0;
                    }
                `,
                fshader: `
                    precision highp float;
                    uniform sampler2D uLeftEyeTexture;
                    uniform sampler2D uRightEyeTexture;
                    uniform float uStereoCompositeMode;
                    uniform float uBrightness;
                    uniform float uContrast;
                    uniform float uExposure;
                    varying vec2 vUv;

                    void main(void) {
                        vec3 resultColor;
                        if (uStereoCompositeMode < 0.5) {
                            float useRight = step(0.5, vUv.x);
                            vec2 eyeUv = vec2(fract(vUv.x * 2.0), vUv.y);
                            vec3 leftColor = texture2D(uLeftEyeTexture, eyeUv).rgb;
                            vec3 rightColor = texture2D(uRightEyeTexture, eyeUv).rgb;
                            resultColor = mix(leftColor, rightColor, useRight);
                        } else if (uStereoCompositeMode < 1.5) {
                            vec3 leftColor = texture2D(uLeftEyeTexture, vUv).rgb;
                            vec3 rightColor = texture2D(uRightEyeTexture, vUv).rgb;
                            float leftLuma = dot(leftColor, vec3(0.299, 0.587, 0.114));
                            float rightLuma = dot(rightColor, vec3(0.299, 0.587, 0.114));
                            resultColor = vec3(leftLuma, rightLuma, rightLuma);
                        } else {
                            vec3 leftColor = texture2D(uLeftEyeTexture, vUv).rgb;
                            vec3 rightColor = texture2D(uRightEyeTexture, vUv).rgb;
                            // #WDD-gpt  2026-08-10 - 参考硬件隔列格式，第 1、3、5 列输出右眼，第 2、4、6 列输出左眼
                            float columnParity = mod(floor(gl_FragCoord.x), 2.0);
                            resultColor = mix(leftColor, rightColor, 1.0 - columnParity);
                        }
                        resultColor = (resultColor - 0.5) * uContrast + 0.5;
                        resultColor = (resultColor + uBrightness) * uExposure;
                        gl_FragColor = vec4(max(resultColor, vec3(0.0)), 1.0);
                    }
                `
            });
            const material = new pc.Material();
            material.shader = shader;
            material.blendType = pc.BLEND_NONE;
            material.cull = pc.CULLFACE_NONE;
            material.depthTest = false;
            material.depthWrite = false;
            material.setParameter('uBrightness', this.brightness);
            material.setParameter('uContrast', this.contrast);
            material.setParameter('uExposure', this.exposure);
            material.update();
            this.compositeMaterial = material;
        }

        if (!this.compositeEntity) {
            const mesh = new pc.Mesh(this.app.graphicsDevice);
            mesh.setPositions([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
            mesh.setUvs(0, [0, 0, 1, 0, 1, 1, 0, 1]);
            mesh.setIndices([0, 1, 2, 0, 2, 3]);
            mesh.update(pc.PRIMITIVE_TRIANGLES);
            const meshInstance = new pc.MeshInstance(mesh, this.compositeMaterial);
            meshInstance.cull = false;

            const entity = new pc.Entity('StereoCompositeQuad');
            entity.addComponent('render', { meshInstances: [meshInstance] });
            if (entity.render) entity.render.layers = [this.compositeLayer.id];
            this.app.root.addChild(entity);
            this.compositeEntity = entity;
        }

        if (!this.compositeCamera) {
            const sourcePriority = this.primaryCamera.camera?.priority || 0;
            const entity = new pc.Entity('StereoCompositeCamera');
            entity.addComponent('camera', {
                clearColor: new pc.Color(0, 0, 0, 1),
                clearColorBuffer: true,
                clearDepthBuffer: false,
                clearStencilBuffer: false,
                layers: [this.compositeLayer.id],
                priority: sourcePriority + 100
            });
            this.app.root.addChild(entity);
            this.compositeCamera = entity;
        }
    }

    private ensureRenderTargets() {
        if (!this.leftEye?.camera || !this.rightEye?.camera || !this.compositeMaterial) return;
        const device = this.app.graphicsDevice;
        const width = Math.max(1, device.width);
        const height = Math.max(1, device.height);
        if (this.leftTarget && this.rightTarget && width === this.targetWidth && height === this.targetHeight) return;

        // #WDD-gpt  2026-08-04 - PlayCanvas 官方销毁流程允许 null，但 1.77 类型声明仍错误标记为不可空
        (this.leftEye.camera as any).renderTarget = null;
        (this.rightEye.camera as any).renderTarget = null;
        this.leftTarget?.destroy();
        this.rightTarget?.destroy();
        this.leftTexture?.destroy();
        this.rightTexture?.destroy();

        const createTexture = (name: string) => new pc.Texture(device, {
            name,
            width,
            height,
            format: pc.PIXELFORMAT_R8_G8_B8_A8,
            mipmaps: false,
            minFilter: pc.FILTER_LINEAR,
            magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE
        });

        this.leftTexture = createTexture('StereoLeftEyeColor');
        this.rightTexture = createTexture('StereoRightEyeColor');
        this.leftTarget = new pc.RenderTarget({ name: 'StereoLeftEyeTarget', colorBuffer: this.leftTexture, depth: true });
        this.rightTarget = new pc.RenderTarget({ name: 'StereoRightEyeTarget', colorBuffer: this.rightTexture, depth: true });
        this.leftEye.camera.renderTarget = this.leftTarget;
        this.rightEye.camera.renderTarget = this.rightTarget;
        this.compositeMaterial.setParameter('uLeftEyeTexture', this.leftTexture);
        this.compositeMaterial.setParameter('uRightEyeTexture', this.rightTexture);
        this.targetWidth = width;
        this.targetHeight = height;
    }

    private ensureRenderPipeline() {
        this.ensureCompositeLayer();
        this.ensureEyeCameras();
        this.ensureCompositePass();
        this.ensureRenderTargets();
    }

    private syncCameraSettings(target: pc.CameraComponent, source: pc.CameraComponent) {
        target.aspectRatioMode = pc.ASPECT_MANUAL;
        target.aspectRatio = this.getFullFrameAspectRatio();
        target.clearColor.copy(source.clearColor);
        target.clearColorBuffer = source.clearColorBuffer;
        target.clearDepthBuffer = source.clearDepthBuffer;
        target.clearStencilBuffer = source.clearStencilBuffer;
        target.farClip = source.farClip;
        target.fov = source.fov;
        target.frustumCulling = source.frustumCulling;
        target.horizontalFov = source.horizontalFov;
        target.nearClip = source.nearClip;
        target.orthoHeight = source.orthoHeight;
        target.projection = source.projection;
    }

    private syncStereoView() {
        if (!this.active || !this.leftEye?.camera || !this.rightEye?.camera || !this.primaryCamera.camera) return;
        this.ensureRenderTargets();

        const source = this.primaryCamera.camera;
        this.syncCameraSettings(this.leftEye.camera, source);
        this.syncCameraSettings(this.rightEye.camera, source);

        // #WDD-gpt  2026-08-04 - 共用视差始终以中心相机为中点，左右眼沿世界空间右轴严格反向偏移
        const centerPosition = this.primaryCamera.getPosition();
        this.primaryCamera.getWorldTransform().getX(this.eyeOffset);
        this.eyeOffset.normalize().mulScalar(this.eyeSeparation * 0.5);
        this.leftPosition.copy(centerPosition).sub(this.eyeOffset);
        this.rightPosition.copy(centerPosition).add(this.eyeOffset);

        const rotation = this.primaryCamera.getRotation();
        this.leftEye.setPosition(this.leftPosition);
        this.leftEye.setRotation(rotation);
        this.rightEye.setPosition(this.rightPosition);
        this.rightEye.setRotation(rotation);
        const compositeMode = this.mode === 'anaglyph' ? 1 : this.mode === 'column-interlaced' ? 2 : 0;
        this.compositeMaterial?.setParameter('uStereoCompositeMode', compositeMode);
        this.syncPlaybackButton();
    }

    private getFullFrameAspectRatio() {
        const device = this.app.graphicsDevice;
        return device.height > 0 ? device.width / device.height : 16 / 9;
    }

    private setEyeSeparation(value: number) {
        if (!Number.isFinite(value)) return;
        this.eyeSeparation = Math.max(MIN_EYE_SEPARATION, Math.min(MAX_EYE_SEPARATION, value));
        if (this.separationInput) this.separationInput.value = String(this.eyeSeparation);
        this.updateSeparationOutput();
        try {
            localStorage.setItem(STORAGE_KEY, String(this.eyeSeparation));
        } catch {
            // #WDD-gpt  2026-08-04 - 浏览器禁用存储时仍保留当前会话共用的视差值
        }
    }

    private readStoredEyeSeparation() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored === null || stored.trim() === '') return DEFAULT_EYE_SEPARATION;
            const value = Number(stored);
            return Number.isFinite(value)
                ? Math.max(MIN_EYE_SEPARATION, Math.min(MAX_EYE_SEPARATION, value))
                : DEFAULT_EYE_SEPARATION;
        } catch {
            return DEFAULT_EYE_SEPARATION;
        }
    }

    private updateSeparationOutput() {
        if (this.separationValue) this.separationValue.textContent = this.eyeSeparation.toFixed(3);
    }

    private syncModeUI() {
        if (this.modeValue) {
            this.modeValue.dataset.mode = this.mode;
            this.modeValue.textContent = this.mode === 'anaglyph'
                ? 'RED / CYAN'
                : this.mode === 'column-interlaced' ? 'COLUMN INTERLACED' : 'HALF-SBS';
        }
        this.sbsButton?.setAttribute('aria-pressed', this.mode === 'sbs' && this.active ? 'true' : 'false');
        this.columnInterlacedButton?.setAttribute('aria-pressed', this.mode === 'column-interlaced' && this.active ? 'true' : 'false');
        this.anaglyphButton?.setAttribute('aria-pressed', this.mode === 'anaglyph' && this.active ? 'true' : 'false');
    }

    private syncPlaybackButton() {
        const playing = Boolean(this.isPlaybackRunning?.());
        this.playbackButton?.classList.toggle('is-playing', playing);
        this.playbackButton?.setAttribute('aria-pressed', playing ? 'true' : 'false');
    }

    enter(mode: StereoDisplayMode = 'sbs') {
        if (this.active || !this.primaryCamera.camera) return;
        this.mode = mode;
        this.ensureRenderPipeline();
        this.onEnter?.();

        this.active = true;
        this.primaryCameraWasEnabled = this.primaryCamera.camera.enabled;
        this.primaryPostEffectsWereEnabled = this.primaryCamera.camera.postEffects.enabled;
        this.primaryCamera.camera.enabled = false;
        if (this.compositeLayer) this.compositeLayer.enabled = true;
        if (this.leftEye) this.leftEye.enabled = true;
        if (this.rightEye) this.rightEye.enabled = true;
        if (this.compositeEntity) this.compositeEntity.enabled = true;
        if (this.compositeCamera) this.compositeCamera.enabled = true;
        document.body.classList.add('stereo-mode');
        document.body.dataset.stereoMode = this.mode;
        this.controls?.setAttribute('aria-hidden', 'false');
        this.syncModeUI();
        this.syncStereoView();
        this.onActiveChanged?.(true, this.mode);
    }

    exit() {
        if (!this.active) return;
        this.active = false;
        // #WDD-gpt 2026-08-04 - 先从合成层移除黑色清屏相机，再恢复主相机，避免退出帧覆盖主画面
        if (this.leftEye) this.leftEye.enabled = false;
        if (this.rightEye) this.rightEye.enabled = false;
        if (this.compositeEntity) this.compositeEntity.enabled = false;
        if (this.compositeCamera) this.compositeCamera.enabled = false;
        if (this.compositeLayer) this.compositeLayer.enabled = false;
        if (this.primaryCamera.camera) this.primaryCamera.camera.enabled = this.primaryCameraWasEnabled;
        document.body.classList.remove('stereo-mode');
        delete document.body.dataset.stereoMode;
        this.controls?.setAttribute('aria-hidden', 'true');
        this.sbsButton?.setAttribute('aria-pressed', 'false');
        this.columnInterlacedButton?.setAttribute('aria-pressed', 'false');
        this.anaglyphButton?.setAttribute('aria-pressed', 'false');

        if (this.fullscreenOwned && this.getFullscreenElement()) void this.exitFullscreen();
        this.fullscreenOwned = false;
        this.onActiveChanged?.(false, this.mode);
        this.requestPrimaryCameraRecovery();
    }

    public isActive() {
        return this.active;
    }

    // #WDD-gpt 2026-08-04 - 立体双眼在最终合成后统一执行颜色调整，避免每个半透明高斯单独调整
    public setColorAdjustments(brightness: number, contrast: number, exposure: number) {
        this.brightness = brightness;
        this.contrast = contrast;
        this.exposure = exposure;
        this.compositeMaterial?.setParameter('uBrightness', brightness);
        this.compositeMaterial?.setParameter('uContrast', contrast);
        this.compositeMaterial?.setParameter('uExposure', exposure);
    }

    private getFullscreenElement() {
        const doc = document as FullscreenDocument;
        return document.fullscreenElement || doc.webkitFullscreenElement || null;
    }

    private async toggleFullscreen() {
        if (this.getFullscreenElement()) {
            await this.exitFullscreen();
            this.fullscreenOwned = false;
            return;
        }

        const root = document.documentElement as FullscreenElement;
        try {
            if (root.requestFullscreen) {
                await root.requestFullscreen();
            } else if (root.webkitRequestFullscreen) {
                await root.webkitRequestFullscreen();
            }
            this.fullscreenOwned = Boolean(this.getFullscreenElement());
        } catch (error) {
            console.warn('[StereoView] Fullscreen request failed:', error);
        }
    }

    private async exitFullscreen() {
        const doc = document as FullscreenDocument;
        if (document.exitFullscreen) {
            await document.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
            await doc.webkitExitFullscreen();
        }
    }

    private readonly syncFullscreenButton = () => {
        this.fullscreenButton?.classList.toggle('active', Boolean(this.getFullscreenElement()));
        this.fullscreenButton?.setAttribute('aria-pressed', this.getFullscreenElement() ? 'true' : 'false');
        if (!this.active) this.requestPrimaryCameraRecovery();
    };

    // #WDD-gpt 2026-08-04 - 全屏退出和 LayerComposition 更新可能跨帧完成，连续请求主相机恢复帧避免停在黑色合成帧
    private requestPrimaryCameraRecovery() {
        const generation = ++this.recoveryGeneration;
        const postEffects = this.primaryCamera.camera?.postEffects;
        // #WDD-gpt 2026-08-04 - 相机同步启停会让后处理保留黑色中间目标，先直出一帧再重新挂载后处理
        if (this.primaryPostEffectsWereEnabled && postEffects?.enabled) postEffects.disable();
        this.app.renderNextFrame = true;
        window.requestAnimationFrame(() => {
            if (this.active || generation !== this.recoveryGeneration) return;
            this.app.resizeCanvas();
            this.app.renderNextFrame = true;
            window.requestAnimationFrame(() => {
                if (this.active || generation !== this.recoveryGeneration) return;
                if (this.primaryPostEffectsWereEnabled && postEffects && !postEffects.enabled) postEffects.enable();
                this.app.renderNextFrame = true;
            });
        });
        window.setTimeout(() => {
            if (this.active || generation !== this.recoveryGeneration) return;
            if (this.primaryPostEffectsWereEnabled && postEffects && !postEffects.enabled) postEffects.enable();
            this.app.renderNextFrame = true;
        }, 120);
    }

    private readonly handleKeyDown = (event: KeyboardEvent) => {
        if (!this.active) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.exit();
        } else if (event.key.toLowerCase() === 'h') {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };
}
