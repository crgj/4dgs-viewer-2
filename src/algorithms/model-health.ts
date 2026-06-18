import type { PlyVertexElement } from './sh-compression';

export type ModelHealthSeverity = 'error' | 'warning' | 'info';

export type ModelHealthIssue = {
    code: string;
    severity: ModelHealthSeverity;
    messageKey: string;
    count: number;
    fixable: boolean;
    indices: number[];
};

export type ModelHealthReport = {
    gaussianCount: number;
    issueCount: number;
    errorCount: number;
    warningCount: number;
    fixableCount: number;
    issues: ModelHealthIssue[];
};

export type ModelHealthFixResult = {
    changedValueCount: number;
    fixedIssueCount: number;
    report: ModelHealthReport;
};

type PlyProperty = PlyVertexElement['properties'][number];

const SCALE_MIN = -20;
const SCALE_MAX = 20;
const OPACITY_MIN = -20;
const OPACITY_MAX = 20;
const SH_LIMIT = 32;
const OUTLIER_SIGMA = 8;

// #WDD-gpt 2026-06-18 - Lab 模型健康检查算法说明：这里做低风险数据体检，优先发现会导致渲染、导出或压缩崩坏的属性异常
// #WDD-gpt 2026-06-18 - 检查项包含缺失属性、数组长度不足、NaN/Infinity、坐标离群、scale/opacity 极端值、rotation 四元数未归一化、SH 系数爆值
// #WDD-gpt 2026-06-18 - 自动修复只处理可逆性低但工程风险高的数值问题：非法值归零、log-scale/logit 限幅、四元数归一化、SH 系数限幅
// #WDD-gpt 2026-06-18 - 离群点、透明度过低点等可能代表真实资产内容的情况只报告不删除，避免健康检查误伤用户模型
export function analyzeModelHealth(vertexElement: PlyVertexElement | null | undefined): ModelHealthReport {
    return analyzeInternal(vertexElement, false).report;
}

export function applyModelHealthAutoFix(vertexElement: PlyVertexElement | null | undefined): ModelHealthFixResult {
    return analyzeInternal(vertexElement, true);
}

function analyzeInternal(vertexElement: PlyVertexElement | null | undefined, fix: boolean): ModelHealthFixResult {
    const issues: ModelHealthIssue[] = [];
    let changedValueCount = 0;

    if (!vertexElement) {
        issues.push(createIssue('missing-model', 'error', 'lab.health.issue.noModel', 1, false));
        return summarize(0, issues, changedValueCount);
    }

    const count = Math.max(0, Math.floor(vertexElement.count || 0));
    const props = new Map(vertexElement.properties.map((prop) => [prop.name, prop]));
    const x = props.get('x')?.storage;
    const y = props.get('y')?.storage;
    const z = props.get('z')?.storage;

    for (const name of ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
        const prop = props.get(name);
        if (!prop?.storage) {
            issues.push(createIssue(`missing-${name}`, name === 'x' || name === 'y' || name === 'z' ? 'error' : 'warning', 'lab.health.issue.missingProperty', 1, false));
            continue;
        }
        if (prop.storage.length < count) {
            issues.push(createIssue(`short-${name}`, 'error', 'lab.health.issue.shortArray', count - prop.storage.length, false));
        }
    }

    for (const prop of vertexElement.properties) {
        const invalid = scanFinite(prop, count, fix);
        if (invalid.changed > 0) changedValueCount += invalid.changed;
        if (invalid.count > 0) issues.push(createIssue(`nonfinite-${prop.name}`, 'error', 'lab.health.issue.nonFinite', invalid.count, true, invalid.indices));
    }

    if (x && y && z) {
        const outliers = collectPositionOutliers(x, y, z, count);
        if (outliers.length > 0) issues.push(createIssue('position-outliers', 'warning', 'lab.health.issue.positionOutlier', outliers.length, false, outliers));
    }

    changedValueCount += clampGroup(props, count, ['scale_0', 'scale_1', 'scale_2'], SCALE_MIN, SCALE_MAX, fix, issues, 'scale-extreme', 'lab.health.issue.scaleExtreme');
    changedValueCount += clampGroup(props, count, ['opacity'], OPACITY_MIN, OPACITY_MAX, fix, issues, 'opacity-extreme', 'lab.health.issue.opacityExtreme');
    changedValueCount += clampGroup(props, count, collectSHNames(props), -SH_LIMIT, SH_LIMIT, fix, issues, 'sh-extreme', 'lab.health.issue.shExtreme');

    const lowOpacity = collectLowOpacityIndices(props.get('opacity')?.storage, count);
    if (lowOpacity.length > 0) issues.push(createIssue('low-opacity', 'info', 'lab.health.issue.lowOpacity', lowOpacity.length, false, lowOpacity));

    const fixedRotations = normalizeRotations(props, count, fix, issues);
    changedValueCount += fixedRotations;

    return summarize(count, issues, changedValueCount);
}

function summarize(gaussianCount: number, issues: ModelHealthIssue[], changedValueCount: number): ModelHealthFixResult {
    const report: ModelHealthReport = {
        gaussianCount,
        issueCount: issues.length,
        errorCount: issues.filter((issue) => issue.severity === 'error').length,
        warningCount: issues.filter((issue) => issue.severity === 'warning').length,
        fixableCount: issues.filter((issue) => issue.fixable).length,
        issues
    };
    return {
        changedValueCount,
        fixedIssueCount: changedValueCount > 0 ? report.fixableCount : 0,
        report
    };
}

