import * as pc from 'playcanvas';
import { splatCoreVS, splatMainVS, splatMainPS } from './shaders/gsplat-shader';
import { TrueSplatsLoader } from './utils/truesplats-loader';
import { SOG4Loader } from './utils/sog4-loader';
import { PLY4Loader } from './utils/ply4-loader';
import { SkyboxManager } from './managers/skybox-manager';

interface SampleItem {
    name: string;
    url: string;
    img?: string;
    model_id?: string;
    skybox?: string;
    duration?: string;
    size?: string;
}

class ShowViewer {
    app: pc.Application;
    camera: pc.Entity | null = null;
    splatEntity: pc.Entity | null = null;

    private pitch = 0;
    private yaw = 0;
    private isPlaying = false;
    private currentTime = 0;
    private playbackTime = 0;
    private fps = 30;
    private duration = 1;
    private totalFrames = 0;

    // 4D state
    private is4DGS = false;
    private trajectoryData: Float32Array | null = null;
    private keyframes = 0;
    private xyzStride = 1;
    private rotTrajectoryData: Float32Array | null = null;
    private rotKeyframes = 0;
    private rotStride = 1;
    private lifeTexData: Float32Array | null = null;
    private scalesTexData: Float32Array | null = null;
    private originalIndices: Float32Array | null = null;
    private posArrays: { x: Float32Array, y: Float32Array, z: Float32Array } | null = null;
    private lastUpdatedFrame = -1;
    private cachedPositions: Float32Array | null = null;

    // Sort state
    private isWaitingForSort = false;
    private sortingTaskID = 0;
    private lastCompletedSortTaskID = 0;
    private pendingSortedFrame: number | null = null;
    private sorterUpdateInterval = 1;
    private sorterUpdateFrame = 0;

    // Samples
    private samples: SampleItem[] = [];
    private isProcessingLoad = false;
    private currentSampleIndex = -1;

    // Skybox
    private skyboxManager: SkyboxManager;
    private selectedSkyboxName = 'paul_lobe_haus_2k';

    // Orbit
    private isOrbitMode = true;
    private orbitDistance = 5.0;

    // Camera control state (reset on model load)
    private isLMB = false;
    private isRMB = false;
    private lastMousePos = new pc.Vec2();
    private lastTouchDistance = 0;
    private lastTouchPos = new pc.Vec2();
    private prevTouchCount = 0;
    public isUIHovered = false;

    // Swizzle / render mode
    private swizzleMode = 1;
    private gaussianRenderMode = 0;

    private frameCount = 0;
    private frameTimer = 0;
    private luminanceTimer = 0;

