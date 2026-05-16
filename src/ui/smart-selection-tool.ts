import * as pc from 'playcanvas';
import type { Viewer } from '../main';
import { autoAlign4DGSScene, type AutoGroundAlignmentResult, type GaussianPoint, type Vec3 } from '../algorithms/autoGroundAlignment';

type ViewerAnalysisSource = {
    name?: string;
    selectionElement?: any;
    positions: Float32Array | null;
    trajectoryData: Float32Array | null;
    keyframes: number;
    originalIndices: Float32Array | null;
    lifetimeMu: Float32Array | null;
    lifetimeW: Float32Array | null;
    totalFrames: number;
    transformPoint?: (point: Vec3) => Vec3;
};

type CylinderSelectionRegion = {
    centerX: number;
    centerZ: number;
    radius: number;
    height: number;
    groundPad: number;
};

// #WDD-gpt 2026-05-16 - 将左侧智能选择工具改为 AutoGroundAlignment 算法模块的 UI 适配层
export class SmartSelectionTool {
    private statusEl: HTMLElement | null = null;
    private planeStatEl: HTMLElement | null = null;
    private staticStatEl: HTMLElement | null = null;
    private centerStatEl: HTMLElement | null = null;
    private lastResult: AutoGroundAlignmentResult | null = null;
    private progressOverlay: HTMLElement | null = null;
    private progressBar: HTMLElement | null = null;
    private progressStage: HTMLElement | null = null;
    private progressDetail: HTMLElement | null = null;
    private progressRequestId = 0;
    private cylinderRegion: CylinderSelectionRegion | null = null;
    private cylinderVisible = false;
    private cylinderPreview: pc.Entity | null = null;
    private cylinderLineMaterial: pc.BasicMaterial | null = null;
    private cylinderControlsEl: HTMLElement | null = null;
    private cylinderToggleEl: HTMLElement | null = null;
    private resizeObserver: ResizeObserver | null = null;

    constructor(private viewer: Viewer) {
        this.bindUI();
        this.setupLayoutObserver();
    }

    private bindUI() {
        this.statusEl = document.getElementById('smart-align-status');
        this.planeStatEl = document.getElementById('smart-align-plane-stat');
        this.staticStatEl = document.getElementById('smart-align-static-stat');
        this.centerStatEl = document.getElementById('smart-align-center-stat');
        this.cylinderControlsEl = document.getElementById('smart-cylinder-controls');
        this.cylinderToggleEl = document.getElementById('smart-cylinder-toggle');
        document.getElementById('smart-align-run')?.addEventListener('click', () => this.runAlignment());
        this.cylinderToggleEl?.addEventListener('click', () => this.setCylinderVisible(!this.cylinderVisible, true));
        document.getElementById('smart-cylinder-select')?.addEventListener('click', () => this.applyCylinderSelectionFromUI());
        for (const id of ['smart-cylinder-radius', 'smart-cylinder-height', 'smart-cylinder-x', 'smart-cylinder-z', 'smart-cylinder-ground']) {
            document.getElementById(id)?.addEventListener('input', () => this.updateCylinderFromInputs());
        }
        this.createProgressOverlay();
    }

    // #WDD-gpt 2026-05-16 - 监听智能面板高度变化，自动调整手工选择面板位置避免重叠
    private setupLayoutObserver() {
        const smartPanel = document.getElementById('smart-selection-panel');
        const toolbar = document.getElementById('selection-toolbar');
        if (!smartPanel || !toolbar) return;

        const adjustLayout = () => {
            const rect = smartPanel.getBoundingClientRect();
            const top = rect.bottom + 12;
            toolbar.style.top = `${top}px`;
        };

        this.resizeObserver = new ResizeObserver(() => {
            window.requestAnimationFrame(adjustLayout);
        });
        this.resizeObserver.observe(smartPanel);

        // Also observe cylinder controls visibility changes
        const cylinderControls = document.getElementById('smart-cylinder-controls');
        if (cylinderControls) {
            const mutationObserver = new MutationObserver(() => {
                window.requestAnimationFrame(adjustLayout);
            });
            mutationObserver.observe(cylinderControls, { attributes: true, attributeFilter: ['class'] });
        }

        // Initial adjustment
        adjustLayout();
    }

