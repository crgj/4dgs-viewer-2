
import * as pc from 'playcanvas';
// @ts-ignore
import { Controller } from 'mind-ar/dist/mindar-image.prod.js';

export class ARHandler {
    viewer: any;
    app: pc.Application;
    arController: any = null;
    isARRunning: boolean = false;
    video: HTMLVideoElement | null = null;

    // AR Background
    videoTexture: pc.Texture | null = null;
    bgPlane: pc.Entity | null = null;
    bgMaterial: pc.Material | null = null;

    // Tracking
    arAnchor: pc.Entity | null = null; // The Marker Space
    originalParent: pc.Entity | null = null;
    originalAxesParent: pc.Entity | null = null;

    postMatrix = new pc.Mat4();
    targetMatrix = new pc.Mat4();
    tempMat = new pc.Mat4();
    tempQuat = new pc.Quat();
    tempPos = new pc.Vec3();
    tempScale = new pc.Vec3();

    // #WDD 2026-01-18 Resize Handler
    private resizeHandler: (() => void) | null = null;
    private hasInitializedDimensions = false;

    // Camera Restoration
    private cachedCamPos = new pc.Vec3();
    private cachedCamRot = new pc.Quat(); // Storing Quat or Euler? Euler is easier to restore to viewer props
    private cachedCamPitch = 0;
    private cachedCamYaw = 0;

    constructor(viewer: any) {
        this.viewer = viewer;
        this.app = viewer.app;
    }

    // #WDD 2026-01-18 Camera Enumeration
    async getCameraDevices(): Promise<MediaDeviceInfo[]> {
        try {
            // Request permission first to ensure labels are available
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });

            // #WDD 2026-01-19: Enumerate while stream is active to get labels
            const devices = await navigator.mediaDevices.enumerateDevices();

