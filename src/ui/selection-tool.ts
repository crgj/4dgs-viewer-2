
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
    // #WDD-gpt 2026-05-16 - 记录当前选区语义；圆柱选择写入的是 all-time 选区，反选/删除必须按全时段处理
    private selectionScope: 'current' | 'alltime' = 'current';

    // #WDD-gpt 2026-06-13 - 记录当前/全时段范围开关，用同一套工具按钮派生具体选择工具
    isAllTimeMode = false;
    // #WDD-gpt 2026-06-13 - Render ALL 下禁用普通选择工具，避免快捷键绕过灰掉的按钮
    private renderAllSelectionDisabled = false;

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
        if (this.isSegmentLoading()) return;
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
            this.commitGlobalSelectionTarget(target);
        }
        if (changed) this.pushUndoSnapshot(before);
        if (changed) this.selectionScope = 'current';
        this.updateTexture();
    }

    deleteSelected() {
        if (this.renderAllSelectionDisabled) return;
        const before = this.captureGlobalSelectionState();
        const targets = this.getGlobalSelectionTargets();
        let deletedTotal = 0;
        let hiddenSelectedTotal = 0;
        const allowAllTimeDelete = this.isAllTimeTool() || this.selectionScope === 'alltime';

        // #WDD-kimi 2026-04-20 - 删除改为跨所有段：对每段已选点同步打删除标记
        for (const target of targets) {
            const deletedIndices: number[] = [];
            const totalSplats = Math.floor(target.selectionData.length / 4);
            for (let i = 0; i < totalSplats; i++) {
                const idx = i * 4;
                // #WDD-gpt 2026-06-13 - 普通 Delete 只删除当前显示高亮；all-time 工具/作用域才删除隐藏生命周期选区
                const selectedNow = target.selectionData[idx] > 0;
                const selectedAllTime = !!target.allTimeSelectionData && idx < target.allTimeSelectionData.length && target.allTimeSelectionData[idx] > 0;
                if (!selectedNow && selectedAllTime) hiddenSelectedTotal++;
                if (selectedNow || (allowAllTimeDelete && selectedAllTime)) {
                    deletedIndices.push(i);
                    target.selectionData[idx + 1] = 255;
                    target.selectionData[idx] = 0;
                    if (target.allTimeSelectionData && idx + 1 < target.allTimeSelectionData.length) {
                        target.allTimeSelectionData[idx + 1] = 255;
                        target.allTimeSelectionData[idx] = 0;
                    }
                }
            }
            if (deletedIndices.length > 0) {
                deletedTotal += deletedIndices.length;
                this.updateTextureForRuntime(target.selectionTexture, target.selectionData);
                this.commitGlobalSelectionTarget(target);
            }
        }

        if (deletedTotal > 0) {
            this.pushUndoSnapshot(before);
            this.selectionScope = 'current';
            this.updateTexture();
            console.log(`[Selection] Deleted ${deletedTotal} points across sequence. Undo stack: ${this.undoStack.length}`);
        } else if (hiddenSelectedTotal > 0 && !allowAllTimeDelete) {
            console.warn(`[Selection] Delete skipped ${hiddenSelectedTotal} hidden all-time selected points. Switch to an all-time selection tool to delete them.`);
        }
    }

    deleteNormallyHiddenPointsWithConfirm() {
        if (!this.selectionData) return;
        const positions = this.getCachedPositions();
        const count = positions ? Math.floor(positions.length / 3) : Math.floor(this.selectionData.length / 4);
        const isNormallyVisible = typeof this.viewer?.isDebugPointNormallyVisible === 'function'
            ? (index: number) => !!this.viewer.isDebugPointNormallyVisible(index)
            : (_index: number) => true;

        const targets: number[] = [];
        const max = Math.min(count, Math.floor(this.selectionData.length / 4));
        for (let i = 0; i < max; i++) {
            const idx = i * 4;
            if (this.selectionData[idx + 1] > 0) continue;
            if (!isNormallyVisible(i)) targets.push(i);
        }

        if (targets.length === 0) {
            alert('No normal-hidden, undeleted points were found in the current frame.');
            return;
        }

        const ok = confirm(`Delete ${targets.length.toLocaleString()} normal-hidden points in the current frame?\n\nThese points will be marked as deleted and filtered during export.`);
        if (!ok) return;

        const before = this.captureGlobalSelectionState();
        for (const i of targets) {
            const idx = i * 4;
            this.selectionData[idx] = 0;
            this.selectionData[idx + 1] = 255;
            if (this.allTimeSelectionData && idx + 1 < this.allTimeSelectionData.length) {
                this.allTimeSelectionData[idx] = 0;
                this.allTimeSelectionData[idx + 1] = 255;
            }
        }

        // #WDD-gpt 2026-06-13 - 独立按钮批量删除 normal 不可见点，写入当前激活段选择纹理并保留 undo
        this.pushUndoSnapshot(before);
        this.selectionScope = 'current';
        this.updateTexture();
        this.commitActiveSelectionState();
        if (typeof this.viewer?.refreshDebugAllPointsEntity === 'function') {
            this.viewer.refreshDebugAllPointsEntity();
        }
        console.log(`[Selection] Deleted ${targets.length} normally hidden points at current frame.`);
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
            const invertAllTime = this.isAllTimeTool() || this.selectionScope === 'alltime';
            const activeIndex = Number.isInteger(this.viewer?.splatSequence?.activeElementIndex)
                ? this.viewer.splatSequence.activeElementIndex
                : (Number.isInteger(this.viewer?.sog4SequenceIndex) ? this.viewer.sog4SequenceIndex : -1);
            let changed = false;
            // #WDD-kimi 2026-04-20 - 反选改为全序列：对每个段的所有非删除点执行反向
            for (const element of sequenceElements) {
                const rt = this.buildSelectionRuntimeFromElement(element);
                const data = (rt?.selectionData as Uint8Array | null) || null;
                let allTimeData = (rt?.allTimeSelectionData as Uint8Array | null) || null;
                const tex = (rt?.selectionTexture as pc.Texture | null) || null;
                if (!data) continue;
                if (invertAllTime && (!allTimeData || allTimeData.length !== data.length)) {
                    allTimeData = new Uint8Array(data.length);
                    rt.allTimeSelectionData = allTimeData;
                    element.runtime = element.runtime || {};
                    element.runtime.allTimeSelectionData = allTimeData;
                }
                const count = Math.floor(data.length / 4);
                const elementIndex = Array.isArray(sequenceElements) ? sequenceElements.indexOf(element) : -1;
                const currentTime = elementIndex === activeIndex ? this.getCurrentTime() : null;
                for (let i = 0; i < count; i++) {
                    const idx = i * 4;
                    if (data[idx + 1] > 0) continue;
                    changed = true;
                    if (invertAllTime && allTimeData) {
                        // #WDD-gpt 2026-05-16 - 圆柱 all-time 反选必须以 all-time 通道为基准，不能用当前帧高亮通道
                        allTimeData[idx] = allTimeData[idx] > 0 ? 0 : 255;
                        data[idx] = currentTime !== null && this.isVisibleAtTimeForRuntime(rt, i, currentTime) ? allTimeData[idx] : 0;
                    } else {
                        data[idx] = data[idx] > 0 ? 0 : 255;
                        if (allTimeData && idx < allTimeData.length) allTimeData[idx] = data[idx];
                    }
                }
                this.updateTextureForRuntime(tex, data);
                if (elementIndex >= 0) {
                    const allTime = (allTimeData || data) as Uint8Array;
                    this.commitSequenceEditState(elementIndex, data, allTime);
                }
            }
            if (changed) this.pushUndoSnapshot(before);
            this.updateTexture();
            return;
        }

        const before = this.captureGlobalSelectionState();
        const isAllTime = this.isAllTimeTool();
        const shouldInvertAllTime = isAllTime || this.selectionScope === 'alltime';
        let changed = false;
        if (shouldInvertAllTime && (!this.allTimeSelectionData || this.allTimeSelectionData.length !== this.selectionData.length)) {
            this.allTimeSelectionData = new Uint8Array(this.selectionData.length);
        }
        for (let i = 0; i < totalSplats; i++) {
            const idx = i * 4;
            if (this.selectionData[idx + 1] > 0) continue;
            if (shouldInvertAllTime && this.allTimeSelectionData) {
                changed = true;
                this.allTimeSelectionData[idx] = this.allTimeSelectionData[idx] > 0 ? 0 : 255;
                this.selectionData[idx] = this.isVisibleAtCurrentTime(i) ? this.allTimeSelectionData[idx] : 0;
            } else if (this.isVisibleAtCurrentTime(i)) {
                changed = true;
                this.selectionData[idx] = this.selectionData[idx] > 0 ? 0 : 255;
                if (this.allTimeSelectionData && idx < this.allTimeSelectionData.length) {
                    this.allTimeSelectionData[idx] = this.selectionData[idx];
                }
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

    markAllTimeSelectionScope() {
        this.selectionScope = 'alltime';
    }

    // #WDD-gpt 2026-05-16 - all-time 选择分离当前高亮通道和全时段操作通道，避免当前帧显示大量圆柱外点
    selectAllTimeIndices(currentIndices: number[], allTimeIndices: number[], replace = true) {
        if (!this.selectionData) return 0;
        if (!this.allTimeSelectionData || this.allTimeSelectionData.length !== this.selectionData.length) {
            this.allTimeSelectionData = new Uint8Array(this.selectionData.length);
        }
        const before = this.captureGlobalSelectionState();
        if (replace) {
            for (let i = 0; i < this.selectionData.length; i += 4) this.selectionData[i] = 0;
            for (let i = 0; i < this.allTimeSelectionData.length; i += 4) this.allTimeSelectionData[i] = 0;
        }
        const current = this.writeSelectionIndices(this.selectionData, currentIndices);
        const allTime = this.writeSelectionIndices(this.allTimeSelectionData, allTimeIndices);
        this.selectionScope = 'alltime';
        this.pushUndoSnapshot(before);
        this.updateTexture();
        return allTime || current;
    }

    selectAllTimeIndicesForElement(element: any, currentIndices: number[], allTimeIndices: number[], replace = true) {
        const rt = this.buildSelectionRuntimeFromElement(element);
        const positions = rt?.cachedPositions as Float32Array | null | undefined;
        if (!rt || !positions) return 0;
        const count = Math.floor(positions.length / 3);
        const bytes = Math.max(count * 4, rt.selectionData?.length || 0);
        if (!rt.selectionData || rt.selectionData.length < count * 4) rt.selectionData = new Uint8Array(bytes);
        if (!rt.allTimeSelectionData || rt.allTimeSelectionData.length < count * 4) rt.allTimeSelectionData = new Uint8Array(bytes);
        const selectionData = rt.selectionData as Uint8Array;
        const allTimeSelectionData = rt.allTimeSelectionData as Uint8Array;
        if (replace) {
            for (let i = 0; i < selectionData.length; i += 4) selectionData[i] = 0;
            for (let i = 0; i < allTimeSelectionData.length; i += 4) allTimeSelectionData[i] = 0;
        }
        const current = this.writeSelectionIndices(selectionData, currentIndices, count);
        const allTime = this.writeSelectionIndices(allTimeSelectionData, allTimeIndices, count);
        element.runtime = element.runtime || {};
        element.runtime.selectionData = selectionData;
        element.runtime.allTimeSelectionData = allTimeSelectionData;
        element.runtime.selectionTexture = rt.selectionTexture || element.runtime.selectionTexture || null;
        if (rt.selectionTexture) this.updateTextureForRuntime(rt.selectionTexture, selectionData);
        const sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
            ? this.viewer.getSplatSequenceSelectionElements()
            : [];
        const elementIndex = Array.isArray(sequenceElements) ? sequenceElements.indexOf(element) : -1;
        if (elementIndex >= 0) this.commitSequenceEditState(elementIndex, selectionData, allTimeSelectionData);
        this.selectionScope = 'alltime';
        return allTime || current;
    }

    private writeSelectionIndices(target: Uint8Array, indices: number[], count = Math.floor(target.length / 4)) {
        let selected = 0;
        for (const splatIdx of indices) {
            if (!Number.isFinite(splatIdx)) continue;
            const i = Math.floor(splatIdx);
            if (i < 0 || i >= count) continue;
            const offset = i * 4;
            if (target[offset + 1] > 0) continue;
            target[offset] = 255;
            selected++;
        }
        return selected;
    }

    // #WDD-gpt 2026-05-16 - 允许智能选择算法按点索引批量写入当前选择通道
    selectIndices(indices: number[], replace = true, allTime = true) {
        if (!this.selectionData) return 0;

        const before = this.captureGlobalSelectionState();
        let changed = false;
        if (replace) {
            for (let i = 0; i < this.selectionData.length; i += 4) {
                if (this.selectionData[i] !== 0) changed = true;
                this.selectionData[i] = 0;
            }
            if (this.allTimeSelectionData) {
                for (let i = 0; i < this.allTimeSelectionData.length; i += 4) {
                    if (this.allTimeSelectionData[i] !== 0) changed = true;
                    this.allTimeSelectionData[i] = 0;
                }
            }
        }

        let selected = 0;
        const total = Math.floor(this.selectionData.length / 4);
        for (const splatIdx of indices) {
            if (!Number.isFinite(splatIdx)) continue;
            const i = Math.floor(splatIdx);
            if (i < 0 || i >= total) continue;
            const offset = i * 4;
            if (this.selectionData[offset + 1] > 0) continue;
            if (this.selectionData[offset] !== 255) changed = true;
            this.selectionData[offset] = 255;
            if (allTime && this.allTimeSelectionData && offset < this.allTimeSelectionData.length) {
                this.allTimeSelectionData[offset] = 255;
            }
            selected++;
        }

        if (changed) {
            if (allTime) this.selectionScope = 'alltime';
            this.pushUndoSnapshot(before);
            this.updateTexture();
        }
        return selected;
    }

    // #WDD-gpt 2026-05-16 - 支持智能选择在不切换可见段的情况下写入指定 PLY4 序列段
    selectIndicesForElement(element: any, indices: number[], replace = true, allTime = true) {
        const rt = this.buildSelectionRuntimeFromElement(element);
        const positions = rt?.cachedPositions as Float32Array | null | undefined;
        if (!rt || !positions) return 0;

        const count = Math.floor(positions.length / 3);
        const bytes = Math.max(count * 4, rt.selectionData?.length || 0);
        if (!rt.selectionData || rt.selectionData.length < count * 4) rt.selectionData = new Uint8Array(bytes);
        if (!rt.allTimeSelectionData || rt.allTimeSelectionData.length < count * 4) rt.allTimeSelectionData = new Uint8Array(bytes);

        const selectionData = rt.selectionData as Uint8Array;
        const allTimeSelectionData = rt.allTimeSelectionData as Uint8Array;
        const sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
            ? this.viewer.getSplatSequenceSelectionElements()
            : [];
        const activeIndex = Number.isInteger(this.viewer?.splatSequence?.activeElementIndex)
            ? this.viewer.splatSequence.activeElementIndex
            : (Number.isInteger(this.viewer?.sog4SequenceIndex) ? this.viewer.sog4SequenceIndex : -1);
        const isActiveElement = Array.isArray(sequenceElements) && sequenceElements[activeIndex] === element;
        if (!rt.selectionTexture && isActiveElement && this.selectionTexture && selectionData.length === this.selectionData?.length) {
            rt.selectionTexture = this.selectionTexture;
        }

        if (replace) {
            for (let i = 0; i < selectionData.length; i += 4) selectionData[i] = 0;
            for (let i = 0; i < allTimeSelectionData.length; i += 4) allTimeSelectionData[i] = 0;
        }

        let selected = 0;
        for (const splatIdx of indices) {
            if (!Number.isFinite(splatIdx)) continue;
            const i = Math.floor(splatIdx);
            if (i < 0 || i >= count) continue;
            const offset = i * 4;
            if (selectionData[offset + 1] > 0) continue;
            selectionData[offset] = 255;
            if (allTime) allTimeSelectionData[offset] = 255;
            selected++;
        }

        element.runtime = element.runtime || {};
        element.runtime.selectionData = selectionData;
        element.runtime.allTimeSelectionData = allTimeSelectionData;
        element.runtime.selectionTexture = rt.selectionTexture || element.runtime.selectionTexture || null;
        if (rt.selectionTexture) this.updateTextureForRuntime(rt.selectionTexture, selectionData);
        const elementIndex = Array.isArray(sequenceElements) ? sequenceElements.indexOf(element) : -1;
        if (elementIndex >= 0) this.commitSequenceEditState(elementIndex, selectionData, allTimeSelectionData);
        if (allTime) this.selectionScope = 'alltime';

        if (isActiveElement) {
            this.selectionData = selectionData;
            this.allTimeSelectionData = allTimeSelectionData;
            if (rt.selectionTexture) {
                this.selectionTexture = rt.selectionTexture;
                this.viewer.updateSelectionUniform(rt.selectionTexture);
            }
        }
        return selected;
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
        // #WDD-gpt 2026-05-16 - 当前帧选择后可能尚未写入段落保存态，捕获前先提交，避免旧的 all-time 删除状态覆盖实时选区
        this.commitActiveSelectionState();
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
            this.commitGlobalSelectionTarget(target);
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

    // All-time selection progress overlay
    private allTimeProgressEl: HTMLElement | null = null;

    private createAllTimeProgressOverlay() {
        const el = document.createElement('div');
        el.id = 'alltime-progress-overlay';
        el.className = 'fixed inset-0 z-50 hidden flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto';
        el.innerHTML = `
            <div class="glass-blue p-5 rounded-xl flex flex-col items-center gap-3 min-w-[240px]">
                <div class="flex items-center gap-2">
                    <svg class="w-5 h-5 text-amber-400 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20" stroke-linecap="round"/>
                    </svg>
                    <span class="text-sm font-bold text-white">All-Time Selection</span>
                </div>
                <div class="w-full h-2 bg-white/10 rounded-full overflow-hidden">
                    <div id="alltime-progress-bar" class="h-full bg-amber-400 rounded-full transition-all duration-200" style="width: 0%"></div>
                </div>
                <span id="alltime-progress-text" class="text-xs text-gray-300 font-mono">0 / 0 frames</span>
            </div>
        `;
        document.body.appendChild(el);
        this.allTimeProgressEl = el;
    }

    private showAllTimeProgress(current: number, total: number) {
        if (!this.allTimeProgressEl) return;
        this.allTimeProgressEl.classList.remove('hidden');
        const bar = document.getElementById('alltime-progress-bar');
        const text = document.getElementById('alltime-progress-text');
        const pct = total > 0 ? (current / total) * 100 : 0;
        if (bar) bar.style.width = `${pct}%`;
        if (text) text.textContent = `${current} / ${total} frames`;
    }

    private hideAllTimeProgress() {
        this.allTimeProgressEl?.classList.add('hidden');
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
        div.dataset.leftPanel = 'edit';
        div.className = 'hidden flex-row items-start gap-2 pointer-events-none transition-all duration-500';
        div.innerHTML = `
            <div id="selection-toolbar-inner" class="flex flex-col gap-1.5 w-[160px] shrink-0">
                
                <!-- #WDD-gpt 2026-06-13 - 当前/全时段改为同一段控件，减少左侧栏重复工具组 -->
                <div id="selection-alltime-tools" class="selection-panel-group glass-blue p-1 rounded-md flex flex-row pointer-events-auto shadow-sm" aria-label="Selection time scope">
                    <button id="scope-current" class="selection-scope-btn active flex-1 py-1.5 text-[9px] rounded font-bold transition-all shadow-sm">Current</button>
                    <button id="scope-alltime" class="selection-scope-btn flex-1 py-1.5 text-[9px] rounded font-bold transition-all">All-Time</button>
                </div>

                <div id="selection-current-tools" class="selection-panel-group glass-blue p-1.5 rounded-md flex flex-col gap-1 pointer-events-auto shadow-sm">
                    <div class="selection-group-label">Tools</div>
                    <div class="grid grid-cols-3 gap-1.5">
                    <button id="tool-brush" class="selection-icon-btn ui-btn p-2 rounded-lg has-tooltip" aria-label="Brush" data-tip="Brush">
                        ${ICON_BRUSH}
                    </button>
                    <button id="tool-rect" class="selection-icon-btn ui-btn p-2 rounded-lg has-tooltip" aria-label="Rect" data-tip="Rect">
                        ${ICON_RECT}
                    </button>
                    <button id="tool-poly" class="selection-icon-btn ui-btn p-2 rounded-lg has-tooltip" aria-label="Polygon" data-tip="Poly">
                        ${ICON_POLY}
                    </button>
                    </div>
                </div>

                <div id="selection-mode-tools" class="selection-panel-group glass-blue p-1 rounded-md flex flex-col gap-1 pointer-events-auto shadow-sm">
                    <div class="selection-group-label">Hit Mode</div>
                    <div class="selection-compact-segment">
                    <button id="select-mode-center" class="selection-hit-mode-btn ui-btn has-tooltip" aria-label="Center Mode" data-tip="Center">
                        ${ICON_CENTER}
                    </button>
                    <button id="select-mode-ellipse" class="selection-hit-mode-btn ui-btn has-tooltip" aria-label="Ellipse Mode" data-tip="Ellipse">
                        ${ICON_ELLIPSE}
                    </button>
                    </div>
                </div>

                <div id="selection-action-tools" class="selection-panel-group glass-blue p-1.5 rounded-md flex flex-col gap-1 pointer-events-auto shadow-sm">
                    <div class="selection-group-label">Edit</div>
                    <div id="selection-operation-tools" class="grid grid-cols-[1fr_1fr_1px_1fr] gap-1.5 items-center">
                    <button id="tool-invert" class="selection-icon-btn ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Invert" data-tip="Invert">
                        ${ICON_INVERT}
                    </button>
                    <button id="tool-clear" class="selection-icon-btn ui-btn p-1.5 rounded-lg has-tooltip" aria-label="Clear" data-tip="Clear">
                        ${ICON_CLEAR}
                    </button>
                    <div class="w-px h-5 bg-white/10 justify-self-center"></div>
                    <button id="action-delete" class="selection-icon-btn p-1.5 rounded-lg hover:bg-red-500/20 text-red-500 active:scale-95 transition-all has-tooltip" aria-label="Delete" data-tip="Delete">
                        <svg viewBox="0 0 24 24" class="w-4 h-4 fill-current"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                    </div>
                    <!-- #WDD-gpt 2026-06-13 - Delete Hidden 属于 Edit 面板操作，不再放在 Smart 面板内部 -->
                    <button id="action-delete-hidden"
                        class="ui-btn h-7 rounded-md flex items-center justify-center gap-1 text-pink-400 border border-pink-500/25 hover:bg-pink-500/15 has-tooltip"
                        aria-label="Delete Hidden Points" data-tip="Delete normal hidden points">
                        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current" aria-hidden="true">
                            <path d="M12 6.5c2.76 0 5 2.24 5 5 0 .66-.13 1.29-.36 1.87l3.18 3.18C21.17 15.35 22.23 13.78 23 11.5 21.27 6.89 16.89 4 12 4c-1.4 0-2.74.24-3.98.68l2.35 2.35c.52-.34 1.13-.53 1.63-.53zM2.28 3 1 4.27l2.42 2.42C2.37 7.85 1.55 9.43 1 11.5 2.73 16.11 7.11 19 12 19c1.56 0 3.04-.3 4.38-.84L19.73 21 21 19.73 2.28 3zM7.53 10.8l1.55 1.55c.3 1.35 1.37 2.42 2.72 2.72l1.55 1.55c-.43.15-.88.23-1.35.23-2.76 0-5-2.24-5-5 0-.47.08-.92.23-1.35z" />
                        </svg>
                        <span class="text-[8px] font-bold tracking-tight uppercase">Delete Hidden</span>
                    </button>
                </div>
                
                <!-- #WDD-gpt 2026-06-13 - 保留旧删除容器 ID 兼容 Render ALL 联动代码 -->
                <div id="selection-delete-tools" class="hidden"></div>
            </div>
            
            <!-- Brush Settings (Hidden by default, shown on right) -->
            <div id="brush-settings" class="glass-blue p-3 rounded-lg pointer-events-auto hidden transition-all flex-col gap-2 items-center shadow-sm">
                <span class="text-[10px] uppercase font-bold ui-text-dim text-center whitespace-nowrap">Brush Size</span>
                <div class="h-32 w-8 flex items-center justify-center relative">
                    <!-- Standard slider rotated -90deg -->
                    <input type="range" id="brush-size" min="10" max="200" value="50" class="absolute w-32 h-2 -rotate-90 origin-center cursor-pointer"/>
                </div>
                <span id="brush-size-val" class="text-xs text-center font-mono ui-text-highlight">50</span>
            </div>
        `;
        const leftToolsPanel = document.getElementById('left-tools-panel');
        if (leftToolsPanel) {
            leftToolsPanel.appendChild(div);
        } else {
            div.classList.add('fixed', 'left-6', 'top-[20rem]', 'z-20');
            document.body.appendChild(div);
        }

        // #WDD-gpt 2026-06-13 - 撤销/重做/帮助移动到顶部品牌栏右侧，减少左侧编辑栏高度
        const topRight = document.createElement('div');
        topRight.id = 'selection-top-right-toolbar';
        topRight.className = 'selection-topbar-actions flex flex-row gap-1.5 pointer-events-auto transition-all duration-500';
        topRight.innerHTML = `
            <div class="flex flex-row gap-1 items-center justify-center">
                <button id="action-undo" class="selection-icon-btn ui-btn p-2 rounded-lg has-tooltip" aria-label="Undo" data-tip="Undo (Ctrl+Z)">
                    ${ICON_UNDO}
                </button>
                <button id="action-redo" class="selection-icon-btn ui-btn p-2 rounded-lg has-tooltip" aria-label="Redo" data-tip="Redo (Ctrl+Y)">
                    ${ICON_REDO}
                </button>
                <div class="w-px h-5 bg-white/10 mx-0.5"></div>
                <button id="action-help" class="selection-icon-btn ui-btn p-2 rounded-lg has-tooltip text-yellow-400" aria-label="Help" data-tip="Shortcuts Help">
                    ${ICON_HELP}
                </button>
            </div>
        `;
        const headerBar = document.querySelector('#header-brand > .glass-blue');
        if (headerBar) {
            headerBar.appendChild(topRight);
        } else {
            topRight.classList.add('fixed', 'right-6', 'top-6', 'z-20');
            document.body.appendChild(topRight);
        }

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

        // All-time selection progress overlay
        this.createAllTimeProgressOverlay();

        this.toolbar = div;

        // Listeners
        const get = (id: string) => document.getElementById(id);

        get('scope-current')?.addEventListener('click', () => this.setTimeScope('current'));
        get('scope-alltime')?.addEventListener('click', () => this.setTimeScope('alltime'));

        get('tool-brush')?.addEventListener('click', () => this.setTool(this.isAllTimeMode ? 'brush-alltime' : 'brush'));
        get('tool-rect')?.addEventListener('click', () => this.setTool(this.isAllTimeMode ? 'rect-alltime' : 'rect'));
        get('tool-poly')?.addEventListener('click', () => this.setTool(this.isAllTimeMode ? 'poly-alltime' : 'poly'));

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
        get('action-delete-hidden')?.addEventListener('click', () => {
            this.deleteNormallyHiddenPointsWithConfirm();
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
        this.refreshLazyModeVisibility();
    }

    // #WDD-gpt 2026-05-16 - Lazy PLY4 模式下隐藏手工区域/笔刷工具，只保留反选组和删除组
    refreshLazyModeVisibility() {
        const lazy = typeof (this.viewer as any).isPly4LazySequenceMode === 'function'
            ? !!(this.viewer as any).isPly4LazySequenceMode()
            : false;
        for (const id of ['selection-current-tools', 'selection-alltime-tools', 'selection-mode-tools']) {
            const group = document.getElementById(id);
            if (!group) continue;
            group.classList.toggle('hidden', lazy);
            // #WDD-gpt 2026-05-16 - 避免动态 Tailwind class 顺序导致 flex 组在 Lazy 模式仍显示
            group.style.display = lazy ? 'none' : '';
            group.setAttribute('aria-hidden', lazy ? 'true' : 'false');
            for (const button of Array.from(group.querySelectorAll('button'))) {
                (button as HTMLButtonElement).disabled = lazy;
                button.classList.toggle('pointer-events-none', lazy);
                button.classList.toggle('opacity-40', lazy);
            }
        }
        if (lazy && this.currentTool !== 'none') {
            this.setTool('none');
        }
        if (lazy) {
            const settings = document.getElementById('brush-settings');
            settings?.classList.add('hidden');
            settings?.classList.remove('flex');
            document.getElementById('brush-cursor-overlay')?.classList.add('hidden');
            if (this.polyOverlay) this.polyOverlay.style.display = 'none';
        }
        document.getElementById('selection-toolbar')?.classList.toggle('selection-lazy-mode', lazy);
    }

    private isLazyManualSelectionDisabled() {
        return typeof (this.viewer as any).isPly4LazySequenceMode === 'function'
            ? !!(this.viewer as any).isPly4LazySequenceMode()
            : false;
    }

    private isSegmentLoading() {
        return typeof (this.viewer as any).isPly4SegmentLoading === 'function'
            ? !!(this.viewer as any).isPly4SegmentLoading()
            : false;
    }

    setTimeScope(scope: 'current' | 'alltime') {
        if (this.renderAllSelectionDisabled) return;
        this.isAllTimeMode = scope === 'alltime';
        
        const get = (id: string) => document.getElementById(id);
        const btnCurrent = get('scope-current');
        const btnAllTime = get('scope-alltime');
        
        if (this.isAllTimeMode) {
            btnAllTime?.classList.add('active');
            btnCurrent?.classList.remove('active');
        } else {
            btnCurrent?.classList.add('active');
            btnAllTime?.classList.remove('active');
        }
        
        // #WDD-gpt 2026-06-13 - 范围切换时保持当前工具类型，只切换 current/all-time 语义
        if (this.currentTool !== 'none') {
            if (this.currentTool.startsWith('brush')) {
                this.setTool(this.isAllTimeMode ? 'brush-alltime' : 'brush', true);
            } else if (this.currentTool.startsWith('rect')) {
                this.setTool(this.isAllTimeMode ? 'rect-alltime' : 'rect', true);
            } else if (this.currentTool.startsWith('poly')) {
                this.setTool(this.isAllTimeMode ? 'poly-alltime' : 'poly', true);
            }
        } else {
            // #WDD-gpt 2026-06-13 - 未激活工具时仍更新图标颜色，保证范围状态可见
            const brushBtn = get('tool-brush');
            const rectBtn = get('tool-rect');
            const polyBtn = get('tool-poly');
            if (brushBtn) brushBtn.innerHTML = this.isAllTimeMode ? ICON_BRUSH_ALLTIME : ICON_BRUSH;
            if (rectBtn) rectBtn.innerHTML = this.isAllTimeMode ? ICON_RECT_ALLTIME : ICON_RECT;
            if (polyBtn) polyBtn.innerHTML = this.isAllTimeMode ? ICON_POLY_ALLTIME : ICON_POLY;
            
            if (this.isAllTimeMode) {
                 brushBtn?.classList.add('text-amber-400', 'alltime-tool');
                 rectBtn?.classList.add('text-amber-400', 'alltime-tool');
                 polyBtn?.classList.add('text-amber-400', 'alltime-tool');
            } else {
                 brushBtn?.classList.remove('text-amber-400', 'alltime-tool');
                 rectBtn?.classList.remove('text-amber-400', 'alltime-tool');
                 polyBtn?.classList.remove('text-amber-400', 'alltime-tool');
            }
        }
        this.updateCursorState();
    }

    setTool(tool: 'brush' | 'rect' | 'brush-alltime' | 'rect-alltime' | 'poly' | 'poly-alltime' | 'none', force = false) {
        if (tool !== 'none' && this.renderAllSelectionDisabled) {
            tool = 'none';
        }
        if (tool !== 'none' && this.isLazyManualSelectionDisabled()) {
            tool = 'none';
        }
        if (!force && this.currentTool === tool && tool !== 'none') {
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
        
        ['tool-brush', 'tool-rect', 'tool-poly'].forEach(id => {
            get(id)?.classList.remove('active');
        });

        // #WDD-gpt 2026-06-13 - 工具图标跟随当前/全时段范围切换
        const brushBtn = get('tool-brush');
        const rectBtn = get('tool-rect');
        const polyBtn = get('tool-poly');
        
        if (brushBtn) {
            brushBtn.innerHTML = this.isAllTimeMode ? ICON_BRUSH_ALLTIME : ICON_BRUSH;
            this.isAllTimeMode ? brushBtn.classList.add('text-amber-400', 'alltime-tool') : brushBtn.classList.remove('text-amber-400', 'alltime-tool');
        }
        if (rectBtn) {
            rectBtn.innerHTML = this.isAllTimeMode ? ICON_RECT_ALLTIME : ICON_RECT;
            this.isAllTimeMode ? rectBtn.classList.add('text-amber-400', 'alltime-tool') : rectBtn.classList.remove('text-amber-400', 'alltime-tool');
        }
        if (polyBtn) {
            polyBtn.innerHTML = this.isAllTimeMode ? ICON_POLY_ALLTIME : ICON_POLY;
            this.isAllTimeMode ? polyBtn.classList.add('text-amber-400', 'alltime-tool') : polyBtn.classList.remove('text-amber-400', 'alltime-tool');
        }

        if (this.currentTool !== 'none') {
            let activeId = '';
            if (this.currentTool.startsWith('brush')) activeId = 'tool-brush';
            if (this.currentTool.startsWith('rect')) activeId = 'tool-rect';
            if (this.currentTool.startsWith('poly')) activeId = 'tool-poly';
            
            if (activeId) {
                get(activeId)?.classList.add('active');
            }
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
        this.updateCursorState();
    }

    setRenderAllSelectionDisabled(disabled: boolean) {
        this.renderAllSelectionDisabled = disabled;
        if (!disabled) return;
        this.isSelecting = false;
        this.brushPath = [];
        this.polyPoints = [];
        this.setTool('none');
        this.removeRectOverlay();
        if (this.polyOverlay) this.polyOverlay.style.display = 'none';
        document.getElementById('brush-cursor-overlay')?.classList.add('hidden');
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

            if (this.renderAllSelectionDisabled && (e.key === 'Delete' || ['1', '2', '3'].includes(e.key))) {
                e.preventDefault();
                this.setTool('none');
                return;
            }
            
            // #WDD 2026-04-10: Delete key to delete selected
            if (e.key === 'Delete') {
                this.deleteSelected();
            }

            // #WDD 2026-04-10: ESC to close help modal
            if (e.key === 'Escape') {
                this.hideHelpModal();
            }

            // #WDD-gpt 2026-06-13 - 数字键只切换三种工具，当前/全时段由顶部范围开关决定
            if (this.isLazyManualSelectionDisabled() && ['1', '2', '3'].includes(e.key)) {
                this.setTool('none');
                return;
            }
            if (e.key === '1') {
                this.setTool(this.isAllTimeMode ? 'brush-alltime' : 'brush');
            }
            if (e.key === '2') {
                this.setTool(this.isAllTimeMode ? 'rect-alltime' : 'rect');
            }
            if (e.key === '3') {
                this.setTool(this.isAllTimeMode ? 'poly-alltime' : 'poly');
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
        const tone = this.getSelectionOverlayTone();
        if (overlay) {
            // Apply visual change to brush cursor
            if (this.isSubtracting) {
                overlay.style.borderColor = '#ef4444'; // Red-500
                overlay.style.borderStyle = 'dashed';
                overlay.style.backgroundColor = 'rgba(239, 68, 68, 0.2)';
                overlay.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.32)';
            } else {
                overlay.style.borderColor = tone.stroke;
                overlay.style.borderStyle = 'solid';
                overlay.style.backgroundColor = tone.fill;
                overlay.style.boxShadow = tone.shadow;
            }
        }

        if (this.rectOverlay) {
            if (this.isSubtracting) {
                this.rectOverlay.className = 'fixed border-2 border-red-500 bg-red-500/20 pointer-events-none z-50';
                this.rectOverlay.style.borderStyle = 'dashed';
            } else {
                this.rectOverlay.className = 'fixed border-2 pointer-events-none z-50';
                this.rectOverlay.style.borderColor = tone.stroke;
                this.rectOverlay.style.backgroundColor = tone.fill;
                this.rectOverlay.style.borderStyle = 'solid';
            }
        }
        this.updatePolyOverlayTone();
    }

    onDblClick(e: MouseEvent) {
        if (this.currentTool !== 'poly' && this.currentTool !== 'poly-alltime') return;
        console.log("DBL CLICK TRIGGERED! polyPoints: ", this.polyPoints.length);
        
        if (this.polyPoints.length > 2) {
            console.log("CALLING PERFORM POLYGON");
            void this.performPolygon(this.polyPoints);
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
                    void this.performBrushEllipseAllTimePath(this.brushPath);
                } else {
                    void this.performBrushAllTimePath(this.brushPath);
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

    // #WDD-gpt 2026-06-13 - 绘制中的 brush/rect/poly 反馈跟随 Current/All-Time 范围切换
    private getSelectionOverlayTone() {
        return this.isAllTimeTool() || this.isAllTimeMode
            ? {
                stroke: '#fbbf24',
                fill: 'rgba(251, 191, 36, 0.18)',
                shadow: '0 0 15px rgba(251, 191, 36, 0.38)'
            }
            : {
                stroke: 'var(--text-highlight)',
                fill: 'var(--accent-glow)',
                shadow: '0 0 15px var(--accent-glow)'
            };
    }

    private updatePolyOverlayTone() {
        if (!this.polyLine || !this.polyCursorLine) return;
        const tone = this.isSubtracting
            ? { stroke: '#ef4444', fill: 'rgba(239, 68, 68, 0.18)' }
            : this.getSelectionOverlayTone();
        this.polyLine.setAttribute('fill', tone.fill);
        this.polyLine.setAttribute('stroke', tone.stroke);
        this.polyCursorLine.setAttribute('stroke', tone.stroke);
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

    // #WDD-gpt 2026-05-16 - Lazy PLY4 卸载段修改后必须立即写回 Viewer 的分段编辑状态
    private commitSequenceEditState(elementIndex: number, selectionData: Uint8Array, allTimeSelectionData: Uint8Array) {
        const setter = (this.viewer as any).setSequenceEditSelectionData;
        if (typeof setter === 'function') {
            setter.call(this.viewer, elementIndex, selectionData, allTimeSelectionData);
        }
    }

    private commitActiveSelectionState() {
        if (!this.selectionData) return;
        const elements = this.viewer?.splatSequence?.elements;
        if (!Array.isArray(elements) || elements.length === 0) return;
        const activeIndex = Number.isInteger(this.viewer?.splatSequence?.activeElementIndex)
            ? this.viewer.splatSequence.activeElementIndex
            : (Number.isInteger(this.viewer?.sog4SequenceIndex) ? this.viewer.sog4SequenceIndex : -1);
        if (activeIndex < 0 || activeIndex >= elements.length) return;
        const allTime = this.allTimeSelectionData && this.allTimeSelectionData.length === this.selectionData.length
            ? this.allTimeSelectionData
            : new Uint8Array(this.selectionData.length);
        // #WDD-gpt 2026-05-16 - 非 lazy 多段切换/删除前同步当前激活段，保证当前帧选择不会被旧保存态回滚
        this.commitSequenceEditState(activeIndex, this.selectionData, allTime);
    }

    private commitGlobalSelectionTarget(target: {
        elementIndex: number;
        selectionData: Uint8Array;
        allTimeSelectionData: Uint8Array;
    }) {
        if (target.elementIndex < 0) return;
        this.commitSequenceEditState(target.elementIndex, target.selectionData, target.allTimeSelectionData);
    }

    // #WDD-kimi 2026-04-20 - 当 runtime 尚未构建时，用 parsed 数据构造可用于 all-time 比对的运行时视图
    private buildSelectionRuntimeFromElement(element: any): any {
        const runtime = element?.runtime || {};

        const parsed = element?.parsed || {};
        const readProp = (name: string): Float32Array | null => {
            const props = parsed?.plyData?.elements?.[0]?.properties || [];
            const hit = props.find((p: any) => p?.name === name);
            return (hit?.storage as Float32Array) || null;
        };

        let cachedPositions: Float32Array | null = (runtime.cachedPositions as Float32Array | null) || null;
        const x = parsed?.x || readProp('x');
        const y = parsed?.y || readProp('y');
        const z = parsed?.z || readProp('z');
        if (!cachedPositions && x && y && z) {
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
        let lifeTexData: Float32Array | null = (runtime.lifeTexData as Float32Array | null) || null;
        if (!lifeTexData && cachedPositions && mu && w) {
            const count = Math.min(cachedPositions.length / 3, mu.length, w.length);
            lifeTexData = new Float32Array(count * 4);
            for (let i = 0; i < count; i++) {
                lifeTexData[i * 4 + 0] = mu[i];
                lifeTexData[i * 4 + 1] = w[i];
                lifeTexData[i * 4 + 2] = k ? k[i] : 10.0;
                lifeTexData[i * 4 + 3] = 0;
            }
        }

        const merged = {
            ...runtime,
            totalFrames: runtime.totalFrames || Math.max(1, Math.floor(parsed?.frames || parsed?.maxMu || element?.duration || 1)),
            is4DGS: runtime.is4DGS ?? !!parsed?.trajectory,
            keyframes: runtime.keyframes || parsed?.keyframes || 0,
            xyzStride: runtime.xyzStride || parsed?.xyzStride || 1,
            lifeTexData,
            trajectoryData: runtime.trajectoryData || parsed?.trajectory || null,
            originalIndices: runtime.originalIndices || parsed?.original_index || readProp('original_index'),
            posArrays: runtime.posArrays || (cachedPositions && x && y && z ? {
                x: x as Float32Array,
                y: y as Float32Array,
                z: z as Float32Array
            } : null),
            cachedPositions,
            selectionData: runtime?.selectionData || null,
            allTimeSelectionData: runtime?.allTimeSelectionData || null,
            selectionTexture: runtime?.selectionTexture || null
        };
        element.runtime = merged;
        return merged;
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
            const activeIndex = Number.isInteger(this.viewer?.splatSequence?.activeElementIndex)
                ? this.viewer.splatSequence.activeElementIndex
                : (Number.isInteger(this.viewer?.sog4SequenceIndex) ? this.viewer.sog4SequenceIndex : 0);
            for (let idx = 0; idx < sequenceElements.length; idx++) {
                const element = sequenceElements[idx];
                const rt = this.buildSelectionRuntimeFromElement(element);
                // #WDD-gpt 2026-05-16 - 当前帧手工选择写入的是 SelectionTool 当前缓冲，删除目标必须优先同步激活段引用
                if (idx === activeIndex && this.selectionData) {
                    element.runtime = element.runtime || {};
                    rt.selectionData = this.selectionData;
                    rt.allTimeSelectionData = this.allTimeSelectionData || rt.allTimeSelectionData || new Uint8Array(this.selectionData.length);
                    rt.selectionTexture = this.selectionTexture || rt.selectionTexture || null;
                    element.runtime.selectionData = rt.selectionData;
                    element.runtime.allTimeSelectionData = rt.allTimeSelectionData;
                    element.runtime.selectionTexture = rt.selectionTexture;
                }
                const count = rt?.cachedPositions
                    ? Math.floor((rt.cachedPositions as Float32Array).length / 3)
                    : Math.max(0, Math.floor(Number(element?.pointCount) || Math.floor(((rt?.selectionData as Uint8Array | null)?.length || 0) / 4)));
                // #WDD-gpt 2026-05-16 - 分段缓冲模式中卸载段没有 cachedPositions，但仍要参与删除通道写入
                if (!rt || count <= 0) continue;
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

                    // #WDD 2026-04-10: Only update current selection if visible at current time
                    if (this.isVisibleAtCurrentTime(i)) {
                        // #WDD-gpt 2026-06-13 - 普通 brush 只把当前帧可见命中写入 all-time，避免隐藏生命周期点被误删
                        this.allTimeSelectionData[idx] = this.isSubtracting ? 0 : 255;
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
                        if (!this.isAllTimeTool()) this.selectionScope = 'current';
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
            void this.performRectAllTime(x1, y1, x2, y2);
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

                    // #WDD 2026-04-10: Only update current selection if visible at current time
                    if (this.isVisibleAtCurrentTime(i)) {
                        // #WDD-gpt 2026-06-13 - 普通 rect 只同步当前帧可见命中，避免 2D 框选污染隐藏 all-time 选区
                        this.allTimeSelectionData[idx] = this.isSubtracting ? 0 : 255;
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
                        if (!this.isAllTimeTool()) this.selectionScope = 'current';
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
            const tone = this.getSelectionOverlayTone();
            this.rectOverlay.className = 'fixed border-2 pointer-events-none z-50';
            this.rectOverlay.style.borderColor = tone.stroke;
            this.rectOverlay.style.backgroundColor = tone.fill;
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

                // #WDD 2026-04-10: Only update current selection if visible at current time
                if (this.isVisibleAtCurrentTime(i)) {
                    // #WDD-gpt 2026-06-13 - 普通 ellipse brush 只同步当前帧可见命中，避免隐藏点进入删除候选
                    this.allTimeSelectionData[idx] = this.isSubtracting ? 0 : 255;
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
                    if (!this.isAllTimeTool()) this.selectionScope = 'current';
                }
            }
        }
        
        if (changed) this.updateTexture();
    }

    // Simple ellipse-rect intersection
    performRectEllipse(x1: number, y1: number, x2: number, y2: number) {
        if (this.isAllTimeTool()) {
            void this.performRectEllipseAllTime(x1, y1, x2, y2);
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

                // #WDD 2026-04-10: Only update current selection if visible at current time
                if (this.isVisibleAtCurrentTime(i)) {
                    // #WDD-gpt 2026-06-13 - 普通 ellipse rect 只同步当前帧可见命中，避免隐藏点进入删除候选
                    this.allTimeSelectionData[idx] = this.isSubtracting ? 0 : 255;
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
                    if (!this.isAllTimeTool()) this.selectionScope = 'current';
                }
            }
        }
        
        if (changed) this.updateTexture();
    }

    // ===== ALL-TIME SELECTION METHODS =====

    // Yield control to the browser so UI can update (progress bar, etc.)
    private static yieldFrame(): Promise<void> {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    // Generic all-time selection: check all frames for points that are visible and in selection area
    // Now async to allow progress UI updates during the long-running operation
    private async selectAllTimePoints(checkScreen: (screenX: number, screenY: number, screenZ: number, splatIdx: number) => boolean): Promise<boolean> {
        const camera = this.viewer.camera?.camera;
        if (!camera) return false;
        const before = this.captureGlobalSelectionState();
        this.selectionScope = 'alltime';

        let sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
            ? this.viewer.getSplatSequenceSelectionElements()
            : [];
        if (Array.isArray(sequenceElements) && sequenceElements.length > 0) {
            await this.ensureAllTimeSequenceElementsReady(sequenceElements);
            sequenceElements = typeof this.viewer.getSplatSequenceSelectionElements === 'function'
                ? this.viewer.getSplatSequenceSelectionElements()
                : sequenceElements;
        }
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
        const changedCounts: Array<{ name: string; allTime: number; display: number }> = [];
        const localPos = new pc.Vec3();
        const worldPos = new pc.Vec3();
        const screen = new pc.Vec3();

        // Calculate total frames for progress
        let totalProgressFrames = 0;
        for (const target of targets) {
            const rt = hasSequence ? this.buildSelectionRuntimeFromElement(target) : target?.runtime;
            totalProgressFrames += Math.max(1, Math.ceil(rt?.totalFrames ?? 1));
        }
        let processedFrames = 0;
        this.showAllTimeProgress(0, totalProgressFrames);

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
            // #WDD-gpt 2026-05-16 - PLY4 序列 all-time 选择覆盖所有段全部时刻，但当前高亮只显示当前激活段当前帧
            const currentFound = new Uint8Array(numSplats);
            const tempPos = new Float32Array(numSplats * 3);
            const modelMat = entity.getWorldTransform();
            const totalFrames = Math.max(1, Math.ceil(rt?.totalFrames ?? 1));
            const targetIndex = hasSequence && Array.isArray(sequenceElements) ? sequenceElements.indexOf(target) : -1;
            const activeIndex = Number.isInteger(this.viewer?.splatSequence?.activeElementIndex)
                ? this.viewer.splatSequence.activeElementIndex
                : (Number.isInteger(this.viewer?.sog4SequenceIndex) ? this.viewer.sog4SequenceIndex : -1);
            // #WDD-gpt 2026-05-16 - 多 PLY4 all-time 手工选择要给每段保存本地显示帧，避免只有当前段有 R 通道
            // #wdd-claude 2026-06-11 修复非激活段误高亮: 原先非激活段赋值为 0(而非 null), 而下方判断用
            // `currentLocalFrame !== null` 恒为真, 导致 t===0 时非激活段也被写入当前帧显示通道(R), 切到该段时
            // 出现不应有的高亮。非激活段应为 null(无当前显示帧), 类型相应改为 number | null。
            const currentLocalFrame: number | null = !hasSequence || targetIndex === activeIndex
                ? Math.max(0, Math.min(totalFrames - 1, Math.floor(this.getCurrentTime())))
                : null;

            for (let t = 0; t < totalFrames; t++) {
                const framePositions = this.getPositionsAtTimeForRuntime(rt, t, tempPos);
                if (!framePositions) continue;
                const isCurrentFrame = currentLocalFrame !== null && t === currentLocalFrame;

                for (let i = 0; i < numSplats; i++) {
                    if (found[i] && !isCurrentFrame) continue;

                    const idx4 = i * 4;
                    if (selectionData[idx4 + 1] > 0) continue;
                    if (!this.isVisibleAtTimeForRuntime(rt, i, t)) continue;

                    localPos.set(framePositions[i * 3 + 0], framePositions[i * 3 + 1], framePositions[i * 3 + 2]);
                    modelMat.transformPoint(localPos, worldPos);
                    camera.worldToScreen(worldPos, screen);

                    if (screen.z > 0 && checkScreen(screen.x, screen.y, screen.z, i)) {
                        found[i] = 1;
                        if (isCurrentFrame) currentFound[i] = 1;
                    }
                }

                processedFrames++;
                // Yield to browser every 3 frames so progress UI can update
                if (processedFrames % 3 === 0) {
                    this.showAllTimeProgress(processedFrames, totalProgressFrames);
                    await SelectionTool.yieldFrame();
                }
            }

            let changed = false;
            let allTimeCount = 0;
            let displayCount = 0;
            for (let i = 0; i < numSplats; i++) {
                const idx4 = i * 4;
                if (this.isSubtracting && found[i]) {
                    if (allTimeSelectionData[idx4] !== 0) changed = true;
                    allTimeSelectionData[idx4] = 0;
                } else {
                    if (!found[i]) continue;
                    if (allTimeSelectionData[idx4] !== 255) changed = true;
                    allTimeSelectionData[idx4] = 255;
                }
                const nextCurrent = currentFound[i] && allTimeSelectionData[idx4] > 0 ? 255 : 0;
                if (selectionData[idx4] !== nextCurrent) changed = true;
                selectionData[idx4] = nextCurrent;
                if (allTimeSelectionData[idx4] > 0) allTimeCount++;
                if (selectionData[idx4] > 0) displayCount++;
            }

            if (changed) {
                anyChanged = true;
                changedCounts.push({ name: target?.name || `segment ${targetIndex}`, allTime: allTimeCount, display: displayCount });
                this.updateTextureForRuntime(selectionTexture, selectionData);
                if (hasSequence && targetIndex >= 0) {
                    this.commitSequenceEditState(targetIndex, selectionData, allTimeSelectionData);
                }
            }
        }

        this.hideAllTimeProgress();
        if (anyChanged) {
            this.selectionScope = 'alltime';
            this.pushUndoSnapshot(before);
            console.log('[Selection] All-time manual selection updated', changedCounts);
        }
        return anyChanged;
    }

    // #WDD-gpt 2026-05-16 - PLY4 序列 all-time 选择必须覆盖所有 PLY4 段；未加载段先后台准备，避免只选当前段
    private async ensureAllTimeSequenceElementsReady(sequenceElements: any[]) {
        const prepare = (this.viewer as any).prepareSog4SequenceSegment;
        if (typeof prepare !== 'function') return;
        for (let i = 0; i < sequenceElements.length; i++) {
            const element = sequenceElements[i];
            if (!element || element.type !== 'ply4') continue;
            const rt = element.runtime || {};
            if (element.entity && (rt.cachedPositions || element.parsed)) continue;
            await prepare.call(this.viewer, i);
        }
    }

    async performBrushAllTime(cx: number, cy: number) {
        const rSq = this.brushRadius * this.brushRadius;
        const changed = await this.selectAllTimePoints((sx, sy) => {
            const dx = sx - cx;
            const dy = sy - cy;
            return dx * dx + dy * dy < rSq;
        });
        if (changed) this.updateTexture();
    }

    async performRectAllTime(x1: number, y1: number, x2: number, y2: number) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        const changed = await this.selectAllTimePoints((sx, sy) => {
            return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
        });
        if (changed) this.updateTexture();
    }

    async performBrushEllipseAllTime(cx: number, cy: number) {
        const r = this.brushRadius;
        const rSq = r * r;
        const changed = await this.selectAllTimePoints((sx, sy, sz) => {
            const pixelSize = Math.max(2, Math.min(15, 100 / (sz + 5)));
            const totalRadius = r + pixelSize;
            const totalRSq = totalRadius * totalRadius;
            const dx = sx - cx;
            const dy = sy - cy;
            return dx * dx + dy * dy <= totalRSq;
        });
        if (changed) this.updateTexture();
    }

    async performRectEllipseAllTime(x1: number, y1: number, x2: number, y2: number) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        const changed = await this.selectAllTimePoints((sx, sy, sz) => {
            const pixelSize = Math.max(2, Math.min(15, 100 / (sz + 5)));
            return sx >= minX - pixelSize && sx <= maxX + pixelSize &&
                   sy >= minY - pixelSize && sy <= maxY + pixelSize;
        });
        if (changed) this.updateTexture();
    }

    // Deferred all-time brush path selection (performance optimization)
    async performBrushAllTimePath(path: Array<{x: number, y: number}>) {
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

        const changed = await this.selectAllTimePoints((sx, sy) => {
            for (const c of circles) {
                const dx = sx - c.x;
                const dy = sy - c.y;
                if (dx * dx + dy * dy < c.rSq) return true;
            }
            return false;
        });

        if (changed) this.updateTexture();
    }

    async performBrushEllipseAllTimePath(path: Array<{x: number, y: number}>) {
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

        const changed = await this.selectAllTimePoints((sx, sy, sz) => {
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
        this.updatePolyOverlayTone();
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

    async performPolygon(pts: Array<{x: number, y: number}>) {
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
            const changed = await this.selectAllTimePoints((sx, sy, sz) => checkInPoly(sx, sy, sz));
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
                // #WDD-gpt 2026-06-13 - 普通 poly 与 brush/rect 一致，只维护当前帧可见选择
                if (this.allTimeSelectionData && idx < this.allTimeSelectionData.length) {
                    this.allTimeSelectionData[idx] = this.isSubtracting ? 0 : 255;
                }

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
                this.selectionScope = 'current';
            }
        }

        if (changed) this.updateTexture();
    }

}
