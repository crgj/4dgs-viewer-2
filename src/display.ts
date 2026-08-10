import * as pc from 'playcanvas';
import './display.css';
import { splatCoreVS, splatMainPS, splatMainVS } from './shaders/gsplat-shader';
import { TrueSplatsLoader } from './utils/truesplats-loader';
import { SOG4Loader } from './utils/sog4-loader';
import { SOGv2Loader } from './utils/sog-v2-loader';
import { PLY4Loader } from './utils/ply4-loader';
import { StereoViewController, type StereoDisplayMode } from './rendering/stereo-view-controller';
import { DynamicGsplatSorter } from './rendering/dynamic-gsplat-sorter';
import { getRenderedBaseAlpha, NORMAL_RENDER_ALPHA_DISCARD } from './algorithms/hidden-point-visibility';
import { getDisplayModelPreset } from './display-model-presets';
import { DisplayModelGallery, type DisplayGalleryItem } from './display-model-gallery';

type DisplayParsed = Record<string, any> & {
    count: number;
    bands?: number;
    frames?: number;
    maxMu?: number;
    opacitySemantic?: string;
    plyData: { elements: any[] };
};

type FullscreenDocument = Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
    webkitFullscreenElement?: Element | null;
};

type FullscreenElement = HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
};

const DEFAULT_MODEL_URL = './sog/lion.sog';
const DEFAULT_FPS = 30;

// #WDD-gpt 2026-08-04 - 独立只读展示运行时仅包含格式加载、4D 播放、轨道相机和立体输出
class DisplayViewer {
    readonly app: pc.Application;
    readonly camera: pc.Entity;
    splatEntity: pc.Entity | null = null;

    private stereoView: StereoViewController;
    private readonly gallery: DisplayModelGallery;
    private currentAsset: pc.Asset | null = null;
    private currentObjectUrl: string | null = null;
    private runtimeTextures: pc.Texture[] = [];
    private dynamicSorter: DynamicGsplatSorter | null = null;
    private dynamicSorterEpoch = 0;
    private loadGeneration = 0;
    private downloadController: AbortController | null = null;

    private isPlaying = false;
    private currentTime = 0;
    private playbackTime = 0;
    private duration = 1;
    private fps = DEFAULT_FPS;
    private is4DGS = false;
    private trajectoryData: Float32Array | null = null;
    private lifeTexData: Float32Array | null = null;
    private originalIndices: Float32Array | null = null;
    private keyframes = 0;
    private xyzStride = 1;
    private rotKeyframes = 0;
    private rotStride = 1;
    private dcStride = 1;
    private lastUpdatedFrame = -1;
    private isWaitingForSort = false;
    private sortingTaskId = 0;
    private pendingSortedFrame: number | null = null;

    private orbitYaw = 0;
    private orbitPitch = 0;
    private orbitDistance = 5;
    private readonly orbitTarget = new pc.Vec3();
    private initialOrbitYaw = 0;
    private initialOrbitPitch = 0;
    private initialOrbitDistance = 5;
    private readonly initialOrbitTarget = new pc.Vec3();
    private initialCameraFov = 48;
    private initialHorizontalFov = false;
    private boundingSphereRadius = 0;
    private readonly thumbnailCapture = new URLSearchParams(window.location.search).get('thumbnail') === '1';
    private isPointerDown = false;
    private lastPointerX = 0;
    private lastPointerY = 0;
    private lastTouchDistance = 0;

    private readonly playButton = document.getElementById('display-play-pause') as HTMLButtonElement;
    private readonly slider = document.getElementById('display-time-slider') as HTMLInputElement;
    private readonly currentFrameLabel = document.getElementById('display-current-frame');
    private readonly totalFrameLabel = document.getElementById('display-total-frames');
    private readonly modelNameLabel = document.getElementById('display-model-name');
    private readonly modelMetaLabel = document.getElementById('display-model-meta');

    constructor() {
        const canvas = document.getElementById('application-canvas') as HTMLCanvasElement | null;
        if (!canvas) throw new Error('Display canvas was not found.');

        const inputOptions = {
            mouse: new pc.Mouse(canvas),
            touch: new pc.TouchDevice(canvas),
            elementInput: new pc.ElementInput(canvas)
        };
        this.app = new pc.Application(canvas, {
            ...inputOptions,
            graphicsDeviceOptions: {
                antialias: false,
                alpha: false,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance'
            }
        });
        this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
        this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
        this.app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);

        this.camera = this.createScene();
        this.stereoView = new StereoViewController(
            this.app,
            this.camera,
            undefined,
            () => this.togglePlay(),
            () => this.isPlaying,
            (active, mode) => this.onStereoActiveChanged(active, mode)
        );
        this.gallery = new DisplayModelGallery((item) => void this.selectGalleryModel(item));
        void this.gallery.initialize();
        document.body.classList.toggle('thumbnail-capture', this.thumbnailCapture);

        this.bindControls(canvas);
        this.app.on('update', (dt: number) => this.update(dt));
        this.app.start();
        this.resetCamera();

