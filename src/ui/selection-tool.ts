
import * as pc from 'playcanvas';
import {
    ICON_BRUSH, ICON_POLY, ICON_RECT, ICON_INVERT, ICON_CLEAR,
    ICON_CENTER, ICON_ELLIPSE, ICON_UNDO, ICON_REDO,
    ICON_BRUSH_ALLTIME, ICON_RECT_ALLTIME, ICON_POLY_ALLTIME, ICON_HELP
} from './selection-tool-icons';
import { SelectionToolHelp } from './selection-tool-help';


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
    currentTool: 'none' | 'brush' | 'rect' | 'brush-alltime' | 'rect-alltime' | 'poly' | 'poly-alltime' = 'none';
    selectionMode: 'center' | 'ellipse' = 'center';
    brushRadius = 50; // pixels

    // State
    isSelecting = false;
    isSubtracting = false;
    startPos = new pc.Vec2();
    currentPos = new pc.Vec2();
    brushPath: Array<{x: number, y: number}> = []; // #WDD 2026-04-18: Deferred all-time brush path
    polyPoints: Array<{x: number, y: number}> = []; // #WDD Poly points
    polyOverlay: SVGElement | null = null;
    polyLine: SVGPolylineElement | null = null;
    polyCursorLine: SVGLineElement | null = null;

    // UI
    toolbar!: HTMLElement;

    // #WDD-kimi 2026-04-20: Undo/Redo 升级为全段状态快照（保存并恢复所有段落状态）
    private readonly MAX_HISTORY = 30;
    private undoStack: Array<{
        segments: Array<{ elementIndex: number; selectionData: Uint8Array; allTimeSelectionData: Uint8Array }>;
        viewContext: any;
    }> = [];
    private redoStack: Array<{
        segments: Array<{ elementIndex: number; selectionData: Uint8Array; allTimeSelectionData: Uint8Array }>;
        viewContext: any;
    }> = [];

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
        const before = this.captureGlobalSelectionState();
        // #WDD-kimi 2026-04-20 - 取消选择改为跨所有段：清空每段的 R 通道和 all-time 选择通道
        const targets = this.getGlobalSelectionTargets();
        let changed = false;
        for (const target of targets) {
            const len = target.selectionData.length;
            for (let i = 0; i < len; i += 4) {
                if (target.selectionData[i] !== 0) changed = true;
                target.selectionData[i] = 0;
            }
            const allLen = target.allTimeSelectionData.length;
            for (let i = 0; i < allLen; i += 4) {
                if (target.allTimeSelectionData[i] !== 0) changed = true;
                target.allTimeSelectionData[i] = 0;
            }
            this.updateTextureForRuntime(target.selectionTexture, target.selectionData);
        }
        if (changed) this.pushUndoSnapshot(before);
        this.updateTexture();
    }

    deleteSelected() {
        const before = this.captureGlobalSelectionState();
        const targets = this.getGlobalSelectionTargets();
        let deletedTotal = 0;

        // #WDD-kimi 2026-04-20 - 删除改为跨所有段：对每段已选点同步打删除标记
        for (const target of targets) {
            const deletedIndices: number[] = [];
            const totalSplats = Math.floor(target.selectionData.length / 4);
            for (let i = 0; i < totalSplats; i++) {
                const idx = i * 4;
                if (target.selectionData[idx] > 0) {
                    deletedIndices.push(i);
                    target.selectionData[idx + 1] = 255;
                    target.selectionData[idx] = 0;
                }
            }
            if (deletedIndices.length > 0) {
                deletedTotal += deletedIndices.length;
                this.updateTextureForRuntime(target.selectionTexture, target.selectionData);
            }
        }

        if (deletedTotal > 0) {
            this.pushUndoSnapshot(before);
            this.updateTexture();
            console.log(`[Selection] Deleted ${deletedTotal} points across sequence. Undo stack: ${this.undoStack.length}`);
        }
    }

    invertSelection(totalSplats: number) {
        // #WDD 2026-04-18: Invert selection based on current tool mode
        // Normal tools: only invert currently visible points
        // All-time tools: invert all non-deleted points globally
        if (!this.selectionData) return;

        const sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
            ? this.viewer.getSplatSequenceSelectionElements()
            : [];
        if (Array.isArray(sequenceElements) && sequenceElements.length > 0) {
            const before = this.captureGlobalSelectionState();
            let changed = false;
            // #WDD-kimi 2026-04-20 - 反选改为全序列：对每个段的所有非删除点执行反向
            for (const element of sequenceElements) {
                const rt = this.buildSelectionRuntimeFromElement(element);
                const data = (rt?.selectionData as Uint8Array | null) || null;
                const tex = (rt?.selectionTexture as pc.Texture | null) || null;
                if (!data) continue;
                const count = Math.floor(data.length / 4);
                for (let i = 0; i < count; i++) {
                    const idx = i * 4;
                    if (data[idx + 1] > 0) continue;
                    changed = true;
                    data[idx] = data[idx] > 0 ? 0 : 255;
                }
                this.updateTextureForRuntime(tex, data);
            }
            if (changed) this.pushUndoSnapshot(before);
            this.updateTexture();
            return;
        }

        const before = this.captureGlobalSelectionState();
        const isAllTime = this.isAllTimeTool();
        let changed = false;
        for (let i = 0; i < totalSplats; i++) {
            const idx = i * 4;
            if (this.selectionData[idx + 1] > 0) continue;
            if (isAllTime || this.isVisibleAtCurrentTime(i)) {
                changed = true;
                this.selectionData[idx] = this.selectionData[idx] > 0 ? 0 : 255;
            }
        }
        if (changed) this.pushUndoSnapshot(before);
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

        const previous = this.undoStack.pop()!;
        const current = this.captureGlobalSelectionState();
        this.restoreGlobalSelectionState(previous);
        this.redoStack.push(current);
        if (this.redoStack.length > this.MAX_HISTORY) this.redoStack.shift();
        this.updateTexture();
        console.log(`[Selection] Undo: restored full sequence state. Undo: ${this.undoStack.length}, Redo: ${this.redoStack.length}`);
    }

    // #WDD 2026-04-10: Redo last undone action
    redo() {
        if (this.redoStack.length === 0) {
            console.log('[Selection] Nothing to redo');
            return;
        }

        const next = this.redoStack.pop()!;
        const current = this.captureGlobalSelectionState();
        this.restoreGlobalSelectionState(next);
        this.undoStack.push(current);
        if (this.undoStack.length > this.MAX_HISTORY) this.undoStack.shift();
        this.updateTexture();
        console.log(`[Selection] Redo: restored full sequence state. Undo: ${this.undoStack.length}, Redo: ${this.redoStack.length}`);
    }

    // #WDD 2026-04-10: Clear undo/redo history (e.g., on new file load)
    clearHistory() {
        this.undoStack = [];
        this.redoStack = [];
        console.log('[Selection] History cleared');
    }

    // #WDD-kimi 2026-04-20 - 捕获当前所有段落的选择状态快照（用于 undo/redo）
    private captureGlobalSelectionState(): {
        segments: Array<{ elementIndex: number; selectionData: Uint8Array; allTimeSelectionData: Uint8Array }>;
        viewContext: any;
    } {
        const targets = this.getGlobalSelectionTargets();
        const segments = targets.map((t) => ({
            elementIndex: t.elementIndex,
            selectionData: new Uint8Array(t.selectionData),
            allTimeSelectionData: new Uint8Array(t.allTimeSelectionData)
        }));
        // #WDD-kimi 2026-04-20 - 记录视图上下文（段落/时间/变换），避免切段后 undo 顺序错位
        const viewContext = typeof this.viewer.captureSelectionUndoViewContext === 'function'
            ? this.viewer.captureSelectionUndoViewContext()
            : null;
        return { segments, viewContext };
    }

    private pushUndoSnapshot(snapshot: {
        segments: Array<{ elementIndex: number; selectionData: Uint8Array; allTimeSelectionData: Uint8Array }>;
        viewContext: any;
    }) {
        this.undoStack.push(snapshot);
        if (this.undoStack.length > this.MAX_HISTORY) this.undoStack.shift();
        this.redoStack = [];
    }

    private restoreGlobalSelectionState(snapshot: {
        segments: Array<{ elementIndex: number; selectionData: Uint8Array; allTimeSelectionData: Uint8Array }>;
        viewContext: any;
    } | Array<{ elementIndex: number; selectionData: Uint8Array; allTimeSelectionData: Uint8Array }>) {
        const segments = Array.isArray(snapshot) ? snapshot : (snapshot?.segments || []);
        const targetMap = new Map<number, {
            elementIndex: number;
            selectionData: Uint8Array;
            allTimeSelectionData: Uint8Array;
            selectionTexture: pc.Texture | null;
        }>();
        for (const t of this.getGlobalSelectionTargets()) targetMap.set(t.elementIndex, t);

        const sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
            ? this.viewer.getSplatSequenceSelectionElements()
            : [];

        for (const s of segments) {
            const target = targetMap.get(s.elementIndex);
            if (!target) continue;

            if (target.selectionData.length !== s.selectionData.length) {
                target.selectionData = new Uint8Array(s.selectionData);
            } else {
                target.selectionData.set(s.selectionData);
            }
            if (target.allTimeSelectionData.length !== s.allTimeSelectionData.length) {
                target.allTimeSelectionData = new Uint8Array(s.allTimeSelectionData);
            } else {
                target.allTimeSelectionData.set(s.allTimeSelectionData);
            }

            if (s.elementIndex >= 0 && Array.isArray(sequenceElements) && sequenceElements[s.elementIndex]) {
                const el = sequenceElements[s.elementIndex];
                el.runtime = el.runtime || {};
                el.runtime.selectionData = target.selectionData;
                el.runtime.allTimeSelectionData = target.allTimeSelectionData;
            } else if (s.elementIndex < 0) {
                this.selectionData = target.selectionData;
                this.allTimeSelectionData = target.allTimeSelectionData;
            }

            this.updateTextureForRuntime(target.selectionTexture, target.selectionData);
        }

        // #WDD-kimi 2026-04-20 - 恢复视图上下文（先变换/段落/时间），保证与选择状态回退顺序一致
        const viewContext = Array.isArray(snapshot) ? null : snapshot?.viewContext;
        if (viewContext && typeof this.viewer.restoreSelectionUndoViewContext === 'function') {
            this.viewer.restoreSelectionUndoViewContext(viewContext);
        }

        // #WDD-kimi 2026-04-20 - 修复切段后 undo/redo 引用错位：恢复完成后强制同步到当前激活段
        this.syncActiveSelectionRefsAfterRestore();
    }

    private syncActiveSelectionRefsAfterRestore() {
        const sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
            ? this.viewer.getSplatSequenceSelectionElements()
            : [];
        if (!Array.isArray(sequenceElements) || sequenceElements.length === 0) return;

        const activeIdx = Number.isInteger(this.viewer?.splatSequence?.activeElementIndex)
            ? this.viewer.splatSequence.activeElementIndex
            : (Number.isInteger(this.viewer?.sog4SequenceIndex) ? this.viewer.sog4SequenceIndex : 0);

        const clampedIdx = Math.max(0, Math.min(sequenceElements.length - 1, activeIdx));
        const active = sequenceElements[clampedIdx];
        if (!active) return;

        const rt = this.buildSelectionRuntimeFromElement(active);
        if (!rt?.selectionData) return;

        this.selectionData = rt.selectionData as Uint8Array;
        this.allTimeSelectionData = (rt.allTimeSelectionData as Uint8Array | null) || this.allTimeSelectionData;
        this.selectionTexture = (rt.selectionTexture as pc.Texture | null) || this.selectionTexture;
    }

    private helpManager = new SelectionToolHelp();

    createHelpModal() { return this.helpManager.createHelpModal(); }
    toggleHelpModal() { return this.helpManager.toggleHelpModal(); }
    hideHelpModal() { return this.helpManager.hideHelpModal(); }

    /* ORIGINAL createHelpModal MOVED to selection-tool-help.ts
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

    */ // END MOVED createHelpModal

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
                <!-- Selection Tools (6 tools together) -->
                <div class="glass-blue p-1.5 rounded-lg flex flex-col gap-1.5 pointer-events-auto">
                    <button id="tool-brush" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Brush Selection">
                        ${ICON_BRUSH}
                    </button>
                    <button id="tool-rect" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Area Selection">
                        ${ICON_RECT}
                    </button>
                    <button id="tool-poly" class="ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Polygon Selection">
                        ${ICON_POLY}
                    </button>
                    <div class="h-px ui-border w-full my-1"></div>
                    <button id="tool-brush-alltime" class="ui-btn p-1.5 rounded-lg has-tooltip text-amber-400 alltime-tool" aria-label="All-Time Brush Selection">
                        ${ICON_BRUSH_ALLTIME}
                    </button>
                    <button id="tool-rect-alltime" class="ui-btn p-1.5 rounded-lg has-tooltip text-amber-400 alltime-tool" aria-label="All-Time Area Selection">
                        ${ICON_RECT_ALLTIME}
                    </button>
                    <button id="tool-poly-alltime" class="ui-btn p-1.5 rounded-lg has-tooltip text-amber-400 alltime-tool" aria-label="All-Time Polygon Selection">
                        ${ICON_POLY_ALLTIME}
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

        // Polygon Overlay
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.id = "poly-cursor-overlay";
        svg.style.position = "fixed";
        svg.style.top = "0";
        svg.style.left = "0";
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.pointerEvents = "none";
        svg.style.zIndex = "49";
        svg.style.display = "none";
        
        const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        polyline.setAttribute("fill", "rgba(16, 185, 129, 0.2)");
        polyline.setAttribute("stroke", "var(--text-highlight)");
        polyline.setAttribute("stroke-width", "2");
        polyline.setAttribute("stroke-dasharray", "4");
        svg.appendChild(polyline);
        
        const cursorLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        cursorLine.setAttribute("stroke", "var(--text-highlight)");
        cursorLine.setAttribute("stroke-width", "2");
        cursorLine.setAttribute("stroke-dasharray", "4");
        svg.appendChild(cursorLine);
        
        document.body.appendChild(svg);
        this.polyOverlay = svg;
        this.polyLine = polyline;
        this.polyCursorLine = cursorLine;

        // #WDD 2026-04-10: Create Help Modal
        this.createHelpModal();

        this.toolbar = div;

        // Listeners
        const get = (id: string) => document.getElementById(id);

        get('tool-brush')?.addEventListener('click', () => this.setTool('brush'));
        get('tool-rect')?.addEventListener('click', () => this.setTool('rect'));
        get('tool-poly')?.addEventListener('click', () => this.setTool('poly'));
        get('tool-brush-alltime')?.addEventListener('click', () => this.setTool('brush-alltime'));
        get('tool-rect-alltime')?.addEventListener('click', () => this.setTool('rect-alltime'));
        get('tool-poly-alltime')?.addEventListener('click', () => this.setTool('poly-alltime'));
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

    setTool(tool: 'brush' | 'rect' | 'brush-alltime' | 'rect-alltime' | 'poly' | 'poly-alltime' | 'none') {
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
            'rect-alltime': 'tool-rect-alltime',
            'poly': 'tool-poly',
            'poly-alltime': 'tool-poly-alltime'
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

        if (this.currentTool === 'poly' || this.currentTool === 'poly-alltime') {
            this.polyPoints = [];
            this.updatePolyOverlay();
            if (this.polyOverlay) this.polyOverlay.style.display = 'block';
        } else {
            if (this.polyOverlay) this.polyOverlay.style.display = 'none';
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
        window.addEventListener('dblclick', (e) => this.onDblClick(e));

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

    onDblClick(e: MouseEvent) {
        if (this.currentTool !== 'poly' && this.currentTool !== 'poly-alltime') return;
        console.log("DBL CLICK TRIGGERED! polyPoints: ", this.polyPoints.length);
        
        if (this.polyPoints.length > 2) {
            console.log("CALLING PERFORM POLYGON");
            this.performPolygon(this.polyPoints);
        }
        this.polyPoints = [];
        this.updatePolyOverlay();
    }

    onMouseDown(e: MouseEvent) {
        if (this.currentTool === 'none') return;
        // Check if hitting UI
        if ((e.target as HTMLElement).closest('.glass-blue')) return;
        if ((e.target as HTMLElement).closest('[style*="border-amber-500"]')) return;

        this.isSelecting = true;
        this.startPos.set(e.clientX, e.clientY);
        this.currentPos.set(e.clientX, e.clientY);

        if (this.currentTool === 'poly' || this.currentTool === 'poly-alltime') {
            this.polyPoints.push({x: e.clientX, y: e.clientY});
            this.updatePolyOverlay();
            return;
        }

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

        if (this.currentTool === 'poly' || this.currentTool === 'poly-alltime') {
            if (this.polyPoints.length > 0) {
                this.polyCursorLine?.setAttribute('x2', e.clientX.toString());
                this.polyCursorLine?.setAttribute('y2', e.clientY.toString());
            }
            return;
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

    // #WDD-kimi 2026-04-20 - 序列模式下返回当前段本地时间，避免用全局时间误判可见性
    getCurrentTime(): number {
        const globalTime = this.viewer.currentTime ?? 0;
        if (this.viewer?.isSog4SequenceMode) {
            const offsets = this.viewer?.sog4SequenceOffsets;
            const segIdx = this.viewer?.sog4SequenceIndex;
            if (Array.isArray(offsets) && typeof segIdx === 'number' && segIdx >= 0) {
                const segStart = offsets[segIdx] ?? 0;
                return Math.max(0, globalTime - segStart);
            }
        }
        return globalTime;
    }

    // #WDD 2026-04-18: Check if current tool is an all-time selection tool
    isAllTimeTool(): boolean {
        return this.currentTool === 'brush-alltime' || this.currentTool === 'rect-alltime' || this.currentTool === 'poly-alltime';
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

    // #WDD-gpt 2026-04-20 - 序列元素可见性检查（使用元素自己的生命周期纹理数据）
    private isVisibleAtTimeForRuntime(runtime: any, splatIdx: number, time: number): boolean {
        const lifeTexData = runtime?.lifeTexData as Float32Array | null | undefined;
        if (!lifeTexData) return true;

        const idx = splatIdx * 4;
        if (idx >= lifeTexData.length) return true;

        const mu = lifeTexData[idx + 0];
        const w = lifeTexData[idx + 1];
        const k = lifeTexData[idx + 2];
        const duration = runtime?.totalFrames ?? 100;
        const totalFrames = Math.ceil(duration);
        const segmentMax = Math.max(0, totalFrames - 1);

        if (time < 0.0 || time > segmentMax) return false;

        const lifeStart = mu - w;
        const lifeEnd = mu + w;
        if (lifeEnd <= 0.0 || lifeStart >= segmentMax || lifeEnd <= lifeStart) return false;

        const left = 1.0 / (1.0 + Math.exp(-k * (time - lifeStart)));
        const right = 1.0 / (1.0 + Math.exp(k * (time - lifeEnd)));
        return (left * right) > 0.01;
    }

    // #WDD-gpt 2026-04-20 - 从序列元素 runtime 计算指定时刻位置
    private getPositionsAtTimeForRuntime(runtime: any, time: number, out?: Float32Array): Float32Array | null {
        const cached = runtime?.cachedPositions as Float32Array | null | undefined;
        if (!cached) return null;

        const posArrays = runtime?.posArrays as { x: Float32Array, y: Float32Array, z: Float32Array } | null | undefined;
        const traj = runtime?.trajectoryData as Float32Array | null | undefined;
        const is4DGS = !!runtime?.is4DGS;
        if (!is4DGS || !posArrays || !traj) return cached;

        const K = runtime?.keyframes || 0;
        const stride = runtime?.xyzStride || 1;
        const origIndices = runtime?.originalIndices as Float32Array | null | undefined;
        const duration = runtime?.totalFrames || 1;
        const N = Math.min(posArrays.x.length, posArrays.y.length, posArrays.z.length);
        if (K <= 0 || N <= 0) return cached;

        const keyframeMax = Math.max(0, (K - 1) * stride);
        const maxTime = Math.max(0, Math.min(duration - 1, keyframeMax));
        const tClamped = Math.max(0, Math.min(time, maxTime));
        const idx = stride > 0 ? Math.floor(tClamped / stride) : 0;
        const k0 = K <= 1 ? 0 : Math.min(Math.max(0, idx), K - 1);
        const k1 = K <= 1 ? 0 : Math.min(k0 + 1, K - 1);
        const t0 = k0 * stride;
        const t1 = k1 * stride;
        const ratio = (k0 === k1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));

        const result = out || new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const oidx = origIndices ? Math.round(origIndices[i]) : i;
            const base = oidx * K * 3;
            const b0 = base + k0 * 3;
            const b1 = base + k1 * 3;
            const x0 = traj[b0 + 0], y0 = traj[b0 + 1], z0 = traj[b0 + 2];
            const x1 = traj[b1 + 0], y1 = traj[b1 + 1], z1 = traj[b1 + 2];
            result[i * 3 + 0] = x0 + (x1 - x0) * ratio;
            result[i * 3 + 1] = y0 + (y1 - y0) * ratio;
            result[i * 3 + 2] = z0 + (z1 - z0) * ratio;
        }
        return result;
    }

    private updateTextureForRuntime(selectionTexture: pc.Texture | null, selectionData: Uint8Array | null) {
        if (!selectionTexture || !selectionData) return;
        const lock = selectionTexture.lock();
        lock.set(selectionData);
        selectionTexture.unlock();
    }

    // #WDD-kimi 2026-04-20 - 当 runtime 尚未构建时，用 parsed 数据构造可用于 all-time 比对的运行时视图
    private buildSelectionRuntimeFromElement(element: any): any {
        const runtime = element?.runtime;
        if (runtime) return runtime;

        const parsed = element?.parsed || {};
        const readProp = (name: string): Float32Array | null => {
            const props = parsed?.plyData?.elements?.[0]?.properties || [];
            const hit = props.find((p: any) => p?.name === name);
            return (hit?.storage as Float32Array) || null;
        };

        let cachedPositions: Float32Array | null = null;
        const x = parsed?.x || readProp('x');
        const y = parsed?.y || readProp('y');
        const z = parsed?.z || readProp('z');
        if (x && y && z) {
            const count = Math.min(x.length, y.length, z.length);
            cachedPositions = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                cachedPositions[i * 3 + 0] = x[i];
                cachedPositions[i * 3 + 1] = y[i];
                cachedPositions[i * 3 + 2] = z[i];
            }
        }

        const mu = parsed?.lifetime_mu || readProp('lifetime_mu');
        const w = parsed?.lifetime_w || readProp('lifetime_w');
        const k = parsed?.lifetime_k || readProp('lifetime_k');
        let lifeTexData: Float32Array | null = null;
        if (cachedPositions && mu && w) {
            const count = Math.min(cachedPositions.length / 3, mu.length, w.length);
            lifeTexData = new Float32Array(count * 4);
            for (let i = 0; i < count; i++) {
                lifeTexData[i * 4 + 0] = mu[i];
                lifeTexData[i * 4 + 1] = w[i];
                lifeTexData[i * 4 + 2] = k ? k[i] : 10.0;
                lifeTexData[i * 4 + 3] = 0;
            }
        }

        return {
            totalFrames: Math.max(1, Math.floor(parsed?.frames || parsed?.maxMu || element?.duration || 1)),
            is4DGS: !!parsed?.trajectory,
            keyframes: parsed?.keyframes || 0,
            xyzStride: parsed?.xyzStride || 1,
            lifeTexData,
            trajectoryData: parsed?.trajectory || null,
            originalIndices: parsed?.original_index || readProp('original_index'),
            posArrays: cachedPositions ? {
                x: x as Float32Array,
                y: y as Float32Array,
                z: z as Float32Array
            } : null,
            cachedPositions,
            selectionData: runtime?.selectionData || null,
            allTimeSelectionData: runtime?.allTimeSelectionData || null,
            selectionTexture: runtime?.selectionTexture || null
        };
    }

    // #WDD-kimi 2026-04-20 - 构建跨段操作目标集，确保每段都有可写 selection/all-time 缓冲
    private getGlobalSelectionTargets(): Array<{
        elementIndex: number;
        selectionData: Uint8Array;
        allTimeSelectionData: Uint8Array;
        selectionTexture: pc.Texture | null;
    }> {
        const sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
            ? this.viewer.getSplatSequenceSelectionElements()
            : [];

        if (Array.isArray(sequenceElements) && sequenceElements.length > 0) {
            const targets: Array<{
                elementIndex: number;
                selectionData: Uint8Array;
                allTimeSelectionData: Uint8Array;
                selectionTexture: pc.Texture | null;
            }> = [];
            for (let idx = 0; idx < sequenceElements.length; idx++) {
                const element = sequenceElements[idx];
                const rt = this.buildSelectionRuntimeFromElement(element);
                if (!rt?.cachedPositions) continue;
                const count = Math.floor((rt.cachedPositions as Float32Array).length / 3);
                if (!rt.selectionData || rt.selectionData.length < count * 4) {
                    rt.selectionData = new Uint8Array(count * 4);
                }
                if (!rt.allTimeSelectionData || rt.allTimeSelectionData.length < count * 4) {
                    rt.allTimeSelectionData = new Uint8Array(count * 4);
                }
                element.runtime = element.runtime || {};
                element.runtime.selectionData = rt.selectionData;
                element.runtime.allTimeSelectionData = rt.allTimeSelectionData;
                if (rt.selectionTexture) {
                    element.runtime.selectionTexture = rt.selectionTexture;
                }
                targets.push({
                    elementIndex: idx,
                    selectionData: rt.selectionData as Uint8Array,
                    allTimeSelectionData: rt.allTimeSelectionData as Uint8Array,
                    selectionTexture: (rt.selectionTexture as pc.Texture | null) || null
                });
            }
            return targets;
        }

        if (!this.selectionData) return [];
        if (!this.allTimeSelectionData || this.allTimeSelectionData.length !== this.selectionData.length) {
            this.allTimeSelectionData = new Uint8Array(this.selectionData.length);
        }
        return [{
            elementIndex: -1,
            selectionData: this.selectionData,
            allTimeSelectionData: this.allTimeSelectionData,
            selectionTexture: this.selectionTexture
        }];
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
        const camera = this.viewer.camera?.camera;
        if (!camera) return false;

        const sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
            ? this.viewer.getSplatSequenceSelectionElements()
            : [];
        const hasSequence = Array.isArray(sequenceElements) && sequenceElements.length > 0;
        const targets = hasSequence ? sequenceElements : [{
            entity: this.viewer.splatEntity,
            runtime: {
                totalFrames: this.viewer.duration ?? 1,
                is4DGS: !!this.viewer.is4DGS,
                keyframes: this.viewer.keyframes,
                xyzStride: this.viewer.xyzStride,
                lifeTexData: this.viewer.lifeTexData,
                trajectoryData: this.viewer.trajectoryData,
                originalIndices: this.viewer.originalIndices,
                posArrays: this.viewer.posArrays,
                cachedPositions: this.getCachedPositions(),
                selectionData: this.selectionData,
                allTimeSelectionData: this.allTimeSelectionData,
                selectionTexture: this.selectionTexture
            }
        }];

        let anyChanged = false;
        const localPos = new pc.Vec3();
        const worldPos = new pc.Vec3();
        const screen = new pc.Vec3();

        for (const target of targets) {
            const rt = hasSequence ? this.buildSelectionRuntimeFromElement(target) : target?.runtime;
            const entity = target?.entity;
            let selectionData = (rt?.selectionData as Uint8Array | null) || null;
            let allTimeSelectionData = (rt?.allTimeSelectionData as Uint8Array | null) || null;
            const selectionTexture = (rt?.selectionTexture as pc.Texture | null) || null;
            const basePositions = (rt?.cachedPositions as Float32Array | null) || null;
            if (!entity || !basePositions) continue;

            if (!selectionData || !allTimeSelectionData) {
                const bytes = Math.max(0, Math.floor(basePositions.length / 3)) * 4;
                selectionData = selectionData || new Uint8Array(bytes);
                allTimeSelectionData = allTimeSelectionData || new Uint8Array(bytes);
                if (hasSequence) {
                    target.runtime = target.runtime || {};
                    target.runtime.selectionData = selectionData;
                    target.runtime.allTimeSelectionData = allTimeSelectionData;
                }
            }

            const numSplats = Math.floor(basePositions.length / 3);
            const found = new Uint8Array(numSplats);
            const tempPos = new Float32Array(numSplats * 3);
            const modelMat = entity.getWorldTransform();
            const totalFrames = Math.max(1, Math.ceil(rt?.totalFrames ?? 1));

            for (let t = 0; t < totalFrames; t++) {
                const framePositions = this.getPositionsAtTimeForRuntime(rt, t, tempPos);
                if (!framePositions) continue;

                for (let i = 0; i < numSplats; i++) {
                    if (found[i]) continue;

                    const idx4 = i * 4;
                    if (selectionData[idx4 + 1] > 0) continue;
                    if (!this.isVisibleAtTimeForRuntime(rt, i, t)) continue;

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
                    allTimeSelectionData[idx4] = 0;
                    if (selectionData[idx4] > 0) {
                        selectionData[idx4] = 0;
                        changed = true;
                    }
                } else {
                    allTimeSelectionData[idx4] = 255;
                    if (selectionData[idx4] === 0) {
                        selectionData[idx4] = 255;
                        changed = true;
                    }
                }
            }

            if (changed) {
                anyChanged = true;
                this.updateTextureForRuntime(selectionTexture, selectionData);
            }
        }

        return anyChanged;
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

    updatePolyOverlay() {
        if (!this.polyLine || !this.polyCursorLine) return;
        if (this.polyPoints.length === 0) {
            this.polyLine.setAttribute('points', '');
            this.polyCursorLine.setAttribute('x1', '0');
            this.polyCursorLine.setAttribute('y1', '0');
            this.polyCursorLine.setAttribute('x2', '0');
            this.polyCursorLine.setAttribute('y2', '0');
            return;
        }
        
        let ptsStr = this.polyPoints.map(p => `${p.x},${p.y}`).join(' ');
        this.polyLine.setAttribute('points', ptsStr);
        
        const last = this.polyPoints[this.polyPoints.length - 1];
        this.polyCursorLine.setAttribute('x1', last.x.toString());
        this.polyCursorLine.setAttribute('y1', last.y.toString());
    }

    performPolygon(pts: Array<{x: number, y: number}>) {
        if (pts.length < 3) return;
        
        const isAllTime = this.isAllTimeTool();
        const minX = Math.min(...pts.map(p => p.x));
        const maxX = Math.max(...pts.map(p => p.x));
        const minY = Math.min(...pts.map(p => p.y));
        const maxY = Math.max(...pts.map(p => p.y));
        
        const pointInPoly = (x: number, y: number) => {
            let inside = false;
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
                const xi = pts[i].x, yi = pts[i].y;
                const xj = pts[j].x, yj = pts[j].y;
                const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
                if (intersect) inside = !inside;
            }
            return inside;
        };

        const checkInPoly = (sx: number, sy: number, sz: number) => {
            let padding = 0;
            if (this.selectionMode === 'ellipse') {
                padding = Math.max(2, Math.min(15, 100 / (sz + 5)));
            }
            if (sx < minX - padding || sx > maxX + padding || sy < minY - padding || sy > maxY + padding) return false;
            return pointInPoly(sx, sy);
        };

        // #WDD 2026-04-20: For all-time tool, use selectAllTimePoints helper which iterates through all frames
        if (isAllTime) {
            const changed = this.selectAllTimePoints((sx, sy, sz) => checkInPoly(sx, sy, sz));
            if (changed) this.updateTexture();
            return;
        }

        // Standard tool: only check current frame
        const positions = this.getCachedPositions();
        if (!positions || !this.selectionData) return;

        const camera = this.viewer.camera?.camera;
        if (!camera) return;

        let changed = false;
        const numSplats = positions.length / 3;
        const screen = new pc.Vec3();
        const modelMat = this.viewer.splatEntity.getWorldTransform();
        const localPos = new pc.Vec3();
        const worldPos = new pc.Vec3();
        const currentTime = this.getCurrentTime();

        for (let i = 0; i < numSplats; i++) {
            if (!this.isVisibleAtTime(i, currentTime)) continue;
            
            localPos.set(positions[i*3], positions[i*3+1], positions[i*3+2]);
            modelMat.transformPoint(localPos, worldPos);
            camera.worldToScreen(worldPos, screen);

            if (screen.z > 0 && checkInPoly(screen.x, screen.y, screen.z)) {
                const idx = i * 4;
                if (this.selectionData[idx + 1] > 0) continue; // Skip deleted
                
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

        if (changed) this.updateTexture();
    }

}
