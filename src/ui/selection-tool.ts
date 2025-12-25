
import * as pc from 'playcanvas';

// SVG Icons for Selection Tools
const ICON_BRUSH = `<svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M20.71 5.63l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-3.12 3.12-1.93-1.91-1.41 1.41 1.42 1.42L3 19.29V21h1.71l11.96-8.92 1.42 1.42 1.41-1.41-1.92-1.92 3.12-3.12c.4-.4.4-1.03.01-1.42zM5.21 20c-.07.53-.51 1-1.21 1 0 0 0 0 0 0H3v-1.04c-.03.73.5 1.14 1.21 1.21.39.04.79-.12 1-.41z"/></svg>`;
const ICON_RECT = `<svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M4 6v12h16V6H4zm14 10H6V8h12v8z"/></svg>`;
const ICON_INVERT = `<svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.49 10 10-4.49 10-10 10zm-1-17.93C7.06 4.56 4 7.92 4 12s3.06 7.44 7 7.93V4.07z"/></svg>`;
const ICON_CLEAR = `<svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`;


// Export class
export class SelectionTool {
    app: pc.Application;
    viewer: any;
    selectionData: Uint8Array | null = null;
    selectionTexture: pc.Texture | null = null;

    // Tools
    currentTool: 'none' | 'brush' | 'rect' = 'none';
    brushRadius = 50; // pixels

    // State
    isSelecting = false;
    isSubtracting = false;
    startPos = new pc.Vec2();
    currentPos = new pc.Vec2();

    // UI
    toolbar!: HTMLElement;

    constructor(app: pc.Application, viewer: any) {
        this.app = app;
        this.viewer = viewer;

        this.setupUI();
        this.setupEvents();
    }

    init(numSplats: number) {
        // Init Selection Data
        const width = Math.ceil(Math.sqrt(numSplats));
        const height = Math.ceil(numSplats / width);
        console.log(`[Selection] Init for ${numSplats} splats. Texture: ${width}x${height}`);

        this.selectionData = new Uint8Array(width * height * 4); // RGBA8

        this.selectionTexture = new pc.Texture(this.app.graphicsDevice, {
            width: width,
            height: height,
            format: pc.PIXELFORMAT_R8_G8_B8_A8,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            name: 'selectionTexture'
        });

        this.clearSelection();
    }

    clearSelection() {
        if (!this.selectionData || !this.selectionTexture) return;
        this.selectionData.fill(0);
        this.updateTexture();
    }

    deleteSelected() {
        if (!this.selectionData) return;
        const positions = this.getCachedPositions();
        if (!positions) return;

        const totalSplats = positions.length / 3;
        let changed = false;

        for (let i = 0; i < totalSplats; i++) {
            const idx = i * 4;
            // If selected (R > 0)
            if (this.selectionData[idx] > 0) {
                // Mark as Deleted (G = 255)
                this.selectionData[idx + 1] = 255;
                // Clear selection (R = 0)
                this.selectionData[idx] = 0;
                changed = true;
            }
        }
        if (changed) {
            this.updateTexture();
        }
    }

    invertSelection(totalSplats: number) {
        if (!this.selectionData) return;
        for (let i = 0; i < totalSplats; i++) {
            const idx = i * 4;
            // Check if deleted (G > 0) - if so, skip
            if (this.selectionData[idx + 1] > 0) continue;

            // Invert R channel
            this.selectionData[idx] = this.selectionData[idx] > 0 ? 0 : 255;
        }
        this.updateTexture();
    }

    updateTexture() {
        if (!this.selectionTexture || !this.selectionData) return;

        // Lock and update
        const lock = this.selectionTexture.lock();
        lock.set(this.selectionData);
        this.selectionTexture.unlock();
        this.viewer.updateSelectionUniform(this.selectionTexture);
    }