    constructor() {
        const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;
        if (!canvas) throw new Error('Canvas not found');

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
                    preserveDrawingBuffer: true, // #WDD 2026-05-12 Required for gl.readPixels HUD luminance detection
                    powerPreference: 'high-performance'
                }
            });
        } catch (e) {
            console.warn('High-performance WebGL failed, retrying...', e);
            this.app = new pc.Application(canvas, options);
        }

        this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
        this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
        this.app.graphicsDevice.maxPixelRatio = window.devicePixelRatio;

        window.addEventListener('resize', () => {
            this.app.resizeCanvas();
            this.orbitCameraUpdates(); // #WDD 2026-05-12 Refresh centering on resize
        });

        this.skyboxManager = new SkyboxManager(this.app);
        this.setupScene();
        this.setupCameraControls();
        this.setupSkyboxSelector();
        this.setupGaussianRenderModeSelector();
        this.setupPlaybar();
        this.setupGallery();
        this.setupUIIsolation();
        this.loadSamples();

        this.app.start();
        this.app.on('update', (dt: number) => this.onUpdate(dt));

        (window as any).showViewer = this;
    }

    private setupUIIsolation() {
        const uiSelectors = ['header', 'nav', '.info-panel', '.data-panel', 'footer', '.selection-zone', '#about-modal', '#show-loading-overlay'];
        uiSelectors.forEach(selector => {
            const el = document.querySelector(selector);
            if (el) {
                el.addEventListener('mouseenter', () => { this.isUIHovered = true; });
                el.addEventListener('mouseleave', () => { this.isUIHovered = false; });
                // Also block touch events
                el.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
                el.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: false });
            }
        });
    }

    private setupScene() {
        // Light
        const light = new pc.Entity('Light');
        light.addComponent('light', {
            type: 'directional',
            color: new pc.Color(1, 1, 1),
            castShadows: false,
            intensity: 1
        });
        light.setEulerAngles(45, 30, 0);
        this.app.root.addChild(light);

        // Ambient
        this.app.scene.ambientLight = new pc.Color(0.2, 0.2, 0.2);

        // Camera
        const camera = new pc.Entity('Camera');
        camera.addComponent('camera', {
            clearColor: new pc.Color(0.1, 0.1, 0.1, 1),
            farClip: 1000,
            fov: 45
        });
        camera.setPosition(0, 0, 5);
        this.app.root.addChild(camera);
        this.camera = camera;

        this.setSkybox(this.selectedSkyboxName);
    }

    public setSkybox(name: string) {
        if (name === 'none') {
            this.skyboxManager.clearSkybox();
            return;
        }
        const ext = (name.includes('Helipad') || name.startsWith('bg_')) ? '.png' : '.hdr';
        const url = `./skybox/${name}${ext}`;
        const asset = new pc.Asset(name, 'texture', { url });
        this.app.assets.add(asset);
        this.skyboxManager.setSkyboxAsset(asset);
    }

    public setSkyboxBlur(value: number) {
        // #WDD 2026-05-12 Proxy blur control to manager
        this.skyboxManager.setBlur(value);
    }

    public applyCameraPreset(idx: number) {
        const v = this as any;
        const presets = v.presetManager?.cameraPresets;
        if (presets && presets[idx]) {
            const p = presets[idx];
            this.pitch = p.pitch || 0;
            this.yaw = p.yaw || 0;
            // If pos exists, use its distance from center
            if (p.pos) {
                this.orbitDistance = p.pos.length();
            }
            this.orbitCameraUpdates();
        }
    }

    // ===================== Camera Controls =====================
    private setupCameraControls() {
        const keys: Record<string, boolean> = {};

        this.app.mouse.on(pc.EVENT_MOUSEDOWN, (e: any) => {
            if (e.button === pc.MOUSEBUTTON_LEFT) this.isLMB = true;
            if (e.button === pc.MOUSEBUTTON_RIGHT) this.isRMB = true;
            // Always sync lastMousePos on mousedown to prevent jump after model switch
            this.lastMousePos.set(e.x, e.y);
        });

        window.addEventListener('mouseup', () => { this.isLMB = false; this.isRMB = false; });

        this.app.mouse.on(pc.EVENT_MOUSEMOVE, (e: pc.MouseEvent) => {
            if (!this.camera || this.isUIHovered) return;
            const dx = e.x - this.lastMousePos.x;
            const dy = e.y - this.lastMousePos.y;

            if (this.isLMB) {
                // Skip first move after reset to prevent camera jump
                if (this.lastMousePos.x === 0 && this.lastMousePos.y === 0) {
                    this.lastMousePos.set(e.x, e.y);
                    return;
                }
                this.yaw -= dx * 0.2;
                this.pitch -= dy * 0.2;
                this.pitch = Math.max(-89, Math.min(89, this.pitch));
                this.orbitDistance = Math.max(1.0, this.camera.getPosition().length());
                this.orbitCameraUpdates();
            } else if (this.isRMB) {
                // Skip first move after reset to prevent camera jump
                if (this.lastMousePos.x === 0 && this.lastMousePos.y === 0) {
                    this.lastMousePos.set(e.x, e.y);
                    return;
                }
                this.camera.translateLocal(-dx * 0.01, dy * 0.01, 0);
            }
            this.lastMousePos.set(e.x, e.y);
        });

        this.app.mouse.on(pc.EVENT_MOUSEWHEEL, (e: any) => {
            if (!this.camera || this.isUIHovered) return;
            this.orbitDistance -= e.wheel * 0.5;
            this.orbitDistance = Math.max(1.0, this.orbitDistance);
            this.orbitCameraUpdates();
        });

        this.app.touch.on(pc.EVENT_TOUCHSTART, (e: any) => {
            this.prevTouchCount = e.touches.length;
            if (e.touches.length === 1) {
                this.lastMousePos.set(e.touches[0].x, e.touches[0].y);
            } else if (e.touches.length === 2) {
                const t0 = e.touches[0], t1 = e.touches[1];
                this.lastTouchDistance = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                this.lastTouchPos.set((t0.x + t1.x) / 2, (t0.y + t1.y) / 2);
            }
        });

        this.app.touch.on(pc.EVENT_TOUCHMOVE, (e: any) => {
            if (!this.camera) return;
            if (e.touches.length !== this.prevTouchCount) {
                this.prevTouchCount = e.touches.length;
                if (e.touches.length === 1) this.lastMousePos.set(e.touches[0].x, e.touches[0].y);
                return;
            }
            if (e.touches.length === 1) {
                const t = e.touches[0];
                const dx = t.x - this.lastMousePos.x;
                const dy = t.y - this.lastMousePos.y;
                this.yaw -= dx * 0.2;
                this.pitch -= dy * 0.2;
                this.pitch = Math.max(-89, Math.min(89, this.pitch));
                this.orbitCameraUpdates();
                this.lastMousePos.set(t.x, t.y);
            } else if (e.touches.length === 2) {
                const t0 = e.touches[0], t1 = e.touches[1];
                const dist = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                const deltaDist = dist - this.lastTouchDistance;
                this.orbitDistance -= deltaDist * 0.02;
                this.orbitDistance = Math.max(1.0, this.orbitDistance);
                this.orbitCameraUpdates();
                this.lastTouchDistance = dist;
            }
        });

        this.app.touch.on(pc.EVENT_TOUCHEND, (e: any) => {
            if (e.touches.length === 0) this.prevTouchCount = 0;
        });

        // Keyboard
        window.addEventListener('keydown', (e) => {
            keys[e.code] = true;
            if (e.code === 'Space') {
                e.preventDefault();
                this.togglePlay();
            }
        });
        window.addEventListener('keyup', (e) => { keys[e.code] = false; });

        this.app.on('update', (dt: number) => {
            if (!this.camera) return;
            const speed = dt * 5;
            let changed = false;
            if (keys['KeyW']) { this.orbitDistance = Math.max(1.0, this.orbitDistance - speed); changed = true; }
            if (keys['KeyS']) { this.orbitDistance = Math.max(1.0, this.orbitDistance + speed); changed = true; }
            if (changed) this.orbitCameraUpdates();
        });
    }

    private orbitCameraUpdates() {
        if (!this.camera) return;
        const pitchRad = this.pitch * pc.math.DEG_TO_RAD;
        const yawRad = this.yaw * pc.math.DEG_TO_RAD;
        const x = this.orbitDistance * Math.cos(pitchRad) * Math.sin(yawRad);
        const y = this.orbitDistance * Math.sin(pitchRad);
        const z = this.orbitDistance * Math.cos(pitchRad) * Math.cos(yawRad);

        this.camera.setPosition(x, y, z);
        this.camera.lookAt(0, 0, 0);

        // #WDD 2026-05-12 Shift visual center to 3/5 of screen width using Projection Matrix Offset
        // On Mobile (<1024px), center it (0.0 offset)
        const camera = this.camera.camera;
        if (camera) {
            (camera as any)._projectionMatrixDataDirty = true; 
            const proj = (camera as any).projectionMatrix;
            const isMobile = window.innerWidth < 1024;
            proj.data[8] = isMobile ? 0 : -0.2; // 0 = Centered, -0.2 = Shifted for HUD
        }
    }

    private resetCamera() {
        if (!this.camera) return;
        this.orbitDistance = 5.0;
        this.pitch = 0;
        this.yaw = 0;
        this.orbitCameraUpdates();
    }

    // ===================== Playbar =====================
    private setupSkyboxSelector() {
        const list = document.getElementById('env-dropdown-list');
        if (list) {
            list.addEventListener('click', (e) => {
                const item = (e.target as HTMLElement).closest('.env-item') as HTMLElement;
                if (item && item.dataset.sky) {
                    this.setSkybox(item.dataset.sky);
                    const nameEl = document.getElementById('data-skybox');
                    if (nameEl) nameEl.textContent = item.textContent || '---';
                }
            });
        }
        const slider = document.getElementById('bg-blur-slider') as HTMLInputElement;
        const valText = document.getElementById('blur-val-text');
        if (slider) {
            slider.addEventListener('input', () => {
                const val = parseFloat(slider.value);
                if (valText) valText.textContent = val.toFixed(1);
                this.skyboxManager.setBlur(val);
            });
        }
    }

    private setupGaussianRenderModeSelector() {
        const list = document.getElementById('render-mode-list');
        if (list) {
            list.addEventListener('click', (e) => {
                const item = (e.target as HTMLElement).closest('.env-item') as HTMLElement;
                if (item && item.dataset.mode) {
                    this.setGaussianRenderMode(parseInt(item.dataset.mode));
                }
            });
        }
    }

    private setupPlaybar() {
        const playBtn = document.getElementById('show-play-pause') as HTMLButtonElement;
        const slider = document.getElementById('show-time-slider') as HTMLInputElement;
        const fpsBtns = document.querySelectorAll('.show-fps-btn');

        playBtn?.addEventListener('click', () => this.togglePlay());

        slider?.addEventListener('input', () => {
            const frame = parseFloat(slider.value);
            this.seekToFrame(frame);
        });

        fpsBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const val = parseInt((btn as HTMLElement).dataset.fps || '30');
                this.fps = val;
                fpsBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }

    private togglePlay() {
        this.isPlaying = !this.isPlaying;
        const playBtn = document.getElementById('show-play-pause');
        if (playBtn) {
            // #WDD 2026-05-12 Update icons to match new UI style
            playBtn.innerHTML = this.isPlaying
                ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`
                : `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        }
    }

    private seekToFrame(frame: number) {
        this.currentTime = Math.max(0, Math.min(frame, this.duration - 1));
        this.playbackTime = this.currentTime;
        if (this.is4DGS && this.trajectoryData) {
            this.updateDynamicPositions(Math.floor(this.currentTime));
        }
        if (this.splatEntity?.gsplat) {
            const material = (this.splatEntity.gsplat as any).instance?.material;
            if (material) {
                material.setParameter('uTime', Math.floor(this.currentTime));
                material.setParameter('uGlobalTotalFrames', this.duration);
            }
        }
        this.syncTimeUI();
    }

    private syncTimeUI() {
        const slider = document.getElementById('show-time-slider') as HTMLInputElement;
        const cur = document.getElementById('show-current-frame');
        const tot = document.getElementById('show-total-frames');
        if (slider) slider.value = String(Math.floor(this.currentTime));
        if (cur) cur.textContent = String(Math.floor(this.currentTime));
        if (tot) tot.textContent = String(Math.max(0, Math.ceil(this.duration) - 1));
    }

    // ===================== Gallery =====================
    private galleryHoverTimer: number | null = null;

    private navigateGallery(dir: number) {
        const scroll = document.getElementById('gallery-scroll');
        if (!scroll) return;
        
        // Scroll by 3 items at a time for a smooth transition
        const scrollAmount = (200 + 25) * 3; 
        scroll.scrollBy({ left: dir * scrollAmount, behavior: 'smooth' });
        
        // The dots will be updated via scroll listener
    }

    private setupGallery() {
        const prev = document.getElementById('nav-prev');
        const next = document.getElementById('nav-next');
        const scroll = document.getElementById('gallery-scroll');
        
        if (prev) prev.onclick = () => this.navigateGallery(-1);
        if (next) next.onclick = () => this.navigateGallery(1);

        if (scroll) {
            // Wheel support
            scroll.addEventListener('wheel', (e) => {
                e.preventDefault();
                scroll.scrollLeft += e.deltaY;
            });

            // Drag-to-scroll support
            let isDown = false;
            let startX: number;
            let scrollLeft: number;

            scroll.addEventListener('mousedown', (e) => {
                isDown = true;
                scroll.classList.add('grabbing');
                startX = e.pageX - scroll.offsetLeft;
                scrollLeft = scroll.scrollLeft;
            });

            scroll.addEventListener('mouseleave', () => {
                isDown = false;
                scroll.classList.remove('grabbing');
            });

            scroll.addEventListener('mouseup', () => {
                isDown = false;
                scroll.classList.remove('grabbing');
            });

            scroll.addEventListener('mousemove', (e) => {
                if (!isDown) return;
                e.preventDefault();
                e.stopPropagation();
                const x = e.pageX - scroll.offsetLeft;
                const walk = (x - startX) * 2; // scroll-fast
                scroll.scrollLeft = scrollLeft - walk;
            });

            // Prevent wheel from zooming camera
            scroll.addEventListener('wheel', (e) => {
                e.stopPropagation();
            }, { passive: false });

            // Prevent all clicks from leaking to camera
            ['mousedown', 'mouseup', 'click', 'dblclick'].forEach(evt => {
                scroll.addEventListener(evt, (e) => e.stopPropagation());
            });

            scroll.addEventListener('scroll', () => this.updateGalleryScrollbar());
            // Initial sync
            setTimeout(() => this.updateGalleryScrollbar(), 100);
        }
    }

    private updateGalleryScrollbar() {
        const scroll = document.getElementById('gallery-scroll');
        const thumb = document.getElementById('gallery-thumb');
        if (!scroll || !thumb) return;

        const scrollWidth = scroll.scrollWidth;
        const clientWidth = scroll.clientWidth;
        const scrollLeft = scroll.scrollLeft;

        // Calculate width of thumb as ratio of visible area
        const thumbWidthRatio = Math.min(1, clientWidth / scrollWidth);
        thumb.style.width = `${thumbWidthRatio * 100}%`;

        // Calculate left position
        const maxScroll = scrollWidth - clientWidth;
        const scrollProgress = maxScroll > 0 ? scrollLeft / maxScroll : 0;
        const thumbMaxTravel = 100 - (thumbWidthRatio * 100);
        thumb.style.left = `${scrollProgress * thumbMaxTravel}%`;
    }

    private async loadSamples() {
        const scroll = document.getElementById('gallery-scroll');
        if (!scroll) return;

        try {
            const res = await fetch('./samples.json');
            if (!res.ok) throw new Error('Failed to load samples');
            this.samples = await res.json() as SampleItem[];

            const dotsContainer = document.getElementById('scrollbar-dots');
            if (dotsContainer) dotsContainer.innerHTML = '';

            scroll.innerHTML = '';
            this.samples.forEach((sample, idx) => {
                const item = document.createElement('div');
                item.className = 'gallery-item';
                item.dataset.index = String(idx);
                
                // Detroit-style rich UI structure
                item.innerHTML = `
                    <div class="scanline"></div>
                    <div class="item-bracket tl"></div>
                    <div class="item-bracket br"></div>
                    <img src="${sample.img}" alt="${sample.name}" loading="lazy" onerror="this.style.display='none'" />
                    <div class="analysis-bar"><div class="analysis-fill"></div></div>
                    <div class="item-info-overlay">
                        <div class="item-meta">ANALYZING SUBJECT...</div>
                        <div class="item-no">CAST ID: 0${idx + 1}</div>
                        <div class="item-name">${sample.name}</div>
                    </div>
                `;
                item.addEventListener('click', () => this.loadSample(idx));
                scroll.appendChild(item);

                // Add mini dots to scrollbar
                if (dotsContainer) {
                    const miniDot = document.createElement('div');
                    miniDot.className = 'mini-dot';
                    dotsContainer.appendChild(miniDot);
                }
            });

            // Auto-load first sample
            if (this.samples.length > 0) {
                this.loadSample(0);
            }
        } catch (err) {
            console.error('Failed to load samples:', err);
            scroll.innerHTML = '<div style="padding:12px;color:rgba(255,255,255,0.5);font-size:12px;">Failed to load samples</div>';
            this.showLoading(false);
        }
    }

    private async loadSample(index: number) {
        if (this.isProcessingLoad) return;
        if (index < 0 || index >= this.samples.length) return;

        this.isProcessingLoad = true;
        
        // Immediate Cleanup to avoid overlapping
        if (this.splatEntity) {
            this.splatEntity.destroy();
            this.splatEntity = null;
        }

        // Update active states in UI
        document.querySelectorAll('.gallery-item').forEach((el, i) => {
            el.classList.toggle('active', i === index);
        });
        // Update dots state in UI
        document.querySelectorAll('.mini-dot').forEach((el, i) => {
            el.classList.toggle('active', i === index);
        });

        this.currentSampleIndex = index;

        // Update active state in gallery
        document.querySelectorAll('.gallery-item').forEach((el, i) => {
            el.classList.toggle('active', i === index);
        });

        const sample = this.samples[index];
        const hugeName = document.getElementById('character-name-huge');
        if (hugeName) hugeName.textContent = sample.name;

        // Sync Metadata
        const setVal = (id: string, val?: string) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val || '---';
        };
        setVal('data-model-id', sample.model_id);
        setVal('data-skybox', sample.skybox?.replace(/_/g, ' ').toUpperCase());
        setVal('data-duration', sample.duration);
        setVal('data-size', sample.size);

        // #WDD 2026-05-12 Emit custom event for UI updates in show.html
        window.dispatchEvent(new CustomEvent('sampleChanged', {
            detail: {
                ...sample,
                index: index,
                total: this.samples.length
            }
        }));

        // #WDD 2026-05-12 Update skybox based on sample data
        if (sample.skybox) {
            this.setSkybox(sample.skybox);
        }

        await this.loadModelUrl(sample.url, sample.name);
    }

    // ===================== Model Loading =====================
    private async loadModelUrl(url: string, name: string) {
        this.showLoading(true, 'Initializing...');
        const progressOverlay = document.getElementById('loading-progress-circle');
        const progressRing = document.getElementById('progress-ring-fill');
        const progressText = document.getElementById('progress-percent');
        const statusText = document.getElementById('loading-status-text');

        const updateUI = (pct: number, status: string) => {
            if (progressText) progressText.textContent = `${Math.round(pct)}%`;
            if (statusText) statusText.textContent = status;
            if (progressRing) {
                const offset = 283 - (283 * pct) / 100;
                progressRing.style.strokeDashoffset = String(offset);
            }
        };

        if (progressOverlay) progressOverlay.style.display = 'flex';
        updateUI(0, 'Connecting...');

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const contentLength = response.headers.get('content-length');
            const total = parseInt(contentLength || '0', 10);
            
            let blob: Blob;
            if (total === 0) {
                blob = await response.blob();
                updateUI(85, 'Finalizing...');
            } else {
                const reader = response.body?.getReader();
                if (!reader) throw new Error('Failed to get reader');

                let loaded = 0;
                const chunks = [];
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    loaded += value.length;
                    
                    // Download maps to 0-85%
                    const downloadPct = (loaded / total) * 85;
                    updateUI(downloadPct, 'Downloading Data');
                }
                blob = new Blob(chunks);
            }

            updateUI(90, 'Processing Assets');
            const filename = url.split('/').pop() || name;
            await this.loadFile(new File([blob], filename));
            updateUI(100, 'System Ready');

            // #WDD 2026-05-12 Check for camera presets and notify UI
            const v = this as any;
            if (v.presetManager?.cameraPresets?.length > 0) {
                window.dispatchEvent(new CustomEvent('camerasChanged', {
                    detail: { presets: v.presetManager.cameraPresets.map((p: any) => p.name) }
                }));
            } else {
                window.dispatchEvent(new CustomEvent('camerasChanged', { detail: { presets: [] } }));
            }

        } catch (err) {
            console.error('Load error:', err);
            alert('Failed to load model: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            this.isProcessingLoad = false;
            setTimeout(() => {
                if (progressOverlay) progressOverlay.style.display = 'none';
                this.showLoading(false);
            }, 500);
        }
    }

    private async loadFile(file: File) {
        const overlay = document.getElementById('show-loading-overlay');
        const status = document.getElementById('show-loading-text');
        const detail = document.getElementById('show-loading-detail');

        const setProgress = (s: string, d?: string) => {
            overlay?.classList.remove('hidden');
            if (status) status.textContent = s;
            if (detail) detail.textContent = d || '';
        };

        setProgress('Parsing...', file.name);

        // Cleanup previous
        if (this.splatEntity) {
            this.splatEntity.destroy();
            this.splatEntity = null;
        }
        this.is4DGS = false;
        this.trajectoryData = null;
        this.keyframes = 0;
        this.rotTrajectoryData = null;
        this.rotKeyframes = 0;
        this.lifeTexData = null;
        this.scalesTexData = null;
        this.posArrays = null;
        this.cachedPositions = null;
        this.isWaitingForSort = false;
        this.sortingTaskID = 0;
        this.lastCompletedSortTaskID = 0;
        this.pendingSortedFrame = null;
        this.sorterUpdateFrame = 0;

        // Reset camera control state
        this.isLMB = false;
        this.isRMB = false;
        this.lastMousePos.set(0, 0);
        this.lastTouchDistance = 0;
        this.lastTouchPos.set(0, 0);
        this.prevTouchCount = 0;

        try {
            const lowerName = file.name.toLowerCase();
            let parsed: any;
            let loader: any;

            if (lowerName.endsWith('.sog4') || lowerName.endsWith('.sog')) {
                loader = new SOG4Loader(this.app);
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress('Loading...', msg);
                });
            } else if (lowerName.endsWith('.ply4') || lowerName.endsWith('.ply')) {
                loader = new PLY4Loader();
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress('Loading...', msg);
                });
            } else if (lowerName.endsWith('.truesplats')) {
                loader = new TrueSplatsLoader(this.app);
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress('Loading...', msg);
                });
            } else {
                loader = new TrueSplatsLoader(this.app);
                parsed = await loader.load(file);
            }

            if (!parsed) throw new Error('Parse returned empty');

            const elements = parsed?.plyData?.elements;
            if (!Array.isArray(elements) || elements.length === 0) {
                throw new Error('Invalid parsed data');
            }

            const vertexElement = elements[0];
            const splatData = new (pc.GSplatData as any)([vertexElement]);
            const resource = new pc.GSplatResource(this.app.graphicsDevice, splatData);

            const blobUrl = URL.createObjectURL(file);
            const asset = new pc.Asset(file.name, 'gsplat', { url: blobUrl });
            asset.resource = resource;
            asset.loaded = true;
            this.app.assets.add(asset);

            const entity = new pc.Entity('GSplat');
            entity.addComponent('gsplat', { asset });
            this.app.root.addChild(entity);
            this.splatEntity = entity;

            // Apply transform
            if (parsed.model_transform) {
                const t = parsed.model_transform;
                if (t.pos) entity.setLocalPosition(t.pos[0], t.pos[1], t.pos[2]);
                if (t.rot) entity.setLocalRotation(new pc.Quat(t.rot[0], t.rot[1], t.rot[2], t.rot[3]));
                if (t.scale) entity.setLocalScale(t.scale[0], t.scale[1], t.scale[2]);
            } else if (parsed.meta) {
                if (parsed.meta.modelPos) entity.setLocalPosition(parsed.meta.modelPos);
                if (parsed.meta.modelRot) entity.setLocalRotation(parsed.meta.modelRot);
                if (parsed.meta.modelScale) entity.setLocalScale(parsed.meta.modelScale);
            }

            // Reset camera: use model's first camera preset if available, else default orbit
            if (parsed.cameras && Array.isArray(parsed.cameras) && parsed.cameras.length > 0) {
                const c = parsed.cameras[0];
                this.camera?.setPosition(c.pos[0], c.pos[1], c.pos[2]);
                this.pitch = c.pitch ?? 0;
                this.yaw = c.yaw ?? 0;
                this.camera?.setEulerAngles(this.pitch, this.yaw, 0);
                // Derive orbit distance from camera position
                const camPos = this.camera!.getPosition();
                this.orbitDistance = Math.sqrt(camPos.x * camPos.x + camPos.y * camPos.y + camPos.z * camPos.z);
            } else {
                this.resetCamera();
            }

            const count = parsed.count || 0;
            const countEl = document.getElementById('show-splat-count');
            if (countEl) countEl.textContent = count.toLocaleString();

            const duration = parsed.frames || parsed.maxMu || 100;
            this.duration = duration;
            this.totalFrames = duration;
            this.currentTime = 0;
            this.playbackTime = 0;

            // Update slider max
            const slider = document.getElementById('show-time-slider') as HTMLInputElement;
            if (slider) {
                slider.max = String(Math.max(1, Math.ceil(duration) - 1));
                slider.value = '0';
            }
            this.syncTimeUI();

            // Finalize
            this.finalizeGSplatLoad(asset, count, parsed);

            // Auto-play
            if (!this.isPlaying) this.togglePlay();

            setTimeout(() => this.showLoading(false), 300);
        } catch (e) {
            console.error('Load error:', e);
            alert('Error: ' + (e instanceof Error ? e.message : String(e)));
            this.showLoading(false);
        }
    }

    private finalizeGSplatLoad(asset: pc.Asset, numSplats: number, parsed: any) {
        const splatData = (asset.resource as pc.GSplatResource).splatData;
        const res = asset.resource as any;
        let width = Math.ceil(Math.sqrt(numSplats));
        if (res?.colorTexture) width = res.colorTexture.width;
        else if (res?.transformATexture) width = res.transformATexture.width;
        const height = Math.ceil(numSplats / width);

        // Cache positions
        const x = splatData.getProp('x'), y = splatData.getProp('y'), z = splatData.getProp('z');
        if (x && y && z) {
            this.posArrays = { x: x as Float32Array, y: y as Float32Array, z: z as Float32Array };
            const num = Math.min(splatData.numSplats, x.length, y.length, z.length);
            this.cachedPositions = new Float32Array(num * 3);
            for (let i = 0; i < num; i++) {
                this.cachedPositions[i * 3 + 0] = x[i];
                this.cachedPositions[i * 3 + 1] = y[i];
                this.cachedPositions[i * 3 + 2] = z[i];
            }
        }

        this.originalIndices = splatData.getProp('original_index') as Float32Array | null;

        // Lifetime texture
        const mu = splatData.getProp('lifetime_mu');
        const w = splatData.getProp('lifetime_w');
        const kArr = splatData.getProp('lifetime_k');
        let lifeTexture: pc.Texture | null = null;
        if (mu && w) {
            this.lifeTexData = new Float32Array(width * height * 4);
            for (let i = 0; i < numSplats; i++) {
                this.lifeTexData[i * 4 + 0] = mu[i];
                this.lifeTexData[i * 4 + 1] = w[i];
                this.lifeTexData[i * 4 + 2] = kArr ? kArr[i] : 10.0;
                this.lifeTexData[i * 4 + 3] = 0.0;
            }
            lifeTexture = new pc.Texture(this.app.graphicsDevice, {
                width, height, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'lifetimeTexture'
            });
            const dst = lifeTexture.lock();
            new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4).set(this.lifeTexData);
            lifeTexture.unlock();
        }

        // Trajectory texture
        let trajectoryTexture: pc.Texture | null = null;
        if (parsed?.trajectory) {
            this.is4DGS = true;
            this.trajectoryData = parsed.trajectory as Float32Array;
            this.keyframes = parsed.keyframes || 0;
            this.xyzStride = parsed.xyzStride || 1;

            const trajData = parsed.trajectory as Float32Array;
            const K = parsed.keyframes || 0;
            const texWidth = 4096;
            const texHeight = Math.ceil((numSplats * K) / texWidth);

            trajectoryTexture = new pc.Texture(this.app.graphicsDevice, {
                width: texWidth, height: texHeight, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'trajectoryTexture'
            });
            const dst = trajectoryTexture.lock();
            const texData = new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4);
            const origIndices = splatData.getProp('original_index');

            for (let i = 0; i < numSplats; i++) {
                const oidx = origIndices ? Math.round(origIndices[i]) : i;
                const base = oidx * K * 3;
                for (let k = 0; k < K; k++) {
                    const srcOff = base + k * 3;
                    const dstOff = (i * K + k) * 4;
                    texData[dstOff + 0] = trajData[srcOff + 0];
                    texData[dstOff + 1] = trajData[srcOff + 1];
                    texData[dstOff + 2] = trajData[srcOff + 2];
                    texData[dstOff + 3] = 1.0;
                }
            }
            trajectoryTexture.unlock();
        }

        // Rotation texture
        let rotationTexture: pc.Texture | null = null;
        if (parsed?.rotTrajectory) {
            this.rotTrajectoryData = parsed.rotTrajectory as Float32Array;
            this.rotKeyframes = parsed.rotKeyframes || 0;
            this.rotStride = parsed.rotStride || 1;

            const rotData = parsed.rotTrajectory as Float32Array;
            const semantic = parsed.rotationSemantic === 'xyzw' ? 'xyzw' : 'wxyz';
            const Kvar = parsed.rotKeyframes || 0;
            const texWidth = 4096;
            const texHeight = Math.ceil((numSplats * Kvar) / texWidth);

            rotationTexture = new pc.Texture(this.app.graphicsDevice, {
                width: texWidth, height: texHeight, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'rotationTexture'
            });
            const dst = rotationTexture.lock();
            const texData = new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4);
            const origIndices = splatData.getProp('original_index');

            for (let i = 0; i < numSplats; i++) {
                const oidx = origIndices ? Math.round(origIndices[i]) : i;
                for (let k = 0; k < Kvar; k++) {
                    const srcOff = (oidx * Kvar + k) * 4;
                    const dstOff = (i * Kvar + k) * 4;
                    if (semantic === 'xyzw') {
                        texData[dstOff + 0] = rotData[srcOff + 0];
                        texData[dstOff + 1] = rotData[srcOff + 1];
                        texData[dstOff + 2] = rotData[srcOff + 2];
                        texData[dstOff + 3] = rotData[srcOff + 3];
                    } else {
                        texData[dstOff + 0] = rotData[srcOff + 1];
                        texData[dstOff + 1] = rotData[srcOff + 2];
                        texData[dstOff + 2] = rotData[srcOff + 3];
                        texData[dstOff + 3] = rotData[srcOff + 0];
                    }
                }
            }
            rotationTexture.unlock();
        }

        // Scales texture
        let scalesTexture: pc.Texture | null = null;
        const s0 = splatData.getProp('scale_0');
        const s1 = splatData.getProp('scale_1');
        const s2 = splatData.getProp('scale_2');
        if (s0 && s1 && s2) {
            scalesTexture = new pc.Texture(this.app.graphicsDevice, {
                width, height, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'scalesTexture'
            });
            const dst = scalesTexture.lock();
            const texData = new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4);
            for (let i = 0; i < splatData.numSplats; i++) {
                texData[i * 4 + 0] = s0[i];
                texData[i * 4 + 1] = s1[i];
                texData[i * 4 + 2] = s2[i];
                texData[i * 4 + 3] = 0.0;
            }
            this.scalesTexData = new Float32Array(texData);
            scalesTexture.unlock();
        }

        if (this.splatEntity?.gsplat) {
            const instance = (this.splatEntity.gsplat as any).instance;

            // Intercept sorter worker
            if (instance?.sorter?.worker) {
                const worker = instance.sorter.worker;
                const self = this;
                const oldOnMessage = worker.onmessage;
                worker.onmessage = function (e: MessageEvent) {
                    if (oldOnMessage) oldOnMessage.call(worker, e);
                    if (self.isWaitingForSort) {
                        self.isWaitingForSort = false;
                        self.lastCompletedSortTaskID = self.sortingTaskID;
                        if (self.pendingSortedFrame !== null) {
                            self.applyVisible4DFrame(self.pendingSortedFrame);
                            self.pendingSortedFrame = null;
                        }
                    }
                };
            }

            this.setupShader(instance, lifeTexture, trajectoryTexture, parsed?.keyframes || 0,
                rotationTexture, parsed?.rotKeyframes || 0, this.duration, scalesTexture, parsed?.bands || 3);
        }
    }

    private setupShader(
        instance: any,
        lifetimeTexture: pc.Texture | null,
        trajectoryTexture: pc.Texture | null,
        keyframes: number,
        rotationTexture: pc.Texture | null,
        rotKeyframes: number,
        totalFrames: number,
        scalesTexture: pc.Texture | null,
        bands: number
    ) {
        const material = instance.material;
        material.setParameter('uTime', 0.0);
        material.setParameter('uTransitionFactor', 0.0);
        material.setParameter('uRotationFactor', 0.0);
        material.setParameter('uSwizzleMode', this.swizzleMode);
        material.setParameter('uOpacityScale', 1.0);
        material.setParameter('uRenderMode', this.gaussianRenderMode);
        material.setParameter('isSelectionMode', 0.0);

        if (lifetimeTexture) material.setParameter('lifetimeTexture', lifetimeTexture);
        if (totalFrames > 0) material.setParameter('uGlobalTotalFrames', totalFrames);
        if (trajectoryTexture) {
            material.setParameter('uTrajectoryTexture', trajectoryTexture);
            material.setParameter('uKeyframes', keyframes);
            material.setParameter('uXYZStride', this.xyzStride);
        }
        if (rotationTexture) {
            material.setParameter('uRotationTexture', rotationTexture);
            material.setParameter('uRotKeyframes', rotKeyframes);
            material.setParameter('uRotStride', this.rotStride);
        }
        if (scalesTexture) material.setParameter('uScalesTexture', scalesTexture);

        // Create a dummy 1x1 selection texture to satisfy shader uniform requirement
        // The shader reads selectionTexture in multiple places; without it all splats get discarded
        const dummySelectionTex = new pc.Texture(this.app.graphicsDevice, {
            width: 1,
            height: 1,
            format: pc.PIXELFORMAT_R8_G8_B8_A8,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            name: 'selectionTexture'
        });
        const dummyLock = dummySelectionTex.lock();
        dummyLock.set(new Uint8Array([0, 0, 0, 0]));
        dummySelectionTex.unlock();
        material.setParameter('selectionTexture', dummySelectionTex);

        material.setParameter('uBrightness', 0.0);
        material.setParameter('uContrast', 1.0);
        material.setParameter('uExposure', 1.0);

        const originalGetShaderVariant = material.getShaderVariant;
        material.getShaderVariant = function (device: any, scene: any, defs: any, unused: any, pass: any) {
            const library = device.getProgramLibrary();
            const originalGetProgram = library.getProgram;

            library.getProgram = function (name: string, options: any, processingOptions: any) {
                if (name === 'splat') {
                    if (!options.defines) options.defines = [];
                    if (lifetimeTexture && !options.defines.includes('USE_LIFETIME_TEXTURE'))
                        options.defines.push('USE_LIFETIME_TEXTURE');
                    if (trajectoryTexture && !options.defines.includes('USE_TRAJECTORY'))
                        options.defines.push('USE_TRAJECTORY');
                    if (rotationTexture && !options.defines.includes('USE_ROTATION'))
                        options.defines.push('USE_ROTATION');
                    if (bands >= 1 && !options.defines.includes('USE_SH1')) options.defines.push('USE_SH1');
                    if (bands >= 2 && !options.defines.includes('USE_SH2')) options.defines.push('USE_SH2');
                    if (bands >= 3 && !options.defines.includes('USE_SH3')) options.defines.push('USE_SH3');

                    const shaderPassInfo = (pc as any).ShaderPass?.get(device)?.getByIndex?.(options.pass);
                    let passDefines = shaderPassInfo?.shaderDefines ? `${shaderPassInfo.shaderDefines}\n` : '';
                    if (options.pass === 2) {
                        if (!passDefines.includes('PICK_PASS')) passDefines += '#define PICK_PASS\n';
                    }
                    const optionDefines = options.defines.map((d: string) => `#define ${d}`).join('\n');
                    const defines = passDefines + optionDefines + '\n';
                    const version = '#version 300 es\n';
                    const vsCode = version + defines + splatCoreVS + splatMainVS;
                    const fsCode = version + defines + 'precision mediump float;\n' + splatMainPS;

                    return new pc.Shader(device, {
                        attributes: {
                            vertex_position: pc.SEMANTIC_POSITION,
                            vertex_id_attrib: pc.SEMANTIC_ATTR13
                        },
                        vshader: vsCode,
                        fshader: fsCode
                    });
                }
                return originalGetProgram.call(this, name, options, processingOptions);
            };

            const result = originalGetShaderVariant.apply(this, arguments);
            library.getProgram = originalGetProgram;
            return result;
        };

        if ((material as any).clearVariants) (material as any).clearVariants();
        material.update();
    }

    // ===================== 4D Update =====================
    private onUpdate(dt: number) {
        if (this.isPlaying) {
            const globalMaxTime = Math.max(0, this.duration - 1.0);

            if (this.is4DGS && this.trajectoryData) {
                this.playbackTime += dt * this.fps;
                if (this.playbackTime > globalMaxTime) this.playbackTime = 0;
                if (!this.isWaitingForSort) {
                    const nextFrame = Math.floor(this.playbackTime);
                    if (nextFrame !== Math.floor(this.currentTime)) {
                        this.requestSortedFrame(nextFrame);
                    }
                }
            } else {
                if (!this.isWaitingForSort) {
                    this.currentTime += dt * this.fps;
                }
                if (this.currentTime > globalMaxTime) this.currentTime = 0;
            }

            let displayFrame = 0;
            if (this.is4DGS && this.trajectoryData) {
                displayFrame = Math.floor(this.playbackTime);
            } else {
                displayFrame = Math.floor(this.currentTime);
            }

            const slider = document.getElementById('show-time-slider') as HTMLInputElement;
            if (slider) slider.value = String(displayFrame);
            this.syncTimeUI();
        } else {
            if (this.is4DGS && this.trajectoryData && !this.isWaitingForSort) {
                this.updateDynamicPositions(Math.floor(this.currentTime));
            }
            if (this.splatEntity?.gsplat) {
                const material = (this.splatEntity.gsplat as any).instance?.material;
                if (material) {
                    material.setParameter('uTime', Math.floor(this.currentTime));
                    material.setParameter('uGlobalTotalFrames', this.duration);
                }
            }
        }

        // #WDD 2026-05-12 Calculate FPS and update HUD
        this.frameCount++;
        this.frameTimer += dt;
        if (this.frameTimer >= 0.5) {
            const fps = Math.round(this.frameCount / this.frameTimer);
            const fpsEl = document.getElementById('show-fps');
            if (fpsEl) fpsEl.textContent = `${fps} FPS`;
            this.frameCount = 0;
            this.frameTimer = 0;
        }
    }

    private requestSortedFrame(frame: number) {
        if (!this.is4DGS || !this.trajectoryData) {
            this.currentTime = Math.max(0, Math.floor(frame));
            this.playbackTime = this.currentTime;
            return;
        }
        const targetFrame = Math.max(0, Math.floor(frame));
        if (this.isWaitingForSort) return;
        if (targetFrame === Math.floor(this.currentTime)) return;
        this.pendingSortedFrame = targetFrame;
        this.updateDynamicPositions(targetFrame);
    }

    private applyVisible4DFrame(frame: number) {
        const clamped = Math.max(0, Math.floor(frame));
        this.currentTime = clamped;
        if (!this.isPlaying) this.playbackTime = clamped;
        if (this.splatEntity?.gsplat) {
            const material = (this.splatEntity.gsplat as any).instance?.material;
            if (material) {
                material.setParameter('uTime', clamped);
                material.setParameter('uGlobalTotalFrames', this.duration);
            }
        }
        this.syncTimeUI();
    }

    private updateDynamicPositions(time: number) {
        if (!this.posArrays || !this.trajectoryData || !this.is4DGS) return;
        if (!this.splatEntity || !this.splatEntity.gsplat) return;

        const frameIdx = Math.floor(time);
        if (frameIdx === this.lastUpdatedFrame && this.isPlaying) return;
        this.lastUpdatedFrame = frameIdx;

        const K = this.keyframes;
        const stride = this.xyzStride;
        const traj = this.trajectoryData;
        const N = this.posArrays.x.length;

        const keyframeMax = Math.max(0, (K - 1) * stride);
        const maxTime = Math.max(0, Math.min(this.duration - 1, keyframeMax));
        const tClamped = Math.max(0, Math.min(time, maxTime));
        const idx = stride > 0 ? Math.floor(tClamped / stride) : 0;
        const k0 = K <= 1 ? 0 : Math.min(Math.max(0, idx), K - 1);
        const k1 = K <= 1 ? 0 : Math.min(k0 + 1, K - 1);
        const t0 = k0 * stride;
        const t1 = k1 * stride;
        const ratio = (k0 === k1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));

        const xArr = this.posArrays.x;
        const yArr = this.posArrays.y;
        const zArr = this.posArrays.z;
        const origIndices = this.originalIndices;
        const instance = (this.splatEntity.gsplat as any).instance;
        const centers = instance?.sorter?.centers;

        for (let i = 0; i < N; i++) {
            const oidx = origIndices ? Math.round(origIndices[i]) : i;
            const base = oidx * K * 3;
            const b0 = base + k0 * 3;
            const b1 = base + k1 * 3;
            const nx = traj[b0 + 0] + (traj[b1 + 0] - traj[b0 + 0]) * ratio;
            const ny = traj[b0 + 1] + (traj[b1 + 1] - traj[b0 + 1]) * ratio;
            const nz = traj[b0 + 2] + (traj[b1 + 2] - traj[b0 + 2]) * ratio;
            xArr[i] = nx;
            yArr[i] = ny;
            zArr[i] = nz;
            if (centers) {
                centers[i * 3 + 0] = nx;
                centers[i * 3 + 1] = ny;
                centers[i * 3 + 2] = nz;
            }
        }

        if (centers && instance.sorter.worker) {
            const shouldUpdate = !this.isPlaying || (this.sorterUpdateFrame++ % this.sorterUpdateInterval === 0);
            if (shouldUpdate) {
                this.isWaitingForSort = true;
                this.sortingTaskID++;
                const centersCopy = new Float32Array(centers);
                instance.sorter.worker.postMessage({ centers: centersCopy.buffer }, [centersCopy.buffer]);
            }
        }
    }

    public setGaussianRenderMode(mode: number) {
        this.gaussianRenderMode = mode;
        if (this.splatEntity?.gsplat) {
            const material = (this.splatEntity.gsplat as any).instance?.material;
            if (material) {
                material.setParameter('uRenderMode', this.gaussianRenderMode);
            }
        }
    }

    // ===================== Loading UI =====================
    private showLoading(show: boolean, text?: string, detail?: string) {
        const overlay = document.getElementById('show-loading-overlay');
        const status = document.getElementById('show-loading-text');
        const det = document.getElementById('show-loading-detail');
        if (show) {
            overlay?.classList.remove('hidden');
            if (status) status.textContent = text || 'Loading';
            if (det) det.textContent = detail || '';
        } else {
            overlay?.classList.add('hidden');
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new ShowViewer();
});