        (window as any).displayViewer = this;
        void this.loadInitialModel();
    }

    private createScene() {
        this.app.scene.ambientLight = new pc.Color(0.16, 0.17, 0.19);
        const camera = new pc.Entity('DisplayCamera');
        camera.addComponent('camera', {
            clearColor: new pc.Color(0.025, 0.03, 0.04, 1),
            clearColorBuffer: true,
            clearDepthBuffer: true,
            farClip: 2000,
            nearClip: 0.01,
            fov: 48
        });
        this.app.root.addChild(camera);
        return camera;
    }

    private bindControls(canvas: HTMLCanvasElement) {
        this.playButton.addEventListener('click', () => this.togglePlay());
        this.slider.addEventListener('input', () => this.seek(Number(this.slider.value)));
        document.getElementById('display-reset-camera')?.addEventListener('click', () => this.resetCamera());
        document.getElementById('display-mono-view')?.addEventListener('click', () => this.stereoView.exit());
        document.getElementById('display-open-file')?.addEventListener('click', () => {
            (document.getElementById('display-file-input') as HTMLInputElement | null)?.click();
        });
        document.getElementById('display-file-input')?.addEventListener('change', (event) => {
            const input = event.currentTarget as HTMLInputElement;
            const file = input.files?.[0];
            if (file) void this.loadLocalFile(file);
            input.value = '';
        });
        document.getElementById('display-fullscreen')?.addEventListener('click', () => void this.toggleFullscreen());

        // #WDD-gpt  2026-08-10 - 旋转只更新轨道角度，保留滚轮或双指缩放后的当前相机距离
        canvas.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            this.isPointerDown = true;
            this.lastPointerX = event.clientX;
            this.lastPointerY = event.clientY;
            canvas.setPointerCapture(event.pointerId);
        });
        canvas.addEventListener('pointermove', (event) => {
            if (!this.isPointerDown || event.pointerType === 'touch') return;
            this.orbitYaw -= (event.clientX - this.lastPointerX) * 0.2;
            this.orbitPitch = Math.max(-89, Math.min(89, this.orbitPitch - (event.clientY - this.lastPointerY) * 0.2));
            this.lastPointerX = event.clientX;
            this.lastPointerY = event.clientY;
            this.updateOrbitCamera();
        });
        const releasePointer = () => { this.isPointerDown = false; };
        canvas.addEventListener('pointerup', releasePointer);
        canvas.addEventListener('pointercancel', releasePointer);
        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const scale = Math.exp(event.deltaY * 0.001);
            this.orbitDistance = Math.max(0.02, Math.min(5000, this.orbitDistance * scale));
            this.updateOrbitCamera();
        }, { passive: false });

        canvas.addEventListener('touchstart', (event) => {
            if (event.touches.length === 1) {
                this.lastPointerX = event.touches[0].clientX;
                this.lastPointerY = event.touches[0].clientY;
            } else if (event.touches.length === 2) {
                this.lastTouchDistance = this.getTouchDistance(event.touches);
            }
        }, { passive: true });
        canvas.addEventListener('touchmove', (event) => {
            if (event.touches.length === 1) {
                const touch = event.touches[0];
                this.orbitYaw -= (touch.clientX - this.lastPointerX) * 0.2;
                this.orbitPitch = Math.max(-89, Math.min(89, this.orbitPitch - (touch.clientY - this.lastPointerY) * 0.2));
                this.lastPointerX = touch.clientX;
                this.lastPointerY = touch.clientY;
                this.updateOrbitCamera();
            } else if (event.touches.length === 2) {
                const distance = this.getTouchDistance(event.touches);
                if (this.lastTouchDistance > 0) {
                    this.orbitDistance = Math.max(0.02, Math.min(5000, this.orbitDistance * this.lastTouchDistance / distance));
                    this.updateOrbitCamera();
                }
                this.lastTouchDistance = distance;
            }
        }, { passive: true });

        window.addEventListener('resize', () => this.handleResize());
        window.addEventListener('keydown', (event) => {
            const interactiveTarget = event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement;
            if (event.code === 'Space' && !interactiveTarget && !document.body.classList.contains('gallery-open')) {
                event.preventDefault();
                this.togglePlay();
            }
        });

        let dragDepth = 0;
        window.addEventListener('dragenter', (event) => {
            event.preventDefault();
            dragDepth++;
            document.body.classList.add('is-dragging');
        });
        window.addEventListener('dragleave', (event) => {
            event.preventDefault();
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) document.body.classList.remove('is-dragging');
        });
        window.addEventListener('dragover', (event) => event.preventDefault());
        window.addEventListener('drop', (event) => {
            event.preventDefault();
            dragDepth = 0;
            document.body.classList.remove('is-dragging');
            const file = event.dataTransfer?.files?.[0];
            if (file) void this.loadLocalFile(file);
        });
    }

    private getTouchDistance(touches: TouchList) {
        return Math.hypot(
            touches[0].clientX - touches[1].clientX,
            touches[0].clientY - touches[1].clientY
        );
    }

    private async loadInitialModel() {
        const params = new URLSearchParams(window.location.search);
        const url = params.get('model') || DEFAULT_MODEL_URL;
        const title = params.get('name') || this.fileNameFromUrl(url);
        await this.loadModelUrl(url, title);
    }

    public async loadModelUrl(url: string, displayName?: string) {
        const generation = ++this.loadGeneration;
        this.downloadController?.abort();
        this.downloadController = new AbortController();
        this.setLoading(true, '正在下载模型', displayName || this.fileNameFromUrl(url), 0);
        this.hideError();

        try {
            const response = await fetch(url, { signal: this.downloadController.signal });
            if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
            const total = Number(response.headers.get('content-length')) || 0;
            const reader = response.body?.getReader();
            let blob: Blob;

            if (!reader) {
                blob = await response.blob();
            } else {
                const chunks: Uint8Array[] = [];
                let loaded = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    loaded += value.byteLength;
                    const progress = total > 0 ? Math.min(82, loaded / total * 82) : 28;
                    this.setLoading(true, '正在下载模型', this.formatBytes(loaded, total), progress);
                }
                blob = new Blob(chunks as BlobPart[]);
            }

            if (generation !== this.loadGeneration) return false;
            const fileName = this.fileNameFromUrl(url) || displayName || 'model.sog';
            const loaded = await this.loadFile(new File([blob], fileName), generation, displayName);
            if (loaded && generation === this.loadGeneration) this.gallery.setActiveUrl(url);
            return loaded;
        } catch (error) {
            if (generation !== this.loadGeneration || (error instanceof DOMException && error.name === 'AbortError')) return false;
            this.handleLoadError(error);
            return false;
        }
    }

    public async loadFile(file: File, generation = ++this.loadGeneration, displayName?: string) {
        if (generation !== this.loadGeneration) return false;
        this.downloadController?.abort();
        this.setLoading(true, '正在解析模型', file.name, 84);
        this.hideError();

        try {
            const parsed = await this.parseFile(file, (progress, detail) => {
                if (generation === this.loadGeneration) {
                    this.setLoading(true, '正在解析模型', detail, 84 + Math.min(14, progress * 0.14));
                }
            });
            if (generation !== this.loadGeneration) return false;
            await this.installParsedModel(parsed, file, displayName || file.name);
            if (generation !== this.loadGeneration) return false;
            this.setLoading(false, '', '', 100);
            return true;
        } catch (error) {
            if (generation !== this.loadGeneration) return false;
            this.handleLoadError(error);
            return false;
        }
    }

    private async loadLocalFile(file: File) {
        if (await this.loadFile(file)) this.gallery.setActiveUrl(null);
    }

    private async selectGalleryModel(item: DisplayGalleryItem) {
        if (!await this.loadModelUrl(item.url, item.name)) return;
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('model', item.url);
        nextUrl.searchParams.set('name', item.name);
        window.history.replaceState(null, '', nextUrl);
    }

    // #WDD-gpt 2026-08-04 - 展示页沿用主查看器的格式嗅探，官方 SOG v2 与项目 SOG4 不混用解析器
    private async parseFile(file: File, onProgress: (progress: number, detail: string) => void): Promise<DisplayParsed> {
        const name = file.name.toLowerCase();
        let parsed: any;

        if (name.endsWith('.sog')) {
            const buffer = await file.arrayBuffer();
            const version = await SOGv2Loader.detectVersion(buffer);
            parsed = version === 2
                ? await new SOGv2Loader().parse(buffer, onProgress)
                : await new SOG4Loader(this.app).load(buffer, onProgress);
        } else if (name.endsWith('.sog4')) {
            parsed = await new SOG4Loader(this.app).load(file, onProgress);
        } else if (name.endsWith('.ply') || name.endsWith('.ply4')) {
            parsed = await new PLY4Loader().load(file, onProgress);
        } else if (name.endsWith('.truesplats')) {
            parsed = await new TrueSplatsLoader(this.app).load(file, onProgress);
        } else {
            throw new Error('仅支持 .sog、.sog4、.ply、.ply4 和 .truesplats 模型。');
        }

        if (!parsed?.count || !Array.isArray(parsed?.plyData?.elements) || parsed.plyData.elements.length === 0) {
            throw new Error('模型解析结果不完整。');
        }
        return parsed as DisplayParsed;
    }

    private async installParsedModel(parsed: DisplayParsed, file: File, displayName: string) {
        this.disposeCurrentModel();
        this.currentTime = 0;
        this.playbackTime = 0;
        this.duration = this.getDuration(parsed);
        this.is4DGS = false;
        this.trajectoryData = null;
        this.lifeTexData = null;
        this.originalIndices = null;
        this.keyframes = 0;
        this.xyzStride = 1;
        this.rotKeyframes = 0;
        this.rotStride = 1;
        this.dcStride = 1;
        this.lastUpdatedFrame = -1;

        const splatData = new (pc.GSplatData as any)([parsed.plyData.elements[0]]);
        const resource = new pc.GSplatResource(this.app.graphicsDevice, splatData);
        this.currentObjectUrl = URL.createObjectURL(file);
        const asset = new pc.Asset(file.name, 'gsplat', { url: this.currentObjectUrl });
        asset.resource = resource;
        asset.loaded = true;
        this.app.assets.add(asset);
        this.currentAsset = asset;

        const entity = new pc.Entity('DisplayGSplat');
        entity.addComponent('gsplat', { asset });
        this.app.root.addChild(entity);
        this.splatEntity = entity;
        this.applyModelTransform(entity, parsed);

        this.setLoading(true, '正在准备渲染', `${parsed.count.toLocaleString()} SPLATS`, 98);
        this.finalizeRenderer(asset, parsed);
        this.fitCameraToModel(splatData, entity, file.name);
        this.updateModelUI(displayName, parsed.count);
        this.syncTimeUI();
        this.setPlaying(new URLSearchParams(window.location.search).get('autoplay') !== '0' && this.duration > 1);
        this.updateDynamicPositions(0);
    }

    private getDuration(parsed: DisplayParsed) {
        const declared = Number(parsed.frames || parsed.maxMu || 0);
        if (Number.isFinite(declared) && declared > 0) return Math.max(1, Math.ceil(declared));
        const xyzEnd = parsed.keyframes > 1 ? (parsed.keyframes - 1) * Math.max(1, parsed.xyzStride || 1) + 1 : 1;
        const rotEnd = parsed.rotKeyframes > 1 ? (parsed.rotKeyframes - 1) * Math.max(1, parsed.rotStride || 1) + 1 : 1;
        return Math.max(1, xyzEnd, rotEnd);
    }

    private applyModelTransform(entity: pc.Entity, parsed: DisplayParsed) {
        const transform = parsed.model_transform;
        if (transform) {
            if (transform.pos) entity.setLocalPosition(transform.pos[0], transform.pos[1], transform.pos[2]);
            if (transform.rot) entity.setLocalRotation(new pc.Quat(transform.rot[0], transform.rot[1], transform.rot[2], transform.rot[3]));
            if (transform.scale) entity.setLocalScale(transform.scale[0], transform.scale[1], transform.scale[2]);
            return;
        }
        if (parsed.meta?.modelPos) entity.setLocalPosition(parsed.meta.modelPos);
        if (parsed.meta?.modelRot) entity.setLocalRotation(parsed.meta.modelRot);
        if (parsed.meta?.modelScale) entity.setLocalScale(parsed.meta.modelScale);
    }

    private finalizeRenderer(asset: pc.Asset, parsed: DisplayParsed) {
        const splatData = (asset.resource as pc.GSplatResource).splatData;
        const count = parsed.count;
        const resource = asset.resource as any;
        let width = Math.ceil(Math.sqrt(count));
        if (resource?.colorTexture) width = resource.colorTexture.width;
        else if (resource?.transformATexture) width = resource.transformATexture.width;
        const height = Math.ceil(count / width);
        this.originalIndices = (splatData.getProp('original_index') as Float32Array | null) || null;

        // #WDD-gpt 2026-08-04 - 静态 SOG/PLY 直接使用引擎原生 GSplat 着色器，只为真实时序银行安装 4D 自定义纹理
        const hasTemporalData = Boolean(
            parsed.trajectory ||
            parsed.rotTrajectory ||
            parsed.dcTrajectory ||
            splatData.getProp('lifetime_mu')
        );
        if (!hasTemporalData) return;

        const lifeTexture = this.createLifetimeTexture(splatData, count, width, height);
        const trajectoryTexture = this.createTrajectoryTexture(parsed, count);
        const rotationTexture = this.createRotationTexture(parsed, count);
        const colorTexture = this.createColorTrajectoryTexture(parsed, count);
        const scalesTexture = this.createScalesTexture(splatData, width, height);
        const selectionTexture = this.createEmptySelectionTexture(width, height);

        const instance = (this.splatEntity?.gsplat as any)?.instance;
        if (!instance) throw new Error('GSplat 渲染实例创建失败。');
        this.setupShader(instance, parsed, {
            lifeTexture,
            trajectoryTexture,
            rotationTexture,
            colorTexture,
            scalesTexture,
            selectionTexture
        });

        if (instance.sorter?.worker && this.trajectoryData && this.keyframes > 0) {
            const opacity = splatData.getProp('opacity') as Float32Array | null;
            const baseAlpha = opacity ? new Float32Array(count) : null;
            if (opacity && baseAlpha) {
                for (let index = 0; index < count; index++) {
                    baseAlpha[index] = getRenderedBaseAlpha(opacity[index], parsed.opacitySemantic);
                }
            }
            const epoch = ++this.dynamicSorterEpoch;
            const sorterInstance = instance;
            this.dynamicSorter = new DynamicGsplatSorter(instance, {
                trajectory: this.trajectoryData,
                originalIndices: this.originalIndices,
                lifeData: this.lifeTexData,
                baseAlpha,
                numSplats: count,
                keyframes: this.keyframes,
                stride: this.xyzStride,
                totalFrames: this.duration,
                alphaDiscard: NORMAL_RENDER_ALPHA_DISCARD,
                onSorted: (result) => {
                    const activeInstance = (this.splatEntity?.gsplat as any)?.instance;
                    if (epoch !== this.dynamicSorterEpoch || activeInstance !== sorterInstance) return;
                    if (this.isWaitingForSort && result.requestId === this.sortingTaskId) {
                        this.isWaitingForSort = false;
                        if (this.pendingSortedFrame !== null && Math.floor(result.frame) === Math.floor(this.pendingSortedFrame)) {
                            this.applyVisibleFrame(this.pendingSortedFrame);
                            this.pendingSortedFrame = null;
                        }
                    }
                }
            });
        }
    }

    private createTexture(name: string, width: number, height: number, data: Float32Array) {
        const texture = new pc.Texture(this.app.graphicsDevice, {
            name,
            width,
            height,
            format: pc.PIXELFORMAT_RGBA32F,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE
        });
        const target = texture.lock();
        new Float32Array(target.buffer, target.byteOffset, target.byteLength / 4).set(data);
        texture.unlock();
        this.runtimeTextures.push(texture);
        return texture;
    }

    private createLifetimeTexture(splatData: pc.GSplatData, count: number, width: number, height: number) {
        const mu = splatData.getProp('lifetime_mu');
        const lifeWidth = splatData.getProp('lifetime_w');
        const sharpness = splatData.getProp('lifetime_k');
        if (!mu || !lifeWidth) return null;
        this.lifeTexData = new Float32Array(width * height * 4);
        for (let index = 0; index < count; index++) {
            this.lifeTexData[index * 4] = mu[index];
            this.lifeTexData[index * 4 + 1] = lifeWidth[index];
            this.lifeTexData[index * 4 + 2] = sharpness ? sharpness[index] : 10;
        }
        return this.createTexture('DisplayLifetime', width, height, this.lifeTexData);
    }

    private createTrajectoryTexture(parsed: DisplayParsed, count: number) {
        if (!parsed.trajectory || !parsed.keyframes) return null;
        this.is4DGS = true;
        this.trajectoryData = parsed.trajectory as Float32Array;
        this.keyframes = parsed.keyframes;
        this.xyzStride = Math.max(1, parsed.xyzStride || 1);
        const textureWidth = 4096;
        const textureHeight = Math.ceil(count * this.keyframes / textureWidth);
        const data = new Float32Array(textureWidth * textureHeight * 4);
        for (let index = 0; index < count; index++) {
            const sourceIndex = this.originalIndices ? Math.round(this.originalIndices[index]) : index;
            for (let keyframe = 0; keyframe < this.keyframes; keyframe++) {
                const source = (sourceIndex * this.keyframes + keyframe) * 3;
                const target = (index * this.keyframes + keyframe) * 4;
                data[target] = this.trajectoryData[source];
                data[target + 1] = this.trajectoryData[source + 1];
                data[target + 2] = this.trajectoryData[source + 2];
                data[target + 3] = 1;
            }
        }
        return this.createTexture('DisplayTrajectory', textureWidth, textureHeight, data);
    }

    private createRotationTexture(parsed: DisplayParsed, count: number) {
        if (!parsed.rotTrajectory || !parsed.rotKeyframes) return null;
        const trajectory = parsed.rotTrajectory as Float32Array;
        this.rotKeyframes = parsed.rotKeyframes;
        this.rotStride = Math.max(1, parsed.rotStride || 1);
        const semantic = parsed.rotationSemantic === 'xyzw' ? 'xyzw' : 'wxyz';
        const textureWidth = 4096;
        const textureHeight = Math.ceil(count * this.rotKeyframes / textureWidth);
        const data = new Float32Array(textureWidth * textureHeight * 4);
        for (let index = 0; index < count; index++) {
            const sourceIndex = this.originalIndices ? Math.round(this.originalIndices[index]) : index;
            for (let keyframe = 0; keyframe < this.rotKeyframes; keyframe++) {
                const source = (sourceIndex * this.rotKeyframes + keyframe) * 4;
                const target = (index * this.rotKeyframes + keyframe) * 4;
                if (semantic === 'xyzw') {
                    data.set(trajectory.subarray(source, source + 4), target);
                } else {
                    data[target] = trajectory[source + 1];
                    data[target + 1] = trajectory[source + 2];
                    data[target + 2] = trajectory[source + 3];
                    data[target + 3] = trajectory[source];
                }
            }
        }
        return this.createTexture('DisplayRotation', textureWidth, textureHeight, data);
    }

    private createColorTrajectoryTexture(parsed: DisplayParsed, count: number) {
        if (!parsed.dcTrajectory || !parsed.dcKeyframes) return null;
        const trajectory = parsed.dcTrajectory as Float32Array;
        const keyframes = parsed.dcKeyframes as number;
        this.dcStride = Math.max(1, parsed.dcStride || 1);
        const textureWidth = 4096;
        const textureHeight = Math.ceil(count * keyframes / textureWidth);
        const data = new Float32Array(textureWidth * textureHeight * 4);
        const sh0 = 0.28209479177387814;
        for (let index = 0; index < count; index++) {
            const sourceIndex = this.originalIndices ? Math.round(this.originalIndices[index]) : index;
            for (let keyframe = 0; keyframe < keyframes; keyframe++) {
                const source = (sourceIndex * keyframes + keyframe) * 3;
                const target = (index * keyframes + keyframe) * 4;
                data[target] = trajectory[source] * sh0 + 0.5;
                data[target + 1] = trajectory[source + 1] * sh0 + 0.5;
                data[target + 2] = trajectory[source + 2] * sh0 + 0.5;
                data[target + 3] = 1;
            }
        }
        return this.createTexture('DisplayColorTrajectory', textureWidth, textureHeight, data);
    }

    private createScalesTexture(splatData: pc.GSplatData, width: number, height: number) {
        const x = splatData.getProp('scale_0');
        const y = splatData.getProp('scale_1');
        const z = splatData.getProp('scale_2');
        if (!x || !y || !z) return null;
        const data = new Float32Array(width * height * 4);
        for (let index = 0; index < splatData.numSplats; index++) {
            data[index * 4] = x[index];
            data[index * 4 + 1] = y[index];
            data[index * 4 + 2] = z[index];
        }
        return this.createTexture('DisplayScales', width, height, data);
    }

    private createEmptySelectionTexture(width: number, height: number) {
        const texture = new pc.Texture(this.app.graphicsDevice, {
            name: 'DisplaySelectionEmpty',
            width,
            height,
            format: pc.PIXELFORMAT_R8_G8_B8_A8,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE
        });
        const data = texture.lock();
        data.fill(0);
        texture.unlock();
        this.runtimeTextures.push(texture);
        return texture;
    }

    private setupShader(instance: any, parsed: DisplayParsed, textures: {
        lifeTexture: pc.Texture | null;
        trajectoryTexture: pc.Texture | null;
        rotationTexture: pc.Texture | null;
        colorTexture: pc.Texture | null;
        scalesTexture: pc.Texture | null;
        selectionTexture: pc.Texture;
    }) {
        const material = instance.material;
        material.setParameter('uTime', 0);
        material.setParameter('uTransitionFactor', 0);
        material.setParameter('uRotationFactor', 0);
        material.setParameter('uSwizzleMode', 1);
        material.setParameter('uOpacityScale', 1);
        material.setParameter('uRenderMode', 0);
        material.setParameter('uSHLevel', 3);
        material.setParameter('isSelectionMode', 0);
        material.setParameter('selectionTexture', textures.selectionTexture);
        material.setParameter('uGlobalTotalFrames', this.duration);
        if (textures.lifeTexture) material.setParameter('lifetimeTexture', textures.lifeTexture);
        if (textures.trajectoryTexture) {
            material.setParameter('uTrajectoryTexture', textures.trajectoryTexture);
            material.setParameter('uKeyframes', this.keyframes);
            material.setParameter('uXYZStride', this.xyzStride);
        }
        if (textures.rotationTexture) {
            material.setParameter('uRotationTexture', textures.rotationTexture);
            material.setParameter('uRotKeyframes', this.rotKeyframes);
            material.setParameter('uRotStride', this.rotStride);
        }
        if (textures.colorTexture) {
            material.setParameter('uColorTrajectoryTexture', textures.colorTexture);
            material.setParameter('uColorKeyframes', parsed.dcKeyframes || 0);
            material.setParameter('uColorStride', this.dcStride);
        }
        if (textures.scalesTexture) material.setParameter('uScalesTexture', textures.scalesTexture);

        const originalGetShaderVariant = material.getShaderVariant;
        const bands = Number(parsed.bands || 0);
        material.getShaderVariant = function (device: any) {
            const library = device.getProgramLibrary();
            const originalGetProgram = library.getProgram;
            library.getProgram = function (name: string, options: any, processingOptions: any) {
                if (name !== 'splat') return originalGetProgram.call(this, name, options, processingOptions);
                if (!options.defines) options.defines = [];
                const addDefine = (enabled: boolean, define: string) => {
                    if (enabled && !options.defines.includes(define)) options.defines.push(define);
                };
                addDefine(Boolean(textures.lifeTexture), 'USE_LIFETIME_TEXTURE');
                addDefine(Boolean(textures.trajectoryTexture), 'USE_TRAJECTORY');
                addDefine(Boolean(textures.rotationTexture), 'USE_ROTATION');
                addDefine(Boolean(textures.colorTexture), 'USE_COLOR_TRAJECTORY');
                addDefine(bands >= 1, 'USE_SH1');
                addDefine(bands >= 2, 'USE_SH2');
                addDefine(bands >= 3, 'USE_SH3');
                const shaderPass = (pc as any).ShaderPass?.get(device)?.getByIndex?.(options.pass);
                let defines = shaderPass?.shaderDefines ? `${shaderPass.shaderDefines}\n` : '';
                if (options.pass === 2 && !defines.includes('PICK_PASS')) defines += '#define PICK_PASS\n';
                defines += options.defines.map((define: string) => `#define ${define}`).join('\n') + '\n';
                return new pc.Shader(device, {
                    attributes: {
                        vertex_position: pc.SEMANTIC_POSITION,
                        vertex_id_attrib: pc.SEMANTIC_ATTR13
                    },
                    vshader: `#version 300 es\n${defines}${splatCoreVS}${splatMainVS}`,
                    fshader: `#version 300 es\n${defines}precision mediump float;\n${splatMainPS}`
                });
            };
            try {
                return originalGetShaderVariant.apply(this, arguments as any);
            } finally {
                library.getProgram = originalGetProgram;
            }
        };
        material.clearVariants?.();
        material.update();
    }

    private update(dt: number) {
        if (!this.isPlaying) return;
        const maxFrame = Math.max(0, this.duration - 1);
        this.playbackTime += dt * this.fps;
        if (this.playbackTime > maxFrame) this.playbackTime = 0;
        const frame = Math.floor(this.playbackTime);

        if (this.is4DGS && this.trajectoryData) {
            if (!this.isWaitingForSort && frame !== Math.floor(this.currentTime)) this.requestSortedFrame(frame);
        } else {
            this.applyVisibleFrame(frame);
        }
        this.syncTimeUI(frame);
    }

    private requestSortedFrame(frame: number) {
        if (this.isWaitingForSort || frame === Math.floor(this.currentTime)) return;
        this.pendingSortedFrame = frame;
        this.updateDynamicPositions(frame);
    }

    private updateDynamicPositions(frame: number) {
        if (!this.dynamicSorter || !this.trajectoryData || !this.is4DGS) return;
        const clamped = Math.max(0, Math.min(this.duration - 1, Math.floor(frame)));
        if (clamped === this.lastUpdatedFrame) return;
        this.lastUpdatedFrame = clamped;
        this.isWaitingForSort = true;
        this.sortingTaskId++;
        this.dynamicSorter.requestFrame(clamped, this.sortingTaskId);
    }

    private applyVisibleFrame(frame: number) {
        const clamped = Math.max(0, Math.min(this.duration - 1, Math.floor(frame)));
        this.currentTime = clamped;
        if (!this.isPlaying) this.playbackTime = clamped;
        const material = (this.splatEntity?.gsplat as any)?.instance?.material;
        material?.setParameter('uTime', clamped);
        material?.setParameter('uGlobalTotalFrames', this.duration);
        this.syncTimeUI(clamped);
    }

    private seek(frame: number) {
        const clamped = Math.max(0, Math.min(this.duration - 1, Math.floor(frame)));
        this.playbackTime = clamped;
        if (this.is4DGS && this.trajectoryData) {
            this.lastUpdatedFrame = -1;
            this.pendingSortedFrame = clamped;
            this.updateDynamicPositions(clamped);
        } else {
            this.applyVisibleFrame(clamped);
        }
        this.syncTimeUI(clamped);
    }

    public togglePlay() {
        this.setPlaying(!this.isPlaying);
    }

    private setPlaying(playing: boolean) {
        this.isPlaying = playing;
        if (playing) this.playbackTime = this.currentTime;
        this.playButton.classList.toggle('is-playing', playing);
        this.playButton.setAttribute('aria-label', playing ? '暂停' : '播放');
        const stereoButton = document.getElementById('stereo-play-pause');
        stereoButton?.classList.toggle('is-playing', playing);
        stereoButton?.setAttribute('aria-pressed', playing ? 'true' : 'false');
        const text = stereoButton?.querySelector('span');
        if (text) text.textContent = playing ? '暂停' : '播放';
    }

    private syncTimeUI(displayFrame = Math.floor(this.currentTime)) {
        const max = Math.max(0, this.duration - 1);
        this.slider.max = String(max);
        this.slider.value = String(Math.max(0, Math.min(max, displayFrame)));
        if (this.currentFrameLabel) this.currentFrameLabel.textContent = String(Math.max(0, displayFrame));
        if (this.totalFrameLabel) this.totalFrameLabel.textContent = String(max);
        const progress = max > 0 ? displayFrame / max * 100 : 0;
        this.slider.style.background = `linear-gradient(90deg, #fff ${progress}%, rgba(255,255,255,.16) ${progress}%)`;
    }

    private fitCameraToModel(splatData: pc.GSplatData, entity: pc.Entity, fileName: string) {
        const x = splatData.getProp('x');
        const y = splatData.getProp('y');
        const z = splatData.getProp('z');
        if (!x || !y || !z || x.length === 0) {
            this.resetCamera();
            return;
        }
        // #WDD-gpt 2026-08-04 - 使用稳健分位边界忽略少量远距离噪点，避免 Seedance 等场景被异常点推成黑屏
        const [minX, maxX] = this.getRobustRange(x);
        const [minY, maxY] = this.getRobustRange(y);
        const [minZ, maxZ] = this.getRobustRange(z);
        if (!Number.isFinite(minX)) {
            this.resetCamera();
            return;
        }
        const localCenter = new pc.Vec3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
        const size = new pc.Vec3(maxX - minX, maxY - minY, maxZ - minZ);
        const preset = getDisplayModelPreset(fileName);

        if (preset) {
            // #WDD-gpt 2026-08-04 - 每个内置 SOG 归一到统一展示尺度和原点，同时保持发布页相机的相对构图
            const normalizationScale = this.normalizePresetModelTransform(entity, localCenter, size);
            const modelPosition = entity.getPosition();
            const normalizePresetPoint = (value: readonly [number, number, number]) => new pc.Vec3(
                value[0] * normalizationScale + modelPosition.x,
                value[1] * normalizationScale + modelPosition.y,
                value[2] * normalizationScale + modelPosition.z
            );
            const cameraTarget = normalizePresetPoint(preset.cameraTarget);
            const cameraPosition = normalizePresetPoint(preset.cameraPosition)
                .sub(cameraTarget)
                .mulScalar(preset.distanceScale)
                .add(cameraTarget);
            const sphereCenter = entity.getWorldTransform().transformPoint(localCenter);
            this.boundingSphereRadius = this.getWorldBoundingSphereRadius(size, entity);
            if (this.thumbnailCapture) {
                this.setInitialOrbitView(cameraPosition, cameraTarget, preset.fov, true);
            } else {
                const viewDirection = cameraPosition.clone().sub(cameraTarget).normalize();
                const distance = Math.max(
                    cameraPosition.distance(cameraTarget),
                    this.getBoundingSphereFitDistance(this.boundingSphereRadius, preset.fov, true)
                );
                this.setInitialOrbitView(
                    sphereCenter.clone().add(viewDirection.mulScalar(distance)),
                    sphereCenter,
                    preset.fov,
                    true
                );
            }
            return;
        }

        entity.getWorldTransform().transformPoint(localCenter, this.orbitTarget);
        this.boundingSphereRadius = this.getWorldBoundingSphereRadius(size, entity);
        const fov = 48;
        const distance = this.getBoundingSphereFitDistance(this.boundingSphereRadius, fov, false);
        const position = new pc.Vec3(this.orbitTarget.x, this.orbitTarget.y, this.orbitTarget.z + distance);
        this.setInitialOrbitView(position, this.orbitTarget, fov);
    }

    private getRobustRange(values: ArrayLike<number>): [number, number] {
        const maxSamples = 131072;
        const sampleCount = Math.min(values.length, maxSamples);
        const samples = new Float32Array(sampleCount);
        let validCount = 0;
        for (let index = 0; index < sampleCount; index++) {
            const sourceIndex = Math.min(values.length - 1, Math.floor(index * values.length / sampleCount));
            const value = values[sourceIndex];
            if (Number.isFinite(value)) samples[validCount++] = value;
        }
        if (validCount === 0) return [Infinity, -Infinity];
        const sorted = samples.subarray(0, validCount);
        sorted.sort();
        const lower = sorted[Math.floor((validCount - 1) * 0.001)];
        const upper = sorted[Math.ceil((validCount - 1) * 0.999)];
        return [lower, upper];
    }

    private normalizePresetModelTransform(entity: pc.Entity, localCenter: pc.Vec3, size: pc.Vec3) {
        const baseScale = entity.getLocalScale().clone();
        const currentExtent = Math.max(
            size.x * Math.abs(baseScale.x),
            size.y * Math.abs(baseScale.y),
            size.z * Math.abs(baseScale.z),
            1e-6
        );
        const normalizationScale = 2 / currentExtent;
        // #WDD-gpt 2026-08-04 - 官方 SOG 发布相机使用转换后的世界坐标，纹理解码坐标需翻转 X/Y 才与原始发布效果一致
        entity.setLocalScale(
            baseScale.x * -normalizationScale,
            baseScale.y * -normalizationScale,
            baseScale.z * normalizationScale
        );
        const worldCenter = entity.getWorldTransform().transformPoint(localCenter);
        entity.setPosition(entity.getPosition().clone().sub(worldCenter));
        return normalizationScale;
    }

    private getWorldBoundingSphereRadius(size: pc.Vec3, entity: pc.Entity) {
        const scale = entity.getLocalScale();
        const halfX = size.x * Math.abs(scale.x) * 0.5;
        const halfY = size.y * Math.abs(scale.y) * 0.5;
        const halfZ = size.z * Math.abs(scale.z) * 0.5;
        return Math.max(0.01, Math.hypot(halfX, halfY, halfZ));
    }

    // #WDD-gpt 2026-08-04 - 以包围球角半径计算窄边视场距离，保证围绕中心任意旋转时球体仍完整留在画布内
    private getBoundingSphereFitDistance(radius: number, fov: number, horizontalFov: boolean) {
        const canvas = this.app.graphicsDevice.canvas;
        const aspect = Math.max(0.1, canvas.clientWidth / Math.max(1, canvas.clientHeight));
        const declaredFov = fov * pc.math.DEG_TO_RAD;
        const horizontal = horizontalFov
            ? declaredFov
            : 2 * Math.atan(Math.tan(declaredFov * 0.5) * aspect);
        const vertical = horizontalFov
            ? 2 * Math.atan(Math.tan(declaredFov * 0.5) / aspect)
            : declaredFov;
        const narrowFov = Math.max(1 * pc.math.DEG_TO_RAD, Math.min(horizontal, vertical));
        return Math.max(0.02, radius / Math.sin(narrowFov * 0.5) * 1.08);
    }

    private handleResize() {
        const wasAtInitialDistance = Math.abs(this.orbitDistance - this.initialOrbitDistance) < 1e-4;
        this.app.resizeCanvas();
        if (this.boundingSphereRadius <= 0 || !this.camera.camera) return;
        const minimumDistance = this.getBoundingSphereFitDistance(
            this.boundingSphereRadius,
            this.camera.camera.fov,
            this.camera.camera.horizontalFov
        );
        if (minimumDistance <= this.initialOrbitDistance) return;
        this.initialOrbitDistance = minimumDistance;
        if (wasAtInitialDistance) {
            this.orbitDistance = minimumDistance;
            this.updateOrbitCamera();
        }
    }

    private setInitialOrbitView(position: pc.Vec3, target: pc.Vec3, fov: number, horizontalFov = false) {
        const offset = position.clone().sub(target);
        const distance = Math.max(0.02, offset.length());
        this.orbitTarget.copy(target);
        this.orbitDistance = distance;
        this.orbitYaw = Math.atan2(offset.x, offset.z) * pc.math.RAD_TO_DEG;
        this.orbitPitch = Math.asin(pc.math.clamp(offset.y / distance, -1, 1)) * pc.math.RAD_TO_DEG;
        this.initialOrbitTarget.copy(this.orbitTarget);
        this.initialOrbitDistance = this.orbitDistance;
        this.initialOrbitYaw = this.orbitYaw;
        this.initialOrbitPitch = this.orbitPitch;
        this.initialCameraFov = fov;
        this.initialHorizontalFov = horizontalFov;
        if (this.camera.camera) {
            this.camera.camera.fov = fov;
            this.camera.camera.horizontalFov = horizontalFov;
            this.camera.camera.nearClip = Math.max(0.001, distance / 1000);
            this.camera.camera.farClip = Math.max(100, distance * 50);
        }
        this.updateOrbitCamera();
    }

    private resetCamera() {
        this.orbitTarget.copy(this.initialOrbitTarget);
        this.orbitDistance = this.initialOrbitDistance;
        this.orbitYaw = this.initialOrbitYaw;
        this.orbitPitch = this.initialOrbitPitch;
        if (this.camera.camera) {
            this.camera.camera.fov = this.initialCameraFov;
            this.camera.camera.horizontalFov = this.initialHorizontalFov;
        }
        this.updateOrbitCamera();
    }

    private updateOrbitCamera() {
        const pitch = this.orbitPitch * pc.math.DEG_TO_RAD;
        const yaw = this.orbitYaw * pc.math.DEG_TO_RAD;
        const cosPitch = Math.cos(pitch);
        this.camera.setPosition(
            this.orbitTarget.x + this.orbitDistance * cosPitch * Math.sin(yaw),
            this.orbitTarget.y + this.orbitDistance * Math.sin(pitch),
            this.orbitTarget.z + this.orbitDistance * cosPitch * Math.cos(yaw)
        );
        this.camera.lookAt(this.orbitTarget);
    }

    private onStereoActiveChanged(active: boolean, mode: StereoDisplayMode) {
        document.getElementById('display-mono-view')?.classList.toggle('active', !active);
        document.getElementById('display-mono-view')?.setAttribute('aria-pressed', active ? 'false' : 'true');
        const deviceRatio = Math.max(1, window.devicePixelRatio || 1);
        // #WDD-gpt  2026-08-10 - 隔列模式保持原生物理像素比，避免浏览器缩放破坏奇偶列左右眼映射
        const ratio = active
            ? mode === 'column-interlaced' ? deviceRatio : Math.min(deviceRatio, 1)
            : Math.min(deviceRatio, 2);
        this.app.graphicsDevice.maxPixelRatio = ratio;
        this.app.resizeCanvas();
    }

    private disposeCurrentModel() {
        this.dynamicSorterEpoch++;
        this.dynamicSorter?.destroy();
        this.dynamicSorter = null;
        this.isWaitingForSort = false;
        this.pendingSortedFrame = null;
        this.boundingSphereRadius = 0;
        this.splatEntity?.destroy();
        this.splatEntity = null;
        this.runtimeTextures.forEach((texture) => texture.destroy());
        this.runtimeTextures = [];
        if (this.currentAsset) {
            this.app.assets.remove(this.currentAsset);
            this.currentAsset.unload();
            this.currentAsset = null;
        }
        if (this.currentObjectUrl) {
            URL.revokeObjectURL(this.currentObjectUrl);
            this.currentObjectUrl = null;
        }
    }

    private updateModelUI(name: string, count: number) {
        const cleanName = name.replace(/\.(sog4?|ply4?|truesplats)$/i, '');
        if (this.modelNameLabel) this.modelNameLabel.textContent = cleanName;
        if (this.modelMetaLabel) this.modelMetaLabel.textContent = `${count.toLocaleString()} SPLATS · ${this.duration} FRAMES`;
        document.title = `${cleanName} · TrueSplats Display`;
    }

    private setLoading(show: boolean, title: string, detail: string, progress: number) {
        const overlay = document.getElementById('display-loading');
        overlay?.classList.toggle('hidden', !show);
        const titleElement = document.getElementById('display-loading-title');
        const detailElement = document.getElementById('display-loading-detail');
        const progressElement = document.getElementById('display-loading-progress') as HTMLElement | null;
        if (titleElement && title) titleElement.textContent = title;
        if (detailElement && detail) detailElement.textContent = detail;
        if (progressElement) progressElement.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    }

    private handleLoadError(error: unknown) {
        console.error('[Display] Model load failed:', error);
        this.setLoading(false, '', '', 0);
        const panel = document.getElementById('display-error');
        const message = document.getElementById('display-error-message');
        if (message) message.textContent = error instanceof Error ? error.message : String(error);
        panel?.classList.remove('hidden');
    }

    private hideError() {
        document.getElementById('display-error')?.classList.add('hidden');
    }

    private fileNameFromUrl(url: string) {
        try {
            const pathname = new URL(url, window.location.href).pathname;
            return decodeURIComponent(pathname.split('/').pop() || 'model.sog');
        } catch {
            return url.split('/').pop()?.split('?')[0] || 'model.sog';
        }
    }

    private formatBytes(loaded: number, total: number) {
        const mb = (loaded / 1024 / 1024).toFixed(1);
        return total > 0 ? `${mb} / ${(total / 1024 / 1024).toFixed(1)} MB` : `${mb} MB`;
    }

    private async toggleFullscreen() {
        const doc = document as FullscreenDocument;
        const active = document.fullscreenElement || doc.webkitFullscreenElement;
        if (active) {
            if (document.exitFullscreen) await document.exitFullscreen();
            else await doc.webkitExitFullscreen?.();
            return;
        }
        const root = document.documentElement as FullscreenElement;
        if (root.requestFullscreen) await root.requestFullscreen();
        else await root.webkitRequestFullscreen?.();
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new DisplayViewer();
});