    private async runAlignment() {
        this.showProgress(0, 'PREPARING', 'Sampling 4DGS points');
        try {
            const sources = this.getAnalysisSources();
            const alignmentSource = sources[0];
            if (!alignmentSource) {
                throw new Error('No points available for auto ground alignment.');
            }
            const points = this.buildGaussianPoints(alignmentSource);
            if (!points.length) {
                throw new Error('No points available for auto ground alignment.');
            }
            const batchText = sources.length > 1 ? ` from first PLY4, batch ${sources.length} segments` : '';
            this.showProgress(18, 'WORKER', `Starting worker with ${points.length} sampled points${batchText}`);
            const result = await this.runAlgorithmInWorker(points);
            this.lastResult = result;
            this.renderResult(result, result.success ? 'ALIGNED' : 'FAILED');
            if (result.success && result.transform) {
                this.showProgress(94, 'CYLINDER', 'Applying scene transform and creating adjustable cylinder only');
                this.viewer.applyAutoGroundAlignmentTransform(result.transform.rotationMatrix, result.transform.translation);
                this.createCylinderRegionFromResult(sources[0], result);
            }
            this.showProgress(100, result.success ? 'CYLINDER READY' : 'FAILED', result.errors[0] || result.warnings[0] || 'Adjust cylinder, then apply selection');
            window.setTimeout(() => this.hideProgress(), result.success ? 700 : 1800);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const result: AutoGroundAlignmentResult = { success: false, confidence: 0, warnings: [], errors: [message] };
            this.lastResult = result;
            this.renderResult(result, 'FAILED');
            this.showProgress(100, 'FAILED', message);
            window.setTimeout(() => this.hideProgress(), 2200);
        }
    }

    private getAnalysisSources(): ViewerAnalysisSource[] {
        const getter = (this.viewer as any).getSmartSelectionBatchAnalysisSources;
        const sources = typeof getter === 'function'
            ? getter.call(this.viewer) as ViewerAnalysisSource[]
            : [this.viewer.getSmartSelectionAnalysisSource() as ViewerAnalysisSource];
        const usable = (Array.isArray(sources) ? sources : []).filter((source) => source?.positions);
        return usable.length ? usable : [this.viewer.getSmartSelectionAnalysisSource() as ViewerAnalysisSource].filter((source) => source?.positions);
    }

    private runAlgorithmOptions(points: GaussianPoint[]) {
        return {
            debug: true,
            dynamicClusterMinPoints: Math.max(30, Math.floor(points.length * 0.0004)),
            staticClusterMinPoints: Math.max(60, Math.floor(points.length * 0.0008)),
            maxEstimationPoints: 18000,
            maxRansacPoints: 10000
        };
    }

    private runAlgorithmInWorker(points: GaussianPoint[]): Promise<AutoGroundAlignmentResult> {
        if (typeof Worker === 'undefined') {
            return Promise.resolve(autoAlign4DGSScene(points, [], this.runAlgorithmOptions(points)));
        }
        const id = ++this.progressRequestId;
        return new Promise((resolve) => {
            const worker = new Worker(new URL('../algorithms/autoGroundAlignment/worker.ts', import.meta.url), { type: 'module' });
            const fallback = (error: unknown) => {
                console.warn('[SmartSelectionTool] Worker unavailable, falling back to main thread', error);
                worker.terminate();
                this.showProgress(35, 'FALLBACK', 'Running on main thread');
                resolve(autoAlign4DGSScene(points, [], this.runAlgorithmOptions(points)));
            };
            worker.onerror = fallback;
            worker.onmessage = (event: MessageEvent<any>) => {
                const msg = event.data;
                if (!msg || msg.id !== id) return;
                if (msg.type === 'progress') {
                    this.showProgress(msg.percent, msg.stage, msg.detail || '');
                    return;
                }
                worker.terminate();
                if (msg.type === 'done') resolve(msg.result);
                else resolve({ success: false, confidence: 0, warnings: [], errors: [msg.error || 'Auto alignment worker failed.'] });
            };
            worker.postMessage({ id, points, options: this.runAlgorithmOptions(points) });
        });
    }