    setupUI() {
        // Create Left Toolbar
        const div = document.createElement('div');
        div.id = 'selection-toolbar';
        div.className = 'fixed left-6 top-1/2 -translate-y-1/2 z-20 flex flex-row items-start gap-2 pointer-events-none transition-all duration-500';
        div.innerHTML = `
            <div class="flex flex-col gap-2">
                <!-- Main Tools -->
                <div class="glass-blue p-2 rounded-xl flex flex-col gap-2 pointer-events-auto">
                    <button id="tool-brush" class="p-2 rounded-lg hover:bg-white/10 active:scale-95 transition-all ui-text-secondary has-tooltip" aria-label="Brush Selection">
                        ${ICON_BRUSH}
                    </button>
                    <button id="tool-rect" class="p-2 rounded-lg hover:bg-white/10 active:scale-95 transition-all ui-text-secondary has-tooltip" aria-label="Area Selection">
                        ${ICON_RECT}
                    </button>
                    <div class="h-px bg-white/10 w-full my-1"></div>
                    <button id="tool-invert" class="p-2 rounded-lg hover:bg-white/10 active:scale-95 transition-all ui-text-secondary has-tooltip" aria-label="Invert Selection">
                        ${ICON_INVERT}
                    </button>
                    <button id="tool-clear" class="p-2 rounded-lg hover:bg-white/10 active:scale-95 transition-all ui-text-secondary has-tooltip" aria-label="Clear Selection">
                        ${ICON_CLEAR}
                    </button>
                </div>

                <!-- Delete Panel (Independent) -->
                <div class="glass-blue p-2 rounded-xl flex flex-col gap-2 pointer-events-auto items-center">
                     <button id="action-delete" class="p-2 rounded-lg hover:bg-red-500/20 text-red-500 active:scale-95 transition-all has-tooltip" aria-label="Delete Selected">
                        <svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </div>
            </div>
            
            <!-- Brush Settings (Hidden by default, shown on right) -->
            <div id="brush-settings" class="glass-blue p-3 rounded-xl pointer-events-auto hidden transition-all flex-col gap-2 items-center">
                <span class="text-[10px] uppercase font-bold ui-text-dim text-center whitespace-nowrap">Brush Size</span>
                <div class="h-32 w-8 flex items-center justify-center relative">
                    <!-- Standard slider rotated -90deg -->
                    <input type="range" id="brush-size" min="10" max="200" value="50" class="absolute w-32 h-2 bg-white/20 rounded-full appearance-none -rotate-90 origin-center cursor-pointer"/>
                </div>
                <span id="brush-size-val" class="text-xs text-center font-mono ui-text-highlight">50</span>
            </div>
        `;
        document.body.appendChild(div);

        // Create Brush Cursor Overlay
        const overlay = document.createElement('div');
        overlay.id = 'brush-cursor-overlay';
        overlay.className = 'fixed rounded-full border-2 border-white/50 pointer-events-none z-50 hidden -translate-x-1/2 -translate-y-1/2 mix-blend-difference';
        overlay.style.width = '100px';
        overlay.style.height = '100px';
        document.body.appendChild(overlay);

        this.toolbar = div;

        // Listeners
        const get = (id: string) => document.getElementById(id);

        get('tool-brush')?.addEventListener('click', () => this.setTool('brush'));
        get('tool-rect')?.addEventListener('click', () => this.setTool('rect'));
        get('tool-invert')?.addEventListener('click', () => {
            const positions = this.getCachedPositions();
            if (positions) {
                const num = positions.length / 3;
                this.invertSelection(num);
            }
        });
        get('tool-clear')?.addEventListener('click', () => this.clearSelection());

        get('action-delete')?.addEventListener('click', () => {
            this.deleteSelected();
        });

        get('brush-size')?.addEventListener('input', (e: any) => {
            this.brushRadius = parseInt(e.target.value);
            const valLabel = get('brush-size-val');
            if (valLabel) valLabel.innerText = this.brushRadius.toString();

            // Update overlay size
            const ov = document.getElementById('brush-cursor-overlay');
            if (ov) {
                ov.style.width = (this.brushRadius * 2) + 'px';
                ov.style.height = (this.brushRadius * 2) + 'px';
            }
        });
    }