            stream.getTracks().forEach(track => track.stop()); // #WDD 2026-01-18 Stop stream immediately to turn off light

            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            // #WDD 2026-01-19: Filter out "default" if real devices exist to avoid duplicates
            if (videoDevices.length > 1) {
                return videoDevices.filter(d => d.deviceId !== 'default');
            }
            return videoDevices;
        } catch (e) {
            console.warn("[AR] Failed to enumerate devices", e);
            return [];
        }
    }


    async start(deviceId?: string) {
        if (this.isARRunning) return;
        console.log(`[AR] Starting MindAR with Device: ${deviceId || 'Default'}...`);

        // 1. Setup Offscreen Video
        if (!this.video) {
            this.video = document.createElement("video");
            this.video.autoplay = true;
            this.video.muted = true;
            this.video.playsInline = true;
            this.video.style.position = 'fixed';
            this.video.style.top = '0';
            this.video.style.left = '0';
            this.video.style.width = '1px';
            this.video.style.height = '1px';
            this.video.style.opacity = '0';
            this.video.style.pointerEvents = 'none';
            this.video.style.zIndex = '-1000';
            document.body.appendChild(this.video);
        }

        try {
            // Device Selection Logic
            const constraints: MediaStreamConstraints = {
                audio: false,
                video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }
            };

            // Refine resolution
            if (typeof constraints.video === 'object') {
                (constraints.video as MediaTrackConstraints).width = { ideal: 1280 };
                (constraints.video as MediaTrackConstraints).height = { ideal: 720 };
            }

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = stream;

            await new Promise((resolve) => {
                if (!this.video) return resolve(true);
                this.video.onloadedmetadata = () => {
                    this.video!.play().then(resolve);
                };
            });

            this.video.setAttribute('width', this.video.videoWidth.toString());
            this.video.setAttribute('height', this.video.videoHeight.toString());

        } catch (e) {
            console.error("[AR] Failed to start video", e);
            alert("Failed to start AR Camera: " + e);
            return;
        }

        // 2. Setup Background Plane
        this.setupBackgroundPlane();

        // 3. Initialize Controller
        const inputWidth = this.video.videoWidth;
        const inputHeight = this.video.videoHeight;

        this.arController = new Controller({
            inputWidth: inputWidth,
            inputHeight: inputHeight,
            maxTrack: 1,
            warmupTolerance: 1,
            missTolerance: 1,
            debugMode: import.meta.env.DEV,
            filterMinCF: 0.001,
            filterBeta: 1000,
            onUpdate: (data: any) => {
                if (data.type === 'updateMatrix') {
                    const { targetIndex, worldMatrix } = data;
                    if (targetIndex === 0 && worldMatrix) {
                        this.updateObject(worldMatrix);
                    }
                }
            }
        });

        // 4. Load Targets
        try {
            const targetData = await this.arController.addImageTargets('./marker/card.mind');
            console.log("[AR] Targets loaded", targetData.dimensions);

            // #WDD 2026-01-18 Fix Coordinates: Center Anchor & Correct Orientation
            const [markerWidth, markerHeight] = targetData.dimensions[0];

            // Center Offset
            const position = new pc.Vec3(markerWidth / 2, markerHeight / 2, 0);

            // Rotation: Align Model Up (Y) with Marker Up (Y). Identity.
            const rot = new pc.Quat();
            rot.setFromEulerAngles(0, 0, 0);

            // Scale
            const scale = new pc.Vec3(1, 1, 1);

            this.postMatrix.setTRS(position, rot, scale);
        } catch (e) {
            console.error("[AR] Failed to load targets", e);
        }

        // 5. Start Processing
        await this.arController.dummyRun(this.video);
        this.arController.processVideo(this.video);

        // --- Setup AR Anchor ---
        this.arAnchor = new pc.Entity("ARAnchor");
        this.arAnchor.setLocalScale(5, 5, 5); // #WDD 2026-01-18 Default Scale 5x
        this.app.root.addChild(this.arAnchor);

        // Reparent SplatEntity
        if (this.viewer.splatEntity) {
            this.originalParent = this.viewer.splatEntity.parent;
            this.viewer.splatEntity.reparent(this.arAnchor);
        }

        // Reparent Axes
        if (this.viewer.axesEntity) {
            this.originalAxesParent = this.viewer.axesEntity.parent;
            this.viewer.axesEntity.reparent(this.arAnchor);
            this.viewer.axesEntity.enabled = true;
        }

        this.isARRunning = true;
        this.hasInitializedDimensions = false; // Reset init flag

        if (this.viewer.gridEntity) this.viewer.gridEntity.enabled = false;

        // #WDD 2026-01-18 Lock Camera at Origin for AR
        if (this.viewer.camera) {
            this.cachedCamPos.copy(this.viewer.camera.getPosition());
            this.cachedCamRot.copy(this.viewer.camera.getRotation());
            this.cachedCamPitch = this.viewer.pitch || 0;
            this.cachedCamYaw = this.viewer.yaw || 0;

            this.viewer.camera.setPosition(0, 0, 0);
            this.viewer.camera.setEulerAngles(0, 0, 0);
        }

        this.updateCameraFOV();

        // #WDD 2026-01-18 Handle Resize
        this.resizeHandler = () => {
            this.updateCameraFOV();
        };
        window.addEventListener('resize', this.resizeHandler);

        const btn = document.getElementById('start-ar');
        if (btn && this.viewer.updateToggleButton) this.viewer.updateToggleButton(btn, true);

        // If a sequence is active, make sure all frames follow the AR anchor too.
        if (this.viewer && typeof this.viewer.onARStartedForSequence === 'function') {
            this.viewer.onARStartedForSequence();
        }
    }

    setupBackgroundPlane() {
        this.videoTexture = new pc.Texture(this.app.graphicsDevice, {
            format: pc.PIXELFORMAT_R8_G8_B8,
            mipmaps: false,
            minFilter: pc.FILTER_LINEAR,
            magFilter: pc.FILTER_LINEAR
        });

        const mat = new pc.BasicMaterial();
        mat.color = new pc.Color(1, 1, 1);
        mat.colorMap = this.videoTexture;
        mat.cull = pc.CULLFACE_NONE;
        mat.depthWrite = false;
        mat.update();
        this.bgMaterial = mat;

        this.bgPlane = new pc.Entity('ARBackground');
        this.bgPlane.addComponent('model', {
            type: 'plane',
            material: this.bgMaterial
        });

        this.bgPlane.setLocalPosition(0, 0, -10);
        this.bgPlane.setLocalEulerAngles(90, 0, 0);
        this.viewer.camera.addChild(this.bgPlane);
    }

    updateCameraFOV() {
        if (!this.video || !this.arController || !this.bgPlane) return;

        const proj = this.arController.getProjectionMatrix();
        const fov = 2 * Math.atan(1 / proj[5]) * 180 / Math.PI;

        if (this.viewer.camera && this.viewer.camera.camera) {
            this.viewer.camera.camera.fov = fov;
        }

        const d = 10;
        const h = 2 * d * Math.tan((fov * Math.PI / 180) / 2);
        const aspect = this.video.videoWidth / this.video.videoHeight;
        const w = h * aspect;

        this.bgPlane.setLocalScale(w, 1, h);
    }

    update() {
        if (!this.isARRunning || !this.video || !this.videoTexture) return;
        if (this.video.readyState >= this.video.HAVE_CURRENT_DATA) {
            this.videoTexture.setSource(this.video);
        }
    }

    // #WDD 2026-01-18 Camera Settings API
    getVideoTrack(): MediaStreamTrack | null {
        if (!this.video || !this.video.srcObject) return null;
        const stream = this.video.srcObject as MediaStream;
        return stream.getVideoTracks()[0] || null;
    }

    getCapabilities(): MediaTrackCapabilities | null {
        const track = this.getVideoTrack();
        return track ? track.getCapabilities() : null;
    }

    getSettings(): MediaTrackSettings | null {
        const track = this.getVideoTrack();
        return track ? track.getSettings() : null;
    }

    async applyConstraints(constraints: MediaTrackConstraints) {
        const track = this.getVideoTrack();
        if (track) {
            try {
                await track.applyConstraints({ advanced: [constraints] });
                console.log("[AR] Applied constraints:", constraints);
            } catch (e) {
                console.error("[AR] Failed to apply constraints", e);
            }
        }
    }

    updateObject(matrixVal: number[]) {
        if (!this.arAnchor) return;

        const m = this.targetMatrix.data;
        for (let i = 0; i < 16; i++) m[i] = matrixVal[i];

        // Apply PostMatrix (Rotation Fix + Centering)
        this.tempMat.mul2(this.targetMatrix, this.postMatrix);

        this.tempMat.getTranslation(this.tempPos);
        this.tempQuat.setFromMat4(this.tempMat);

        // Scale Factor (Convert px to meters approx)
        const globalScale = 0.01;
        this.tempPos.mulScalar(globalScale);

        this.arAnchor.setPosition(this.tempPos);
        this.arAnchor.setRotation(this.tempQuat);
    }

    stop() {
        console.log("[AR] Stopping AR Session...");
        if (!this.isARRunning) return;

        if (this.arController) {
            this.arController.stopProcessVideo();
            this.arController = null;
        }

        if (this.video) {
            const stream = this.video.srcObject as MediaStream;
            if (stream) {
                const tracks = stream.getTracks();
                tracks.forEach(track => track.stop());
                this.video.srcObject = null;
            }
            this.video.remove();
            this.video = null;
        }

        if (this.bgPlane) {
            this.bgPlane.destroy();
            this.bgPlane = null;
        }

        if (this.viewer.splatEntity && this.originalParent) {
            this.viewer.splatEntity.reparent(this.originalParent);
        }

        if (this.viewer.axesEntity && this.originalAxesParent) {
            this.viewer.axesEntity.reparent(this.originalAxesParent);
            this.viewer.axesEntity.enabled = true;
        }

        // Ensure any hidden sequence entities are moved out of the anchor before destroying it.
        if (this.viewer && typeof this.viewer.onARStoppingForSequence === 'function') {
            this.viewer.onARStoppingForSequence(this.originalParent || this.app.root);
        }

        if (this.arAnchor) {
            this.arAnchor.destroy();
            this.arAnchor = null;
        }

        if (this.viewer.gridEntity) this.viewer.gridEntity.enabled = true;

        // #WDD 2026-01-18 Restore Camera
        if (this.viewer.camera) {
            this.viewer.camera.setPosition(this.cachedCamPos);
            this.viewer.camera.setRotation(this.cachedCamRot);
            this.viewer.pitch = this.cachedCamPitch;
            this.viewer.yaw = this.cachedCamYaw;
        }

        this.isARRunning = false;

        const btn = document.getElementById('start-ar');
        if (btn && this.viewer.updateToggleButton) this.viewer.updateToggleButton(btn, false);

        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
            this.resizeHandler = null;
        }

        console.log("[AR] Stopped successfully.");
    }
}
