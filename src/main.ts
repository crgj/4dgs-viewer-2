import * as pc from 'playcanvas';
import { PlyExporter } from './utils/ply-exporter';
import { splatCoreVS, splatMainVS, splatMainPS } from './shaders/gsplat-shader';

import { TrueSplatsLoader } from './utils/truesplats-loader';
import { SOG4Loader } from './utils/sog4-loader'; // #WDD 2026-01-18 SOG4 Support
import { PLY4Loader } from './utils/ply4-loader'; // #WDD 2026-01-21 PLY4 Support
import { SelectionTool } from './ui/selection-tool';
import { GaussianEffects } from './particle-effects';
import { ARHandler } from './utils/ar-handler';

// --- Configuration & State ---
interface CameraPreset {
    name: string;
    pos: pc.Vec3;
    pitch: number;
    yaw: number;
    textObjects?: {
        id: string;
        content: string;
        font: string;
        fontSize: number;
        color: string;
        fontWeight: string;
        fontStyle: string;
        top: number;
        left: number;
    }[];
}

class Viewer {
    app: pc.Application;
    camera: pc.Entity | null = null;
    splatEntity: pc.Entity | null = null;
    prevTime = 0;
    fpsCounter = 0;
    fpsTimer = 0;
    duration = 1.0;
    fps = 30; // Default playback fps
    currentFileName: string | null = null;
    originalFrames: number | null = null;
    private isPlaying = false;
    private currentTime = 0;
    private currentPresetIndex = -1;

    // Cache for Selection Tool
    cachedPositions: Float32Array | null = null;
    selectionTool: SelectionTool;
    arHandler: ARHandler;
    private effects: GaussianEffects;

    private pitch = 0;
    private yaw = 0;
    private gridEntity: pc.Entity | null = null;
    private axesEntity: pc.Entity | null = null;

    // --- Text Object Feature Interfaces #WDD 2026-01-15 ---
    private activeTextId: string | null = null;
    private textOverlays: Map<string, HTMLElement> = new Map();



    // Camera Presets State
    private cameraPresets: CameraPreset[] = [];
    private isCameraAnimating = false;
    private wasPlayingBeforeAnim = false; // #WDD 2026-01-15 Store playback state
    private animTargetPos = new pc.Vec3();
    private animTargetPitch = 0;
    private animTargetYaw = 0;
    private animStartPos = new pc.Vec3();
    private animStartPitch = 0;
    private animStartYaw = 0;
    private animProgress = 0;

    // Debugging #WDD 2026-01-15
    private swizzleMode = 1; // 0=yzwx, 1=xyzw, 2=wxyz

    private is4DGS = false;
    private trajectoryData: Float32Array | null = null;
    private keyframes = 0;
    private xyzStride = 1;
    private rotTrajectoryData: Float32Array | null = null;
    private rotKeyframes = 0;
    private rotStride = 1;
    private totalFrames = 0;
    private lifeTexData: Float32Array | null = null;
    private scalesTexData: Float32Array | null = null;
    private originalIndices: Float32Array | null = null; // #WDD 2026-01-17
    private lastParsedData: any = null;
    private hasLoggedSorterKeys: boolean = false;
    private isMobile: boolean = false;


