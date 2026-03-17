import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// #WDD 2026-02-03 Face Tracker Class
export class FaceTracker {
    private faceLandmarker: FaceLandmarker | undefined;
    private video: HTMLVideoElement;
    private lastVideoTime = -1;
    private rafId: number = 0;
    public isActive = false;
    private onUpdate: (pos: { x: number, y: number, z: number }) => void;
    public isLoading = false;

    constructor(videoElementId: string, onUpdate: (pos: { x: number, y: number, z: number }) => void) {
        const el = document.getElementById(videoElementId);
        if (!el) throw new Error(`Video element ${videoElementId} not found`);
        this.video = el as HTMLVideoElement;
        this.onUpdate = onUpdate;
    }

    async init() {
        if (this.faceLandmarker) return;
        this.isLoading = true;
        try {
            console.log("Initializing FaceLandmarker...");
            const filesetResolver = await FilesetResolver.forVisionTasks(
                "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
            );
            this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                    delegate: "GPU"
                },
                outputFaceBlendshapes: true,
                runningMode: "VIDEO",
                numFaces: 1
            });
            console.log("FaceLandmarker initialized.");
        } catch (e) {
            console.error("Failed to init FaceLandmarker", e);
            throw e;
        } finally {
            this.isLoading = false;
        }
    }

    async start(deviceId?: string) {
        if (!this.faceLandmarker) {
            await this.init();
        }

        const constraints = {
            video: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: 'user'
            }
        };

        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = stream;
            // Wait for video to be ready
            this.video.onloadeddata = () => {
                this.isActive = true;
                this.predictWebcam();
            };
        } catch (err) {
            console.error("Error starting video stream:", err);
            throw err;
        }
    }

    stop() {
        if (this.video.srcObject) {
            const stream = this.video.srcObject as MediaStream;
            stream.getTracks().forEach(track => track.stop());
            this.video.srcObject = null;
        }
        this.isActive = false;
        cancelAnimationFrame(this.rafId);
    }

    predictWebcam = () => {
        if (!this.isActive || !this.faceLandmarker) return;

        // Ensure video is playing and has dimension
        if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
            this.rafId = requestAnimationFrame(this.predictWebcam);
            return;
        }

        let startTimeMs = performance.now();
        if (this.lastVideoTime !== this.video.currentTime) {
            this.lastVideoTime = this.video.currentTime;

            try {
                const results = this.faceLandmarker.detectForVideo(this.video, startTimeMs);

                if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                    const landmarks = results.faceLandmarks[0];
                    // Landmark 1 is the nose tip
                    const nose = landmarks[1];

                    // Coordinate system:
                    // x: 0 (left) -> 1 (right)
                    // y: 0 (top) -> 1 (bottom)
                    // z: proximity (normalized somewhat by face width)

                    // Center is 0.5.
                    // We want -1 (left) to 1 (right)
                    // But remember video is mirrored (scale-x -1 in CSS), but MediaPipe coords are based on source image.
                    // If source is mirrored by CSS, the user sees themselves as a mirror.
                    // If I move left in reality, in the camera frame I move right (if not mirrored) or left (if mirrored).
                    // Usually we want the virtual camera to move opposite to head movement for "window" effect?
                    // Parallax: Move head LEFT -> View angle changes to look from LEFT. 
                    // To look from left, the camera must move LEFT.

                    // Let's output raw relative coords from center.
                    // x: -0.5 to 0.5
                    const x = (nose.x - 0.5);
                    const y = (nose.y - 0.5);
                    const z = nose.z;

                    this.onUpdate({ x, y, z });
                }
            } catch (e) {
                console.warn("Face tracking error:", e);
            }
        }
        this.rafId = requestAnimationFrame(this.predictWebcam);
    };

    static async getCameras() {
        // Ensure permission first
        try {
            await navigator.mediaDevices.getUserMedia({ video: true });
        } catch (e) {
            console.warn("Camera permission not granted yet");
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === 'videoinput');
    }
}
