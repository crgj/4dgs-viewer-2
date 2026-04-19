
import * as pc from 'playcanvas';

// SVG Icons for Selection Tools
const ICON_BRUSH = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M20.71 5.63l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-3.12 3.12-1.93-1.91-1.41 1.41 1.42 1.42L3 19.29V21h1.71l11.96-8.92 1.42 1.42 1.41-1.41-1.92-1.92 3.12-3.12c.4-.4.4-1.03.01-1.42zM5.21 20c-.07.53-.51 1-1.21 1 0 0 0 0 0 0H3v-1.04c-.03.73.5 1.14 1.21 1.21.39.04.79-.12 1-.41z"/></svg>`;
const ICON_RECT = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M4 6v12h16V6H4zm14 10H6V8h12v8z"/></svg>`;
const ICON_INVERT = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.49 10 10-4.49 10-10 10zm-1-17.93C7.06 4.56 4 7.92 4 12s3.06 7.44 7 7.93V4.07z"/></svg>`;
const ICON_CLEAR = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`;
// Center point icon (dot in center)
const ICON_CENTER = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><circle cx="12" cy="12" r="3"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" opacity="0.5"/></svg>`;
// Ellipse/Edge icon (circle with ring)
const ICON_ELLIPSE = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3"/></svg>`;
// Undo icon
const ICON_UNDO = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>`;
// Redo icon
const ICON_REDO = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z"/></svg>`;
// All-Time Brush icon with clock badge
const ICON_BRUSH_ALLTIME = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5"><path fill="currentColor" transform="scale(0.8) translate(1, 3)" d="M20.71 5.63l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-3.12 3.12-1.93-1.91-1.41 1.41 1.42 1.42L3 19.29V21h1.71l11.96-8.92 1.42 1.42 1.41-1.41-1.92-1.92 3.12-3.12c.4-.4.4-1.03.01-1.42zM5.21 20c-.07.53-.51 1-1.21 1 0 0 0 0 0 0H3v-1.04c-.03.73.5 1.14 1.21 1.21.39.04.79-.12 1-.41z"/><circle cx="19" cy="5" r="4" fill="currentColor" opacity="0.2"/><circle cx="19" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M19 3v2l1.2 0.8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;
// All-Time Rect icon with clock badge
const ICON_RECT_ALLTIME = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5"><path fill="currentColor" transform="scale(0.8) translate(1, 3)" d="M4 6v12h16V6H4zm14 10H6V8h12v8z"/><circle cx="19" cy="5" r="4" fill="currentColor" opacity="0.2"/><circle cx="19" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M19 3v2l1.2 0.8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>`;
// Help/Question icon
const ICON_HELP = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>`;


// Export class
export class SelectionTool {
    app: pc.Application;
    viewer: any;
    selectionData: Uint8Array | null = null;
    selectionTexture: pc.Texture | null = null;
    
    // #WDD 2026-04-11: All-time selection for invert operation
    // Stores points that are in selection area at ANY time (not just current time)
    allTimeSelectionData: Uint8Array | null = null;

    // Tools
    currentTool: 'none' | 'brush' | 'rect' | 'brush-alltime' | 'rect-alltime' = 'none';
    selectionMode: 'center' | 'ellipse' = 'center';
    brushRadius = 50; // pixels

    // State
    isSelecting = false;
    isSubtracting = false;
    startPos = new pc.Vec2();
    currentPos = new pc.Vec2();
    brushPath: Array<{x: number, y: number}> = []; // #WDD 2026-04-18: Deferred all-time brush path

    // UI
    toolbar!: HTMLElement;

    // #WDD 2026-04-10: Undo/Redo for deletion
    private readonly MAX_HISTORY = 30;
    private undoStack: Array<{ type: 'delete'; indices: number[] }> = [];
    private redoStack: Array<{ type: 'delete'; indices: number[] }> = [];

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
        this.allTimeSelectionData = new Uint8Array(width * height * 4); // RGBA8 for all-time selection

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
        this.clearHistory(); // #WDD 2026-04-10: Clear undo/redo history
    }

    // Sequence mode can require matching the gsplat internal texture dimensions (width/height),
    // as the shader indexes selectionTexture using the same splatUV as transform textures.
    initWithSize(numSplats: number, width: number, height: number) {
        console.log(`[Selection] InitWithSize for ${numSplats} splats. Texture: ${width}x${height}`);

        this.selectionData = new Uint8Array(width * height * 4); // RGBA8
        this.allTimeSelectionData = new Uint8Array(width * height * 4); // RGBA8 for all-time selection

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
        this.clearHistory(); // #WDD 2026-04-10: Clear undo/redo history
    }

    clearSelection() {
        if (!this.selectionData || !this.selectionTexture) return;

        // Only clear the Selection Channel (R), preserve Deleted Channel (G)
        // usage: R=Selection, G=Deleted
        const len = this.selectionData.length;
        for (let i = 0; i < len; i += 4) {
            this.selectionData[i] = 0;
        }

        // #WDD 2026-04-11: Clear all-time selection as well
        if (this.allTimeSelectionData) {
            const allTimeLen = this.allTimeSelectionData.length;
            for (let i = 0; i < allTimeLen; i += 4) {
                this.allTimeSelectionData[i] = 0;
            }
        }

        this.updateTexture();
    }

    deleteSelected() {
        if (!this.selectionData) return;
        const positions = this.getCachedPositions();
        if (!positions) return;

        const totalSplats = positions.length / 3;
        const deletedIndices: number[] = [];

        for (let i = 0; i < totalSplats; i++) {
            const idx = i * 4;
            // If selected (R > 0)
            if (this.selectionData[idx] > 0) {
                // Record this index for undo
                deletedIndices.push(i);
                // Mark as Deleted (G = 255)
                this.selectionData[idx + 1] = 255;
                // Clear selection (R = 0)
                this.selectionData[idx] = 0;
            }
        }

        if (deletedIndices.length > 0) {
            // #WDD 2026-04-10: Push to undo stack
            this.undoStack.push({ type: 'delete', indices: deletedIndices });
            // Clear redo stack since we made a new change
            this.redoStack = [];
            // Limit undo stack size
            if (this.undoStack.length > this.MAX_HISTORY) {
                this.undoStack.shift();
            }
            this.updateTexture();
            console.log(`[Selection] Deleted ${deletedIndices.length} points. Undo stack: ${this.undoStack.length}`);
        }
    }

    invertSelection(totalSplats: number) {
        // #WDD 2026-04-18: Invert selection based on current tool mode
        // Normal tools: only invert currently visible points
        // All-time tools: invert all non-deleted points globally
        if (!this.selectionData) return;
        
        const isAllTime = this.isAllTimeTool();
        
        for (let i = 0; i < totalSplats; i++) {
            const idx = i * 4;
            // Skip deleted points (G > 0)
            if (this.selectionData[idx + 1] > 0) continue;
            
            // All-time tools: invert all non-deleted points
            // Normal tools: only invert currently visible points
            if (isAllTime || this.isVisibleAtCurrentTime(i)) {
                this.selectionData[idx] = this.selectionData[idx] > 0 ? 0 : 255;
            }
        }
        
        this.updateTexture();
    }

    // #WDD 2026-01-18 Restore deleted state
    restoreDeletedIndices(indices: number[]) {
        if (!this.selectionData || !indices) return;

        for (let i = 0; i < indices.length; i++) {
            const splatIdx = indices[i];
            const idx = splatIdx * 4;
            if (idx < this.selectionData.length) {
                this.selectionData[idx] = 0;   // Clear selection
                this.selectionData[idx + 1] = 255; // Mark Deleted
            }
        }
        this.updateTexture();
    }

    // #WDD 2026-04-10: Undo last deletion
    undo() {
        if (this.undoStack.length === 0) {
            console.log('[Selection] Nothing to undo');
            return;
        }

        const action = this.undoStack.pop()!;
        
        if (action.type === 'delete') {
            // Restore deleted points (clear G channel)
            for (const splatIdx of action.indices) {
                const idx = splatIdx * 4;
                if (idx < this.selectionData!.length) {
                    this.selectionData![idx + 1] = 0; // Clear deleted flag
                }
            }
            this.updateTexture();
            
            // Push to redo stack
            this.redoStack.push(action);
            console.log(`[Selection] Undo: restored ${action.indices.length} points. Undo: ${this.undoStack.length}, Redo: ${this.redoStack.length}`);
        }
    }

    // #WDD 2026-04-10: Redo last undone action
    redo() {
        if (this.redoStack.length === 0) {
            console.log('[Selection] Nothing to redo');
            return;
        }

        const action = this.redoStack.pop()!;
        
        if (action.type === 'delete') {
            // Delete again (set G channel to 255)
            for (const splatIdx of action.indices) {
                const idx = splatIdx * 4;
                if (idx < this.selectionData!.length) {
                    this.selectionData![idx + 1] = 255; // Mark as deleted
                    this.selectionData![idx] = 0;       // Clear selection
                }
            }
            this.updateTexture();
            
            // Push back to undo stack
            this.undoStack.push(action);
            console.log(`[Selection] Redo: deleted ${action.indices.length} points. Undo: ${this.undoStack.length}, Redo: ${this.redoStack.length}`);
        }
    }

    // #WDD 2026-04-10: Clear undo/redo history (e.g., on new file load)
    clearHistory() {
        this.undoStack = [];
        this.redoStack = [];
        console.log('[Selection] History cleared');
    }

    // #WDD 2026-04-10: Help Modal
    private helpModal: HTMLElement | null = null;

    createHelpModal() {
        const modal = document.createElement('div');
        modal.id = 'help-modal';
        modal.className = 'fixed inset-0 z-50 hidden flex items-center justify-center bg-black/60 backdrop-blur-sm';
        modal.innerHTML = `
            <div class="glass-blue p-6 rounded-xl max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto shadow-2xl border border-white/10">
                <div class="flex justify-between items-center mb-4 pb-3 border-b border-white/10">
                    <h2 class="text-lg font-bold text-white flex items-center gap-2">
                        <svg viewBox="0 0 24 24" class="w-6 h-6 fill-current text-yellow-400"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>
                        使用帮助
                    </h2>
                    <button id="help-close" class="p-1 hover:bg-white/10 rounded-lg transition-colors">
                        <svg viewBox="0 0 24 24" class="w-6 h-6 fill-current text-gray-400 hover:text-white"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
                
                <div class="space-y-4 text-sm">
                    <!-- 选择工具 -->
                    <div>
                        <h3 class="text-xs uppercase font-bold text-emerald-400 mb-2 tracking-wider">选择工具</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">1</kbd>
                                <span>切换<strong>笔刷选择</strong>工具（再按关闭）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">2</kbd>
                                <span>切换<strong>矩形选择</strong>工具（再按关闭）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">3</kbd>
                                <span>切换<strong>全时段笔刷</strong>工具（选中所有帧可见点）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">4</kbd>
                                <span>切换<strong>全时段矩形</strong>工具（选中所有帧可见点）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Alt</kbd>
                                <span>按住进入<strong>减选模式</strong>（从选区移除）</span>
                            </li>
                        </ul>
                    </div>

                    <!-- 选择模式 -->
                    <div>
                        <h3 class="text-xs uppercase font-bold text-blue-400 mb-2 tracking-wider">选择模式</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2">
                                <span class="w-2 h-2 rounded-full bg-blue-400"></span>
                                <span><strong>中心模式</strong> - 仅选择中心点在选区内的点</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <span class="w-2 h-2 rounded-full bg-purple-400"></span>
                                <span><strong>椭圆模式</strong> - 考虑点的屏幕空间大小</span>
                            </li>
                        </ul>
                    </div>

                    <!-- 删除操作 -->
                    <div>
                        <h3 class="text-xs uppercase font-bold text-red-400 mb-2 tracking-wider">删除操作</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Delete</kbd>
                                <span>删除当前<strong>选中的点</strong></span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Z</kbd>
                                <span><strong>撤销</strong>删除（最多30步）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Y</kbd>
                                <span>或 <kbd class="px-1.5 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Shift+Z</kbd> <strong>重做</strong>删除</span>
                            </li>
                        </ul>
                    </div>

                    <!-- 时间感知选择 -->
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                        <h3 class="text-xs uppercase font-bold text-yellow-400 mb-1 tracking-wider">💡 提示</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            选择工具现在是<strong>时间感知</strong>的！只会选择当前时刻可见的点。
                            播放动画时，当前时刻会自动更新。
                        </p>
                        <p class="text-gray-300 text-xs leading-relaxed mt-1">
                            <strong>全时段选择</strong>（<kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">3</kbd> / <kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">4</kbd>）可选中所有时间帧内可见的点，适合清理跨帧噪点。
                        </p>
                    </div>
                </div>

                <div class="mt-4 pt-3 border-t border-white/10 text-center">
                    <p class="text-xs text-gray-500">按 <kbd class="px-1.5 py-0.5 bg-white/5 rounded text-xs">ESC</kbd> 或点击空白处关闭</p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.helpModal = modal;

        // Close button
        modal.querySelector('#help-close')?.addEventListener('click', () => this.hideHelpModal());
        
        // Click outside to close
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideHelpModal();
        });
    }

    toggleHelpModal() {
        if (!this.helpModal) return;
        if (this.helpModal.classList.contains('hidden')) {
            this.helpModal.classList.remove('hidden');
        } else {
            this.hideHelpModal();
        }
    }

    hideHelpModal() {
        this.helpModal?.classList.add('hidden');
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
                <!-- Selection Tools (4 tools together) -->
                <div class="glass-blue p-1.5 rounded-lg flex flex-col gap-1.5 pointer-events-auto">
                    <button id="tool-brush" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Brush Selection">
                        ${ICON_BRUSH}
                    </button>
                    <button id="tool-rect" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Area Selection">
                        ${ICON_RECT}
                    </button>
                    <div class="h-px ui-border w-full my-1"></div>
                    <button id="tool-brush-alltime" class="ui-btn p-1.5 rounded-lg has-tooltip text-amber-400 alltime-tool" aria-label="All-Time Brush Selection">
                        ${ICON_BRUSH_ALLTIME}
                    </button>
                    <button id="tool-rect-alltime" class="ui-btn p-1.5 rounded-lg has-tooltip text-amber-400 alltime-tool" aria-label="All-Time Area Selection">
                        ${ICON_RECT_ALLTIME}
                    </button>
                </div>

                <!-- Operations: Invert / Clear / Undo / Redo -->
                <div class="glass-blue p-1.5 rounded-lg flex flex-col gap-1.5 pointer-events-auto items-center">
                    <button id="tool-invert" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Invert Selection">
                        ${ICON_INVERT}
                    </button>
                    <button id="tool-clear" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Clear Selection">
                        ${ICON_CLEAR}
                    </button>
                    <div class="h-px ui-border w-full my-1"></div>
                    <button id="action-undo" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Undo (Ctrl+Z)">
                        ${ICON_UNDO}
                    </button>
                    <button id="action-redo" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Redo (Ctrl+Y)">
                        ${ICON_REDO}
                    </button>
                </div>

                <!-- Selection Mode -->
                <div class="glass-blue p-1.5 rounded-lg flex flex-col gap-1.5 pointer-events-auto">
                    <button id="select-mode-center" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Center Mode">
                        ${ICON_CENTER}
                    </button>
                    <button id="select-mode-ellipse" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Ellipse Mode">
                        ${ICON_ELLIPSE}
                    </button>
                </div>

                <!-- Delete Panel -->
                <div class="glass-blue p-1.5 rounded-lg flex flex-col gap-1.5 pointer-events-auto items-center">
                     <button id="action-delete" class="p-1.5 rounded-lg hover:bg-red-500/20 text-red-500 active:scale-95 transition-all has-tooltip" aria-label="Delete Selected">
                        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </div>

                <!-- Help Panel -->
                <div class="glass-blue p-1.5 rounded-lg flex flex-col gap-1.5 pointer-events-auto items-center">
                    <button id="action-help" class="ui-btn p-2 rounded-lg has-tooltip text-yellow-400" aria-label="Help (Shortcuts)">
                        ${ICON_HELP}
                    </button>
                </div>
            </div>
            
            <!-- Brush Settings (Hidden by default, shown on right) -->
            <div id="brush-settings" class="glass-blue p-3 rounded-lg pointer-events-auto hidden transition-all flex-col gap-2 items-center">
                <span class="text-[10px] uppercase font-bold ui-text-dim text-center whitespace-nowrap">Brush Size</span>
                <div class="h-32 w-8 flex items-center justify-center relative">
                    <!-- Standard slider rotated -90deg -->
                    <input type="range" id="brush-size" min="10" max="200" value="50" class="absolute w-32 h-2 -rotate-90 origin-center cursor-pointer"/>
                </div>
                <span id="brush-size-val" class="text-xs text-center font-mono ui-text-highlight">50</span>
            </div>
        `;
        document.body.appendChild(div);

        // Create Brush Cursor Overlay
        const overlay = document.createElement('div');
        overlay.id = 'brush-cursor-overlay';
        overlay.className = 'fixed rounded-full border-2 border-emerald-500/50 pointer-events-none z-50 hidden -translate-x-1/2 -translate-y-1/2';
        overlay.style.backgroundColor = 'var(--accent-glow)';
        overlay.style.borderColor = 'var(--text-highlight)';
        overlay.style.boxShadow = '0 0 15px var(--accent-glow)';
        overlay.style.width = '100px';
        overlay.style.height = '100px';
        document.body.appendChild(overlay);

        // #WDD 2026-04-10: Create Help Modal
        this.createHelpModal();

        this.toolbar = div;

        // Listeners
        const get = (id: string) => document.getElementById(id);

        get('tool-brush')?.addEventListener('click', () => this.setTool('brush'));
        get('tool-rect')?.addEventListener('click', () => this.setTool('rect'));
        get('tool-brush-alltime')?.addEventListener('click', () => this.setTool('brush-alltime'));
        get('tool-rect-alltime')?.addEventListener('click', () => this.setTool('rect-alltime'));
        get('select-mode-center')?.addEventListener('click', () => this.setSelectionMode('center'));
        get('select-mode-ellipse')?.addEventListener('click', () => this.setSelectionMode('ellipse'));
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

        get('action-undo')?.addEventListener('click', () => this.undo());
        get('action-redo')?.addEventListener('click', () => this.redo());
        get('action-help')?.addEventListener('click', () => this.toggleHelpModal());

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
        
        // Initialize selection mode UI
        this.setSelectionMode('center');
    }

    setTool(tool: 'brush' | 'rect' | 'brush-alltime' | 'rect-alltime' | 'none') {
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
        const map: Record<string, string> = { 
            'brush': 'tool-brush', 
            'rect': 'tool-rect',
            'brush-alltime': 'tool-brush-alltime',
            'rect-alltime': 'tool-rect-alltime'
        };

        Object.values(map).forEach(id => get(id)?.classList.remove('active'));
        if (this.currentTool !== 'none' && map[this.currentTool]) {
            get(map[this.currentTool])?.classList.add('active');
        }

        // Show/Hide brush settings
        const settings = document.getElementById('brush-settings');
        if (this.currentTool === 'brush' || this.currentTool === 'brush-alltime') {
            settings?.classList.remove('hidden');
            settings?.classList.add('flex');
            document.getElementById('brush-cursor-overlay')?.classList.remove('hidden');
        } else {
            settings?.classList.add('hidden');
            settings?.classList.remove('flex');
            document.getElementById('brush-cursor-overlay')?.classList.add('hidden');
        }
    }

    setSelectionMode(mode: 'center' | 'ellipse') {
        this.selectionMode = mode;
        
        // UI Feedback
        const get = (id: string) => document.getElementById(id);
        get('select-mode-center')?.classList.toggle('active', mode === 'center');
        get('select-mode-ellipse')?.classList.toggle('active', mode === 'ellipse');
        
        console.log(`[Selection] Mode: ${mode}`);
    }

    setupEvents() {
        // Need to hook into app mouse events
        window.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));

        // #WDD 2026-04-10: Check if user is typing in an input field
        const isTyping = () => {
            const active = document.activeElement;
            if (!active) return false;
            const tagName = active.tagName.toLowerCase();
            const isInput = tagName === 'input' || tagName === 'textarea';
            const isEditable = active.getAttribute('contenteditable') === 'true';
            return isInput || isEditable;
        };

        // Key events for Alt modifier, Delete, and Undo/Redo
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Alt') {
                this.isSubtracting = true;
                this.updateCursorState();
            }
            
            // #WDD 2026-04-10: Skip shortcuts when typing in input fields
            if (isTyping()) return;
            
            // #WDD 2026-04-10: Delete key to delete selected
            if (e.key === 'Delete') {
                this.deleteSelected();
            }

            // #WDD 2026-04-10: ESC to close help modal
            if (e.key === 'Escape') {
                this.hideHelpModal();
            }

            // #WDD 2026-04-10: Number keys for tool selection
            if (e.key === '1') {
                // Toggle brush tool
                if (this.currentTool === 'brush') {
                    this.setTool('none');
                } else {
                    this.setTool('brush');
                }
            }
            if (e.key === '2') {
                // Toggle rect tool
                if (this.currentTool === 'rect') {
                    this.setTool('none');
                } else {
                    this.setTool('rect');
                }
            }
            if (e.key === '3') {
                // Toggle all-time brush tool
                if (this.currentTool === 'brush-alltime') {
                    this.setTool('none');
                } else {
                    this.setTool('brush-alltime');
                }
            }
            if (e.key === '4') {
                // Toggle all-time rect tool
                if (this.currentTool === 'rect-alltime') {
                    this.setTool('none');
                } else {
                    this.setTool('rect-alltime');
                }
            }
            
            // #WDD 2026-04-10: Undo/Redo keyboard shortcuts
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'z' || e.key === 'Z') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        // Ctrl+Shift+Z = Redo
                        this.redo();
                    } else {
                        // Ctrl+Z = Undo
                        this.undo();
                    }
                } else if (e.key === 'y' || e.key === 'Y') {
                    // Ctrl+Y = Redo (alternative)
                    e.preventDefault();
                    this.redo();
                }
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
                this.rectOverlay.className = 'fixed border-2 pointer-events-none z-50';
                this.rectOverlay.style.borderColor = 'var(--text-highlight)';
                this.rectOverlay.style.backgroundColor = 'var(--accent-glow)';
                this.rectOverlay.style.borderStyle = 'solid';
            }
        }
    }

    onMouseDown(e: MouseEvent) {
        if (this.currentTool === 'none') return;
        // Check if hitting UI
        if ((e.target as HTMLElement).closest('.glass-blue')) return;
        if ((e.target as HTMLElement).closest('[style*="border-amber-500"]')) return;

        this.isSelecting = true;
        this.startPos.set(e.clientX, e.clientY);
        this.currentPos.set(e.clientX, e.clientY);

        if (this.currentTool === 'brush' || this.currentTool === 'brush-alltime') {
            if (this.isAllTimeTool()) {
                // Record path for deferred all-time selection at mouseup
                this.brushPath = [{x: e.clientX, y: e.clientY}];
            }
            // Real-time select currently visible points
            this.performBrush(e.clientX, e.clientY);
        }
    }

    onMouseMove(e: MouseEvent) {
        // Update Brush Cursor
        const overlay = document.getElementById('brush-cursor-overlay');
        if (overlay && (this.currentTool === 'brush' || this.currentTool === 'brush-alltime')) {
            overlay.style.left = e.clientX + 'px';
            overlay.style.top = e.clientY + 'px';
        }

        if (!this.isSelecting) return;
        this.currentPos.set(e.clientX, e.clientY);

        if (this.currentTool === 'brush' || this.currentTool === 'brush-alltime') {
            if (this.isAllTimeTool()) {
                // Record path for deferred all-time selection at mouseup
                this.brushPath.push({x: e.clientX, y: e.clientY});
            }
            // Real-time select currently visible points
            this.performBrush(e.clientX, e.clientY);
        } else if (this.currentTool === 'rect' || this.currentTool === 'rect-alltime') {
            // Draw visual rect overlay?
            this.drawRectOverlay();
        }
    }

    onMouseUp(e: MouseEvent) {
        if (!this.isSelecting) return;
        this.isSelecting = false;

        if (this.currentTool === 'brush' || this.currentTool === 'brush-alltime') {
            if (this.isAllTimeTool()) {
                this.brushPath.push({x: e.clientX, y: e.clientY});
                if (this.selectionMode === 'ellipse') {
                    this.performBrushEllipseAllTimePath(this.brushPath);
                } else {
                    this.performBrushAllTimePath(this.brushPath);
                }
                this.brushPath = [];
            }
        } else if (this.currentTool === 'rect' || this.currentTool === 'rect-alltime') {
            this.performRect(this.startPos.x, this.startPos.y, e.clientX, e.clientY);
            this.removeRectOverlay();
        }
    }

    // --- Selection Logic ---

    getCachedPositions() {
        if (!this.viewer.splatEntity) return null;
        // #WDD 2026-01-18: Use dynamic positions if available
        if (typeof this.viewer.getCurrentPositions === 'function') {
            return this.viewer.getCurrentPositions();
        }
        return this.viewer.cachedPositions;
    }

    // #WDD 2026-04-10: Get current time for time-based selection
    getCurrentTime(): number {
        return this.viewer.currentTime ?? 0;
    }

    // #WDD 2026-04-18: Check if current tool is an all-time selection tool
    isAllTimeTool(): boolean {
        return this.currentTool === 'brush-alltime' || this.currentTool === 'rect-alltime';
    }

    // #WDD 2026-04-18: Check if a point is visible at a specific time
    isVisibleAtTime(splatIdx: number, time: number): boolean {
        const lifeTexData = this.viewer.lifeTexData;
        if (!lifeTexData) return true;

        const idx = splatIdx * 4;
        if (idx >= lifeTexData.length) return true;

        const mu = lifeTexData[idx + 0];
        const w = lifeTexData[idx + 1];
        const k = lifeTexData[idx + 2];
        const duration = this.viewer.duration ?? 100;
        const totalFrames = Math.ceil(duration);
        const segmentMax = Math.max(0, totalFrames - 1);

        if (time < 0.0 || time > segmentMax) return false;

        const lifeStart = mu - w;
        const lifeEnd = mu + w;

        if (lifeEnd <= 0.0 || lifeStart >= segmentMax || lifeEnd <= lifeStart) return false;

        const argLeft = k * (time - lifeStart);
        const left = 1.0 / (1.0 + Math.exp(-argLeft));

        const argRight = -k * (time - lifeEnd);
        const right = 1.0 / (1.0 + Math.exp(-argRight));

        const alpha = left * right;

        return alpha > 0.01;
    }

    // #WDD 2026-04-10: Check if a point is visible at current time
    isVisibleAtCurrentTime(splatIdx: number): boolean {
        return this.isVisibleAtTime(splatIdx, this.getCurrentTime());
    }

    performBrush(cx: number, cy: number) {
        if (this.selectionMode === 'ellipse') {
            this.performBrushEllipse(cx, cy);
            return;
        }
        
        // Center mode (original)
        const positions = this.getCachedPositions();
        if (!positions || !this.selectionData || !this.allTimeSelectionData) return;

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

                    // #WDD 2026-04-11: Always update all-time selection (regardless of time visibility)
                    if (this.isSubtracting) {
                        this.allTimeSelectionData[idx] = 0;
                    } else {
                        this.allTimeSelectionData[idx] = 255;
                    }

                    // #WDD 2026-04-10: Only update current selection if visible at current time
                    if (this.isVisibleAtCurrentTime(i)) {
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
        }

        if (changed) this.updateTexture();
    }

    performRect(x1: number, y1: number, x2: number, y2: number) {
        if (this.selectionMode === 'ellipse') {
            this.performRectEllipse(x1, y1, x2, y2);
            return;
        }

        if (this.isAllTimeTool()) {
            this.performRectAllTime(x1, y1, x2, y2);
            return;
        }
        
        // Center mode (original)
        const positions = this.getCachedPositions();
        if (!positions || !this.selectionData || !this.allTimeSelectionData) return;

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

                    // #WDD 2026-04-11: Always update all-time selection (regardless of time visibility)
                    if (this.isSubtracting) {
                        this.allTimeSelectionData[idx] = 0;
                    } else {
                        this.allTimeSelectionData[idx] = 255;
                    }

                    // #WDD 2026-04-10: Only update current selection if visible at current time
                    if (this.isVisibleAtCurrentTime(i)) {
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

    // ===== ELLIPSE SELECTION METHODS =====
    
    // Simple ellipse-brush intersection using screen-space approximation
    performBrushEllipse(cx: number, cy: number) {
        const positions = this.getCachedPositions();
        if (!positions || !this.selectionData || !this.allTimeSelectionData) return;

        const camera = this.viewer.camera?.camera;
        if (!camera) return;

        const r = this.brushRadius;
        const rSq = r * r;
        
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

            // screen.z > 0 means in front of camera
            if (screen.z <= 0) continue;

            // For ellipse mode: check if brush intersects with splat's ellipse boundary
            // Estimate screen-space ellipse radius based on z-depth
            // Use smaller radius so brush must be closer to center to select
            const pixelSize = Math.max(2, Math.min(15, 100 / (screen.z + 5))); 
            const totalRadius = r + pixelSize;
            const totalRSq = totalRadius * totalRadius;
            
            const dx = screen.x - cx;
            const dy = screen.y - cy;
            
            if (dx * dx + dy * dy <= totalRSq) {
                const idx = i * 4;
                if (this.selectionData[idx + 1] > 0) continue;

                // #WDD 2026-04-11: Always update all-time selection (regardless of time visibility)
                if (this.isSubtracting) {
                    this.allTimeSelectionData[idx] = 0;
                } else {
                    this.allTimeSelectionData[idx] = 255;
                }

                // #WDD 2026-04-10: Only update current selection if visible at current time
                if (this.isVisibleAtCurrentTime(i)) {
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

    // Simple ellipse-rect intersection
    performRectEllipse(x1: number, y1: number, x2: number, y2: number) {
        if (this.isAllTimeTool()) {
            this.performRectEllipseAllTime(x1, y1, x2, y2);
            return;
        }
        const positions = this.getCachedPositions();
        if (!positions || !this.selectionData || !this.allTimeSelectionData) return;

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

            if (screen.z <= 0) continue;

            // Estimate screen-space ellipse radius based on z-depth
            const pixelSize = Math.max(2, Math.min(15, 100 / (screen.z + 5)));
            
            // Check if splat circle intersects with selection rect
            if (screen.x >= minX - pixelSize && 
                screen.x <= maxX + pixelSize &&
                screen.y >= minY - pixelSize && 
                screen.y <= maxY + pixelSize) {
                
                const idx = i * 4;
                if (this.selectionData[idx + 1] > 0) continue;

                // #WDD 2026-04-11: Always update all-time selection (regardless of time visibility)
                if (this.isSubtracting) {
                    this.allTimeSelectionData[idx] = 0;
                } else {
                    this.allTimeSelectionData[idx] = 255;
                }

                // #WDD 2026-04-10: Only update current selection if visible at current time
                if (this.isVisibleAtCurrentTime(i)) {
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

    // ===== ALL-TIME SELECTION METHODS =====

    // Generic all-time selection: check all frames for points that are visible and in selection area
    private selectAllTimePoints(checkScreen: (screenX: number, screenY: number, screenZ: number, splatIdx: number) => boolean): boolean {
        const positions = this.getCachedPositions();
        if (!positions || !this.selectionData) return false;

        const camera = this.viewer.camera?.camera;
        if (!camera) return false;

        const duration = this.viewer.duration ?? 1;
        const totalFrames = Math.ceil(duration);
        const numSplats = positions.length / 3;

        const found = new Uint8Array(numSplats);
        const tempPos = new Float32Array(numSplats * 3);
        const localPos = new pc.Vec3();
        const worldPos = new pc.Vec3();
        const screen = new pc.Vec3();
        const modelMat = this.viewer.splatEntity.getWorldTransform();

        for (let t = 0; t < totalFrames; t++) {
            const framePositions = this.viewer.getPositionsAtTime(t, tempPos);
            if (!framePositions) continue;

            for (let i = 0; i < numSplats; i++) {
                if (found[i]) continue;

                const idx4 = i * 4;
                if (this.selectionData[idx4 + 1] > 0) continue;

                if (!this.isVisibleAtTime(i, t)) continue;

                localPos.set(framePositions[i * 3 + 0], framePositions[i * 3 + 1], framePositions[i * 3 + 2]);
                modelMat.transformPoint(localPos, worldPos);
                camera.worldToScreen(worldPos, screen);

                if (screen.z > 0 && checkScreen(screen.x, screen.y, screen.z, i)) {
                    found[i] = 1;
                }
            }
        }

        let changed = false;
        for (let i = 0; i < numSplats; i++) {
            if (!found[i]) continue;
            const idx4 = i * 4;
            if (this.isSubtracting) {
                if (this.selectionData[idx4] > 0) {
                    this.selectionData[idx4] = 0;
                    changed = true;
                }
            } else {
                if (this.selectionData[idx4] === 0) {
                    this.selectionData[idx4] = 255;
                    changed = true;
                }
            }
        }

        return changed;
    }

    performBrushAllTime(cx: number, cy: number) {
        const rSq = this.brushRadius * this.brushRadius;
        const changed = this.selectAllTimePoints((sx, sy) => {
            const dx = sx - cx;
            const dy = sy - cy;
            return dx * dx + dy * dy < rSq;
        });
        if (changed) this.updateTexture();
    }

    performRectAllTime(x1: number, y1: number, x2: number, y2: number) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        const changed = this.selectAllTimePoints((sx, sy) => {
            return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
        });
        if (changed) this.updateTexture();
    }

    performBrushEllipseAllTime(cx: number, cy: number) {
        const r = this.brushRadius;
        const rSq = r * r;
        const changed = this.selectAllTimePoints((sx, sy, sz) => {
            const pixelSize = Math.max(2, Math.min(15, 100 / (sz + 5)));
            const totalRadius = r + pixelSize;
            const totalRSq = totalRadius * totalRadius;
            const dx = sx - cx;
            const dy = sy - cy;
            return dx * dx + dy * dy <= totalRSq;
        });
        if (changed) this.updateTexture();
    }

    performRectEllipseAllTime(x1: number, y1: number, x2: number, y2: number) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        const changed = this.selectAllTimePoints((sx, sy, sz) => {
            const pixelSize = Math.max(2, Math.min(15, 100 / (sz + 5)));
            return sx >= minX - pixelSize && sx <= maxX + pixelSize &&
                   sy >= minY - pixelSize && sy <= maxY + pixelSize;
        });
        if (changed) this.updateTexture();
    }

    // Deferred all-time brush path selection (performance optimization)
    performBrushAllTimePath(path: Array<{x: number, y: number}>) {
        if (path.length === 0) return;

        // Simplify path: remove points that are too close to each other
        const simplified: Array<{x: number, y: number}> = [];
        const thresholdSq = 25; // 5px threshold squared
        for (const p of path) {
            if (simplified.length === 0) {
                simplified.push(p);
            } else {
                const last = simplified[simplified.length - 1];
                const dx = p.x - last.x;
                const dy = p.y - last.y;
                if (dx * dx + dy * dy > thresholdSq) {
                    simplified.push(p);
                }
            }
        }

        const rSq = this.brushRadius * this.brushRadius;
        const circles = simplified.map(p => ({x: p.x, y: p.y, rSq}));

        const changed = this.selectAllTimePoints((sx, sy) => {
            for (const c of circles) {
                const dx = sx - c.x;
                const dy = sy - c.y;
                if (dx * dx + dy * dy < c.rSq) return true;
            }
            return false;
        });

        if (changed) this.updateTexture();
    }

    performBrushEllipseAllTimePath(path: Array<{x: number, y: number}>) {
        if (path.length === 0) return;

        // Simplify path: remove points that are too close to each other
        const simplified: Array<{x: number, y: number}> = [];
        const thresholdSq = 25; // 5px threshold squared
        for (const p of path) {
            if (simplified.length === 0) {
                simplified.push(p);
            } else {
                const last = simplified[simplified.length - 1];
                const dx = p.x - last.x;
                const dy = p.y - last.y;
                if (dx * dx + dy * dy > thresholdSq) {
                    simplified.push(p);
                }
            }
        }

        const r = this.brushRadius;
        const circles = simplified.map(p => ({x: p.x, y: p.y}));

        const changed = this.selectAllTimePoints((sx, sy, sz) => {
            const pixelSize = Math.max(2, Math.min(15, 100 / (sz + 5)));
            for (const c of circles) {
                const totalRadius = r + pixelSize;
                const totalRSq = totalRadius * totalRadius;
                const dx = sx - c.x;
                const dy = sy - c.y;
                if (dx * dx + dy * dy <= totalRSq) return true;
            }
            return false;
        });

        if (changed) this.updateTexture();
    }
}