    setTool(tool: 'brush' | 'rect' | 'none') {
        if (this.currentTool === tool && tool !== 'none') {
            this.currentTool = 'none'; // Toggle off if clicking the same tool
        } else {
            this.currentTool = tool;
        }

        // Notify Shader about Selection Mode
        if (this.viewer && typeof this.viewer.updateSelectionModeParams === 'function') {
            this.viewer.updateSelectionModeParams(this.currentTool !== 'none');
        }

        // UI Feedback
        const get = (id: string) => document.getElementById(id);
        const map: Record<string, string> = { 'brush': 'tool-brush', 'rect': 'tool-rect' };

        Object.values(map).forEach(id => get(id)?.classList.remove('bg-white/20', 'ui-text-highlight'));
        if (this.currentTool !== 'none' && map[this.currentTool]) {
            get(map[this.currentTool])?.classList.add('bg-white/20', 'ui-text-highlight');
        }

        // Show/Hide brush settings
        const settings = document.getElementById('brush-settings');
        if (this.currentTool === 'brush') {
            settings?.classList.remove('hidden');
            settings?.classList.add('flex');
            document.getElementById('brush-cursor-overlay')?.classList.remove('hidden');
        } else {
            settings?.classList.add('hidden');
            settings?.classList.remove('flex');
            document.getElementById('brush-cursor-overlay')?.classList.add('hidden');
        }
    }