    private buildGaussianPoints(source: ViewerAnalysisSource): GaussianPoint[] {
        if (!source.positions) return [];
        const count = Math.floor(source.positions.length / 3);
        const maxPoints = 30000;
        const stride = Math.max(1, Math.ceil(count / maxPoints));
        const points: GaussianPoint[] = [];
        const hasTrajectory = !!source.trajectoryData && source.keyframes > 1;
        const motions = hasTrajectory && source.trajectoryData
            ? this.computeMotionMagnitudes(source, count)
            : null;
        const motionStats = motions ? this.estimateMotionThreshold(motions) : null;
        const useMotionLabels = !!motionStats?.usable;

        for (let i = 0; i < count; i += stride) {
            const position = this.readPosition(source.positions, i);
            const transformed = source.transformPoint ? source.transformPoint(position) : position;
            const motionMagnitude = motions ? motions[i] : undefined;
            const motionLabel = useMotionLabels
                ? (motionMagnitude! >= motionStats!.threshold ? 'dynamic' : 'static')
                : this.labelFromLifetime(source, i);
            points.push({
                id: i,
                position: transformed,
                motionMagnitude,
                motionLabel,
                positionsOverTime: hasTrajectory && source.trajectoryData
                    ? this.readPositionsOverTime(source, i)
                    : undefined
            });
        }
        return points;
    }

    // #WDD-gpt 2026-05-16 - 自动对齐后只生成可调圆柱区域，不再立即按分类直接选点
    private createCylinderRegionFromResult(source: ViewerAnalysisSource, result: AutoGroundAlignmentResult) {
        if (!source?.positions || !result.transform || !result.personCluster?.points.length) return;
        const count = Math.floor(source.positions.length / 3);
        const sceneScale = this.estimateAlignedSceneScale(source, result.transform.rotationMatrix, result.transform.translation, count);
        const personAligned = result.personCluster.points
            .map((point) => this.applyAlignment(result.transform!.rotationMatrix, result.transform!.translation, point.position))
            .filter((point) => point.every(Number.isFinite));
        if (personAligned.length < 3) return;

        const xs = personAligned.map((p) => p[0]);
        const ys = personAligned.map((p) => p[1]);
        const zs = personAligned.map((p) => p[2]);
        const centerX = this.quantile(xs, 0.5);
        const centerZ = this.quantile(zs, 0.5);
        const yHigh = Math.max(this.quantile(ys, 0.995), this.quantile(ys, 0.98));
        const height = Math.max(yHigh * 1.18, sceneScale * 0.08, 0.1);
        const radii = personAligned.map((p) => Math.hypot(p[0] - centerX, p[2] - centerZ));
        const radius = Math.max(this.quantile(radii, 0.995) * 2.4, height * 0.32, sceneScale * 0.035, 0.05);
        const planeRms = result.groundPlane?.rmsError || result.transform.groundPlane?.rmsError || 0;
        const groundPad = Math.max(sceneScale * 0.008, planeRms * 5, height * 0.035, 0.02);

        this.cylinderRegion = { centerX, centerZ, radius, height, groundPad };
        this.syncCylinderInputs();
        this.setCylinderVisible(true, false);
        this.setStatus('CYLINDER', 'ok');
    }

    // #WDD-gpt 2026-05-16 - 圆柱选择区用开关显示，关闭时清空当前选择
    private setCylinderVisible(visible: boolean, clearSelectionOnHide: boolean) {
        this.cylinderVisible = visible;
        this.cylinderControlsEl?.classList.toggle('hidden', !visible);
        this.cylinderToggleEl?.classList.toggle('active', visible);
        const label = this.cylinderToggleEl?.querySelector('span');
        if (label) label.textContent = visible ? 'Hide Cylinder' : 'Show Cylinder';
        if (!visible) {
            if (this.cylinderPreview) this.cylinderPreview.enabled = false;
            if (clearSelectionOnHide) this.viewer.selectionTool?.clearSelection();
            this.setStatus('CYL OFF', 'idle');
            return;
        }
        this.updateCylinderFromInputs();
        this.updateCylinderPreview();
    }