    constructor() {
        const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;
        if (!canvas) {
            console.error("Canvas element not found!");
            throw new Error("Canvas element not found!");
        }

        // --- Robust WebGL Initialization #WDD 2026-01-08 修复WebGL启动错误 ---
        const options: any = {
            mouse: new pc.Mouse(canvas),
            touch: new pc.TouchDevice(canvas),
            elementInput: new pc.ElementInput(canvas)
        };

        try {
            this.app = new pc.Application(canvas, {
                ...options,
                graphicsDeviceOptions: {
                    antialias: true,
                    alpha: false,
                    preserveDrawingBuffer: false,
                    powerPreference: 'high-performance'
                }
            });
        } catch (e) {
            console.warn("High-performance WebGL failed, retrying with defaults...", e);
            try {
                this.app = new pc.Application(canvas, options);
            } catch (e2) {
                console.error("Critical: WebGL not supported even with defaults.", e2);
                document.body.innerHTML = `< div style = "padding:20px; color:white; background:#222; font-family:sans-serif;" >
    <h2>WebGL Not Supported </h2>
        < p > This viewer requires WebGL.Please ensure your browser supports it and hardware acceleration is enabled.</p>
            </div>`;
                throw e2;
            }
        }

        this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
        this.app.setCanvasResolution(pc.RESOLUTION_AUTO);

        window.addEventListener('resize', () => {
            this.app.resizeCanvas();
        });

        this.setupScene();

        // Init Selection Tool
        this.selectionTool = new SelectionTool(this.app, this);
        this.effects = new GaussianEffects(this.app);
        this.arHandler = new ARHandler(this);

        this.setupEventListeners();

        this.app.start();

        // #WDD 2026-01-21 Mobile simplified mode lock
        // 检测手机端：UserAgent包含移动端标识 且 屏幕宽度小于800 (排除平板)
        const isMobileUA = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        this.isMobile = isMobileUA && window.innerWidth < 800;

        if (this.isMobile) {
            console.log("[Viewer] Mobile Mode Detected: Locking to Simplified UI");
            // Auto-enter simplified mode
            setTimeout(() => this.toggleUIVisibility(true), 100);

            // Hide the toggle buttons to prevent switching back
            const ids = ['toggle-ui', 'simple-toggle-ui'];
            ids.forEach(id => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.style.display = 'none';
                    btn.style.pointerEvents = 'none';
                }
            });
        }

        this.app.on('update', (dt: number) => this.onUpdate(dt));
    }

    updateToggleButton(btn: HTMLElement | null, active: boolean) {
        if (!btn) return;
        if (active) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    private setupScene() {
        const app = this.app;

        const camera = new pc.Entity('Camera');
        camera.addComponent('camera', {
            clearColor: new pc.Color(0.1, 0.1, 0.1, 1), // Updated to match #2a2b2f
            farClip: 1000,
            nearClip: 0.1,
            fov: 60
        });

        camera.setPosition(0, 1, 5);
        app.root.addChild(camera);
        this.camera = camera;

        this.initGrid();
        this.initAxes();
    }

    private initGrid() {
        const size = 20;
        const divisions = 40;
        // 使用稍亮的颜色，但不开启透明混合，确保它能写入深度图
        const color = new pc.Color(0.2, 0.2, 0.2, 1);

        const positions: number[] = [];
        for (let i = 0; i <= divisions; i++) {
            const coord = (i / divisions - 0.5) * size;
            // X方向线段 (从一端到另一端)
            positions.push(coord, 0, -size / 2, coord, 0, size / 2);
            // Z方向线段
            positions.push(-size / 2, 0, coord, size / 2, 0, coord);
        }

        const mesh = new pc.Mesh(this.app.graphicsDevice);
        mesh.setPositions(new Float32Array(positions));
        mesh.update(pc.PRIMITIVE_LINES);

        const material = new pc.BasicMaterial();
        material.color = color;
        material.blendType = pc.BLEND_NONE; // 关键：关闭混合，作为不透明物体渲染
        material.depthWrite = true;       // 关键：写入深度，用于高斯遮挡
        material.update();

        const entity = new pc.Entity('Grid');
        entity.addComponent('render', {
            meshInstances: [new pc.MeshInstance(mesh, material)]
        });

        this.app.root.addChild(entity);
        this.gridEntity = entity;
    }

    private initAxes() {
        const length = 1.0;
        const thickness = 0.015;
        const entity = new pc.Entity('Axes');

        const createAxis = (name: string, pos: pc.Vec3, scale: pc.Vec3, color: pc.Color) => {
            const axis = new pc.Entity(name);
            // Using primitive box for controlled thickness
            axis.addComponent('render', {
                type: 'box'
            });
            axis.setLocalPosition(pos);
            axis.setLocalScale(scale);

            const material = new pc.BasicMaterial();
            material.color = color;
            material.depthWrite = true;
            material.blendType = pc.BLEND_NONE;
            material.update();

            // Apply material after component is added
            if (axis.render) {
                axis.render.meshInstances[0].material = material;
            }

            entity.addChild(axis);
        };

        // Create X, Y, Z axes as thin boxes
        createAxis('AxisX', new pc.Vec3(length / 2, 0, 0), new pc.Vec3(length, thickness, thickness), new pc.Color(1, 0, 0));
        createAxis('AxisY', new pc.Vec3(0, length / 2, 0), new pc.Vec3(thickness, length, thickness), new pc.Color(0, 1, 0));
        createAxis('AxisZ', new pc.Vec3(0, 0, length / 2), new pc.Vec3(thickness, thickness, length), new pc.Color(0, 0, 1));

        this.app.root.addChild(entity);
        this.axesEntity = entity;
    }

    // #WDD 2026-01-16 Restored for internal logic / verification
    private setupEventListeners() {

        // 1. Disable Right-Click Context Menu
        window.addEventListener('contextmenu', e => e.preventDefault());

        const openBtn = document.getElementById('open-file');
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const resetBtn = document.getElementById('reset-cam');
        const exportTimestampBtn = document.getElementById('export-timestamp'); // #WDD 2026-01-16

        openBtn?.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        resetBtn?.addEventListener('click', () => this.resetCamera());

        const startArBtn = document.getElementById('start-ar');
        const arSelect = document.getElementById('ar-camera-select') as HTMLSelectElement;

        // Populate Cameras
        let isPopulatingCameras = false;
        const populateCameras = async () => {
            // Only populate if not already populated (beyond placeholder)
            if (!arSelect || arSelect.options.length > 1) return;
            // #WDD 2026-01-18 Fix: Prevent concurrent camera population
            if (isPopulatingCameras) return;

            isPopulatingCameras = true;
            try {
                const devices = await this.arHandler.getCameraDevices();

                // Double check after await in case another process somehow intervened (unlikely with flag but safe)
                // #WDD 2026-01-19: Clear existing options (keep placeholder at index 0) before populating to avoid duplicates
                while (arSelect.options.length > 1) {
                    arSelect.remove(1);
                }

                devices.forEach((d, i) => {
                    const opt = document.createElement('option');
                    opt.value = d.deviceId;
                    opt.text = d.label || `Camera ${i + 1}`;
                    arSelect.appendChild(opt);
                });
            } finally {
                isPopulatingCameras = false;
            }
        };

        // Populate only on explicit interaction (click) to avoid random camera light activation
        // startArBtn?.addEventListener('mouseenter', populateCameras);
        // arSelect?.addEventListener('mouseenter', populateCameras);

        arSelect?.addEventListener('click', populateCameras); // For mobile/touch

        startArBtn?.addEventListener('click', async () => {
            await populateCameras(); // Ensure populated before start if clicked rapidly

            // #WDD 2026-01-19: Update button state AFTER AR action completes
            if (this.arHandler.isARRunning) {
                this.arHandler.stop();
                this.updateToggleButton(startArBtn, false);
            } else {
                const deviceId = arSelect?.value;
                // If placeholder selected, pass undefined (default)
                await this.arHandler.start(deviceId || undefined);
                this.updateToggleButton(startArBtn, this.arHandler.isARRunning);
            }
        });

        // Handle Select Change
        arSelect?.addEventListener('change', () => {
            if (this.arHandler.isARRunning) {
                this.arHandler.stop();
                this.arHandler.start(arSelect.value).then(() => {
                    this.updateToggleButton(startArBtn, true);
                    updateSettingsUI(); // Refresh settings for new camera
                });
            } else {
                this.arHandler.start(arSelect.value).then(() => {
                    this.updateToggleButton(startArBtn, true);
                    updateSettingsUI();
                });
            }
        });

        // #WDD 2026-01-18 Settings UI Logic
        const settingsBtn = document.getElementById('ar-settings-btn');
        const settingsPanel = document.getElementById('ar-settings-panel');
        const closeSettingsBtn = document.getElementById('close-ar-settings');
        const settingsContent = document.getElementById('ar-settings-content');

        const updateSettingsUI = () => {
            if (!settingsContent) return;
            settingsContent.innerHTML = '';

            if (!this.arHandler.isARRunning) {
                settingsContent.innerHTML = '<div class="text-gray-500 italic text-center">Start AR to edit settings</div>';
                return;
            }

            const caps = this.arHandler.getCapabilities();
            const settings = this.arHandler.getSettings();

            if (!caps || !settings) {
                settingsContent.innerHTML = '<div class="text-gray-500 italic text-center">No capabilities available</div>';
                return;
            }

            // Helper to create slider
            const createSlider = (label: string, key: string, min: number, max: number, step: number, value: number) => {
                const div = document.createElement('div');
                div.className = 'flex flex-col mb-2';
                div.innerHTML = `
                    <div class="flex justify-between">
                        <label class="text-gray-400 capitalize">${label}</label>
                        <span class="text-gray-300 ml-2" id="val-${key}">${value}</span>
                    </div>
                    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" class="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer slider-thumb">
                `;
                const input = div.querySelector('input')!;
                const valSpan = div.querySelector(`#val-${key}`)!;

                input.addEventListener('input', (e) => {
                    const val = parseFloat((e.target as HTMLInputElement).value);
                    valSpan.textContent = val.toString();
                    this.arHandler.applyConstraints({ [key]: val });
                });
                return div;
            };

            // brightness
            // @ts-ignore
            if (caps.brightness) {
                // @ts-ignore
                settingsContent.appendChild(createSlider('Brightness', 'brightness', caps.brightness.min, caps.brightness.max, caps.brightness.step, settings.brightness));
            }
            // contrast
            // @ts-ignore
            if (caps.contrast) {
                // @ts-ignore
                settingsContent.appendChild(createSlider('Contrast', 'contrast', caps.contrast.min, caps.contrast.max, caps.contrast.step, settings.contrast));
            }
            // exposureCompensation
            // @ts-ignore
            if (caps.exposureCompensation) {
                // @ts-ignore
                settingsContent.appendChild(createSlider('Exposure', 'exposureCompensation', caps.exposureCompensation.min, caps.exposureCompensation.max, caps.exposureCompensation.step, settings.exposureCompensation));
            }

            if (settingsContent.children.length === 0) {
                settingsContent.innerHTML = '<div class="text-gray-500 italic text-center">Camera supports no adjustable settings</div>';
            }
        };

        settingsBtn?.addEventListener('click', () => {
            settingsPanel?.classList.toggle('hidden');
            if (!settingsPanel?.classList.contains('hidden')) {
                updateSettingsUI();
            }
        });

        closeSettingsBtn?.addEventListener('click', () => {
            settingsPanel?.classList.add('hidden');
        });

        // #WDD 2026-01-19 导出按钮直接导出 SOG4 文件
        const exportBtn = document.getElementById('export-file');
        exportBtn?.addEventListener('click', () => {
            this.saveAsSOG4();
        });
        const sidebar = document.getElementById('sidebar');
        const playbar = document.getElementById('playbar-container');
        const selectionToolbar = document.getElementById('selection-toolbar');

        const toggleUI = document.getElementById('toggle-ui');
        const headerBrand = document.getElementById('header-brand');

        const doToggle = () => this.toggleUIVisibility();


        toggleUI?.addEventListener('click', doToggle);

        const simplePrev = document.getElementById('simple-prev');
        const simpleNext = document.getElementById('simple-next');
        const simplePlay = document.getElementById('simple-play-pause');
        const simpleToggleUI = document.getElementById('simple-toggle-ui');

        simplePrev?.addEventListener('click', () => {
            if (this.cameraPresets.length === 0) return;
            let nextIdx = this.currentPresetIndex - 1;
            if (nextIdx < 0) nextIdx = this.cameraPresets.length - 1;
            this.jumpToPreset(nextIdx);
        });
        simpleNext?.addEventListener('click', () => {
            if (this.cameraPresets.length === 0) return;
            let nextIdx = this.currentPresetIndex + 1;
            if (nextIdx >= this.cameraPresets.length) nextIdx = 0;
            this.jumpToPreset(nextIdx);
        });
        simplePlay?.addEventListener('click', () => this.togglePlay());
        simpleToggleUI?.addEventListener('click', doToggle);

        // --- Double Click to Toggle UI ---
        window.addEventListener('dblclick', (e) => {
            const target = e.target as HTMLElement;
            // Only toggle if we double-click on the canvas or background, not on UI panels
            const isUIPanel = target.closest('.glass-blue') ||
                target.closest('.ui-playbar') ||
                target.closest('#selection-toolbar') ||
                target.closest('header') ||
                target.closest('#loading-overlay') ||
                target.closest('#simplified-panel');

            if (!isUIPanel) {
                // #WDD 2026-01-21 Lock double click on mobile
                if (!this.isMobile) {
                    this.toggleUIVisibility();
                }
            }
        });

        // Listen to Grid/Axes toggles in main index.html
        const btnGrid = document.getElementById('toggle-grid');
        const btnAxes = document.getElementById('toggle-axes');

        btnGrid?.addEventListener('click', () => {
            if (this.gridEntity) this.gridEntity.enabled = !this.gridEntity.enabled;
            this.updateToggleButton(btnGrid, this.gridEntity?.enabled ?? false);
        });

        btnAxes?.addEventListener('click', () => {
            if (this.axesEntity) this.axesEntity.enabled = !this.axesEntity.enabled;
            this.updateToggleButton(btnAxes, this.axesEntity?.enabled ?? false);
        });

        // Init Button States
        if (btnGrid) this.updateToggleButton(btnGrid, this.gridEntity?.enabled ?? false);
        if (btnAxes) this.updateToggleButton(btnAxes, this.axesEntity?.enabled ?? false);

        const dropZone = document.getElementById('drop-zone');
        const dropMsg = document.getElementById('drop-msg');

        window.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone?.classList.add('active');
            if (dropMsg) dropMsg.style.opacity = '0.5';
        });
        window.addEventListener('dragleave', () => {
            dropZone?.classList.remove('active');
            if (dropMsg) dropMsg.style.opacity = '0.1';
        });
        window.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone?.classList.remove('active');
            if (dropMsg) dropMsg.style.opacity = '0.1';
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) this.loadFile(files[0]);
        });

        const updateObjectTransform = () => {
            if (!this.splatEntity) return;
            const px = parseFloat((document.getElementById('pos-x') as HTMLInputElement).value) || 0;
            const py = parseFloat((document.getElementById('pos-y') as HTMLInputElement).value) || 0;
            const pz = parseFloat((document.getElementById('pos-z') as HTMLInputElement).value) || 0;
            const rx = parseFloat((document.getElementById('rot-x') as HTMLInputElement).value) || 0;
            const ry = parseFloat((document.getElementById('rot-y') as HTMLInputElement).value) || 0;
            const rz = parseFloat((document.getElementById('rot-z') as HTMLInputElement).value) || 0;

            this.splatEntity.setPosition(px, py, pz);
            this.splatEntity.setEulerAngles(rx, ry, rz);

            // Save to cache on every update (manual input or scrub)
            if (this.currentFileName) {
                this.saveTransformToCache(this.currentFileName);
            }
        };

        // --- View Presets ---
        document.getElementById('view-top')?.addEventListener('click', () => {
            if (!this.camera) return;
            this.camera.setPosition(0, 5, 0);
            this.camera.setEulerAngles(-90, 0, 0);
            this.pitch = -90; this.yaw = 0;
        });

        // --- Custom Debug Toggle (K Key) #WDD 2026-01-15 ---
        window.addEventListener('keydown', (e) => {
            if (e.key === 'k' || e.key === 'K') {
                this.swizzleMode = (this.swizzleMode + 1) % 3;
                console.log(`[Debug] Switched Swizzle Mode to: ${this.swizzleMode} (0=yzwx, 1=xyzw, 2=wxyz)`);

                if (this.splatEntity?.gsplat) {
                    const instance = (this.splatEntity.gsplat as any).instance;
                    if (instance && instance.material) {
                        instance.material.setParameter('uSwizzleMode', this.swizzleMode);
                        instance.material.update();
                    }
                }
            }
            if (e.key === 'l' || e.key === 'L') {
                // Log Texture debug info
                console.log("--- Texture Debug Info ---");
                if (this.splatEntity?.gsplat) {
                    const instance = (this.splatEntity.gsplat as any).instance;
                    // We can't easily read GPU texture back here without async, but we can check sizes
                    // Actually we logged sizes during load.
                }
            }
        });

        document.getElementById('view-front')?.addEventListener('click', () => {
            if (!this.camera) return;
            this.camera.setPosition(0, 0, 5);
            this.camera.setEulerAngles(0, 0, 0);
            this.pitch = 0; this.yaw = 0;
        });
        document.getElementById('view-side')?.addEventListener('click', () => {
            if (!this.camera) return;
            this.camera.setPosition(5, 0, 0);
            this.camera.setEulerAngles(0, 90, 0);
            this.pitch = 0; this.yaw = 90;
        });

        // --- Themes ---
        const themeBtn = document.getElementById('toggle-theme');
        let currentTheme = 'dark';

        // --- Transition Effect Toggle #WDD 2026-01-15 ---
        const transitionBtn = document.getElementById('toggle-transition-effect');
        transitionBtn?.addEventListener('click', () => {
            this.effects.isEnabled = !this.effects.isEnabled;
            this.updateToggleButton(transitionBtn, this.effects.isEnabled);
        });
        if (transitionBtn) this.updateToggleButton(transitionBtn, this.effects.isEnabled);

        const updateTheme = (theme: string) => {
            currentTheme = theme;
            if (this.camera?.camera) {
                if (theme === 'light') {
                    this.camera.camera.clearColor = new pc.Color(0.95, 0.96, 0.98, 1);
                    document.body.classList.add('theme-light');
                } else {
                    this.camera.camera.clearColor = new pc.Color(0.1, 0.1, 0.1, 1);
                    document.body.classList.remove('theme-light');
                }
                // Keep the button 'active' (highlighted) to match other tools in the panel
                if (themeBtn) this.updateToggleButton(themeBtn, true);
            }
        };

        // Initialize state: make it active (green) by default to match Grid/Axes
        if (themeBtn) this.updateToggleButton(themeBtn, true);

        themeBtn?.addEventListener('click', () => {
            updateTheme(currentTheme === 'dark' ? 'light' : 'dark');
        });

        const fpsItems = document.querySelectorAll('.fps-item');
        fpsItems.forEach(item => {
            item.addEventListener('click', () => {
                const val = (item as HTMLElement).dataset.value;
                if (val) {
                    this.fps = parseInt(val);
                    // Update active state
                    fpsItems.forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                }
            });
        });

        const playBtn = document.getElementById('play-pause');
        const timeSlider = document.getElementById('time-slider') as HTMLInputElement;
        const timeLabel = document.getElementById('time-label');

        playBtn?.addEventListener('click', () => this.togglePlay());

        let isScrubbing = false;

        timeSlider?.addEventListener('mousedown', () => { isScrubbing = true; });
        timeSlider?.addEventListener('mouseup', () => { isScrubbing = false; });
        timeSlider?.addEventListener('touchstart', () => { isScrubbing = true; });
        timeSlider?.addEventListener('touchend', () => { isScrubbing = false; });

        // Ensure slider has fine granularity for dragging
        if (timeSlider) timeSlider.step = "0.01";

        timeSlider?.addEventListener('input', () => {
            // When scrubbing, we explicitly set currentTime
            this.currentTime = parseFloat(timeSlider.value);
            const total = Math.ceil(this.duration);
            if (timeLabel) timeLabel.innerText = `${Math.floor(this.currentTime)} / ${total}`;

            // Immediate visual update
            if (this.splatEntity?.gsplat) {
                (this.splatEntity.gsplat as any).time = Math.floor(this.currentTime);
            }
        });

        // Close text edit when clicking anywhere outside
        window.addEventListener('mousedown', (e) => {
            const panel = document.getElementById('text-edit-panel');
            if (panel && panel.classList.contains('show')) {
                const target = e.target as HTMLElement;
                const isOverlay = target.closest('#text-overlay-container');
                const isPanel = target.closest('#text-edit-panel');
                const isPresetBtn = target.closest('.add-text');

                if (!isOverlay && !isPanel && !isPresetBtn) {
                    this.closeTextEdit();
                }
            }
        });

        // --- Interaction & Keyboard ---
        let isLMB = false;
        let isRMB = false;
        const lastMousePos = new pc.Vec2();
        const keys: Record<string, boolean> = {};
        let isUIInteracting = false;
        let isHoveringUI = false; // #WDD 2026-01-15 Tracking hover state separately

        // Block camera when mouse is over UI panels
        // #WDD 2026-01-15 Added 'control-panel' to the list to cover the entire right area
        // #WDD 2026-01-19 Added all UI panels to strictly block camera control
        const uiPanels = [
            'sidebar',
            'control-panel',
            'time-controls',
            'header-brand',
            'selection-toolbar',
            'text-edit-panel',
            'simplified-panel',
            'samples-dropdown',
            'loading-overlay'
        ];
        uiPanels.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('mouseenter', () => { isHoveringUI = true; });
            el.addEventListener('mouseleave', () => { isHoveringUI = false; });
            el.addEventListener('mousedown', (e) => {
                isHoveringUI = true; // Extra safety
                e.stopPropagation();
            });
            el.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: false }); // #WDD 2026-01-19 Block scroll explicitly
            el.addEventListener('touchstart', (e) => {
                isHoveringUI = true;
                // Don't stop propagation if we want the actual touch event to reach children (like buttons)
                // but we want to prevent the camera from moving.
            }, { passive: true });
        });

        window.addEventListener('mouseup', () => {
            isLMB = false;
            isRMB = false;
            // #WDD 2026-01-15 Removed reset here as it was breaking camera lock when mouse is still over UI
            // if (!activeScrubInput) isUIInteracting = false; 
            document.body.style.cursor = 'default';
        });

        // --- Scrub Logic (Drag to change) ---
        let activeScrubInput: HTMLInputElement | null = null;
        let scrubStartX = 0;
        let scrubStartVal = 0;

        ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z'].forEach(id => {
            const input = document.getElementById(id) as HTMLInputElement;
            if (!input) return;

            input.addEventListener('input', updateObjectTransform);

            input.addEventListener('mousedown', (e) => {
                activeScrubInput = input;
                isUIInteracting = true;
                scrubStartX = e.clientX;
                scrubStartVal = parseFloat(input.value) || 0;
                document.body.style.cursor = 'ew-resize';
                input.select();
                e.stopPropagation(); // Avoid sidebar mousedown interference
            });

            input.addEventListener('touchstart', (e) => {
                activeScrubInput = input;
                isUIInteracting = true;
                scrubStartX = e.touches[0].clientX;
                scrubStartVal = parseFloat(input.value) || 0;
                input.select();
                e.stopPropagation();
            }, { passive: true });
        });

        const handleMove = (clientX: number) => {
            if (!activeScrubInput) return;
            isUIInteracting = true;
            const delta = clientX - scrubStartX;
            const step = activeScrubInput.id.startsWith('rot') ? 1 : 0.05;
            const newVal = scrubStartVal + delta * step;

            activeScrubInput.value = activeScrubInput.id.startsWith('rot')
                ? Math.round(newVal).toString()
                : newVal.toFixed(2);

            updateObjectTransform();
        };

        window.addEventListener('mousemove', (e) => handleMove(e.clientX));
        window.addEventListener('touchmove', (e) => {
            if (activeScrubInput) {
                handleMove(e.touches[0].clientX);
                if (e.cancelable) e.preventDefault(); // Prevent scrolling while scrubbing
            }
        }, { passive: false });

        window.addEventListener('keydown', (e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

            if (e.key.toLowerCase() === 'h') {
                this.toggleUIVisibility();
            }
            if (e.key === ' ') {
                e.preventDefault();
                this.togglePlay();
            }
            // #WDD 2026-01-16 'e' key removed
        });

        const handleEnd = () => {
            if (activeScrubInput) {
                activeScrubInput = null;
                isUIInteracting = false;
                document.body.style.cursor = 'default';
            }
        };

        window.addEventListener('mouseup', handleEnd);
        window.addEventListener('touchend', handleEnd);

        // Initialize rotation state from default camera
        this.pitch = 0;
        this.yaw = 0;

        window.addEventListener('keydown', (e) => {
            if (isUIInteracting || isHoveringUI) return; // #WDD 2026-01-15 Also check hover
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

            keys[e.code] = true;
            if (e.code === 'Space') {
                e.preventDefault();
                this.togglePlay();
            }
            if (e.code === 'Escape') {
                if (this.selectionTool && this.selectionTool.currentTool !== 'none') {
                    this.selectionTool.setTool('none');
                }
            }
        });
        window.addEventListener('keyup', (e) => { keys[e.code] = false; });

        this.app.mouse.on(pc.EVENT_MOUSEDOWN, (e: any) => {
            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (isUIInteracting || isHoveringUI || isEditing) return; // #WDD 2026-01-15 Also check hover
            if (e.button === pc.MOUSEBUTTON_LEFT) isLMB = true;
            if (e.button === pc.MOUSEBUTTON_RIGHT) isRMB = true;
            lastMousePos.set(e.x, e.y);
        });

        this.app.mouse.on(pc.EVENT_MOUSEMOVE, (e: pc.MouseEvent) => {
            // #WDD 2026-01-18 Lock Camera in AR
            if (this.arHandler && this.arHandler.isARRunning) return;

            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (!this.camera || isUIInteracting || isHoveringUI || isEditing || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return; // #WDD 2026-01-15 Also check hover

            // #WDD 2026-01-21 Simplified Mode: Orbit Camera (Mouse)
            // 模式修正: 摄像机围绕原点(0,0,0)在球面上移动 (Orbit)
            if (this.isUIHidden()) {
                if (isLMB && this.camera) {
                    const dx = e.x - lastMousePos.x;
                    const dy = e.y - lastMousePos.y;
                    const sens = 0.2;

                    const pos = this.camera.getPosition();
                    const dist = pos.length();

                    // Yaw: Rotate position around World UP (Y)
                    const qYaw = new pc.Quat().setFromAxisAngle(pc.Vec3.UP, -dx * sens);
                    qYaw.transformVector(pos, pos);
                    this.camera.setPosition(pos);
                    this.camera.lookAt(pc.Vec3.ZERO); // Update orientation to refresh Right vector

                    // Pitch: Rotate position around Camera Right
                    const qPitch = new pc.Quat().setFromAxisAngle(this.camera.right, -dy * sens);
                    qPitch.transformVector(pos, pos);

                    // Re-normalize to ensure spherical surface
                    pos.normalize();
                    pos.mulScalar(dist);

                    this.camera.setPosition(pos);
                    this.camera.lookAt(pc.Vec3.ZERO);

                    // Sync internal state to avoid jumps on mode switch
                    const eu = this.camera.getEulerAngles();
                    this.pitch = eu.x;
                    this.yaw = eu.y;
                }
                lastMousePos.set(e.x, e.y);
                return;
            }

            const dx = e.x - lastMousePos.x;
            const dy = e.y - lastMousePos.y;

            if (isLMB) {
                this.yaw -= dx * 0.2;
                this.pitch -= dy * 0.2;
                this.pitch = Math.max(-89, Math.min(89, this.pitch));
                this.camera.setEulerAngles(this.pitch, this.yaw, 0);
            } else if (isRMB) {
                this.camera.translateLocal(-dx * 0.01, dy * 0.01, 0);
            }
            lastMousePos.set(e.x, e.y);
        });

        // Zoom logic #WDD 2026-01-15
        this.app.mouse.on(pc.EVENT_MOUSEWHEEL, (e: any) => {
            // #WDD 2026-01-18 Lock Camera in AR
            if (this.arHandler && this.arHandler.isARRunning) return;

            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (this.camera && !isUIInteracting && !isEditing && (!this.selectionTool || this.selectionTool.currentTool === 'none'))
                this.camera.translateLocal(0, 0, -e.wheel * 0.5);
        });

        // --- Touch Support ---
        let lastTouchDistance = 0;
        let lastTouchPos = new pc.Vec2();
        let prevTouchCount = 0;

        this.app.touch.on(pc.EVENT_TOUCHSTART, (e: any) => {
            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (isUIInteracting || isEditing || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return;

            prevTouchCount = e.touches.length;

            if (e.touches.length === 1) {
                lastMousePos.set(e.touches[0].x, e.touches[0].y);
            } else if (e.touches.length === 2) {
                const t0 = e.touches[0];
                const t1 = e.touches[1];
                lastTouchDistance = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                lastTouchPos.set((t0.x + t1.x) / 2, (t0.y + t1.y) / 2);
            }
        });

        this.app.touch.on(pc.EVENT_TOUCHMOVE, (e: any) => {
            // #WDD 2026-01-18 Lock Camera in AR
            if (this.arHandler && this.arHandler.isARRunning) return;

            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (!this.camera || isUIInteracting || isEditing || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return;
            // e.event.preventDefault(); // Managed by PlayCanvas TouchDevice usually, but good for safety

            // Detect touch count change (switch between single/multi touch) and reset anchors
            if (e.touches.length !== prevTouchCount) {
                prevTouchCount = e.touches.length;
                if (e.touches.length === 1) {
                    lastMousePos.set(e.touches[0].x, e.touches[0].y);
                } else if (e.touches.length === 2) {
                    const t0 = e.touches[0];
                    const t1 = e.touches[1];
                    lastTouchDistance = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                    lastTouchPos.set((t0.x + t1.x) / 2, (t0.y + t1.y) / 2);
                }
                return; // Skip movement this frame to avoid jumps
            }

            // #WDD 2026-01-21 Simplified Mode: Orbit Camera (Touch)
            // 模式修正: 摄像机围绕原点(0,0,0)在球面上移动 (Orbit)
            if (this.isUIHidden()) {
                if (e.touches.length === 1 && this.camera) {
                    const t = e.touches[0];
                    const dx = t.x - lastMousePos.x;
                    const dy = t.y - lastMousePos.y;
                    const sens = 0.2;

                    const pos = this.camera.getPosition();
                    const dist = pos.length();

                    // Yaw
                    const qYaw = new pc.Quat().setFromAxisAngle(pc.Vec3.UP, -dx * sens);
                    qYaw.transformVector(pos, pos);
                    this.camera.setPosition(pos);
                    this.camera.lookAt(pc.Vec3.ZERO);

                    // Pitch
                    const qPitch = new pc.Quat().setFromAxisAngle(this.camera.right, -dy * sens);
                    qPitch.transformVector(pos, pos);

                    pos.normalize();
                    pos.mulScalar(dist);

                    this.camera.setPosition(pos);
                    this.camera.lookAt(pc.Vec3.ZERO);

                    const eu = this.camera.getEulerAngles();
                    this.pitch = eu.x;
                    this.yaw = eu.y;

                    lastMousePos.set(t.x, t.y);
                } else if (e.touches.length === 2 && this.camera) {
                    // Keep Zoom for convenience
                    const t0 = e.touches[0];
                    const t1 = e.touches[1];

                    // Pinch to Zoom
                    const dist = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                    const deltaDist = dist - lastTouchDistance;
                    this.camera.translateLocal(0, 0, -deltaDist * 0.02);
                    lastTouchDistance = dist;
                    // Disable Pan
                }
                return;
            }

            if (e.touches.length === 1) {
                const t = e.touches[0];
                const dx = t.x - lastMousePos.x;
                const dy = t.y - lastMousePos.y;
                this.yaw -= dx * 0.2;
                this.pitch -= dy * 0.2;
                this.pitch = Math.max(-89, Math.min(89, this.pitch));
                this.camera.setEulerAngles(this.pitch, this.yaw, 0);
                lastMousePos.set(t.x, t.y);
            } else if (e.touches.length === 2) {
                const t0 = e.touches[0];
                const t1 = e.touches[1];

                // Pinch to Zoom
                const dist = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                const deltaDist = dist - lastTouchDistance;
                this.camera.translateLocal(0, 0, -deltaDist * 0.02); // Faster zoom for touch
                lastTouchDistance = dist;

                // Two-finger Pan
                const midX = (t0.x + t1.x) / 2;
                const midY = (t0.y + t1.y) / 2;
                const dx = midX - lastTouchPos.x;
                const dy = midY - lastTouchPos.y;
                this.camera.translateLocal(-dx * 0.01, dy * 0.01, 0);
                lastTouchPos.set(midX, midY);
            }
        });

        this.app.touch.on(pc.EVENT_TOUCHEND, (e: pc.TouchEvent) => {
            // Update count, but rely on TOUCHMOVE to reset anchors if needed
            // If we reset here, TOUCHMOVE sees "same count" and might jump if coordinates shifted
            // If we don't reset here, TOUCHMOVE sees "diff count" and triggers the guard.
            // However, updating the count is good practice for state tracking.
            // Let's NOT update prevTouchCount here, to force TOUCHMOVE to detect the mismatch.
            // But if we stop touching completely (count 0), we should probably know.
            if (e.touches.length === 0) {
                prevTouchCount = 0;
            }
        });

        this.app.on('update', (dt: number) => {
            // #WDD 2026-01-15 Update text visibility based on camera proximity
            this.updateTextVisibility();

            // Smooth Camera Animation
            if (this.isCameraAnimating && this.camera) {
                this.animProgress += dt / 1.0; // Transition speed: 1.0 second total #WDD 2026-01-15
                if (this.animProgress >= 1) {
                    this.animProgress = 1;
                    this.isCameraAnimating = false;
                    // Resume playback if it was playing before #WDD 2026-01-15
                    if (this.wasPlayingBeforeAnim) {
                        this.togglePlay();
                        this.wasPlayingBeforeAnim = false;
                    }
                }

                // Ease out cubic
                const t = 1 - Math.pow(1 - this.animProgress, 3);

                const currentPos = new pc.Vec3().lerp(this.animStartPos, this.animTargetPos, t);
                const currentPitch = pc.math.lerp(this.animStartPitch, this.animTargetPitch, t);
                const currentYaw = pc.math.lerp(this.animStartYaw, this.animTargetYaw, t);

                this.camera.setPosition(currentPos);
                this.camera.setEulerAngles(currentPitch, currentYaw, 0);
                this.pitch = currentPitch;
                this.yaw = currentYaw;

                // Update Transition Effect #WDD 2026-01-15
                const material = (this.splatEntity?.gsplat as any)?.instance?.material;
                if (material) {
                    material.setParameter('uTime', this.currentTime); // Ensure uTime is also updated
                    this.effects.update(this.animProgress, material);
                }
            } else {
                // Ensure effect is reset when not animating
                const material = (this.splatEntity?.gsplat as any)?.instance?.material;
                if (material) {
                    this.effects.reset(material);
                }
            }

            // WASD Camera Movement - blocked only if we are actively scrubbing or focused on UI
            const activeEl = document.activeElement as HTMLElement;
            const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);

            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            // #WDD 2026-01-18 Lock Camera in AR (Added isARRunning check)
            if (this.camera && !isUIInteracting && !isHoveringUI && !isEditing && !this.isCameraAnimating && !isTyping && !(this.arHandler && this.arHandler.isARRunning)) {
                const speed = dt * 5;
                if (keys['KeyW']) this.camera.translateLocal(0, 0, -speed);
                if (keys['KeyS']) this.camera.translateLocal(0, 0, speed);
                if (keys['KeyA']) this.camera.translateLocal(-speed, 0, 0);
                if (keys['KeyD']) this.camera.translateLocal(speed, 0, 0);
                if (keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD']) {
                    // Sync overlays on manual move too? Maybe not every frame, but proximity needs it.
                }
                if (keys['KeyQ']) this.camera.translateLocal(0, -speed, 0);
                if (keys['KeyE']) this.camera.translateLocal(0, speed, 0);
            }

            if (this.isPlaying) {
                // Use FPS-based playback
                this.currentTime += dt * this.fps;

                // Loop logic
                // Loop logic #WDD 2026-01-16
                // If total frames is 50, indices are 0..49. Duration is 50 (count).
                // We should loop when we hit the last frame index.
                const maxTime = Math.max(0, this.duration - 1.0);
                if (this.currentTime > maxTime) {
                    this.currentTime = 0;
                }

                // For UI, we floor to closest frame
                const displayFrame = Math.floor(this.currentTime);
                // #WDD 2026-01-16 Fix: Display 0 to N-1
                const total = Math.max(0, Math.ceil(this.duration) - 1); // Duration is roughly max frame index or count

                // Only auto-update slider if user is NOT scrubbing
                if (timeSlider && !isScrubbing) {
                    timeSlider.value = displayFrame.toString();
                }
                if (timeLabel) timeLabel.innerText = `${displayFrame} / ${total}`;

                if (this.splatEntity?.gsplat) {
                    const material = (this.splatEntity.gsplat as any).instance.material;
                    if (material) {
                        const shaderTime = Math.floor(this.currentTime); // #WDD 2026-01-18: Integer time
                        material.setParameter('uTime', shaderTime);
                        material.setParameter('uGlobalTotalFrames', this.duration);
                    }
                }
            } else {
                // Also update on scrub
                if (this.splatEntity?.gsplat) {
                    const material = (this.splatEntity.gsplat as any).instance.material;
                    if (material) {
                        const shaderTime = Math.floor(this.currentTime); // #WDD 2026-01-18: Integer time
                        material.setParameter('uTime', shaderTime);
                        material.setParameter('uGlobalTotalFrames', this.duration);
                    }
                }
            }
        });

        // --- Samples Dropdown ---
        const toggleSamples = document.getElementById('toggle-samples');
        const samplesDropdown = document.getElementById('samples-dropdown');

        toggleSamples?.addEventListener('click', (e) => {
            samplesDropdown?.classList.toggle('hidden');
            toggleSamples.classList.toggle('open');
            e.stopPropagation();
        });

        window.addEventListener('click', (e) => {
            if (!samplesDropdown?.contains(e.target as Node)) {
                samplesDropdown?.classList.add('hidden');
                toggleSamples?.classList.remove('open');
            }
        });

        const initSamples = async () => {
            if (!samplesDropdown) return;
            try {
                const response = await fetch('./samples.json');
                if (!response.ok) return;
                const samples = await response.json() as { name: string, url: string }[];

                // Clear existing
                samplesDropdown.innerHTML = '';

                samples.forEach(sample => {
                    const btn = document.createElement('button');
                    btn.className = 'sample-item ui-item group';
                    btn.dataset.url = sample.url;
                    btn.innerHTML = `
                        <div class="ui-dot"></div>
                        <span class="text-[10px] ui-text-primary font-medium">${sample.name}</span>
                    `;
                    btn.addEventListener('click', () => {
                        this.loadSampleFile(sample.url);
                        samplesDropdown?.classList.add('hidden');
                        toggleSamples?.classList.remove('open');
                    });
                    samplesDropdown.appendChild(btn);
                });
            } catch (err) {
                console.warn('Failed to load samples.json', err);
            }
        };

        initSamples();

        // --- Camera Presets ---
        const addPresetBtn = document.getElementById('add-preset');
        const clearPresetsBtn = document.getElementById('clear-presets');

        this.renderPresets();
        addPresetBtn?.addEventListener('click', () => {
            if (!this.camera) return;
            this.cameraPresets.push({
                name: `CAM_${this.cameraPresets.length + 1}`,
                pos: this.camera.getPosition().clone(),
                pitch: this.pitch,
                yaw: this.yaw
            });
            this.renderPresets();
        });

        clearPresetsBtn?.addEventListener('click', () => {
            if (confirm('Clear all presets?')) {
                this.cameraPresets = [];
                this.renderPresets();
            }
        });
    }

    private renderPresets() {
        const presetsList = document.getElementById('presets-list');
        if (!presetsList) return;
        presetsList.innerHTML = '';
        this.cameraPresets.forEach((preset, index) => {
            const item = document.createElement('div');
            item.className = 'flex flex-col gap-1';

            const mainRow = document.createElement('div');
            mainRow.className = 'ui-item group justify-between py-1.5 px-2 cursor-grab active:cursor-grabbing';
            mainRow.setAttribute('draggable', 'true');
            mainRow.dataset.index = index.toString();

            mainRow.innerHTML = `
                <div class="flex items-center gap-2 overflow-hidden flex-1 cursor-pointer justify-between">
                    <div class="flex items-center gap-2 overflow-hidden">
                        <div class="ui-dot"></div>
                        <span class="preset-name text-[9px] ui-text-primary font-medium truncate">${preset.name}</span>
                    </div>
                    <svg viewBox="0 0 24 24" class="w-3 h-3 fill-current opacity-40 flex-shrink-0">
                        <path d="M7 10l5 5 5-5z"/>
                    </svg>
                </div>
                <div class="flex items-center gap-1">
                    <button class="add-text p-1 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:ui-text-highlight transition-all has-tooltip" aria-label="Add Text">
                        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                    </button>
                    <button class="delete-preset p-1 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-red-400 transition-all">
                        <svg viewBox="0 0 24 24" class="w-3 h-3 fill-current"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
            `;

            // --- Text Objects List for this preset #WDD 2026-01-15 ---
            const textObjectsList = document.createElement('div');
            textObjectsList.className = 'flex flex-col gap-0.5 ml-6 mb-1';
            if (preset.textObjects && preset.textObjects.length > 0) {
                preset.textObjects.forEach((textObj) => {
                    const textItem = document.createElement('div');
                    textItem.className = 'flex items-center justify-between group/text hover:bg-white/5 rounded px-1.5 py-0.5 cursor-pointer';
                    textItem.innerHTML = `
                        <span class="text-[8px] opacity-40 group-hover/text:opacity-100 truncate flex-1">${textObj.content || '(Empty)'}</span>
                        <button class="delete-text p-0.5 opacity-0 group-hover/text:opacity-60 hover:!opacity-100 hover:text-red-400 transition-all">
                             <svg viewBox="0 0 24 24" class="w-2.5 h-2.5 fill-current"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </button>
                    `;
                    textItem.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openTextEdit(textObj, index);
                    });
                    textItem.querySelector('.delete-text')?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        preset.textObjects = preset.textObjects?.filter(t => t.id !== textObj.id);
                        this.renderPresets();
                        this.syncTextOverlays();
                    });
                    textObjectsList.appendChild(textItem);
                });
            }

            item.appendChild(mainRow);
            item.appendChild(textObjectsList);

            // --- Rename Logic ---
            const nameSpan = mainRow.querySelector('.preset-name') as HTMLElement;
            nameSpan.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'text';
                input.value = preset.name;
                input.className = 'bg-black/50 border-none outline-none text-[9px] w-full ui-text-highlight px-1 rounded';

                const finishEdit = () => {
                    const newName = input.value.trim() || `CAM_${index + 1}`;
                    preset.name = newName;
                    this.renderPresets();
                };

                input.addEventListener('blur', finishEdit);
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') finishEdit();
                    if (e.key === 'Escape') this.renderPresets();
                });

                nameSpan.replaceWith(input);
                input.focus();
                input.select();
            });

            // --- Drag and Drop Logic ---
            mainRow.addEventListener('dragstart', (e) => {
                if (e.dataTransfer) {
                    e.dataTransfer.setData('text/plain', index.toString());
                    mainRow.classList.add('opacity-40');
                }
            });

            mainRow.addEventListener('dragend', () => {
                mainRow.classList.remove('opacity-40');
            });

            mainRow.addEventListener('dragover', (e) => {
                e.preventDefault();
                mainRow.classList.add('bg-white/5');
            });

            mainRow.addEventListener('dragleave', () => {
                mainRow.classList.remove('bg-white/5');
            });

            mainRow.addEventListener('drop', (e) => {
                e.preventDefault();
                mainRow.classList.remove('bg-white/5');
                const sourceIdx = parseInt(e.dataTransfer?.getData('text/plain') || '-1');
                if (sourceIdx !== -1 && sourceIdx !== index) {
                    const movedItem = this.cameraPresets.splice(sourceIdx, 1)[0];
                    this.cameraPresets.splice(index, 0, movedItem);
                    this.renderPresets();
                }
            });

            // Jump to preset
            mainRow.querySelector('.flex')?.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).tagName === 'INPUT') return;

                if (!this.camera) return;

                // --- Stop playback during animation #WDD 2026-01-15 ---
                this.wasPlayingBeforeAnim = this.isPlaying;
                if (this.isPlaying) {
                    this.togglePlay();
                }

                this.isCameraAnimating = true;
                this.animProgress = 0;
                this.animStartPos.copy(this.camera.getPosition());
                this.animStartPitch = this.pitch;
                this.animStartYaw = this.yaw;

                this.animTargetPos.copy(preset.pos);
                this.animTargetPitch = preset.pitch;
                this.animTargetYaw = preset.yaw;
            });

            // Add Text
            mainRow.querySelector('.add-text')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.addTextToPreset(index);
            });

            // Delete preset
            mainRow.querySelector('.delete-preset')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cameraPresets.splice(index, 1);
                this.renderPresets();
                this.syncTextOverlays();
            });

            presetsList.appendChild(item);
        });
    }

    // --- Text Object Management Methods #WDD 2026-01-15 ---

    private addTextToPreset(index: number) {
        const preset = this.cameraPresets[index];
        if (!preset.textObjects) preset.textObjects = [];

        const id = `text_${Date.now()}`;
        const newText = {
            id: id,
            content: "New Annotation",
            font: "'Inter', sans-serif",
            fontSize: 24,
            color: "#ffffff",
            fontWeight: "normal",
            fontStyle: "normal",
            top: 50,
            left: 50
        };

        preset.textObjects.push(newText);
        this.renderPresets();
        this.syncTextOverlays();
        this.openTextEdit(newText, index);
    }

    private openTextEdit(textObj: any, presetIndex: number) {
        this.activeTextId = textObj.id;
        const panel = document.getElementById('text-edit-panel');
        const contentArea = document.getElementById('text-edit-content') as HTMLTextAreaElement;
        const sizeSelect = document.getElementById('text-edit-size') as HTMLSelectElement;
        const colorInput = document.getElementById('text-edit-color') as HTMLInputElement;
        const fontSelect = document.getElementById('text-edit-font') as HTMLSelectElement;

        if (!panel || !contentArea || !sizeSelect || !colorInput || !fontSelect) return;

        contentArea.value = textObj.content;
        sizeSelect.value = textObj.fontSize.toString();
        colorInput.value = textObj.color;
        fontSelect.value = textObj.font;

        const boldBtn = document.getElementById('text-bold');
        const italicBtn = document.getElementById('text-italic');

        const updateStyleToggle = () => {
            if (boldBtn) boldBtn.classList.toggle('ui-text-highlight', textObj.fontWeight === 'bold');
            if (italicBtn) italicBtn.classList.toggle('ui-text-highlight', textObj.fontStyle === 'italic');
        };
        updateStyleToggle();

        panel.classList.add('show');

        // --- Dynamic Positioning near text obj #WDD 2026-01-15 ---
        const textEl = this.textOverlays.get(textObj.id);
        if (textEl) {
            const rect = textEl.getBoundingClientRect();
            let top = rect.bottom + 10;
            let left = rect.left;

            // Constrain to window
            const panelWidth = 288; // w-72
            const panelHeight = panel.offsetHeight || 300;
            if (left + panelWidth > window.innerWidth) left = window.innerWidth - panelWidth - 20;
            if (top + panelHeight > window.innerHeight) top = rect.top - panelHeight - 10;
            if (left < 10) left = 10;
            if (top < 10) top = 10;

            panel.style.top = `${top}px`;
            panel.style.left = `${left}px`;
            panel.style.bottom = 'auto'; // Override fixed bottom if any
            panel.style.right = 'auto';  // Override fixed right if any
            panel.style.transform = 'scale(1)'; // Ensure scale is 1
        }

        // --- Make Panel Draggable #WDD 2026-01-15 ---
        const header = panel.querySelector('.flex.items-center.justify-between');
        if (header) {
            (header as HTMLElement).style.cursor = 'move';
            let isDragging = false;
            let startX = 0, startY = 0;
            let initialTop = 0, initialLeft = 0;

            const onMouseDown = (e: MouseEvent) => {
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                initialTop = panel.offsetTop;
                initialLeft = panel.offsetLeft;
                e.preventDefault();
            };

            const onMouseMove = (e: MouseEvent) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                panel.style.top = `${initialTop + dy}px`;
                panel.style.left = `${initialLeft + dx}px`;
            };

            const onMouseUp = () => { isDragging = false; };

            header.addEventListener('mousedown', onMouseDown as any);
            window.addEventListener('mousemove', onMouseMove as any);
            window.addEventListener('mouseup', onMouseUp as any);
        }

        // Update handlers
        const updateText = () => {
            if (this.activeTextId !== textObj.id) return;
            textObj.content = contentArea.value;
            textObj.fontSize = parseInt(sizeSelect.value) || 24;
            textObj.color = colorInput.value;
            textObj.font = fontSelect.value;

            this.renderPresets();
            this.syncTextOverlays();
        };

        contentArea.oninput = updateText;
        sizeSelect.onchange = updateText;
        colorInput.oninput = updateText;
        fontSelect.onchange = updateText;

        if (boldBtn) {
            boldBtn.onclick = () => {
                textObj.fontWeight = textObj.fontWeight === 'bold' ? 'normal' : 'bold';
                updateStyleToggle();
                updateText();
            };
        }
        if (italicBtn) {
            italicBtn.onclick = () => {
                textObj.fontStyle = textObj.fontStyle === 'italic' ? 'normal' : 'italic';
                updateStyleToggle();
                updateText();
            };
        }

        const deleteBtn = document.getElementById('delete-text-obj');
        if (deleteBtn) {
            deleteBtn.onclick = () => {
                const preset = this.cameraPresets[presetIndex];
                preset.textObjects = preset.textObjects?.filter(t => t.id !== textObj.id);
                this.closeTextEdit();
                this.renderPresets();
                this.syncTextOverlays();
            };
        }
    }

    private closeTextEdit() {
        this.activeTextId = null;
        document.getElementById('text-edit-panel')?.classList.remove('show');
    }

    private syncTextOverlays() {
        const container = document.getElementById('text-overlay-container');
        if (!container) return;

        // Collect all text objects across all presets
        const allTextObjects: { text: any, preset: any }[] = [];
        this.cameraPresets.forEach(preset => {
            if (preset.textObjects) {
                preset.textObjects.forEach(t => allTextObjects.push({ text: t, preset }));
            }
        });

        // Remove old ones that no longer exist
        this.textOverlays.forEach((el, id) => {
            if (!allTextObjects.find(o => o.text.id === id)) {
                el.remove();
                this.textOverlays.delete(id);
            }
        });

        // Create or update
        allTextObjects.forEach(({ text, preset }) => {
            let el = this.textOverlays.get(text.id);
            if (!el) {
                el = document.createElement('div');
                el.className = 'text-object';
                el.id = text.id;
                container.appendChild(el);
                this.textOverlays.set(text.id, el);

                // Make draggable in screen space
                let isDragging = false;
                el.addEventListener('mousedown', (e) => {
                    isDragging = true;
                    this.openTextEdit(text, this.cameraPresets.indexOf(preset));
                    e.stopPropagation();
                });
                window.addEventListener('mousemove', (e) => {
                    if (isDragging && el) {
                        const top = (e.clientY / window.innerHeight) * 100;
                        const left = (e.clientX / window.innerWidth) * 100;
                        text.top = top;
                        text.left = left;
                        el.style.top = `${top}%`;
                        el.style.left = `${left}%`;
                    }
                });
                window.addEventListener('mouseup', () => { isDragging = false; });
            }

            el.innerText = text.content;
            el.style.fontFamily = text.font;
            el.style.fontSize = `${text.fontSize}px`;
            el.style.color = text.color;
            el.style.fontWeight = text.fontWeight;
            el.style.fontStyle = text.fontStyle;
            el.style.top = `${text.top}%`;
            el.style.left = `${text.left}%`;

            if (this.activeTextId === text.id) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
    }

    private updateTextVisibility() {
        if (!this.camera) return;
        const camPos = this.camera.getPosition();

        this.cameraPresets.forEach(preset => {
            if (!preset.textObjects) return;

            // Distance-based fade #WDD 2026-01-15
            const dist = camPos.distance(preset.pos);
            const fadeStart = 0.5;
            const fadeEnd = 3.0;
            let opacity = 1.0 - (dist - fadeStart) / (fadeEnd - fadeStart);
            opacity = Math.max(0, Math.min(1, opacity));

            preset.textObjects.forEach(textObj => {
                const el = this.textOverlays.get(textObj.id);
                if (el) {
                    el.style.opacity = opacity.toString();
                    el.style.pointerEvents = opacity > 0.1 ? 'auto' : 'none';
                    el.style.display = opacity > 0 ? 'block' : 'none';
                }
            });
        });
    }

    private togglePlay() {
        this.isPlaying = !this.isPlaying;
        const playBtn = document.getElementById('play-pause');
        const simplePlayBtn = document.getElementById('simple-play-pause');

        const icon = this.isPlaying
            ? '<svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
            : '<svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M8 5v14l11-7z"/></svg>';

        const simpleIcon = this.isPlaying
            ? '<svg viewBox="0 0 24 24" class="w-6 h-6 fill-current"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
            : '<svg viewBox="0 0 24 24" class="w-6 h-6 fill-current"><path d="M8 5v14l11-7z"/></svg>';

        if (playBtn) playBtn.innerHTML = icon;
        if (simplePlayBtn) simplePlayBtn.innerHTML = simpleIcon;
    }

    private jumpToPreset(index: number) {
        if (index < 0 || index >= this.cameraPresets.length) return;
        this.currentPresetIndex = index;
        const preset = this.cameraPresets[index];
        if (!this.camera) return;

        // --- Stop playback during animation #WDD 2026-01-15 ---
        this.wasPlayingBeforeAnim = this.isPlaying;
        if (this.isPlaying) {
            this.togglePlay();
        }

        this.isCameraAnimating = true;
        this.animProgress = 0;
        this.animStartPos.copy(this.camera.getPosition());
        this.animStartPitch = this.pitch;
        this.animStartYaw = this.yaw;

        this.animTargetPos.copy(preset.pos);
        this.animTargetPitch = preset.pitch;
        this.animTargetYaw = preset.yaw;
    }

    private isUIHidden() {
        const sidebar = document.getElementById('sidebar');
        return sidebar?.classList.contains('sidebar-hidden');
    }

    private toggleUIVisibility(forceHidden?: boolean) {


        const sidebar = document.getElementById('sidebar');
        const playbar = document.getElementById('playbar-container');
        const selectionToolbar = document.getElementById('selection-toolbar');
        const controlPanel = document.getElementById('control-panel');
        const simplifiedPanel = document.getElementById('simplified-panel');

        const shouldHide = forceHidden !== undefined ? forceHidden : !this.isUIHidden();

        // #WDD 2026-01-21 Lock UI on mobile (prevent showing)
        if (this.isMobile && !shouldHide) {
            return;
        }

        if (shouldHide) {
            sidebar?.classList.add('sidebar-hidden');
            playbar?.classList.add('bottom-bar-hidden');
            selectionToolbar?.classList.add('tools-hidden');
            controlPanel?.classList.add('panel-hidden');
            simplifiedPanel?.classList.remove('hidden-panel');

            // #WDD 2026-01-21 Hide Grid/Axes in Simplified Mode
            if (this.gridEntity) this.gridEntity.enabled = false;
            if (this.axesEntity) this.axesEntity.enabled = false;
        } else {
            sidebar?.classList.remove('sidebar-hidden');
            playbar?.classList.remove('bottom-bar-hidden');
            selectionToolbar?.classList.remove('tools-hidden');
            controlPanel?.classList.remove('panel-hidden');
            simplifiedPanel?.classList.add('hidden-panel');

            // #WDD 2026-01-21 Restore Grid/Axes based on UI state
            const btnGrid = document.getElementById('toggle-grid');
            const btnAxes = document.getElementById('toggle-axes');
            if (this.gridEntity && btnGrid) this.gridEntity.enabled = btnGrid.classList.contains('active');
            if (this.axesEntity && btnAxes) this.axesEntity.enabled = btnAxes.classList.contains('active');
        }
    }

    private async loadSampleFile(url: string) {
        const filename = url.split('/').pop() || 'sample.truesplats';

        // Initial setup for the UI through a dummy call to loadFile's initial logic
        // We'll manually trigger the overlay since loadFile happens AFTER download
        const overlay = document.getElementById('loading-overlay');
        const status = document.getElementById('loading-status');
        const detail = document.getElementById('loading-detail');
        const stepProgress = document.getElementById('loading-step-progress');
        const stepSquares = document.querySelectorAll('.step-square');

        const updateDownloadProgress = (p: number, s: string, d?: string) => {
            if (overlay) overlay.classList.remove('hidden');
            if (status) status.innerText = s;
            if (detail && d) detail.innerText = d;

            if (stepProgress) {
                // Map 0-100% download to the first segment (Step 0 to Step 1)
                const percentage = (p / 100) * (1 / (stepSquares.length - 1)) * 100;
                stepProgress.style.width = `${percentage}%`;
            }

            stepSquares.forEach((sq, idx) => {
                if (idx === 0) (sq as HTMLElement).classList.add('reached');
            });
        };

        try {
            updateDownloadProgress(0, "DOWNLOADING", filename);

            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch ${url}`);

            const contentLength = response.headers.get('content-length');
            const total = contentLength ? parseInt(contentLength, 10) : 0;

            if (total === 0) {
                // Fallback if no content-length
                const blob = await response.blob();
                const file = new File([blob], filename, { type: 'application/octet-stream' });
                this.loadFile(file);
                return;
            }

            const reader = response.body!.getReader();
            let loaded = 0;
            const chunks: Uint8Array[] = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                chunks.push(value);
                loaded += value.length;

                const percent = Math.round((loaded / total) * 100);
                const sizeMB = (loaded / (1024 * 1024)).toFixed(1);
                const totalMB = (total / (1024 * 1024)).toFixed(1);
                updateDownloadProgress(percent, "DOWNLOADING", `${filename} (${sizeMB}MB / ${totalMB}MB)`);
            }

            const blob = new Blob(chunks as any[]);
            const file = new File([blob], filename, { type: 'application/octet-stream' });

            this.loadFile(file);
        } catch (error) {
            console.error('Error loading sample file:', error);
            alert('Failed to load sample file.');
            if (overlay) overlay.classList.add('hidden');
        }
    }

    private handleFileSelect(e: Event) {
        const input = e.target as HTMLInputElement;
        if (input.files && input.files.length > 0) this.loadFile(input.files[0]);
    }

    private async loadFile(file: File) {
        // If on small screen (phone/tablet), auto-hide UI to simplified mode
        if (window.innerWidth < 1024) {
            this.toggleUIVisibility(true);
        }

        const name = file.name.toLowerCase();
        if (!name.endsWith('.truesplats') && !name.endsWith('.sog4') && !name.endsWith('.ply') && !name.endsWith('.ply4')) {
            alert('Please drop a .truesplats, .sog4, .ply, or .ply4 file');
            return;
        }

        console.log(`[Viewer] Loading file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

        const overlay = document.getElementById('loading-overlay');
        const status = document.getElementById('loading-status');
        const detail = document.getElementById('loading-detail');
        const stepProgress = document.getElementById('loading-step-progress');
        const stepSquares = document.querySelectorAll('.step-square');

        const setProgress = (stepIndex: number, s: string, d?: string) => {
            if (overlay) overlay.classList.remove('hidden');
            if (status) status.innerText = s;
            if (detail && d) detail.innerText = d || "";

            // 1. Update Line Progress immediately to the current point
            if (stepProgress) {
                const percentage = (stepIndex / (stepSquares.length - 1)) * 100;
                stepProgress.style.width = `${percentage}%`;
            }

            // 2. Highlight only squares that are reached by the line
            stepSquares.forEach((sq, idx) => {
                const element = sq as HTMLElement;
                if (idx <= stepIndex) {
                    element.classList.add('reached');
                } else {
                    element.classList.remove('reached');
                }
            });
        };

        setProgress(0, "PREPARING", file.name);

        // Update filename for caching
        this.currentFileName = file.name;

        if (this.splatEntity) this.splatEntity.destroy();
        this.cameraPresets = [];
        this.renderPresets();

        const scElem = document.getElementById('splat-count');
        if (scElem) scElem.innerText = "--";

        try {
            setProgress(9, "READY", "Processing Asset...");

            let parsed;
            let loader: any;
            const lowerName = file.name.toLowerCase();

            // #WDD 2026-01-19 Fix: Support both .sog and .sog4
            if (lowerName.endsWith('.sog4') || lowerName.endsWith('.sog')) {
                console.log("[Viewer] Using SOG4Loader for", file.name);
                loader = new SOG4Loader(this.app);
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress(Math.floor(p / 10), "LOADING", msg);
                });
            } else if (lowerName.endsWith('.truesplats')) {
                console.log("[Viewer] Using TrueSplatsLoader for", file.name);
                loader = new TrueSplatsLoader(this.app);
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress(Math.floor(p / 10), "LOADING", msg);
                });
            } else if (lowerName.endsWith('.ply4') || lowerName.endsWith('.ply')) {
                console.log("[Viewer] Using PLY4Loader for", file.name);
                loader = new PLY4Loader(); // #WDD 2026-01-21 Use PLY4Loader
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress(Math.floor(p / 10), "LOADING", msg);
                });
            } else {
                console.warn("[Viewer] Unknown extension, defaulting to TrueSplatsLoader:", file.name);
                loader = new TrueSplatsLoader(this.app);
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress(Math.floor(p / 10), "LOADING", msg);
                });
            }

            // #WDD 2026-01-16 DEBUG: Sort by Frame 20 - REMOVED
            // We rely on updateDynamicPositions now.


            if (parsed) {
                this.lastParsedData = parsed; // #WDD 2026-01-18 Fix: Persist loaded data
                const count = parsed.count;

                // #WDD 2026-01-16: Force Static Frame 0 for debugging
                const forceStatic = false;
                let elements = parsed.plyData.elements;
                if (forceStatic) {
                    console.log(`[Debug] Forcing Static Frame 0 Reconstruction (Verified getFrameElements Path)...`);
                    elements = loader.getFrameElements(0);
                }

                // TrueSplatsLoader returns a ready-to-use vertexElement in plyData
                let vertexElement = elements[0];

                // Instantiating GSplatData with the elements option correctly
                const splatData = new (pc.GSplatData as any)([vertexElement]);

                const resource = new pc.GSplatResource(this.app.graphicsDevice, splatData);

                const url = URL.createObjectURL(file);
                const asset = new pc.Asset(file.name, 'gsplat', { url: url });
                asset.resource = resource;
                asset.loaded = true;

                this.app.assets.add(asset);

                const entity = new pc.Entity('GSplat');
                entity.addComponent('gsplat', { asset: asset });

                // #WDD 2026-01-18 AR Compatibility: Robust Parenting
                let arScaleFactor = 1.0;

                // 1. Always add to Root first (World Origin)
                this.app.root.addChild(entity);

                // 2. If AR is running, move to Anchor
                if (this.arHandler && this.arHandler.isARRunning && this.arHandler.arAnchor) {
                    console.log("[Viewer] AR Active: Reparenting new Splat to AR Anchor");

                    // Reparent to Anchor.
                    // IMPORTANT: We want it to SNAP to the Anchor's position (the Marker), 
                    // not keep its world position (which is 0,0,0 / the Camera).
                    // So we use addChild (keeps local transform) if we were creating fresh, 
                    // but since we added to root, we `reparent`.
                    // Wait, `reparent` KEEPS World Position. If World was 0, it stays 0.
                    // We WANT it to go to the Marker. The Marker is at Anchor Pos.
                    // So we want Local Position to be (0,0,0).

                    this.arHandler.arAnchor.addChild(entity); // Start as child

                    // Reset Local Transform to Snap to Marker
                    entity.setLocalPosition(0, 0, 0);
                    entity.setLocalRotation(new pc.Quat().setFromEulerAngles(0, 0, 0));

                    // Normalize Scale Logic
                    const pScale = this.arHandler.arAnchor.getLocalScale().x;
                    console.log(`[Viewer] AR Anchor Scale: ${pScale}`);
                    if (pScale !== 0) {
                        arScaleFactor = 1.0 / pScale;
                        // #WDD 2026-01-18 Fix: Do NOT compensate Entity Scale. 
                        // We WANT it to inherit the 5x magnification. 
                        // Only compensate Position so it doesn't fly away.
                        // entity.setLocalScale(arScaleFactor, arScaleFactor, arScaleFactor); 
                    }
                }

                this.splatEntity = entity;

                // #WDD 2026-01-18: Restore Model Transform if present
                if (parsed.model_transform) {
                    const t = parsed.model_transform;
                    console.log("[TrueSplats] applying model_transform with arFactor for Pos:", arScaleFactor, t);

                    // Apply AR Compensation to Loaded Transform
                    // Compensate POS (multiply by 0.2) because Parent is scaled 5x. 5 * 0.2 = 1.0 (World Units maintained)
                    if (t.pos) entity.setLocalPosition(t.pos[0] * arScaleFactor, t.pos[1] * arScaleFactor, t.pos[2] * arScaleFactor);

                    if (t.rot) entity.setLocalRotation(new pc.Quat(t.rot[0], t.rot[1], t.rot[2], t.rot[3]));

                    // Do NOT compensate Scale. Let it inherit AR Scale (Magnified).
                    if (t.scale) entity.setLocalScale(t.scale[0], t.scale[1], t.scale[2]);
                } else {
                    console.log("[TrueSplats] No model_transform found. Using default 0,0,0 local.");
                }

                console.log("[Viewer] Final Entity World Pos:", entity.getPosition().toString());
                console.log("[Viewer] Final Entity World Scale:", entity.getLocalScale().toString());

                // #WDD 2026-01-18: Restore Camera Presets if present
                if (parsed.cameras && Array.isArray(parsed.cameras)) {
                    this.cameraPresets = parsed.cameras.map((c: any) => ({
                        name: c.name,
                        pos: new pc.Vec3(c.pos[0], c.pos[1], c.pos[2]),
                        pitch: c.pitch,
                        yaw: c.yaw,
                        textObjects: c.textObjects
                    }));
                    this.renderPresets(); // Ensure UI updates
                    console.log(`[TrueSplats] Restored \${this.cameraPresets.length} Camera Presets`);
                }

                setProgress(9, "READY", "System Update Complete");
                setTimeout(() => { if (overlay) overlay.classList.add('hidden'); }, 600);

                // Finalize
                this.updateStats(asset);
                this.updateStats(asset);
                this.updateTransformUIFromEntity(); // #WDD 2026-01-18: Sync UI with restored transform
                this.resetCamera();
                this.resetCamera();
                const container = document.getElementById('timeline-ticks');
                if (container) container.innerHTML = '';

                // Call legacy finalize to setup shaders
                // #WDD 2026-01-16
                this.finalizeGSplatLoad(asset, count, null, parsed.frames || parsed.maxMu || 100, parsed);
                return;
            }
        } catch (e) {
            console.error("Load Error:", e);
            alert("Error loading file: " + (e instanceof Error ? e.message : String(e)));
            if (overlay) overlay.classList.add('hidden');
        }
    }

    // #WDD 2026-01-17: Dynamic Sorting Update
    // #WDD 2026-01-17: Dynamic Sorting Update
    // #WDD 2026-01-17: Dynamic Sorting Update
    private updateDynamicPositions(time: number) {
        if (!this.posArrays || !this.trajectoryData || !this.is4DGS) return;
        if (!this.splatEntity || !this.splatEntity.gsplat) return;

        const K = this.keyframes;
        const stride = this.xyzStride;
        const traj = this.trajectoryData;
        const N = this.posArrays.x.length;

        // Calculate interpolation vars
        const idx = Math.floor(time / stride);
        const k0 = Math.min(Math.max(0, idx), K - 2);
        const k1 = k0 + 1;

        const t0 = k0 * stride;
        const t1 = k1 * stride;
        const ratio = Math.max(0, Math.min(1, (time - t0) / (t1 - t0)));

        const xArr = this.posArrays.x;
        const yArr = this.posArrays.y;
        const zArr = this.posArrays.z;

        // Optimized loop
        const origIndices = this.originalIndices;

        // #WDD 2026-01-17: Sync to Sorter
        const instance = (this.splatEntity.gsplat as any).instance;
        const centers = instance?.sorter?.centers;

        for (let i = 0; i < N; i++) {
            // If we have original indices (sorted -> original mapping), usage it.
            // Otherwise assume data is pre-sorted.
            const oidx = origIndices ? Math.round(origIndices[i]) : i;
            const base = oidx * K * 3;
            const b0 = base + k0 * 3;
            const b1 = base + k1 * 3;

            const x0 = traj[b0 + 0], y0 = traj[b0 + 1], z0 = traj[b0 + 2];
            const x1 = traj[b1 + 0], y1 = traj[b1 + 1], z1 = traj[b1 + 2];

            const nx = x0 + (x1 - x0) * ratio;
            const ny = y0 + (y1 - y0) * ratio;
            const nz = z0 + (z1 - z0) * ratio;

            xArr[i] = nx;
            yArr[i] = ny;
            zArr[i] = nz;

            if (centers) {
                centers[i * 3 + 0] = nx;
                centers[i * 3 + 1] = ny;
                centers[i * 3 + 2] = nz;
            }
        }

        // #WDD 2026-01-17: Force Worker Update
        // instance.sorter.centers is updated, but Worker has a stale copy.
        // We must send the new centers to the worker.
        if (centers && instance.sorter.worker) {
            // Important: varying checks to ensure stability
            // We MUST copy the buffer because sending it transfers ownership (detaches it),
            // which would crash the Main Thread on the next frame access.
            const centersCopy = new Float32Array(centers);
            instance.sorter.worker.postMessage({
                centers: centersCopy.buffer
            }, [centersCopy.buffer]);
        }

        // PlayCanvas's GSplat sorter reads these arrays (referenced by GSplatData) naturally 
        // when calculating depth, assuming it runs every frame.
    }


    private posArrays: { x: Float32Array, y: Float32Array, z: Float32Array } | null = null;

    private finalizeGSplatLoad(asset: pc.Asset, numSplats: number, plyData: any, originalFrames: number | null, parsed: any) {
        this.duration = originalFrames || (parsed ? (parsed.frames || parsed.maxMu) : 100) || 100;
        this.totalFrames = this.duration; // #WDD 2026-01-16: Keep sync
        this.originalFrames = originalFrames;
        this.lastParsedData = parsed;

        const splatData = (asset.resource as pc.GSplatResource).splatData;
        const overlay = document.getElementById('loading-overlay');

        console.log(`[Finalize] Splats: ${numSplats}, GSplatData Num: ${splatData.numSplats}`);

        const res = asset.resource as any;
        let width = Math.ceil(Math.sqrt(numSplats));
        if (res?.colorTexture) width = res.colorTexture.width;
        else if (res?.transformATexture) width = res.transformATexture.width;
        const height = Math.ceil(numSplats / width);

        // --- Cache Positions for Selection ---
        const x = splatData.getProp('x'), y = splatData.getProp('y'), z = splatData.getProp('z');
        if (x && y && z) {
            console.log(`[Debug] First 3 positions: (${x[0].toFixed(3)}, ${y[0].toFixed(3)}, ${z[0].toFixed(3)}), (${x[1].toFixed(3)}, ${y[1].toFixed(3)}, ${z[1].toFixed(3)}), (${x[2].toFixed(3)}, ${y[2].toFixed(3)}, ${z[2].toFixed(3)})`);
            const num = Math.min(splatData.numSplats, x.length, y.length, z.length);

            // #WDD 2026-01-17: Cache for Dynamic Sorting
            this.posArrays = { x: x as Float32Array, y: y as Float32Array, z: z as Float32Array };

            this.cachedPositions = new Float32Array(num * 3);
            for (let i = 0; i < num; i++) {
                this.cachedPositions[i * 3 + 0] = x[i];
                this.cachedPositions[i * 3 + 1] = y[i];
                this.cachedPositions[i * 3 + 2] = z[i];
            }
        }
        if (this.cachedPositions) this.selectionTool.init(this.cachedPositions.length / 3);

        const origIndices = splatData.getProp('original_index');
        this.originalIndices = origIndices ? (origIndices as Float32Array) : null; // #WDD 2026-01-17

        if (origIndices) {
            console.log(`[Finalize] Reordering Check: First Index=${origIndices[0]}, Last Index=${origIndices[numSplats - 1]}`);
            if (origIndices[0] !== 0) {
                console.log(`[Finalize] ALERT: Reordering Detected! Aligning trajectories...`);
            }
        }

        // --- Camera Presets ---
        if (parsed.cameras && parsed.cameras.length > 0) {
            this.cameraPresets = parsed.cameras.map((c: any) => ({
                name: c.name, pos: new pc.Vec3(c.pos[0], c.pos[1], c.pos[2]),
                pitch: c.pitch, yaw: c.yaw, textObjects: c.textObjects
            }));
            this.renderPresets();
            this.renderPresets();
            this.syncTextOverlays();
        }

        // #WDD 2026-01-18: Restore Deleted Splats
        if (parsed.deleted_indices && parsed.deleted_indices.length > 0) {
            console.log(`[Finalize] Restoring ${parsed.deleted_indices.length} deleted splats...`);
            this.selectionTool.restoreDeletedIndices(parsed.deleted_indices);
        }

        // --- Lifetime Texture ---
        // #WDD 2026-01-17 Restore LifeTexData population
        const mu = splatData.getProp('lifetime_mu');
        const w = splatData.getProp('lifetime_w');
        const kArr = splatData.getProp('lifetime_k');

        if (mu && w) {
            this.lifeTexData = new Float32Array(width * height * 4);
            for (let i = 0; i < numSplats; i++) {
                this.lifeTexData[i * 4 + 0] = mu[i];
                this.lifeTexData[i * 4 + 1] = w[i];
                this.lifeTexData[i * 4 + 2] = kArr ? kArr[i] : 10.0;
                this.lifeTexData[i * 4 + 3] = 0.0;
            }
        }

        let lifeTexture: pc.Texture | null = null;
        if (this.lifeTexData) {
            lifeTexture = new pc.Texture(this.app.graphicsDevice, {
                width, height, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'lifetimeTexture'
            });
            const dst = lifeTexture.lock();
            new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4).set(this.lifeTexData);
            lifeTexture.unlock();
        }

        // --- Trajectory Texture ---
        let trajectoryTexture: pc.Texture | null = null;

        // --- 4DGS Trajectory Texture ---
        if (parsed.trajectory) {
            this.is4DGS = true;
            this.trajectoryData = parsed.trajectory as Float32Array;
            this.keyframes = parsed.keyframes || 0;
            this.xyzStride = parsed.xyzStride || 1;

            const trajData = parsed.trajectory as Float32Array;
            const K = parsed.keyframes || 0;
            const texWidth = 4096;
            const totalPixels = numSplats * K;
            const texHeight = Math.ceil(totalPixels / texWidth);
            const texData = new Float32Array(texWidth * texHeight * 4);

            // #WDD 2026-01-16: Fix - Data is ALREADY SORTED in data.bin
            // #WDD 2026-01-17: Restore Reordering Logic if original_index exists
            const origIndices = splatData.getProp('original_index');

            for (let i = 0; i < numSplats; i++) {
                const oidx = origIndices ? Math.round(origIndices[i]) : i;

                for (let k = 0; k < K; k++) {
                    const srcOff = (oidx * K + k) * 3; // Source from Original Index (BIN)
                    const dstOff = (i * K + k) * 4;    // Destination to Sorted Index (Texture)

                    texData[dstOff + 0] = trajData[srcOff + 0];
                    texData[dstOff + 1] = trajData[srcOff + 1];
                    texData[dstOff + 2] = trajData[srcOff + 2];
                    texData[dstOff + 3] = 1.0;
                }
            }

            trajectoryTexture = new pc.Texture(this.app.graphicsDevice, {
                width: texWidth, height: texHeight, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'trajectoryTexture'
            });
            const dst = trajectoryTexture.lock();
            new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4).set(texData);
            trajectoryTexture.unlock();
        }


        // --- 4DGS Rotation Texture ---
        let rotationTexture: pc.Texture | null = null;
        if (parsed.rotTrajectory) {
            this.rotTrajectoryData = parsed.rotTrajectory as Float32Array;
            this.rotKeyframes = parsed.rotKeyframes || 0;
            this.rotStride = parsed.rotStride || 1;

            const rotData = parsed.rotTrajectory as Float32Array;
            const Kvar = parsed.rotKeyframes || 0;
            const texWidth = 4096;
            const totalPixels = numSplats * Kvar;
            const texHeight = Math.ceil(totalPixels / texWidth);
            const texData = new Float32Array(texWidth * texHeight * 4);

            // #WDD 2026-01-16: Standardize to [x, y, z, w] with reorder alignment
            const origIndices = splatData.getProp('original_index');
            if (origIndices) {
                console.log(`[Debug] 'original_index' detected. First 5: ${origIndices.slice(0, 5).join(', ')}`);
            } else {
                console.log("[Debug] No 'original_index' property found. Assuming data is linear/pre-sorted.");
            }

            for (let i = 0; i < numSplats; i++) {
                // If original_index exists, use it to lookup trajectory from the RAW/Unsorted BIN
                // If BIN was sorted same as PLY, this would not be needed.
                // But typically 4DGS BINs are often unsorted.
                const oidx = origIndices ? Math.round(origIndices[i]) : i;

                for (let k = 0; k < Kvar; k++) {
                    const srcOff = (oidx * Kvar + k) * 4; // Source from Original Index (BIN)
                    const dstOff = (i * Kvar + k) * 4;    // Destination to Sorted Index (Texture)

                    texData[dstOff + 0] = rotData[srcOff + 1]; // x
                    texData[dstOff + 1] = rotData[srcOff + 2]; // y
                    texData[dstOff + 2] = rotData[srcOff + 3]; // z
                    texData[dstOff + 3] = rotData[srcOff + 0]; // w
                }
            }

            // DEBUG: Compare Static vs Dynamic Rotation for Point 0
            const r0 = splatData.getProp('rot_0');
            const r1 = splatData.getProp('rot_1');
            const r2 = splatData.getProp('rot_2');
            const r3 = splatData.getProp('rot_3');
            if (r0 && r1 && r2 && r3 && this.rotTrajectoryData) {
                const i = 0;
                const staticRot = [r0[i], r1[i], r2[i], r3[i]];
                const dynRot = [this.rotTrajectoryData[0], this.rotTrajectoryData[1], this.rotTrajectoryData[2], this.rotTrajectoryData[3]];
                const texRot = [texData[0], texData[1], texData[2], texData[3]];
                console.log(`[Debug] Point 0 Rotation Comparison:`);
                console.log(`  Static (PLY): [${staticRot.map(v => v.toFixed(3))}]`);
                console.log(`  Dynamic (BIN): [${dynRot.map(v => v.toFixed(3))}]`);
                console.log(`  Texture (XYZW): [${texRot.map(v => v.toFixed(3))}]`);
            }

            rotationTexture = new pc.Texture(this.app.graphicsDevice, {
                width: texWidth, height: texHeight, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'rotationTexture'
            });
            const dst = rotationTexture.lock();
            new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4).set(texData);
            rotationTexture.unlock();
        }


        // --- Scales Texture (for dynamic rotation reconstruction) ---
        let scalesTexture: pc.Texture | null = null;
        const s0 = splatData.getProp('scale_0');
        const s1 = splatData.getProp('scale_1');
        const s2 = splatData.getProp('scale_2');
        if (s0 && s1 && s2) {
            const texData = new Float32Array(width * height * 4);
            for (let i = 0; i < splatData.numSplats; i++) {
                texData[i * 4 + 0] = s0[i];
                texData[i * 4 + 1] = s1[i];
                texData[i * 4 + 2] = s2[i];
                texData[i * 4 + 3] = 0.0;
            }
            this.scalesTexData = texData;
            scalesTexture = new pc.Texture(this.app.graphicsDevice, {
                width, height, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'scalesTexture'
            });
            const dst = scalesTexture.lock();
            new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4).set(texData);
            scalesTexture.unlock();
        }

        if (this.splatEntity?.gsplat) {
            this.setupLifetimeShader(
                (this.splatEntity.gsplat as any).instance,
                lifeTexture,
                trajectoryTexture, parsed.keyframes,
                rotationTexture, parsed.rotKeyframes,
                this.duration, // #WDD 2026-01-16 Use calculated duration
                scalesTexture,
                parsed.bands || 3 // #WDD 2026-01-16
            );
        }

        // #WDD 2026-01-19: Robustly persist parsed data for export
        if (parsed) {
            console.log("[Viewer] Persisting parsed data for export (finalize). isSOG4:", parsed.isSOG4);
            this.lastParsedData = parsed;
        }

        this.updateToggleButton(document.getElementById('mode-default') as HTMLElement, true);
        this.updateToggleButton(document.getElementById('mode-selection') as HTMLElement, false);

        // #WDD 2026-01-17 Restore Slider Logic
        const slider = (document.getElementById('time-slider') as HTMLInputElement);
        const maxIdx = Math.max(0, Math.ceil(this.duration) - 1);
        if (slider) {
            slider.max = maxIdx.toString();
            slider.step = "0.1";
            slider.value = "0";
        }
        this.updateTimelineTicks(this.duration);
        const timeLabel = document.getElementById('time-label');
        if (timeLabel) timeLabel.innerText = `0 / ${maxIdx}`;

        setTimeout(() => { if (overlay) overlay.classList.add('hidden'); }, 600);
        this.updateStats(asset);

        if (parsed.model_transform) {
            // #WDD 2026-01-19: Embedded transform takes precedence over cache
            console.log("[Viewer] Finalize: Respecting embedded model_transform, skipping cache.");
            this.updateTransformUIFromEntity();
        } else if (parsed.pose) {
            if (this.splatEntity) {
                this.splatEntity.setPosition(parseFloat(parsed.pose.px), parseFloat(parsed.pose.py), parseFloat(parsed.pose.pz));
                this.splatEntity.setEulerAngles(parseFloat(parsed.pose.rx), parseFloat(parsed.pose.ry), parseFloat(parsed.pose.rz));
                ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z'].forEach(id => {
                    const el = (document.getElementById(id) as HTMLInputElement);
                    if (el) el.value = parsed.pose[id.replace('-', '')];
                });
            }
        } else if (this.currentFileName) {
            this.loadCachedTransform(this.currentFileName);
        } else {
            this.resetObjectTransformUI();
        }
    }











    private async setupLifetimeShader(
        instance: any,
        lifetimeTexture: pc.Texture | null,
        trajectoryTexture: pc.Texture | null = null,
        keyframes: number = 0,
        rotationTexture: pc.Texture | null = null,
        rotKeyframes: number = 0,
        totalFrames: number = 0,
        scalesTexture: pc.Texture | null = null,
        bands: number = 0 // #WDD 2026-01-16
    ) {
        console.log(`[Shader] Setting up Lifetime Shader with duration: ${totalFrames}`, { lifetimeTexture, trajectoryTexture, rotationTexture, scalesTexture, bands });

        const material = instance.material;
        material.setParameter('uTime', 0.0);
        material.setParameter('uTransitionFactor', 0.0);
        material.setParameter('uSwizzleMode', this.swizzleMode); // #WDD 2026-01-15 Init

        if (lifetimeTexture) {
            material.setParameter('lifetimeTexture', lifetimeTexture);
        }

        if (totalFrames > 0) {
            material.setParameter('uGlobalTotalFrames', totalFrames);
        }

        if (trajectoryTexture) {
            material.setParameter('uTrajectoryTexture', trajectoryTexture);
            material.setParameter('uKeyframes', keyframes);
            material.setParameter('uGlobalTotalFrames', totalFrames); // #WDD 2026-01-16 Use passed totalFrames
            material.setParameter('uXYZStride', this.xyzStride);
            material.setParameter('uRotKeyframes', this.rotKeyframes);
            material.setParameter('uRotStride', this.rotStride);
        }

        if (rotationTexture) {
            material.setParameter('uRotationTexture', rotationTexture);
            material.setParameter('uRotKeyframes', rotKeyframes);
        }

        if (scalesTexture) {
            material.setParameter('uScalesTexture', scalesTexture);
        }

        if (totalFrames > 0) material.setParameter('uGlobalTotalFrames', totalFrames);

        // --- ROBUST SHADER INJECTION ---

        const originalGetShaderVariant = material.getShaderVariant;

        material.getShaderVariant = function (device: any, scene: any, defs: any, unused: any, pass: any, sortedLights: any, viewUniformFormat: any, viewBindGroupFormat: any) {

            const library = device.getProgramLibrary();
            const originalGetProgram = library.getProgram;

            library.getProgram = function (name: string, options: any, processingOptions: any) {
                if (name === 'splat') {
                    console.log("[ShaderInject] Intercepted 'splat' shader generation.");

                    // We must bypass the original generator's concatenation because it uses a broken splatCoreVS.
                    // Instead, we construct the full shader here using our FIXED core and mains.

                    // 1. Prepare Defines
                    if (!options.defines) options.defines = [];
                    if (lifetimeTexture) {
                        console.log("[ShaderInject] Defining USE_LIFETIME_TEXTURE");
                        if (!options.defines.includes('USE_LIFETIME_TEXTURE')) options.defines.push('USE_LIFETIME_TEXTURE');
                    }
                    if (trajectoryTexture) {
                        if (!options.defines.includes('USE_TRAJECTORY')) options.defines.push('USE_TRAJECTORY');
                    }
                    if (rotationTexture) {
                        if (!options.defines.includes('USE_ROTATION')) options.defines.push('USE_ROTATION');
                    }

                    // #WDD 2026-01-16 Dynamically set SH bands
                    if (bands >= 1) {
                        if (!options.defines.includes('USE_SH1')) options.defines.push('USE_SH1');
                    }
                    if (bands >= 2) {
                        if (!options.defines.includes('USE_SH2')) options.defines.push('USE_SH2');
                    }
                    if (bands >= 3) {
                        if (!options.defines.includes('USE_SH3')) options.defines.push('USE_SH3');
                    }

                    // Check for other standard options usually passed
                    // e.g. DITHER_NONE, TONEMAP...
                    // For simplicity, we assume standard defines are handled or we append standard chunks if needed.
                    // But 'splatMainPS' is self-contained for now. 
                    // If we want dithering/tonemapping, we'd need to import chunks or add them to splatMainPS.
                    // Let's assume the user wants the raw splatMainPS provided.


                    const defines = options.defines.map((d: string) => `#define ${d}`).join('\n') + '\n';

                    const version = "#version 300 es\n";

                    // 2. Construct Codes
                    // splatCoreVS is the FIXED core with helper functions
                    // splatMainVS is the main() function
                    const vsCode = version + defines + splatCoreVS + splatMainVS;

                    // PS: For now, strict splatMainPS. 
                    // PS needs precision for GLSL 300 es unless provided by chunks, but we act standalone.
                    const fsCode = version + defines + "precision mediump float;\n" + splatMainPS;

                    // 3. Create Definition directly (Bypassing generator)
                    const shaderDefinition = {
                        attributes: {
                            vertex_position: pc.SEMANTIC_POSITION,
                            vertex_id_attrib: pc.SEMANTIC_ATTR13
                        },
                        vshader: vsCode,
                        fshader: fsCode
                    };
                    return new pc.Shader(device, shaderDefinition);
                }
                return originalGetProgram.call(this, name, options, processingOptions);
            };

            const result = originalGetShaderVariant.apply(this, arguments);
            library.getProgram = originalGetProgram;
            return result;
        };

        // Force update
        if ((material as any).clearVariants) {
            (material as any).clearVariants();
        }
        material.update();
    }




    private updateTimelineTicks(duration: number) {
        const container = document.getElementById('timeline-ticks');
        if (!container) return;
        container.innerHTML = '';

        // #WDD 2026-01-16 Fix: Ticks up to N-1
        const maxFrame = Math.max(0, Math.ceil(duration) - 1);
        // Determine step size to keep UI clean
        let step = 1;
        if (maxFrame > 20) step = 5;
        if (maxFrame > 50) step = 10;
        if (maxFrame > 100) step = 20; // e.g. 0, 20, 40...

        for (let i = 0; i <= maxFrame; i += step) {
            // Ensure we don't overflow too much if duration isn't exact multiple, but standard loops cover it.
            // Create tick element
            const tick = document.createElement('div');
            tick.className = 'flex flex-col items-center';
            tick.innerHTML = `
                <div class="tick-mark"></div>
                <div class="tick-label">${i}</div>
            `;
            container.appendChild(tick);
        }
    }

    private resetObjectTransformUI() {
        ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z'].forEach(id => {
            const input = document.getElementById(id) as HTMLInputElement;
            if (input) input.value = "0";
        });
    }

    // Updated loadPointCloud to accept entity parent if needed, but signature changed above.
    // We'll fix call site.
    // private createPointCloud... Removed


    public updateSelectionUniform(tex: pc.Texture) {
        if (this.splatEntity?.gsplat) {
            const instance = (this.splatEntity.gsplat as any).instance;
            if (instance && instance.material) {
                instance.material.setParameter('selectionTexture', tex);
                instance.material.update();
            }
        }
    }

    public updateSelectionModeParams(isSelecting: boolean) {
        if (this.splatEntity?.gsplat) {
            const instance = (this.splatEntity.gsplat as any).instance;
            if (instance && instance.material) {
                instance.material.setParameter('isSelectionMode', isSelecting ? 1.0 : 0.0);
                instance.material.update();
            }
        }
    }





    private resetCamera() {
        if (!this.camera) return;
        // #WDD 2026-01-18 Skip reset if AR is running to maintain alignment
        if (this.arHandler && this.arHandler.isARRunning) return;

        if (this.cameraPresets.length > 0) {
            const first = this.cameraPresets[0];
            this.camera.setPosition(first.pos);
            this.pitch = first.pitch;
            this.yaw = first.yaw;
            this.camera.setLocalEulerAngles(this.pitch, this.yaw, 0);
        } else {
            this.camera.setPosition(0, 1, 5);
            this.camera.setEulerAngles(0, 0, 0);
            this.pitch = 0;
            this.yaw = 0;
        }
    }

    private updateStats(asset: pc.Asset) {
        if (!asset || !asset.resource) return;
        const resource = asset.resource as pc.GSplatResource;
        const splatData = resource.splatData;
        if (!splatData) return;

        const splatCountElem = document.getElementById('splat-count');
        if (splatCountElem) {
            // Use local format for better readability (e.g., 1,234,567)
            splatCountElem.innerText = splatData.numSplats.toLocaleString();
        }
    }

    private onUpdate(dt: number) {
        if (this.arHandler) this.arHandler.update();

        this.fpsCounter++;
        this.fpsTimer += dt;
        if (this.fpsTimer >= 1) {
            const fpsElem = document.getElementById('fps-display');
            if (fpsElem) fpsElem.innerText = Math.round(this.fpsCounter).toString();
            this.fpsCounter = 0;
            this.fpsTimer = 0;
        }

        // #WDD 2026-01-17: Handle Playback
        if (this.isPlaying) {
            this.currentTime += dt * 10.0; // 10 FPS for 4DGS usually sufficient, can tune
            if (this.currentTime >= this.duration) {
                this.currentTime = 0;
            }

            // Sync UI
            const slider = document.getElementById('time-slider') as HTMLInputElement;
            if (slider) slider.value = this.currentTime.toString();

            const timeLabel = document.getElementById('time-label');
            const maxIdx = Math.max(0, Math.ceil(this.duration) - 1);
            if (timeLabel) timeLabel.innerText = `${Math.floor(this.currentTime)} / ${maxIdx}`;

            // Sync Shader
            if (this.splatEntity?.gsplat) {
                (this.splatEntity.gsplat as any).time = Math.floor(this.currentTime);
            }
        }

        // #WDD 2026-01-17: Dynamic Sorting - Update CPU positions
        if (this.is4DGS && this.trajectoryData) {
            this.updateDynamicPositions(this.currentTime);
        }
    }

    private loadCachedTransform(fileName: string) {
        try {
            const cachedKey = `transform_cache_${fileName}`;
            const cachedData = localStorage.getItem(cachedKey);

            if (cachedData) {
                const data = JSON.parse(cachedData); // { px, py, pz, rx, ry, rz }

                // Update Inputs
                const posX = document.getElementById('pos-x') as HTMLInputElement;
                const posY = document.getElementById('pos-y') as HTMLInputElement;
                const posZ = document.getElementById('pos-z') as HTMLInputElement;
                const rotX = document.getElementById('rot-x') as HTMLInputElement;
                const rotY = document.getElementById('rot-y') as HTMLInputElement;
                const rotZ = document.getElementById('rot-z') as HTMLInputElement;

                if (posX) posX.value = data.px;
                if (posY) posY.value = data.py;
                if (posZ) posZ.value = data.pz;
                if (rotX) rotX.value = data.rx;
                if (rotY) rotY.value = data.ry;
                if (rotZ) rotZ.value = data.rz;

                // Apply to Entity
                if (this.splatEntity) {
                    this.splatEntity.setPosition(parseFloat(data.px), parseFloat(data.py), parseFloat(data.pz));
                    this.splatEntity.setEulerAngles(parseFloat(data.rx), parseFloat(data.ry), parseFloat(data.rz));

                    console.log(`Restored transform for ${fileName}`);
                }
            } else {
                // No cache, just reset UI to 0
                this.resetObjectTransformUI();
            }
        } catch (e) {
            console.warn("Failed to load cached transform", e);
            this.resetObjectTransformUI();
        }
    }

    private saveTransformToCache(fileName: string) {
        if (!this.splatEntity) return;

        const pos = this.splatEntity.getPosition();
        const rot = this.splatEntity.getEulerAngles();

        const data = {
            px: pos.x.toFixed(2),
            py: pos.y.toFixed(2),
            pz: pos.z.toFixed(2),
            rx: rot.x.toFixed(1),
            ry: rot.y.toFixed(1),
            rz: rot.z.toFixed(1)
        };

        //console.log(`Saving transform usage for ${fileName}:`, data);

        const cachedKey = `transform_cache_${fileName}`;
        localStorage.setItem(cachedKey, JSON.stringify(data));
    }

    // #WDD 2026-01-18: Helper to sync UI inputs with current Entity state
    private updateTransformUIFromEntity() {
        if (!this.splatEntity) return;

        const pos = this.splatEntity.getLocalPosition();
        const rot = this.splatEntity.getLocalEulerAngles();
        const scale = this.splatEntity.getLocalScale(); // Future proofing

        const posX = document.getElementById('pos-x') as HTMLInputElement;
        const posY = document.getElementById('pos-y') as HTMLInputElement;
        const posZ = document.getElementById('pos-z') as HTMLInputElement;
        const rotX = document.getElementById('rot-x') as HTMLInputElement;
        const rotY = document.getElementById('rot-y') as HTMLInputElement;
        const rotZ = document.getElementById('rot-z') as HTMLInputElement;

        if (posX) posX.value = pos.x.toFixed(2);
        if (posY) posY.value = pos.y.toFixed(2);
        if (posZ) posZ.value = pos.z.toFixed(2);
        if (rotX) rotX.value = rot.x.toFixed(1);
        if (rotY) rotY.value = rot.y.toFixed(1);
        if (rotZ) rotZ.value = rot.z.toFixed(1);
    }

    // #WDD 2026-01-18: Expose current positions for SelectionTool
    public getCurrentPositions(): Float32Array | null {
        // If 4DGS is active, usage the dynamic positions from the sorter
        if (this.is4DGS && this.splatEntity?.gsplat) {
            const instance = (this.splatEntity.gsplat as any).instance;
            if (instance?.sorter?.centers) {
                return instance.sorter.centers;
            }
        }
        // Fallback or Non-4DGS
        return this.cachedPositions;
    }

    // Public method for window binding
    public async exportPlySequence() {
        if (!this.splatEntity || !this.splatEntity.gsplat) {
            alert("No Splat loaded to export!");
            return;
        }

        const component = this.splatEntity.gsplat as any;
        const asset = component.asset;
        if (!asset || !asset.resource) return;

        const resource = asset.resource as pc.GSplatResource;
        const splatData = resource.splatData;

        // Collect extra props from loader
        // We know we attached some custom props to vertex element 0?
        // Or we pass the whole splatData structure and let the exporter inspect it.
        // But PlyExporter expects a { count, plyData, ... } object similar to 'parsed'.
        // We need to re-construct a suitable object or pass splatData directly if upgraded.

        // Actually, PlyExporter.exportSequence takes 'data' which has 'trajectory', 'lifetime_mu' etc.
        // We need to check if 'splatData' holds these.
        // In finalizeGSplatLoad, we see:
        // const x = splatData.getProp('x')...
        // const reorderedMu = splatData.getProp('lifetime_mu');
        // So splatData IS the source of truth.

        // We construct a 'data' object that PlyExporter expects.
        // It seems PlyExporter was designed to take the 'parsed' object from loader, or similar.
        // But here we might not have 'parsed' anymore.
        // We must reconstruct it from splatData props.

        const data: any = {
            count: splatData.numSplats,
            plyData: { elements: [{ properties: [] }] }, // Mock if needed, or Exporter uses getProp from data?
            // Wait, PlyExporter uses data.plyData.elements[0] to find properties?
            // See PlyExporter.ts:43: const vertexElement = data.plyData.elements[0];
            // So we need to provide that structure.
        };

        // Re-build vertex properties list from splatData
        // We can just iterate the vertex element from splatData (it has one).
        const elem = (splatData as any).elements[0]; // Access internal elements
        data.plyData.elements[0] = elem;

        // Pass validation props
        // We need to ensure we pass keyframes/strides if 4DGS
        if (this.is4DGS) {
            data.is4DGS = true;
            data.keyframes = this.keyframes;
            data.rotKeyframes = this.rotKeyframes;
            data.xyzStride = this.xyzStride;
            data.rotStride = this.rotStride;

            // Attaching arrays directly for convenience if Exporter needs them
            data.trajectory = this.trajectoryData;
            data.rotTrajectory = this.rotTrajectoryData;

            data.lifetime_mu = splatData.getProp('lifetime_mu');
            data.lifetime_w = splatData.getProp('lifetime_w');
            data.lifetime_k = splatData.getProp('lifetime_k');
        }

        const totalFrames = this.totalFrames || Math.ceil(this.duration);

        await PlyExporter.exportSequence(data, totalFrames, `sequence_${this.currentFileName}`);
    }

    /**
     * Reconstructs current frame from real textures sent to GPU.
     * #WDD 2026-01-16 Verification path requested by user.
     */
    private async exportCurrentFrameToPly() {
        if (!this.lastParsedData || !this.lifeTexData || !this.scalesTexData) {
            console.error("[Export] Cannot export: metadata or textures missing.", {
                parsed: !!this.lastParsedData,
                life: !!this.lifeTexData,
                scales: !!this.scalesTexData
            });
            alert("No 4DGS data loaded for texture export. (Is it 4DGS?)");
            return;
        }

        console.log(`[Export] Reconstructing frame ${this.currentTime.toFixed(2)} from textures...`);
        const component = (this.splatEntity?.gsplat || (this as any).splatComponent) as any;
        if (!component) {
            console.error("[Export] No GSplatComponent found on entity.");
            alert("No GSplatComponent found. Please ensure a splat is loaded.");
            return;
        }

        const asset = component.asset;
        const resource = (asset?.resource || (component as any).instance?.splatData?._resource) as any;
        const splatData = resource?.splatData || component.instance?.splatData || (this.lastParsedData as any);

        if (!splatData && !this.lastParsedData) {
            console.error("[Export] SplatData not found.", { resource: !!resource, instance: !!component.instance });
            alert("SplatData not found for export.");
            return;
        }

        const numSplats = splatData.numSplats || this.lastParsedData.count;

        const params = {
            keyframes: this.keyframes,
            xyzStride: this.xyzStride,
            rotKeyframes: this.rotKeyframes,
            rotStride: this.rotStride,
            texWidth: 4096 // We use 4096 in our creation logic
        };

        const buffer = await PlyExporter.exportFrameFromTextures(
            numSplats,
            this.currentTime,
            this.duration,
            this.lifeTexData!,
            this.trajectoryData!, // Raw trajectory keyframes
            this.rotTrajectoryData!, // Raw rotation keyframes
            this.scalesTexData, // Pack of scale_0,1,2,0
            params,
            this.lastParsedData
        );

        const filename = `gpu_reconstruct_${this.currentFileName}_f${this.currentTime.toFixed(1)}.ply`;
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        console.log(`[Export] Saved: ${filename}`);
    }


    // #WDD 2026-01-18
    async saveAsTrueSplats() {
        if (!this.lastParsedData) {
            console.error("[Export] No data loaded.");
            return;
        }

        console.log(`[Export] Saving .truesplats...`);
        try {
            // #WDD 2026-01-18: Capture Model Transform & Cameras
            const transform = {
                pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1]
            };
            if (this.splatEntity) {
                const p = this.splatEntity.getLocalPosition();
                const r = this.splatEntity.getLocalRotation();
                const s = this.splatEntity.getLocalScale();
                transform.pos = [p.x, p.y, p.z];
                transform.rot = [r.x, r.y, r.z, r.w];
                transform.scale = [s.x, s.y, s.z];
            }

            const cameras = this.cameraPresets.map(c => ({
                name: c.name,
                pos: [c.pos.x, c.pos.y, c.pos.z],
                pitch: c.pitch,
                yaw: c.yaw,
                textObjects: c.textObjects
            }));

            // #WDD 2026-01-18: Capture Deleted Indices
            const deletedIndices: number[] = [];
            if (this.selectionTool.selectionData) {
                const selData = this.selectionTool.selectionData;
                const numSplats = selData.length / 4;
                for (let i = 0; i < numSplats; i++) {
                    if (selData[i * 4 + 1] > 0) { // Green channel = Deleted
                        deletedIndices.push(i);
                    }
                }
            }

            const buffer = await TrueSplatsLoader.save(this.lastParsedData, {
                model_transform: transform,
                cameras: cameras,
                deleted_indices: deletedIndices // #WDD 2026-01-18
            });
            const filename = `saved_${this.currentFileName || 'model.truesplats'}`;

            const blob = new Blob([buffer], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            console.log(`[Export] Saved .truesplats: ${filename}`);
        } catch (e: any) { // Explicit any for error
            console.error("[Export] Save failed:", e);
            alert("Save failed: " + e.message);
        }
    }
    async saveAsSOG4() {
        console.log("[Export] saveAsSOG4 called. LastParsed:", this.lastParsedData);
        if (!this.lastParsedData || !this.lastParsedData.isSOG4) {
            console.error("[Export] SOG4 Save Mismatch. isSOG4:", this.lastParsedData?.isSOG4);
            alert("No SOG4 loaded or format mismatch.");
            return;
        }

        console.log(`[Export] Saving .sog4...`);
        try {
            const transform = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
            if (this.splatEntity) {
                const p = this.splatEntity.getLocalPosition();
                const r = this.splatEntity.getLocalRotation();
                const s = this.splatEntity.getLocalScale();
                transform.pos = [p.x, p.y, p.z];
                transform.rot = [r.x, r.y, r.z, r.w];
                transform.scale = [s.x, s.y, s.z];
            }

            const cameras = this.cameraPresets.map(c => ({
                name: c.name, pos: [c.pos.x, c.pos.y, c.pos.z], pitch: c.pitch, yaw: c.yaw,
                textObjects: c.textObjects
            }));

            const deletedIndices: number[] = [];
            if (this.selectionTool.selectionData) {
                const selData = this.selectionTool.selectionData;
                const numSplats = selData.length / 4;
                for (let i = 0; i < numSplats; i++) {
                    if (selData[i * 4 + 1] > 0) deletedIndices.push(i);
                }
            }

            const buffer = await SOG4Loader.save(this.lastParsedData, {
                model_transform: transform,
                cameras: cameras,
                deleted_indices: deletedIndices
            });
            const filename = `saved_${this.currentFileName || 'model.sog4'}`;

            const blob = new Blob([buffer.buffer as ArrayBuffer], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            console.log(`[Export] Saved .sog4: ${filename}`);
        } catch (e: any) {
            console.error("[Export] Save SOG4 failed:", e);
            alert("Save failed: " + e.message);
        }
    }
}

// Global scoped app for access in callbacks
let app: pc.Application;
declare global {
    interface Window {
        exportPlySequence: () => void;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const viewer = new Viewer();
    app = viewer.app;
    window.exportPlySequence = () => viewer.exportPlySequence();
});