    setupEvents() {
        // Need to hook into app mouse events
        window.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));

        // Key events for Alt modifier
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Alt') {
                this.isSubtracting = true;
                this.updateCursorState();
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === 'Alt') {
                this.isSubtracting = false;
                this.updateCursorState();
            }
        });
    }

    updateCursorState() {
        const overlay = document.getElementById('brush-cursor-overlay');
        if (overlay) {
            // Apply visual change to brush cursor
            if (this.isSubtracting) {
                overlay.style.borderColor = '#ef4444'; // Red-500
                overlay.style.borderStyle = 'dashed';
            } else {
                overlay.style.borderColor = 'rgba(255, 255, 255, 0.5)';
                overlay.style.borderStyle = 'solid';
            }
        }

        if (this.rectOverlay) {
            if (this.isSubtracting) {
                this.rectOverlay.className = 'fixed border-2 border-red-500 bg-red-500/20 pointer-events-none z-50';
                this.rectOverlay.style.borderStyle = 'dashed';
            } else {
                this.rectOverlay.className = 'fixed border-2 border-indigo-500 bg-indigo-500/20 pointer-events-none z-50';
                this.rectOverlay.style.borderStyle = 'solid';
            }
        }
    }

    onMouseDown(e: MouseEvent) {
        if (this.currentTool === 'none') return;
        // Check if hitting UI
        if ((e.target as HTMLElement).closest('.glass-blue')) return;

        this.isSelecting = true;
        this.startPos.set(e.clientX, e.clientY);
        this.currentPos.set(e.clientX, e.clientY);

        if (this.currentTool === 'brush') {
            this.performBrush(e.clientX, e.clientY);
        }
    }

    onMouseMove(e: MouseEvent) {
        // Update Brush Cursor
        const overlay = document.getElementById('brush-cursor-overlay');
        if (overlay && this.currentTool === 'brush') {
            overlay.style.left = e.clientX + 'px';
            overlay.style.top = e.clientY + 'px';
        }

        if (!this.isSelecting) return;
        this.currentPos.set(e.clientX, e.clientY);

        if (this.currentTool === 'brush') {
            this.performBrush(e.clientX, e.clientY);
        } else if (this.currentTool === 'rect') {
            // Draw visual rect overlay?
            this.drawRectOverlay();
        }
    }

    onMouseUp(e: MouseEvent) {
        if (!this.isSelecting) return;
        this.isSelecting = false;

        if (this.currentTool === 'rect') {
            this.performRect(this.startPos.x, this.startPos.y, e.clientX, e.clientY);
            this.removeRectOverlay();
        }
    }

    // --- Selection Logic ---

    getCachedPositions() {
        if (!this.viewer.splatEntity) return null;
        // Ideally we cached this on load
        return this.viewer.cachedPositions;
    }

    performBrush(cx: number, cy: number) {
        const positions = this.getCachedPositions();
        if (!positions || !this.selectionData) return;

        const camera = this.viewer.camera?.camera;
        if (!camera) return;

        const rSq = this.brushRadius * this.brushRadius;
        const width = this.app.graphicsDevice.width;
        const height = this.app.graphicsDevice.height;

        let changed = false;

        // Iterate all points (Optimization needed for millions, but JS is okay for <500k usually)
        // Access positions: 3 floats per point
        const numSplats = positions.length / 3;
        const screen = new pc.Vec3();

        const modelMat = this.viewer.splatEntity.getWorldTransform();
        const localPos = new pc.Vec3();
        const worldPos = new pc.Vec3();

        for (let i = 0; i < numSplats; i++) {
            localPos.set(
                positions[i * 3 + 0],
                positions[i * 3 + 1],
                positions[i * 3 + 2]
            );

            modelMat.transformPoint(localPos, worldPos);

            camera.worldToScreen(worldPos, screen);

            // Check
            if (screen.z > 0) { // In front of camera
                const dx = screen.x - cx;
                const dy = screen.y - cy;
                if (dx * dx + dy * dy < rSq) {
                    const idx = i * 4;

                    // Skip if deleted
                    if (this.selectionData[idx + 1] > 0) continue;

                    if (this.isSubtracting) {
                        if (this.selectionData[idx] > 0) {
                            this.selectionData[idx] = 0;
                            changed = true;
                        }
                    } else {
                        if (this.selectionData[idx] === 0) {
                            this.selectionData[idx] = 255;
                            changed = true;
                        }
                    }
                }
            }
        }

        if (changed) this.updateTexture();
    }

    performRect(x1: number, y1: number, x2: number, y2: number) {
        const positions = this.getCachedPositions();
        if (!positions || !this.selectionData) return;

        const camera = this.viewer.camera?.camera;
        if (!camera) return;

        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);

        let changed = false;
        const numSplats = positions.length / 3;
        const screen = new pc.Vec3();

        const modelMat = this.viewer.splatEntity.getWorldTransform();
        const localPos = new pc.Vec3();
        const worldPos = new pc.Vec3();

        for (let i = 0; i < numSplats; i++) {
            localPos.set(
                positions[i * 3 + 0],
                positions[i * 3 + 1],
                positions[i * 3 + 2]
            );

            modelMat.transformPoint(localPos, worldPos);

            camera.worldToScreen(worldPos, screen);

            if (screen.z > 0) {
                if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
                    const idx = i * 4;

                    // Skip if deleted
                    if (this.selectionData[idx + 1] > 0) continue;

                    if (this.isSubtracting) {
                        if (this.selectionData[idx] > 0) {
                            this.selectionData[idx] = 0;
                            changed = true;
                        }
                    } else {
                        if (this.selectionData[idx] === 0) {
                            this.selectionData[idx] = 255;
                            changed = true;
                        }
                    }
                }
            }
        }
        if (changed) this.updateTexture();
    }

    rectOverlay: HTMLElement | null = null;
    drawRectOverlay() {
        if (!this.rectOverlay) {
            this.rectOverlay = document.createElement('div');
            this.rectOverlay.className = 'fixed border-2 pointer-events-none z-50';
            document.body.appendChild(this.rectOverlay);
        }

        // Apply style based on mode
        if (this.isSubtracting) {
            this.rectOverlay.className = 'fixed border-2 border-red-500 bg-red-500/20 pointer-events-none z-50';
            this.rectOverlay.style.borderStyle = 'dashed';
        } else {
            this.rectOverlay.className = 'fixed border-2 border-indigo-500 bg-indigo-500/20 pointer-events-none z-50';
            this.rectOverlay.style.borderStyle = 'solid';
        }

        const x = Math.min(this.startPos.x, this.currentPos.x);
        const y = Math.min(this.startPos.y, this.currentPos.y);
        const w = Math.abs(this.startPos.x - this.currentPos.x);
        const h = Math.abs(this.startPos.y - this.currentPos.y);

        this.rectOverlay.style.left = x + 'px';
        this.rectOverlay.style.top = y + 'px';
        this.rectOverlay.style.width = w + 'px';
        this.rectOverlay.style.height = h + 'px';
    }

    removeRectOverlay() {
        if (this.rectOverlay) {
            this.rectOverlay.remove();
            this.rectOverlay = null;
        }
    }
}
