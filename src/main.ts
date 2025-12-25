import * as pc from 'playcanvas';
import { splatCoreVS, splatMainVS, splatMainPS } from './shaders/gsplat-shader';
import { SelectionTool } from './ui/selection-tool';

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

    // Cache for Selection Tool
    cachedPositions: Float32Array | null = null;
    selectionTool: SelectionTool;

    private pitch = 0;
    private yaw = 0;
    private gridEntity: pc.Entity | null = null;
    private axesEntity: pc.Entity | null = null;

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
        this.setupEventListeners();

        // Init Selection Tool
        this.selectionTool = new SelectionTool(this.app, this);

        this.app.start();

        this.app.on('update', (dt: number) => this.onUpdate(dt));
    }

    updateToggleButton(btn: HTMLElement, active: boolean) {
        if (active) {
            btn.classList.add('bg-white/20', 'ui-text-highlight');
            btn.classList.remove('ui-text-dim');
        } else {
            btn.classList.remove('bg-white/20', 'ui-text-highlight');
            btn.classList.add('ui-text-dim');
        }
    }

    private setupScene() {
        const app = this.app;

        const camera = new pc.Entity('Camera');
        camera.addComponent('camera', {
            clearColor: new pc.Color(0.043, 0.063, 0.106, 1), // Default to Dark Theme Background
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

    private async exportPly() {
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

        // Add "dataFrames" comment if we tracked it (restore from duration/loaded data)
        // We stored `dataFrames` in parsePly return, but maybe didn't store on instance.
        // We can just dump `Math.ceil(this.duration)` as frames.
        header += `comment frames ${Math.ceil(this.duration)}\n`;

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
        const blob = new Blob([headerBlob, dataBuffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `exported_scene_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, "")}.ply`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    private setupEventListeners() {
        // 0. Export Button
        const exportBtn = document.getElementById('export-file');
        exportBtn?.addEventListener('click', () => this.exportPly());

        // 1. Disable Right-Click Context Menu
        window.addEventListener('contextmenu', e => e.preventDefault());

        const openBtn = document.getElementById('open-file');
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const resetBtn = document.getElementById('reset-cam');

        openBtn?.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        resetBtn?.addEventListener('click', () => this.resetCamera());

        // --- Sidebar Visibility Toggle ---
        const sidebar = document.getElementById('sidebar');
        const playbar = document.getElementById('playbar-container');
        const selectionToolbar = document.getElementById('selection-toolbar');
        const toggleSidebar = document.getElementById('toggle-sidebar');
        toggleSidebar?.addEventListener('click', () => {
            sidebar?.classList.toggle('sidebar-hidden');
            playbar?.classList.toggle('bottom-bar-hidden');
            selectionToolbar?.classList.toggle('tools-hidden');
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
        const themeBtns = document.querySelectorAll('.bg-picker');
        themeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                // 1. Handle Active State
                themeBtns.forEach(b => b.classList.remove('active-theme'));
                btn.classList.add('active-theme');

                // 2. Handle Camera Color
                const element = btn as HTMLElement;
                const colorStr = element.dataset.bg;
                if (colorStr && this.camera?.camera) {
                    const c = colorStr.split(',').map(Number);
                    this.camera.camera.clearColor = new pc.Color(c[0], c[1], c[2], 1);
                }

                // 3. Handle UI Theme (Light/Dark)
                const theme = element.dataset.theme;
                if (theme === 'light') {
                    document.body.classList.add('theme-light');
                } else {
                    document.body.classList.remove('theme-light');
                }
            });
        });

        const playBtn = document.getElementById('play-pause');
        const timeSlider = document.getElementById('time-slider') as HTMLInputElement;
        const timeLabel = document.getElementById('time-label');
        const fpsSelect = document.getElementById('fps-select') as HTMLSelectElement;

        let isPlaying = false;
        let currentTime = 0;

        fpsSelect?.addEventListener('change', () => {
            this.fps = parseInt(fpsSelect.value);
        });

        const togglePlay = () => {
            isPlaying = !isPlaying;
            if (playBtn) {
                playBtn.innerHTML = isPlaying
                    ? '<svg viewBox="0 0 24 24" class="w-6 h-6 fill-white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
                    : '<svg viewBox="0 0 24 24" class="w-6 h-6 fill-white"><path d="M8 5v14l11-7z"/></svg>';
            }
        };

        playBtn?.addEventListener('click', togglePlay);

        let isScrubbing = false;

        timeSlider?.addEventListener('mousedown', () => { isScrubbing = true; });
        timeSlider?.addEventListener('mouseup', () => { isScrubbing = false; });
        timeSlider?.addEventListener('touchstart', () => { isScrubbing = true; });
        timeSlider?.addEventListener('touchend', () => { isScrubbing = false; });

        // Ensure slider has fine granularity for dragging
        if (timeSlider) timeSlider.step = "0.01";

        timeSlider?.addEventListener('input', () => {
            // When scrubbing, we explicitly set currentTime
            currentTime = parseFloat(timeSlider.value);
            const total = Math.ceil(this.duration);
            if (timeLabel) timeLabel.innerText = `Frame ${Math.floor(currentTime)} / ${total}`;

            // Immediate visual update
            if (this.splatEntity?.gsplat) {
                (this.splatEntity.gsplat as any).time = currentTime;
            }
        });

        // --- Interaction & Keyboard ---
        let isLMB = false;
        let isRMB = false;
        const lastMousePos = new pc.Vec2();
        const keys: Record<string, boolean> = {};
        let isUIInteracting = false;

        // Block camera when mouse is over UI panels
        const uiPanels = ['sidebar', 'time-controls'];
        uiPanels.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('mouseenter', () => { isUIInteracting = true; });
            el.addEventListener('mouseleave', () => { if (!activeScrubInput) isUIInteracting = false; });
            el.addEventListener('mousedown', (e) => e.stopPropagation());
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
        });

        window.addEventListener('mousemove', (e) => {
            if (!activeScrubInput) return;
            isUIInteracting = true;
            const delta = e.clientX - scrubStartX;
            const step = activeScrubInput.id.startsWith('rot') ? 1 : 0.05;
            const newVal = scrubStartVal + delta * step;

            activeScrubInput.value = activeScrubInput.id.startsWith('rot')
                ? Math.round(newVal).toString()
                : newVal.toFixed(2);

            updateObjectTransform();

            // Cache the update while scrubbing
            if (this.currentFileName) {
                this.saveTransformToCache(this.currentFileName);
            }
        });

        window.addEventListener('mouseup', () => {
            if (activeScrubInput) {
                activeScrubInput = null;
                isUIInteracting = false;
                document.body.style.cursor = 'default';
            }
        });

        // Initialize rotation state from default camera
        this.pitch = 0;
        this.yaw = 0;

        window.addEventListener('keydown', (e) => {
            if (isUIInteracting) return;
            keys[e.code] = true;
            if (e.code === 'Space') {
                e.preventDefault();
                togglePlay();
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

        this.app.on('update', (dt: number) => {
            // WASD Camera Movement - blocked only if we are actively scrubbing or focused on UI
            if (this.camera && !isUIInteracting) {
                const speed = dt * 5;
                if (keys['KeyW']) this.camera.translateLocal(0, 0, -speed);
                if (keys['KeyS']) this.camera.translateLocal(0, 0, speed);
                if (keys['KeyA']) this.camera.translateLocal(-speed, 0, 0);
                if (keys['KeyD']) this.camera.translateLocal(speed, 0, 0);
                if (keys['KeyQ']) this.camera.translateLocal(0, -speed, 0);
                if (keys['KeyE']) this.camera.translateLocal(0, speed, 0);
            }

            if (isPlaying) {
                // Use FPS-based playback
                currentTime += dt * this.fps;

                // Loop logic
                if (currentTime > this.duration) {
                    currentTime = 0;
                }

                // For UI, we floor to closest frame
                // For UI, we floor to closest frame
                const displayFrame = Math.floor(currentTime);
                const total = Math.ceil(this.duration); // Duration is roughly max frame index or count

                // Only auto-update slider if user is NOT scrubbing
                if (timeSlider && !isScrubbing) {
                    timeSlider.value = displayFrame.toString();
                }
                if (timeLabel) timeLabel.innerText = `Frame ${displayFrame} / ${total}`;

                // Update time uniform for custom shader
                if (this.splatEntity?.gsplat) {
                    const material = (this.splatEntity.gsplat as any).instance.material;
                    if (material) {
                        // User request: input 't' must be integer frame if playing as frames
                        const shaderTime = (this.duration > 1.0) ? Math.floor(currentTime) : currentTime;
                        material.setParameter('uTime', shaderTime);
                    }
                }
            } else {
                // Also update on scrub
                if (this.splatEntity?.gsplat) {
                    const material = (this.splatEntity.gsplat as any).instance.material;
                    if (material) {
                        const shaderTime = (this.duration > 1.0) ? Math.floor(currentTime) : currentTime;
                        material.setParameter('uTime', shaderTime);
                    }
                }
            }
        });
    }

    private handleFileSelect(e: Event) {
        const input = e.target as HTMLInputElement;
        if (input.files && input.files.length > 0) this.loadFile(input.files[0]);
    }

    private async loadFile(file: File) {
        if (!file.name.endsWith('.ply') && !file.name.endsWith('.splat')) {
            alert('Please drop a .ply or .splat file');
            return;
        }

        const overlay = document.getElementById('loading-overlay');
        const status = document.getElementById('loading-status');
        if (overlay) overlay.classList.remove('hidden');
        if (status) status.innerText = `Parsing Surface`;

        // Update filename for caching
        this.currentFileName = file.name;

        if (this.splatEntity) this.splatEntity.destroy();

        try {
            // 1. Pre-parse for PointCloud AND Lifetime Data
            const buffer = await file.arrayBuffer();
            let positions: Float32Array | null = null;
            let colors: Uint8Array | null = null;
            let lifetimes: Float32Array | null = null;

            if (file.name.endsWith('.ply')) {
                // Parse PLY with SH Injection
                const parsed = this.parsePly(buffer);
                if (parsed) {
                    // Create GSplatResource directly from our prepared data
                    const splatData = new pc.GSplatData(parsed.plyData.elements);
                    const resource = new pc.GSplatResource(this.app.graphicsDevice, splatData);

                    // --- Cache Positions for Selection (Must use reordered data from GSplatData) ---
                    const x = splatData.getProp('x');
                    const y = splatData.getProp('y');
                    const z = splatData.getProp('z');

                    if (x && y && z) {
                        // Safely determine count
                        const num = Math.min(splatData.numSplats, x.length, y.length, z.length);

                        this.cachedPositions = new Float32Array(num * 3);
                        for (let i = 0; i < num; i++) {
                            this.cachedPositions[i * 3 + 0] = x[i];
                            this.cachedPositions[i * 3 + 1] = y[i];
                            this.cachedPositions[i * 3 + 2] = z[i];
                        }
                    }
                    // -----------------------------------------------------------------------------

                    const asset = new pc.Asset('pointcloud', 'gsplat', {
                        url: ''
                    });
                    asset.resource = resource;
                    asset.loaded = true;
                    this.app.assets.add(asset);

                    // Recreate entity (previous one was destroyed)
                    this.splatEntity = new pc.Entity('GSplat');
                    this.splatEntity.addComponent('gsplat', { asset: asset });
                    this.app.root.addChild(this.splatEntity);

                    // --- Init Selection Tool NOW ---
                    if (this.cachedPositions) {
                        const num = this.cachedPositions.length / 3;
                        this.selectionTool.init(num);
                        this.selectionTool.setTool('none');
                    }
                    // -------------------------------

                    // Update Stats window to show "Creating Textures..."
                    if (status) status.innerText = "Creating Lifetime Texture";

                    // The GSplatResource constructor has already reordered the data (via GSplatData)
                    // We can now access the reordered 'lifetime_mu', 'w', 'k' arrays from the splatData.
                    const reorderedMu = splatData.getProp('lifetime_mu');
                    const reorderedW = splatData.getProp('lifetime_w');
                    const reorderedK = splatData.getProp('lifetime_k');

                    let lifeTexture: pc.Texture | null = null;

                    if (reorderedMu && reorderedW && reorderedK) {
                        // Determine texture size. Match color texture if possible, or calculate from count.
                        // PlayCanvas usually packs into a square-ish texture. 
                        // splatData.numSplats is accurate.
                        // Let's rely on the width used by the other textures.
                        // We can get it from the resource if available, or compute:
                        const width = (resource as any).startWidth || Math.ceil(Math.sqrt(splatData.numSplats));
                        const height = Math.ceil(splatData.numSplats / width);

                        console.log(`Creating Lifetime Texture: ${width}x${height} for ${splatData.numSplats} splats`);

                        const floatData = new Float32Array(width * height * 4); // R,G,B,A (Mu, W, K, Unused)
                        for (let i = 0; i < splatData.numSplats; i++) {
                            floatData[i * 4 + 0] = reorderedMu[i];
                            floatData[i * 4 + 1] = reorderedW[i];
                            floatData[i * 4 + 2] = reorderedK[i];
                            floatData[i * 4 + 3] = 0.0;
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
                            name: 'lifetimeParams'
                        });

                        const pixels = lifeTexture.lock();
                        // Assume pixels is Float32Array because format is RGBA32F? 
                        // PC internal storage might differ but .lock() usually returns TypedArray for the format.
                        // Actually, for WebGL1/2, manual upload via setSource/upload is safer if lock() isn't straightforward.
                        // But PC Texture constructor can take data in `levels` option or we can use setSource.
                        // Let's use simpler constructor or setSource.
                    }

                    // Re-create texture with data passed in constructor for simplicity if supported, 
                    // or just use Source. 
                    if (reorderedMu && reorderedW && reorderedK) {
                        // We already calculated floatData above.
                        // Let's recreate properly cleanly.
                    }

                    // CLEANER BLOCK:
                    if (reorderedMu && reorderedW && reorderedK) {
                        const width = Math.ceil(Math.sqrt(splatData.numSplats));
                        const height = Math.ceil(splatData.numSplats / width);
                        // Ensure it matches POT if needed? PC handles NPOT usually.

                        const texData = new Float32Array(width * height * 4);
                        for (let i = 0; i < splatData.numSplats; i++) {
                            texData[i * 4 + 0] = reorderedMu[i];
                            texData[i * 4 + 1] = reorderedW[i];
                            texData[i * 4 + 2] = reorderedK[i];
                            texData[i * 4 + 3] = 0;
                        }

                        lifeTexture = new pc.Texture(this.app.graphicsDevice, {
                            width: width,
                            height: height,
                            format: pc.PIXELFORMAT_RGBA32F,
                            mipmaps: false,
                            minFilter: pc.FILTER_NEAREST,
                            magFilter: pc.FILTER_NEAREST,
                            name: 'lifetimeTexture'
                        });

                        // Set blob
                        const levels = [texData];
                        (lifeTexture as any)._levels = levels; // Hack or use setSource?
                        // Correct API:
                        // lifeTexture.setSource(texData); // Not quite standard API for PC?
                        // lifeTexture.upload();

                        // Standard PC way for floats:
                        // lock() returns raw buffer.
                        const lockRef = lifeTexture.lock();
                        lockRef.set(texData);
                        lifeTexture.unlock();
                    }

                    // Setup Shader (Inject Lifetime Logic)
                    if (this.splatEntity.gsplat) {
                        this.setupLifetimeShader((this.splatEntity.gsplat as any).instance, lifeTexture);
                    }

                    // Update Time Slider
                    // Update Time Slider
                    this.duration = parsed.dataFrames ? parsed.dataFrames : (parsed.maxMu || 100);
                    const slider = document.getElementById('time-slider') as HTMLInputElement;
                    if (slider) {
                        slider.max = Math.ceil(this.duration).toString();
                        slider.step = "0.1";
                        slider.value = "0";
                    }

                    this.updateTimelineTicks(this.duration);

                    if (overlay) overlay.classList.add('hidden');
                    this.updateStats(asset);

                    // Attempt to load cached transform for this file
                    if (this.currentFileName) {
                        this.loadCachedTransform(this.currentFileName);
                    } else {
                        this.resetObjectTransformUI();
                    }

                    this.resetCamera();
                    return;
                }
            } else if (file.name.endsWith('.splat')) {
                // Parse Splat (Likely simplified, no lifetimes supported in standard .splat yet?)
                const parsed = this.parseSplat(buffer);
                if (parsed) {
                    positions = parsed.positions;
                    colors = parsed.colors;
                }
            }

            const url = URL.createObjectURL(file);
            const entity = new pc.Entity('GSplat');
            this.app.root.addChild(entity);
            this.splatEntity = entity;

            const asset = new pc.Asset(file.name, 'gsplat', { url: url });
            this.app.assets.add(asset);
            this.app.assets.load(asset);

            // Setup Point Cloud Entity - REMOVED per request
            // if (positions && colors) {
            //    this.createPointCloud(positions, colors, entity);
            // }

            asset.ready(() => {
                const component = entity.addComponent('gsplat', { asset: asset });
                if (overlay) overlay.classList.add('hidden');
                this.updateStats(asset);
                this.resetObjectTransformUI();
                this.resetCamera();

                // Clear ticks for static splat
                const container = document.getElementById('timeline-ticks');
                if (container) container.innerHTML = '';


                // 2. Inject (No lifetime via Url load yet? or implement later)
            });
        } catch (err) {
            console.error('Failed to load splat:', err);
            alert('Error loading splat file: ' + err);
            if (overlay) overlay.classList.add('hidden');
        }
    }

    // Expose for SelectionTool
    updateSelectionUniform(tex: pc.Texture) {
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
            positions: null, colors: null, lifetimes: null
        };
    }

    private resetCamera() {
        if (!this.camera) return;
        this.camera.setPosition(0, 1, 5);
        this.camera.setEulerAngles(0, 0, 0);
        this.pitch = 0;
        this.yaw = 0;
    }

    private updateStats(asset: pc.Asset) {
        // Stats display removed per user request
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