function createIssue(code: string, severity: ModelHealthSeverity, messageKey: string, count: number, fixable: boolean, indices: number[] = []): ModelHealthIssue {
    return { code, severity, messageKey, count, fixable, indices };
}

function scanFinite(prop: PlyProperty, count: number, fix: boolean) {
    let invalidCount = 0;
    let changed = 0;
    const indices: number[] = [];
    const limit = Math.min(count, prop.storage.length);
    for (let i = 0; i < limit; i++) {
        if (Number.isFinite(prop.storage[i])) continue;
        invalidCount++;
        indices.push(i);
        if (fix) {
            prop.storage[i] = 0;
            changed++;
        }
    }
    return { count: invalidCount, changed, indices };
}

function clampGroup(props: Map<string, PlyProperty>, count: number, names: string[], min: number, max: number, fix: boolean, issues: ModelHealthIssue[], code: string, messageKey: string) {
    const extremeIndices = new Set<number>();
    let changed = 0;
    for (const name of names) {
        const storage = props.get(name)?.storage;
        if (!storage) continue;
        const limit = Math.min(count, storage.length);
        for (let i = 0; i < limit; i++) {
            const value = storage[i];
            if (!Number.isFinite(value) || value >= min && value <= max) continue;
            extremeIndices.add(i);
            if (fix) {
                storage[i] = Math.max(min, Math.min(max, value));
                changed++;
            }
        }
    }
    if (extremeIndices.size > 0) issues.push(createIssue(code, 'warning', messageKey, extremeIndices.size, true, Array.from(extremeIndices)));
    return changed;
}

function collectSHNames(props: Map<string, PlyProperty>) {
    const names: string[] = [];
    for (const name of ['f_dc_0', 'f_dc_1', 'f_dc_2']) {
        if (props.has(name)) names.push(name);
    }
    for (let i = 0; i < 45; i++) {
        const name = `f_rest_${i}`;
        if (props.has(name)) names.push(name);
    }
    return names;
}

function collectLowOpacityIndices(opacity: Float32Array | undefined, count: number) {
    const indices: number[] = [];
    if (!opacity) return indices;
    const limit = Math.min(count, opacity.length);
    for (let i = 0; i < limit; i++) {
        if (Number.isFinite(opacity[i]) && opacity[i] < -12) indices.push(i);
    }
    return indices;
}

function normalizeRotations(props: Map<string, PlyProperty>, count: number, fix: boolean, issues: ModelHealthIssue[]) {
    const r0 = props.get('rot_0')?.storage;
    const r1 = props.get('rot_1')?.storage;
    const r2 = props.get('rot_2')?.storage;
    const r3 = props.get('rot_3')?.storage;
    if (!r0 || !r1 || !r2 || !r3) return 0;

    let abnormal = 0;
    let changed = 0;
    const indices: number[] = [];
    const limit = Math.min(count, r0.length, r1.length, r2.length, r3.length);
    for (let i = 0; i < limit; i++) {
        const len = Math.hypot(r0[i], r1[i], r2[i], r3[i]);
        if (!Number.isFinite(len) || len < 1e-6) {
            abnormal++;
            indices.push(i);
            if (fix) {
                r0[i] = 1;
                r1[i] = 0;
                r2[i] = 0;
                r3[i] = 0;
                changed += 4;
            }
            continue;
        }
        if (Math.abs(len - 1) <= 1e-3) continue;
        abnormal++;
        indices.push(i);
        if (fix) {
            r0[i] /= len;
            r1[i] /= len;
            r2[i] /= len;
            r3[i] /= len;
            changed += 4;
        }
    }
    if (abnormal > 0) issues.push(createIssue('rotation-normalized', 'warning', 'lab.health.issue.rotation', abnormal, true, indices));
    return changed;
}

function collectPositionOutliers(x: Float32Array, y: Float32Array, z: Float32Array, count: number) {
    const outliers: number[] = [];
    const limit = Math.min(count, x.length, y.length, z.length);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let valid = 0;
    for (let i = 0; i < limit; i++) {
        if (!Number.isFinite(x[i]) || !Number.isFinite(y[i]) || !Number.isFinite(z[i])) continue;
        cx += x[i];
        cy += y[i];
        cz += z[i];
        valid++;
    }
    if (valid < 16) return outliers;
    cx /= valid;
    cy /= valid;
    cz /= valid;

    let mean = 0;
    let m2 = 0;
    let seen = 0;
    const distances = new Float32Array(valid);
    const sourceIndices = new Uint32Array(valid);
    for (let i = 0; i < limit; i++) {
        if (!Number.isFinite(x[i]) || !Number.isFinite(y[i]) || !Number.isFinite(z[i])) continue;
        const d = Math.hypot(x[i] - cx, y[i] - cy, z[i] - cz);
        distances[seen++] = d;
        sourceIndices[seen - 1] = i;
        const delta = d - mean;
        mean += delta / seen;
        m2 += delta * (d - mean);
    }
    const std = Math.sqrt(m2 / Math.max(1, seen - 1));
    const threshold = mean + OUTLIER_SIGMA * std;
    if (!Number.isFinite(threshold) || threshold <= 0) return outliers;

    for (let i = 0; i < seen; i++) {
        if (distances[i] > threshold) outliers.push(sourceIndices[i]);
    }
    return outliers;
}
