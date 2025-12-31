import * as pc from 'playcanvas';
import { splatCoreVS, splatMainVS, splatMainPS } from './shaders/gsplat-shader';
import { UnzipPipeline } from './utils/unzip-pipeline';
import { SelectionTool } from './ui/selection-tool';
import { ZipPly } from './utils/zip_ply';

// --- Configuration & State ---
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

    private pitch = 0;
    private yaw = 0;
    private gridEntity: pc.Entity | null = null;
    private axesEntity: pc.Entity | null = null;

    // Camera Presets State
    private cameraPresets: { name: string, pos: pc.Vec3, pitch: number, yaw: number }[] = [];
    private isCameraAnimating = false;
    private animTargetPos = new pc.Vec3();
    private animTargetPitch = 0;
    private animTargetYaw = 0;
    private animStartPos = new pc.Vec3();
    private animStartPitch = 0;
    private animStartYaw = 0;
    private animProgress = 0;

    constructor() {
        const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;

        this.app = new pc.Application(canvas, {
            mouse: new pc.Mouse(canvas),
            touch: new pc.TouchDevice(canvas),
            elementInput: new pc.ElementInput(canvas),
            graphicsDeviceOptions: {
                antialias: true,
                alpha: false,
                preserveDrawingBuffer: false,
                powerPreference: 'high-performance'
            }
        });

        this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
        this.app.setCanvasResolution(pc.RESOLUTION_AUTO);

        window.addEventListener('resize', () => {
            this.app.resizeCanvas();
        });

        this.setupScene();

        // Init Selection Tool
        this.selectionTool = new SelectionTool(this.app, this);

        this.setupEventListeners();

        this.app.start();

        this.app.on('update', (dt: number) => this.onUpdate(dt));
    }

    updateToggleButton(btn: HTMLElement, active: boolean) {
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

    private async exportData(format: 'ply' | 'gszip' = 'ply') {
        if (!this.splatEntity || !this.splatEntity.gsplat) return;

        const component = this.splatEntity.gsplat as any;
        let asset = component.asset;
        // Resolve asset if it is an ID
        if (typeof asset === 'number') {
            asset = this.app.assets.get(asset);
        } else if (typeof asset === 'string') {
            asset = this.app.assets.find(asset);
        }

        if (!asset || !asset.resource) {
            console.error("Export failed: GSplat Asset not found or not loaded.");
            return;
        }

        const resource = asset.resource as pc.GSplatResource;
        const splatData = resource.splatData;

        if (!splatData) {
            console.error("Export failed: No SplatData in resource.");
            return;
        }

        // 1. Identify valid indices (not deleted)
        const validIndices: number[] = [];
        const selectionData = this.selectionTool.selectionData;
        const count = splatData.numSplats;

        if (selectionData) {
            for (let i = 0; i < count; i++) {
                // If G channel (index * 4 + 1) is > 0, it's deleted
                if (selectionData[i * 4 + 1] === 0) {
                    validIndices.push(i);
                }
            }
        } else {
            // No selection tool initialized? Save all.
            for (let i = 0; i < count; i++) validIndices.push(i);
        }

        const newCount = validIndices.length;
        if (newCount === 0) {
            alert("No points to export!");
            return;
        }

        console.log(`Exporting ${newCount} / ${count} splats...`);

        // 2. Define Properties to Export
        // We iterate all known potential properties.
        const propNames = [
            'x', 'y', 'z',
            'f_dc_0', 'f_dc_1', 'f_dc_2',
            'opacity',
            'scale_0', 'scale_1', 'scale_2',
            'rot_0', 'rot_1', 'rot_2', 'rot_3',
            'lifetime_mu', 'lifetime_w', 'lifetime_k'
        ];

        // Add all 45 f_rest SH coeffs
        for (let k = 0; k < 45; k++) propNames.push(`f_rest_${k}`);

        // Filter to those that actually exist in splatData
        const activeProps = propNames.filter(name => splatData.getProp(name) !== null);

        // 3. Construct PLY Header
        let header = "ply\n";
        header += "format binary_little_endian 1.0\n";
        header += `element vertex ${newCount}\n`;

        activeProps.forEach(name => {
            // Check type. Usually float.
            // splatData stores as Float32Array usually.
            header += `property float ${name}\n`;
        });

        // Add "dataFrames" comment if we tracked it (restore from header)
        // Check if we have an explicit original frame count
        const framesToExport = (this.originalFrames && this.originalFrames > 0) ? this.originalFrames : Math.ceil(this.duration);
        header += `comment frames ${framesToExport}\n`;

        // 3.5 Add camera presets to header
        if (this.cameraPresets.length > 0) {
            const camerasJson = JSON.stringify(this.cameraPresets.map(p => ({
                name: p.name,
                pos: [p.pos.x, p.pos.y, p.pos.z],
                pitch: p.pitch,
                yaw: p.yaw
            })));
            header += `comment cameras ${camerasJson}\n`;
        }

        // 3.6 Add object pose (position and rotation) to header
        if (this.splatEntity) {
            const pos = this.splatEntity.getPosition();
            const rot = this.splatEntity.getEulerAngles();
            const poseJson = JSON.stringify({
                px: pos.x.toFixed(3),
                py: pos.y.toFixed(3),
                pz: pos.z.toFixed(3),
                rx: rot.x.toFixed(2),
                ry: rot.y.toFixed(2),
                rz: rot.z.toFixed(2)
            });
            header += `comment pose ${poseJson}\n`;
        }

        header += "end_header\n";

        const headerBlob = new TextEncoder().encode(header);

        // 4. Construct Binary Data
        // Each vertex has all activeProps floats.
        // Size = newCount * activeProps.length * 4 bytes
        const rowFloats = activeProps.length;
        const bufferSize = newCount * rowFloats * 4;
        const dataBuffer = new ArrayBuffer(bufferSize);
        const dataView = new DataView(dataBuffer);

        // Pre-fetch source arrays to avoid getProp lookups in loop
        const sourceArrays = activeProps.map(name => splatData.getProp(name)!);

        let offset = 0;
        for (let i = 0; i < newCount; i++) {
            const originalIdx = validIndices[i];

            for (let p = 0; p < rowFloats; p++) {
                const val = sourceArrays[p][originalIdx];
                dataView.setFloat32(offset, val, true); // Little Endian
                offset += 4;
            }
        }

        // 5. Trigger Download
        const combinedBuffer = new Uint8Array(headerBlob.length + dataBuffer.byteLength);
        combinedBuffer.set(headerBlob);
        combinedBuffer.set(new Uint8Array(dataBuffer), headerBlob.length);

        if (format === 'gszip') {
            const overlay = document.getElementById('loading-overlay');
            const status = document.getElementById('loading-status');
            const detail = document.getElementById('loading-detail');
            const stepProgress = document.getElementById('loading-step-progress');
            const stepSquares = document.querySelectorAll('.step-square');

            const updateProgress = (p: number, msg: string) => {
                if (overlay) overlay.classList.remove('hidden');
                if (status) status.innerText = "COMPRESSING";
                if (detail) detail.innerText = msg;

                // Map 0-100% to 0-9 steps
                const stepIndex = Math.min(9, Math.floor(p / 10));

                if (stepProgress) {
                    const percentage = (stepIndex / (stepSquares.length - 1)) * 100;
                    stepProgress.style.width = `${percentage}%`;
                }

                stepSquares.forEach((sq, idx) => {
                    const element = sq as HTMLElement;
                    if (idx <= stepIndex) {
                        element.classList.add('reached');
                    } else {
                        element.classList.remove('reached');
                    }
                });
            };

            updateProgress(0, "Initializing...");

            try {
                const zipper = new ZipPly();
                // Pass progress callback
                const gszipBlob = await zipper.compress(combinedBuffer.buffer, {}, (p, msg) => {
                    updateProgress(p, msg);
                }) as Blob;

                updateProgress(100, "Download Starting...");

                const url = URL.createObjectURL(gszipBlob);
                const a = document.createElement('a');
                a.href = url;
                const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
                a.download = `exported_scene_${timestamp}.gszip`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (err) {
                console.error("GSZIP compression failed:", err);
                alert("Compression failed. Checking console for details.");
            } finally {
                if (overlay) setTimeout(() => overlay.classList.add('hidden'), 500);
            }
        }

        if (format === 'ply') {
            const blob = new Blob([combinedBuffer], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
            a.download = `exported_scene_${timestamp}.ply`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }

    private setupEventListeners() {
        // 0. Export Button is now handled by sub-buttons (ply/gszip) in the menu.

        // 1. Disable Right-Click Context Menu
        window.addEventListener('contextmenu', e => e.preventDefault());

        const openBtn = document.getElementById('open-file');
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const resetBtn = document.getElementById('reset-cam');
        const exportPlyBtn = document.getElementById('export-ply');
        const exportGszipBtn = document.getElementById('export-gszip');

        openBtn?.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        resetBtn?.addEventListener('click', () => this.resetCamera());
        exportPlyBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.exportData('ply');
        });
        exportGszipBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.exportData('gszip');
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
                this.toggleUIVisibility();
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
                (this.splatEntity.gsplat as any).time = this.currentTime;
            }
        });

        // --- Interaction & Keyboard ---
        let isLMB = false;
        let isRMB = false;
        const lastMousePos = new pc.Vec2();
        const keys: Record<string, boolean> = {};
        let isUIInteracting = false;

        // Block camera when mouse is over UI panels
        const uiPanels = ['sidebar', 'time-controls', 'header-brand', 'selection-toolbar'];
        uiPanels.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('mouseenter', () => { isUIInteracting = true; });
            el.addEventListener('mouseleave', () => { if (!activeScrubInput) isUIInteracting = false; });
            el.addEventListener('mousedown', (e) => e.stopPropagation());
            el.addEventListener('touchstart', (e) => {
                isUIInteracting = true;
                // Don't stop propagation if we want the actual touch event to reach children (like buttons)
                // but we want to prevent the camera from moving.
            }, { passive: true });
        });

        window.addEventListener('mouseup', () => {
            isLMB = false;
            isRMB = false;
            if (!activeScrubInput) isUIInteracting = false;
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
            if (isUIInteracting) return;
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

        this.app.mouse.on(pc.EVENT_MOUSEDOWN, (e: pc.MouseEvent) => {
            if (isUIInteracting || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return;
            if (e.button === pc.MOUSEBUTTON_LEFT) isLMB = true;
            if (e.button === pc.MOUSEBUTTON_RIGHT) isRMB = true;
            lastMousePos.set(e.x, e.y);
        });

        this.app.mouse.on(pc.EVENT_MOUSEMOVE, (e: pc.MouseEvent) => {
            if (!this.camera || isUIInteracting || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return;
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

        this.app.mouse.on(pc.EVENT_MOUSEWHEEL, (e: any) => {
            if (this.camera && !isUIInteracting && (!this.selectionTool || this.selectionTool.currentTool === 'none'))
                this.camera.translateLocal(0, 0, -e.wheel * 0.5);
        });

        // --- Touch Support ---
        let lastTouchDistance = 0;
        let lastTouchPos = new pc.Vec2();
        let prevTouchCount = 0;

        this.app.touch.on(pc.EVENT_TOUCHSTART, (e: pc.TouchEvent) => {
            if (isUIInteracting || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return;

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

        this.app.touch.on(pc.EVENT_TOUCHMOVE, (e: pc.TouchEvent) => {
            if (!this.camera || isUIInteracting || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return;
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
            // Smooth Camera Animation
            if (this.isCameraAnimating && this.camera) {
                this.animProgress += dt * 2.0; // Transition speed
                if (this.animProgress >= 1) {
                    this.animProgress = 1;
                    this.isCameraAnimating = false;
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
            }

            // WASD Camera Movement - blocked only if we are actively scrubbing or focused on UI
            const activeEl = document.activeElement as HTMLElement;
            const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);

            if (this.camera && !isUIInteracting && !this.isCameraAnimating && !isTyping) {
                const speed = dt * 5;
                if (keys['KeyW']) this.camera.translateLocal(0, 0, -speed);
                if (keys['KeyS']) this.camera.translateLocal(0, 0, speed);
                if (keys['KeyA']) this.camera.translateLocal(-speed, 0, 0);
                if (keys['KeyD']) this.camera.translateLocal(speed, 0, 0);
                if (keys['KeyQ']) this.camera.translateLocal(0, -speed, 0);
                if (keys['KeyE']) this.camera.translateLocal(0, speed, 0);
            }

            if (this.isPlaying) {
                // Use FPS-based playback
                this.currentTime += dt * this.fps;

                // Loop logic
                if (this.currentTime > this.duration) {
                    this.currentTime = 0;
                }

                // For UI, we floor to closest frame
                const displayFrame = Math.floor(this.currentTime);
                const total = Math.ceil(this.duration); // Duration is roughly max frame index or count

                // Only auto-update slider if user is NOT scrubbing
                if (timeSlider && !isScrubbing) {
                    timeSlider.value = displayFrame.toString();
                }
                if (timeLabel) timeLabel.innerText = `${displayFrame} / ${total}`;

                // Update time uniform for custom shader
                if (this.splatEntity?.gsplat) {
                    const material = (this.splatEntity.gsplat as any).instance.material;
                    if (material) {
                        // User request: input 't' must be integer frame if playing as frames
                        const shaderTime = (this.duration > 1.0) ? Math.floor(this.currentTime) : this.currentTime;
                        material.setParameter('uTime', shaderTime);
                    }
                }
            } else {
                // Also update on scrub
                if (this.splatEntity?.gsplat) {
                    const material = (this.splatEntity.gsplat as any).instance.material;
                    if (material) {
                        const shaderTime = (this.duration > 1.0) ? Math.floor(this.currentTime) : this.currentTime;
                        material.setParameter('uTime', shaderTime);
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
            item.className = 'ui-item group justify-between py-1.5 px-2 cursor-grab active:cursor-grabbing';
            item.setAttribute('draggable', 'true');
            item.dataset.index = index.toString();

            item.innerHTML = `
                <div class="flex items-center gap-2 overflow-hidden flex-1 cursor-pointer">
                    <div class="ui-dot"></div>
                    <span class="preset-name text-[9px] ui-text-primary font-medium truncate">${preset.name}</span>
                </div>
                <button class="delete-preset p-1 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-red-400 transition-all">
                    <svg viewBox="0 0 24 24" class="w-3 h-3 fill-current"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
            `;

            // --- Rename Logic ---
            const nameSpan = item.querySelector('.preset-name') as HTMLElement;
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
            item.addEventListener('dragstart', (e) => {
                if (e.dataTransfer) {
                    e.dataTransfer.setData('text/plain', index.toString());
                    item.classList.add('opacity-40');
                }
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('opacity-40');
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                item.classList.add('bg-white/5');
            });

            item.addEventListener('dragleave', () => {
                item.classList.remove('bg-white/5');
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('bg-white/5');
                const sourceIdx = parseInt(e.dataTransfer?.getData('text/plain') || '-1');
                if (sourceIdx !== -1 && sourceIdx !== index) {
                    const movedItem = this.cameraPresets.splice(sourceIdx, 1)[0];
                    this.cameraPresets.splice(index, 0, movedItem);
                    this.renderPresets();
                }
            });

            // Jump to preset
            item.querySelector('.flex')?.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).tagName === 'INPUT') return;

                if (!this.camera) return;
                this.isCameraAnimating = true;
                this.animProgress = 0;
                this.animStartPos.copy(this.camera.getPosition());
                this.animStartPitch = this.pitch;
                this.animStartYaw = this.yaw;

                this.animTargetPos.copy(preset.pos);
                this.animTargetPitch = preset.pitch;
                this.animTargetYaw = preset.yaw;
            });

            // Delete preset
            item.querySelector('.delete-preset')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cameraPresets.splice(index, 1);
                this.renderPresets();
            });

            presetsList.appendChild(item);
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

        if (shouldHide) {
            sidebar?.classList.add('sidebar-hidden');
            playbar?.classList.add('bottom-bar-hidden');
            selectionToolbar?.classList.add('tools-hidden');
            controlPanel?.classList.add('panel-hidden');
            simplifiedPanel?.classList.remove('hidden-panel');
        } else {
            sidebar?.classList.remove('sidebar-hidden');
            playbar?.classList.remove('bottom-bar-hidden');
            selectionToolbar?.classList.remove('tools-hidden');
            controlPanel?.classList.remove('panel-hidden');
            simplifiedPanel?.classList.add('hidden-panel');
        }
    }

    private async loadSampleFile(url: string) {
        const filename = url.split('/').pop() || 'sample.gszip';

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

        if (!file.name.endsWith('.ply') && !file.name.endsWith('.splat') && !file.name.endsWith('.zip') && !file.name.endsWith('.gszip')) {
            alert('Please drop a .ply, .splat, .zip, or .gszip file');
            return;
        }

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
            // 1. Get Buffer (Directly or via Unzip)
            let buffer: ArrayBuffer;
            let zipFrameCount: number | null = null;

            if (file.name.endsWith('.zip') || file.name.endsWith('.gszip')) {
                const pipeline = new UnzipPipeline();
                const result = await pipeline.process(file, (p: number, s: string) => {
                    let step = 1;
                    if (p < 50) {
                        // Map 0-50% progress to steps 1-8 (The slow HEVC decoding phase)
                        step = 1 + Math.floor((p / 50) * 7);
                    } else {
                        // Map 50-100% progress to step 9 (The fast reconstruction phase)
                        step = 9;
                    }
                    setProgress(step, "DECOMPRESSING", s);
                });
                buffer = result.buffer;
                zipFrameCount = result.frameCount;
                setProgress(9, "PROCESSING", "Finalizing Reconstruction...");
            } else {
                setProgress(1, "LOADING", "Reading File Buffer...");
                buffer = await file.arrayBuffer();
                setProgress(2, "LOADING", "Buffer Ready");
            }

            if (file.name.endsWith('.ply') || file.name.endsWith('.zip') || file.name.endsWith('.gszip')) {
                // Parse PLY with SH Injection
                setProgress(9, "PARSING", "Analyzing PLY Header...");
                const parsed = this.parsePly(buffer);
                if (parsed) {
                    setProgress(9, "PARSING", "Creating GSplatResource...");
                    // Create GSplatResource directly from our prepared data
                    const splatData = new pc.GSplatData(parsed.plyData.elements);
                    const resource = new pc.GSplatResource(this.app.graphicsDevice, splatData);
                    const url = URL.createObjectURL(file);
                    const asset = new pc.Asset(file.name, 'gsplat', { url: url }, { propData: parsed.plyData });
                    asset.resource = resource;
                    asset.loaded = true;
                    this.app.assets.add(asset);

                    const entity = new pc.Entity('GSplat');
                    this.app.root.addChild(entity);
                    this.splatEntity = entity;
                    entity.addComponent('gsplat', { asset: asset });

                    // --- Cache Positions for Selection (Must use reordered data from GSplatData) ---
                    const x = splatData.getProp('x');
                    const y = splatData.getProp('y');
                    const z = splatData.getProp('z');

                    if (x && y && z) {
                        const num = Math.min(splatData.numSplats, x.length, y.length, z.length);
                        this.cachedPositions = new Float32Array(num * 3);
                        for (let i = 0; i < num; i++) {
                            this.cachedPositions[i * 3 + 0] = x[i];
                            this.cachedPositions[i * 3 + 1] = y[i];
                            this.cachedPositions[i * 3 + 2] = z[i];
                        }
                    }

                    if (this.cachedPositions) {
                        const num = this.cachedPositions.length / 3;
                        this.selectionTool.init(num);
                        this.selectionTool.setTool('none');
                    }

                    // --- Load Camera Presets from PLY if present ---
                    if (parsed.cameras && parsed.cameras.length > 0) {
                        this.cameraPresets = parsed.cameras.map((c: any) => ({
                            name: c.name,
                            pos: new pc.Vec3(c.pos[0], c.pos[1], c.pos[2]),
                            pitch: c.pitch,
                            yaw: c.yaw
                        }));
                        this.renderPresets();
                    }

                    setProgress(9, "READY", "System Update Complete");

                    const reorderedMu = splatData.getProp('lifetime_mu');
                    const reorderedW = splatData.getProp('lifetime_w');
                    const reorderedK = splatData.getProp('lifetime_k');

                    let lifeTexture: pc.Texture | null = null;

                    if (reorderedMu && reorderedW && reorderedK) {
                        const width = Math.ceil(Math.sqrt(splatData.numSplats));
                        const height = Math.ceil(splatData.numSplats / width);
                        const texData = new Float32Array(width * height * 4);
                        for (let i = 0; i < splatData.numSplats; i++) {
                            texData[i * 4 + 0] = reorderedMu[i];
                            texData[i * 4 + 1] = reorderedW[i];
                            texData[i * 4 + 2] = reorderedK[i];
                            texData[i * 4 + 3] = 0.0;
                        }

                        lifeTexture = new pc.Texture(this.app.graphicsDevice, {
                            width: width,
                            height: height,
                            format: pc.PIXELFORMAT_RGBA32F,
                            mipmaps: false,
                            minFilter: pc.FILTER_NEAREST,
                            magFilter: pc.FILTER_NEAREST,
                            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
                            name: 'lifetimeTexture'
                        });

                        const lockRef = lifeTexture.lock();
                        lockRef.set(texData);
                        lifeTexture.unlock();
                    }

                    if (this.splatEntity.gsplat) {
                        this.setupLifetimeShader((this.splatEntity.gsplat as any).instance, lifeTexture);
                    }

                    this.originalFrames = zipFrameCount || parsed.dataFrames || null;
                    if (this.originalFrames) {
                        this.duration = this.originalFrames; // Explicit frame count is the authority
                    } else {
                        // Fallback to maxMu if no explicit frame count
                        this.duration = parsed.maxMu || 100;
                    }
                    const slider = document.getElementById('time-slider') as HTMLInputElement;
                    if (slider) {
                        slider.max = Math.ceil(this.duration).toString();
                        slider.step = "0.1";
                        slider.value = "0";
                    }

                    this.updateTimelineTicks(this.duration);
                    const timeLabel = document.getElementById('time-label');
                    if (timeLabel) {
                        timeLabel.innerText = `0 / ${Math.ceil(this.duration)}`;
                    }
                    setProgress(9, "READY", "System Update Complete");
                    setTimeout(() => {
                        if (overlay) overlay.classList.add('hidden');
                    }, 600);
                    this.updateStats(asset);

                    if (parsed.pose) {
                        // Apply pose from PLY
                        if (this.splatEntity) {
                            this.splatEntity.setPosition(parseFloat(parsed.pose.px), parseFloat(parsed.pose.py), parseFloat(parsed.pose.pz));
                            this.splatEntity.setEulerAngles(parseFloat(parsed.pose.rx), parseFloat(parsed.pose.ry), parseFloat(parsed.pose.rz));

                            // Sync UI inputs
                            const posX = document.getElementById('pos-x') as HTMLInputElement;
                            const posY = document.getElementById('pos-y') as HTMLInputElement;
                            const posZ = document.getElementById('pos-z') as HTMLInputElement;
                            const rotX = document.getElementById('rot-x') as HTMLInputElement;
                            const rotY = document.getElementById('rot-y') as HTMLInputElement;
                            const rotZ = document.getElementById('rot-z') as HTMLInputElement;

                            if (posX) posX.value = parsed.pose.px;
                            if (posY) posY.value = parsed.pose.py;
                            if (posZ) posZ.value = parsed.pose.pz;
                            if (rotX) rotX.value = parsed.pose.rx;
                            if (rotY) rotY.value = parsed.pose.ry;
                            if (rotZ) rotZ.value = parsed.pose.rz;

                            console.log("Restored pose from PLY header");
                        }
                    } else if (this.currentFileName) {
                        this.loadCachedTransform(this.currentFileName);
                    } else {
                        this.resetObjectTransformUI();
                    }

                    this.resetCamera();
                    return;
                }
            } else if (file.name.endsWith('.splat')) {
                setProgress(9, "READY", "Processing Asset...");
                const parsed = this.parseSplat(buffer);
                if (parsed) {
                    const url = URL.createObjectURL(file);
                    const entity = new pc.Entity('GSplat');
                    this.app.root.addChild(entity);
                    this.splatEntity = entity;

                    const asset = new pc.Asset(file.name, 'gsplat', { url: url });
                    this.app.assets.add(asset);
                    this.app.assets.load(asset);

                    asset.ready(() => {
                        entity.addComponent('gsplat', { asset: asset });
                        setProgress(9, "READY", "System Update Complete");
                        setTimeout(() => {
                            if (overlay) overlay.classList.add('hidden');
                        }, 600);
                        this.updateStats(asset);
                        this.resetObjectTransformUI();
                        this.resetCamera();
                        const container = document.getElementById('timeline-ticks');
                        if (container) container.innerHTML = '';
                    });
                    return;
                }
            }
        } catch (e) {
            console.error("Load Error:", e);
            alert("Error loading file: " + (e instanceof Error ? e.message : String(e)));
            if (overlay) overlay.classList.add('hidden');
        }
    }


    // Selection Tool Support
    private updateSelectionUniform(tex: pc.Texture) {
        if (this.splatEntity?.gsplat) {
            const instance = (this.splatEntity.gsplat as any).instance;
            if (instance && instance.material) {
                instance.material.setParameter('selectionTexture', tex);
                instance.material.update();
            }
        }
    }

    updateSelectionModeParams(isSelecting: boolean) {
        if (this.splatEntity?.gsplat) {
            const instance = (this.splatEntity.gsplat as any).instance;
            if (instance && instance.material) {
                instance.material.setParameter('isSelectionMode', isSelecting ? 1.0 : 0.0);
                instance.material.update();
            }
        }
    }

    private async setupLifetimeShader(instance: any, lifetimeTexture: pc.Texture | null) {
        console.log("Setting up Lifetime Shader with Texture...", lifetimeTexture);

        const material = instance.material;
        material.setParameter('uTime', 0.0);

        if (lifetimeTexture) {
            material.setParameter('lifetimeTexture', lifetimeTexture);
        }

        // --- ROBUST SHADER INJECTION ---

        const originalGetShaderVariant = material.getShaderVariant;

        material.getShaderVariant = function (device: any, scene: any, defs: any, unused: any, pass: any, sortedLights: any, viewUniformFormat: any, viewBindGroupFormat: any) {

            const library = device.getProgramLibrary();
            const originalGetProgram = library.getProgram;

            library.getProgram = function (name: string, options: any, processingOptions: any) {
                if (name === 'splat') {
                    console.log("[ShaderInject] Intercepted 'splat' shader generation. Injecting Custom VS/PS (Lifetime Texture & Fixed SH).");

                    // We must bypass the original generator's concatenation because it uses a broken splatCoreVS.
                    // Instead, we construct the full shader here using our FIXED core and mains.

                    // 1. Prepare Defines
                    if (!options.defines) options.defines = [];
                    if (lifetimeTexture) {
                        if (!options.defines.includes('USE_LIFETIME_TEXTURE')) options.defines.push('USE_LIFETIME_TEXTURE');
                    }
                    if (!options.defines.includes('USE_SH1')) options.defines.push('USE_SH1');
                    if (!options.defines.includes('USE_SH2')) options.defines.push('USE_SH2');
                    if (!options.defines.includes('USE_SH3')) options.defines.push('USE_SH3');

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

        const maxFrame = Math.ceil(duration);
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


    private parseSplat(buffer: ArrayBuffer) {
        // Standard .splat: P(3f), S(3f), C(4b), R(4b) = 32 bytes
        const ROW_SIZE = 32;
        const numVertices = Math.floor(buffer.byteLength / ROW_SIZE);
        const positions = new Float32Array(numVertices * 3);
        const colors = new Uint8Array(numVertices * 4);

        const dataView = new DataView(buffer);

        for (let i = 0; i < numVertices; i++) {
            const offset = i * ROW_SIZE;
            positions[i * 3 + 0] = dataView.getFloat32(offset + 0, true);
            positions[i * 3 + 1] = dataView.getFloat32(offset + 4, true);
            positions[i * 3 + 2] = dataView.getFloat32(offset + 8, true);

            // Splat format colors are RGBA
            colors[i * 4 + 0] = dataView.getUint8(offset + 24);
            colors[i * 4 + 1] = dataView.getUint8(offset + 25);
            colors[i * 4 + 2] = dataView.getUint8(offset + 26);
            colors[i * 4 + 3] = dataView.getUint8(offset + 27);
        }

        return { positions, colors };
    }

    private parsePly(buffer: ArrayBuffer) {
        // Robust header parsing to find binary start
        const view = new Uint8Array(buffer);
        let headerEndOffset = 0;
        const target = new TextEncoder().encode("end_header");

        // Scan for end_header
        for (let i = 0; i < Math.min(view.length, 5000); i++) {
            let match = true;
            for (let j = 0; j < target.length; j++) {
                if (view[i + j] !== target[j]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                let ptr = i + target.length;
                // Skip newline(s) to find start of binary data
                while (ptr < view.length && (view[ptr] === 0x0A || view[ptr] === 0x0D || view[ptr] === 0x20)) {
                    ptr++;
                }
                headerEndOffset = ptr;
                break;
            }
        }

        if (headerEndOffset === 0) {
            console.error("Could not find end_header in PLY");
            return null;
        }

        const headerText = new TextDecoder().decode(buffer.slice(0, headerEndOffset));
        const lines = headerText.split('\n');

        let vertexCount = 0;
        let parsedCameras: any[] = [];
        let parsedPose: any = null;

        // Property mapping
        const props: { name: string, type: string, offset: number }[] = [];
        let currentOffset = 0;
        let dataFrames = 0;

        const typeSizes: Record<string, number> = {
            'char': 1, 'uchar': 1, 'short': 2, 'ushort': 2, 'int': 4, 'uint': 4, 'float': 4, 'double': 8
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('element vertex')) {
                const parts = line.split(/\s+/);
                vertexCount = parseInt(parts[2]);
            } else if (line.startsWith('property')) {
                const parts = line.split(/\s+/);
                const type = parts[1];
                const name = parts[2];
                props.push({ name, type, offset: currentOffset });
                currentOffset += typeSizes[type] || 4;
            } else if (line.startsWith('comment frames')) {
                const parts = line.split(/\s+/);
                dataFrames = parseInt(parts[2]);
            } else if (line.startsWith('comment cameras')) {
                const jsonStr = line.replace('comment cameras ', '').trim();
                try {
                    parsedCameras = JSON.parse(jsonStr);
                } catch (e) {
                    console.warn("Failed to parse cameras comment", e);
                }
            } else if (line.startsWith('comment pose')) {
                const jsonStr = line.replace('comment pose ', '').trim();
                try {
                    parsedPose = JSON.parse(jsonStr);
                } catch (e) {
                    console.warn("Failed to parse pose comment", e);
                }
            }
        }

        if (vertexCount === 0) {
            console.error("Vertex count is 0");
            return null;
        }

        const rowSize = currentOffset;
        const dataView = new DataView(buffer, headerEndOffset);

        // Prepare data containers for all standard GSplat properties + SH Hack
        const data: any = {
            x: new Float32Array(vertexCount),
            y: new Float32Array(vertexCount),
            z: new Float32Array(vertexCount),
            f_dc_0: new Float32Array(vertexCount),
            f_dc_1: new Float32Array(vertexCount),
            f_dc_2: new Float32Array(vertexCount),
            opacity: new Float32Array(vertexCount),
            rot_0: new Float32Array(vertexCount),
            rot_1: new Float32Array(vertexCount),
            rot_2: new Float32Array(vertexCount),
            rot_3: new Float32Array(vertexCount),
            scale_0: new Float32Array(vertexCount),
            scale_1: new Float32Array(vertexCount),
            scale_2: new Float32Array(vertexCount),

            // Lifetime Data containers (initialize explicit)
            lifetime_mu: new Float32Array(vertexCount),
            lifetime_w: new Float32Array(vertexCount),
            lifetime_k: new Float32Array(vertexCount),
        };

        // Initialize storage for ALL 45 SH coefficients (f_rest_0 to f_rest_44)
        // Whether they exist in PLY or not, we need the storage for GSplatData
        for (let i = 0; i < 45; i++) {
            (data as any)[`f_rest_${i}`] = new Float32Array(vertexCount);
        }

        // Property offsets
        const getPropParams = (name: string) => {
            const p = props.find(p => p.name === name);
            return p ? { offset: p.offset, type: p.type } : null;
        };

        const pX = getPropParams('x');
        const pY = getPropParams('y');
        const pZ = getPropParams('z');
        const pR0 = getPropParams('rot_0'), pR1 = getPropParams('rot_1'), pR2 = getPropParams('rot_2'), pR3 = getPropParams('rot_3');
        const pS0 = getPropParams('scale_0'), pS1 = getPropParams('scale_1'), pS2 = getPropParams('scale_2');
        const pD0 = getPropParams('f_dc_0'), pD1 = getPropParams('f_dc_1'), pD2 = getPropParams('f_dc_2');
        const pOp = getPropParams('opacity');
        const pMu = getPropParams('lifetime_mu');
        const pW = getPropParams('lifetime_w');
        const pK = getPropParams('lifetime_k');

        let maxMu = 1.0;

        // Populate Data
        try {
            for (let i = 0; i < vertexCount; i++) {
                const rowOffset = i * rowSize;
                if (headerEndOffset + rowOffset + rowSize > buffer.byteLength) break;

                // Position
                if (pX) data.x[i] = dataView.getFloat32(rowOffset + pX.offset, true);
                if (pY) data.y[i] = dataView.getFloat32(rowOffset + pY.offset, true);
                if (pZ) data.z[i] = dataView.getFloat32(rowOffset + pZ.offset, true);

                // Rotation
                if (pR0) data.rot_0[i] = dataView.getFloat32(rowOffset + pR0.offset, true);
                if (pR1) data.rot_1[i] = dataView.getFloat32(rowOffset + pR1.offset, true);
                if (pR2) data.rot_2[i] = dataView.getFloat32(rowOffset + pR2.offset, true);
                if (pR3) data.rot_3[i] = dataView.getFloat32(rowOffset + pR3.offset, true);

                // Scale
                if (pS0) data.scale_0[i] = dataView.getFloat32(rowOffset + pS0.offset, true);
                if (pS1) data.scale_1[i] = dataView.getFloat32(rowOffset + pS1.offset, true);
                if (pS2) data.scale_2[i] = dataView.getFloat32(rowOffset + pS2.offset, true);

                // Color (DC)
                if (pD0) data.f_dc_0[i] = dataView.getFloat32(rowOffset + pD0.offset, true);
                if (pD1) data.f_dc_1[i] = dataView.getFloat32(rowOffset + pD1.offset, true);
                if (pD2) data.f_dc_2[i] = dataView.getFloat32(rowOffset + pD2.offset, true);

                // Opacity
                if (pOp) {
                    const opRaw = dataView.getFloat32(rowOffset + pOp.offset, true);
                    data.opacity[i] = opRaw; // Pass raw logit, GSplatData applies sigmoid
                } else {
                    data.opacity[i] = 100.0; // Default (very opaque logit)
                }

                // LIFETIME PARSING (Separate)
                if (pMu) {
                    const mu = dataView.getFloat32(rowOffset + pMu.offset, true);
                    if (mu > maxMu) maxMu = mu;
                    data.lifetime_mu[i] = mu;
                }
                if (pW) data.lifetime_w[i] = dataView.getFloat32(rowOffset + pW.offset, true);
                if (pK) data.lifetime_k[i] = dataView.getFloat32(rowOffset + pK.offset, true);
            }

            // Second Pass: Fill SH data if it exists
            // Standard loop for all 45 coefficients
            for (let shIdx = 0; shIdx < 45; shIdx++) {
                const propName = `f_rest_${shIdx}`;
                const pSH = getPropParams(propName);
                if (pSH) {
                    const arr = (data as any)[propName];
                    for (let i = 0; i < vertexCount; i++) {
                        arr[i] = dataView.getFloat32(i * rowSize + pSH.offset, true);
                    }
                }
            }

        } catch (e) {
            console.error("Ply Parse Error", e);
        }

        // --- DEBUG: Log first 10 points completely ---
        for (let i = 0; i < Math.min(vertexCount, 10); i++) {
            const f_rest_debug = [];
            for (let k = 0; k < 45; k++) {
                if ((data as any)[`f_rest_${k}`]) f_rest_debug.push((data as any)[`f_rest_${k}`][i]);
            }

            console.log(`[PLY Parse Debug Pt ${i}]`, {
                index: i,
                xyz: [data.x[i], data.y[i], data.z[i]],
                f_dc: [data.f_dc_0[i], data.f_dc_1[i], data.f_dc_2[i]],
                opacity: data.opacity[i],
                scale: [data.scale_0[i], data.scale_1[i], data.scale_2[i]],
                rot: [data.rot_0[i], data.rot_1[i], data.rot_2[i], data.rot_3[i]],
                lifetime: [data.lifetime_mu[i], data.lifetime_w[i], data.lifetime_k[i]],
                f_rest: f_rest_debug
            });
        }
        // ---------------------------------------------

        // Create explicit properties definition for GSplatData with storage
        const properties = [
            { name: 'x', type: 'float', storage: data.x },
            { name: 'y', type: 'float', storage: data.y },
            { name: 'z', type: 'float', storage: data.z },
            { name: 'f_dc_0', type: 'float', storage: data.f_dc_0 },
            { name: 'f_dc_1', type: 'float', storage: data.f_dc_1 },
            { name: 'f_dc_2', type: 'float', storage: data.f_dc_2 },
            { name: 'opacity', type: 'float', storage: data.opacity },
            { name: 'rot_0', type: 'float', storage: data.rot_0 },
            { name: 'rot_1', type: 'float', storage: data.rot_1 },
            { name: 'rot_2', type: 'float', storage: data.rot_2 },
            { name: 'rot_3', type: 'float', storage: data.rot_3 },
            { name: 'scale_0', type: 'float', storage: data.scale_0 },
            { name: 'scale_1', type: 'float', storage: data.scale_1 },
            { name: 'scale_2', type: 'float', storage: data.scale_2 },

            // Lifetime properties for reordering
            { name: 'lifetime_mu', type: 'float', storage: data.lifetime_mu },
            { name: 'lifetime_w', type: 'float', storage: data.lifetime_w },
            { name: 'lifetime_k', type: 'float', storage: data.lifetime_k }
        ];

        // Add SH prop defs (0-44)
        for (let i = 0; i < 45; i++) {
            properties.push({ name: `f_rest_${i}`, type: 'float', storage: (data as any)[`f_rest_${i}`] });
        }

        // Make data match GSplatData expected structure (vertex element)
        const vertexElement = {
            name: 'vertex',
            count: vertexCount,
            properties: properties
        };

        // Return structure compatible with pc.GSplatData constructor (which expects { elements: [...] })
        return {
            plyData: { elements: [vertexElement] },
            maxMu: maxMu,
            dataFrames: dataFrames,
            cameras: parsedCameras,
            pose: parsedPose,
            positions: null, colors: null, lifetimes: null
        };
    }

    private resetCamera() {
        if (!this.camera) return;
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
        this.fpsCounter++;
        this.fpsTimer += dt;
        if (this.fpsTimer >= 1) {
            const fpsElem = document.getElementById('fps-display');
            if (fpsElem) fpsElem.innerText = Math.round(this.fpsCounter).toString();
            this.fpsCounter = 0;
            this.fpsTimer = 0;
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
}

// Global scoped app for access in callbacks
let app: pc.Application;
window.addEventListener('DOMContentLoaded', () => {
    const viewer = new Viewer();
    app = viewer.app;
});