    private syncCylinderInputs() {
        if (!this.cylinderRegion) return;
        this.setInputNumber('smart-cylinder-radius', this.cylinderRegion.radius);
        this.setInputNumber('smart-cylinder-height', this.cylinderRegion.height);
        this.setInputNumber('smart-cylinder-x', this.cylinderRegion.centerX);
        this.setInputNumber('smart-cylinder-z', this.cylinderRegion.centerZ);
        this.setInputNumber('smart-cylinder-ground', this.cylinderRegion.groundPad);
    }

    private setInputNumber(id: string, value: number) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.value = Number.isFinite(value) ? value.toFixed(3) : '0.000';
    }

    private updateCylinderFromInputs() {
        const current = this.cylinderRegion || { centerX: 0, centerZ: 0, radius: 1, height: 2, groundPad: 0.08 };
        this.cylinderRegion = {
            centerX: this.readInputNumber('smart-cylinder-x', current.centerX),
            centerZ: this.readInputNumber('smart-cylinder-z', current.centerZ),
            radius: Math.max(0.001, this.readInputNumber('smart-cylinder-radius', current.radius)),
            height: Math.max(0.001, this.readInputNumber('smart-cylinder-height', current.height)),
            groundPad: Math.max(0, this.readInputNumber('smart-cylinder-ground', current.groundPad))
        };
        this.updateCylinderPreview();
    }

    private readInputNumber(id: string, fallback: number) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        const value = Number(input?.value);
        return Number.isFinite(value) ? value : fallback;
    }

    private updateCylinderPreview() {
        if (!this.cylinderRegion) return;
        const app = (this.viewer as any).app as pc.Application | undefined;
        if (!app) return;
        if (!this.cylinderVisible) {
            if (this.cylinderPreview) this.cylinderPreview.enabled = false;
            return;
        }
        if (!this.cylinderPreview) {
            this.cylinderPreview = new pc.Entity('SmartSelectionCylinder');
            app.root.addChild(this.cylinderPreview);
        }
        const r = this.cylinderRegion;
        this.cylinderPreview.enabled = true;
        this.rebuildCylinderLinePreview(r);
    }

    // #WDD-gpt 2026-05-16 - 用网格线强化显示圆柱选择区，避免透明面片在点云中不可见
    private rebuildCylinderLinePreview(region: CylinderSelectionRegion) {
        if (!this.cylinderPreview) return;
        const app = (this.viewer as any).app as pc.Application | undefined;
        if (!app) return;
        const children = [...this.cylinderPreview.children];
        for (const child of children) child.destroy();

        if (!this.cylinderLineMaterial) {
            this.cylinderLineMaterial = new pc.BasicMaterial();
            this.cylinderLineMaterial.color = new pc.Color(0.0, 0.9, 1.0);
            this.cylinderLineMaterial.update();
        }

        const minY = -region.groundPad;
        const maxY = region.height;
        const midY = (minY + maxY) * 0.5;
        const segments = 48;
        const verticalEvery = 4;
        const points: pc.Vec3[] = [];
        const add = (a: pc.Vec3, b: pc.Vec3) => points.push(a, b);
        const ringPoint = (i: number, y: number) => {
            const t = (i / segments) * Math.PI * 2;
            return new pc.Vec3(
                region.centerX + Math.cos(t) * region.radius,
                y,
                region.centerZ + Math.sin(t) * region.radius
            );
        };
        for (let i = 0; i < segments; i++) {
            add(ringPoint(i, minY), ringPoint(i + 1, minY));
            add(ringPoint(i, midY), ringPoint(i + 1, midY));
            add(ringPoint(i, maxY), ringPoint(i + 1, maxY));
            if (i % verticalEvery === 0) add(ringPoint(i, minY), ringPoint(i, maxY));
        }

        const positions = new Float32Array(points.length * 3);
        for (let i = 0; i < points.length; i++) {
            positions[i * 3 + 0] = points[i].x;
            positions[i * 3 + 1] = points[i].y;
            positions[i * 3 + 2] = points[i].z;
        }
        const mesh = new pc.Mesh(app.graphicsDevice);
        mesh.setPositions(positions, 3);
        mesh.update(pc.PRIMITIVE_LINES);
        const meshInstance = new pc.MeshInstance(mesh, this.cylinderLineMaterial);
        const lineEntity = new pc.Entity('SmartSelectionCylinderGrid');
        lineEntity.addComponent('render');
        lineEntity.render!.meshInstances = [meshInstance];
        this.cylinderPreview.addChild(lineEntity);
    }

    // #WDD-gpt 2026-05-16 - 将圆柱区域应用到当前模型或全部 PLY4 序列段的选择纹理
    private applyCylinderSelectionFromUI() {
        if (!this.cylinderRegion || !this.viewer.selectionTool) {
            this.setStatus('NO CYL', 'warn');
            return;
        }
        if (!this.cylinderVisible) {
            this.setStatus('CYL OFF', 'warn');
            return;
        }
        this.updateCylinderFromInputs();
        const sources = this.getAnalysisSources();
        let total = 0;
        let segments = 0;
        for (const source of sources) {
            if (!source.positions) continue;
            const indices = this.computeCylinderSelectionIndices(source, this.cylinderRegion);
            const selected = source.selectionElement && typeof this.viewer.selectionTool.selectIndicesForElement === 'function'
                ? this.viewer.selectionTool.selectIndicesForElement(source.selectionElement, indices, true, true)
                : this.viewer.selectionTool.selectIndices(indices, true, true);
            total += selected;
            segments++;
        }
        this.setStatus(total > 0 ? 'SELECTED' : 'EMPTY', total > 0 ? 'ok' : 'warn');
        if (this.planeStatEl) this.planeStatEl.textContent = `${total}`;
        if (this.staticStatEl) this.staticStatEl.textContent = `${segments} seg`;
        console.log('[SmartSelectionTool] Cylinder selection', { total, segments, region: this.cylinderRegion });
    }

    private computeCylinderSelectionIndices(source: ViewerAnalysisSource, region: CylinderSelectionRegion) {
        const indices: number[] = [];
        const count = Math.floor(source.positions!.length / 3);
        for (let i = 0; i < count; i++) {
            if (this.pointEntersCylinderAnyFrame(source, i, region)) {
                indices.push(i);
            }
        }
        return indices;
    }

    // #WDD-gpt 2026-05-16 - 圆柱选择改为全时段命中：任意关键帧进入区域即选中该高斯点
    // 关键修复：统一使用渲染顺序索引。trajectoryData 是原始顺序，通过 originalIndices 正确映射。
    private pointEntersCylinderAnyFrame(source: ViewerAnalysisSource, renderIndex: number, region: CylinderSelectionRegion) {
        // 1) 检查当前帧位置（positions 是渲染顺序，直接用 renderIndex）
        if (this.isPointInsideCylinder(this.getWorldPoint(source, renderIndex), region)) {
            return true;
        }

        if (!source.trajectoryData || source.keyframes <= 1) {
            return false;
        }

        // 2) 将当前 renderIndex 映射到原始索引，用于读取 trajectoryData
        // originalIndices[renderIndex] = originalIndex（渲染顺序 -> 原始顺序）
        const originalIndex = source.originalIndices
            ? Math.max(0, Math.round(source.originalIndices[renderIndex] || 0))
            : renderIndex;

        // 3) 读取该原始索引在所有关键帧中的轨迹位置
        const K = source.keyframes;
        const base = originalIndex * K * 3;
        const maxOffset = source.trajectoryData.length - 3;

        for (let frame = 0; frame < K; frame++) {
            const offset = base + frame * 3;
            if (offset < 0 || offset > maxOffset) continue;
            const p: Vec3 = [
                source.trajectoryData![offset + 0],
                source.trajectoryData![offset + 1],
                source.trajectoryData![offset + 2]
            ];
            // trajectoryData 中的点是模型局部坐标，需要应用实体变换
            const worldPoint = source.transformPoint ? source.transformPoint(p) : p;
            if (this.isPointInsideCylinder(worldPoint, region)) {
                return true;
            }
        }
        return false;
    }

    private isPointInsideCylinder(point: Vec3, region: CylinderSelectionRegion) {
        const radius = Math.hypot(point[0] - region.centerX, point[2] - region.centerZ);
        return radius <= region.radius && point[1] >= -region.groundPad && point[1] <= region.height;
    }

    private buildMotionContext(source: ViewerAnalysisSource, count: number) {
        const hasTrajectory = !!source.trajectoryData && source.keyframes > 1;
        const motions = hasTrajectory ? this.computeMotionMagnitudes(source, count) : null;
        const motionStats = motions ? this.estimateMotionThreshold(motions) : null;
        return {
            motions,
            threshold: motionStats?.threshold || 0,
            useMotion: !!motionStats?.usable
        };
    }

    private classifyMotion(
        source: ViewerAnalysisSource,
        index: number,
        context: { motions: Float32Array | null; threshold: number; useMotion: boolean }
    ): 'static' | 'dynamic' | 'unknown' {
        if (context.useMotion && context.motions) {
            return context.motions[index] >= context.threshold ? 'dynamic' : 'static';
        }
        return this.labelFromLifetime(source, index);
    }

    private estimateAlignedSceneScale(source: ViewerAnalysisSource, rotationMatrix: number[][], translation: Vec3, count: number) {
        const stride = Math.max(1, Math.ceil(count / 5000));
        const min: Vec3 = [Infinity, Infinity, Infinity];
        const max: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < count; i += stride) {
            const aligned = this.applyAlignment(rotationMatrix, translation, this.getWorldPoint(source, i));
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], aligned[axis]);
                max[axis] = Math.max(max[axis], aligned[axis]);
            }
        }
        const dx = max[0] - min[0];
        const dy = max[1] - min[1];
        const dz = max[2] - min[2];
        const scale = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return Number.isFinite(scale) && scale > 0 ? scale : 1;
    }

    // #WDD-gpt 2026-05-16 - 获取当前帧世界坐标
    // positions 来自 getCurrentPositions()，已经是世界坐标，按渲染顺序排列
    private getWorldPoint(source: ViewerAnalysisSource, renderIndex: number): Vec3 {
        return this.readPosition(source.positions!, renderIndex);
    }

    private applyAlignment(rotationMatrix: number[][], translation: Vec3, point: Vec3): Vec3 {
        return [
            rotationMatrix[0][0] * point[0] + rotationMatrix[0][1] * point[1] + rotationMatrix[0][2] * point[2] + translation[0],
            rotationMatrix[1][0] * point[0] + rotationMatrix[1][1] * point[1] + rotationMatrix[1][2] * point[2] + translation[1],
            rotationMatrix[2][0] * point[0] + rotationMatrix[2][1] * point[1] + rotationMatrix[2][2] * point[2] + translation[2]
        ];
    }

    private quantile(values: number[], percentile: number) {
        if (!values.length) return 0;
        const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
        if (!sorted.length) return 0;
        const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile)));
        return sorted[index];
    }

    private computeMotionMagnitudes(source: ViewerAnalysisSource, count: number) {
        const motions = new Float32Array(count);
        if (!source.trajectoryData || source.keyframes <= 1) return motions;
        for (let i = 0; i < count; i++) {
            const base = this.trajectoryBase(source, i);
            const p0 = this.readTrajectoryPoint(source, base);
            let maxMove = 0;
            const step = Math.max(1, Math.floor(source.keyframes / 5));
            for (let k = 1; k < source.keyframes; k += step) {
                maxMove = Math.max(maxMove, this.distance(p0, this.readTrajectoryPoint(source, base + k * 3)));
            }
            maxMove = Math.max(maxMove, this.distance(p0, this.readTrajectoryPoint(source, base + (source.keyframes - 1) * 3)));
            motions[i] = maxMove;
        }
        return motions;
    }

    private estimateMotionThreshold(motions: Float32Array) {
        const sorted = Array.from(motions).sort((a, b) => a - b);
        const q = (p: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))] || 0;
        const q90 = q(0.9);
        return {
            threshold: Math.max(0.006, q(0.6) * 1.5, q(0.75) * 0.65),
            usable: q90 > 1e-5
        };
    }

    private labelFromLifetime(source: ViewerAnalysisSource, index: number): 'static' | 'dynamic' | 'unknown' {
        if (!source.lifetimeMu || !source.lifetimeW) return 'unknown';
        const start = source.lifetimeMu[index] - source.lifetimeW[index];
        const end = source.lifetimeMu[index] + source.lifetimeW[index];
        return start <= source.totalFrames * 0.08 && end >= source.totalFrames * 0.72 ? 'static' : 'dynamic';
    }

    private readPositionsOverTime(source: ViewerAnalysisSource, index: number) {
        if (!source.trajectoryData) return undefined;
        const base = this.trajectoryBase(source, index);
        const frames = [0, Math.floor((source.keyframes - 1) / 2), source.keyframes - 1];
        return frames.map((frame) => this.readTrajectoryPoint(source, base + frame * 3));
    }

    private readTrajectoryPoint(source: ViewerAnalysisSource, offset: number): Vec3 {
        const p: Vec3 = [
            source.trajectoryData![offset + 0],
            source.trajectoryData![offset + 1],
            source.trajectoryData![offset + 2]
        ];
        return source.transformPoint ? source.transformPoint(p) : p;
    }

    // #WDD-gpt 2026-05-16 - 已内联到 pointEntersCylinderAnyFrame，保留此函数供其他调用方使用
    private trajectoryBase(source: ViewerAnalysisSource, index: number) {
        const original = source.originalIndices ? Math.max(0, Math.round(source.originalIndices[index] || 0)) : index;
        return original * source.keyframes * 3;
    }

    private readPosition(data: Float32Array, index: number): Vec3 {
        return [data[index * 3 + 0], data[index * 3 + 1], data[index * 3 + 2]];
    }

    private distance(a: Vec3, b: Vec3) {
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        const dz = a[2] - b[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private renderResult(result: AutoGroundAlignmentResult, okText: string) {
        const tone = result.success ? 'ok' : (result.confidence > 0 ? 'warn' : 'error');
        this.setStatus(result.success ? okText : (result.errors[0] ? 'FAILED' : 'LOW CONF'), tone);
        if (this.planeStatEl) {
            this.planeStatEl.textContent = result.groundPlane
                ? `${result.groundPlane.inliers.length} / ${Math.round(result.confidence * 100)}%`
                : `-- / ${Math.round(result.confidence * 100)}%`;
        }
        if (this.staticStatEl) {
            const d = result.debug;
            this.staticStatEl.textContent = d ? `${d.staticCleanCount} / ${d.dynamicCleanCount}` : '--';
        }
        if (this.centerStatEl) {
            this.centerStatEl.textContent = result.footCenter ? result.footCenter.map((x) => x.toFixed(2)).join(', ') : '--';
        }
        console.log('[SmartSelectionTool] AutoGroundAlignment result', result);
    }

    private setStatus(text: string, tone: 'idle' | 'ok' | 'warn' | 'error' = 'idle') {
        if (!this.statusEl) return;
        this.statusEl.textContent = text;
        this.statusEl.dataset.tone = tone;
    }

    private createProgressOverlay() {
        if (document.getElementById('smart-align-progress-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'smart-align-progress-overlay';
        overlay.className = 'smart-align-progress-overlay hidden';
        overlay.innerHTML = `
            <div class="smart-align-progress-card">
                <div class="smart-align-progress-title">Auto Ground Alignment</div>
                <div id="smart-align-progress-stage" class="smart-align-progress-stage">Preparing</div>
                <div class="smart-align-progress-track">
                    <div id="smart-align-progress-bar" class="smart-align-progress-bar"></div>
                </div>
                <div id="smart-align-progress-detail" class="smart-align-progress-detail">Sampling points</div>
            </div>
        `;
        document.body.appendChild(overlay);
        this.progressOverlay = overlay;
        this.progressBar = document.getElementById('smart-align-progress-bar');
        this.progressStage = document.getElementById('smart-align-progress-stage');
        this.progressDetail = document.getElementById('smart-align-progress-detail');
    }

    private showProgress(percent: number, stage: string, detail: string) {
        this.createProgressOverlay();
        this.progressOverlay?.classList.remove('hidden');
        if (this.progressBar) this.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        if (this.progressStage) this.progressStage.textContent = `${stage} ${Math.round(percent)}%`;
        if (this.progressDetail) this.progressDetail.textContent = detail;
    }

    private hideProgress() {
        this.progressOverlay?.classList.add('hidden');
    }
}
