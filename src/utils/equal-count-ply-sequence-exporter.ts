import { PLYEncoder } from './ply-encoder';
import { t } from '../i18n';

// #WDD-gpt  2026-07-16 - 新增固定点数、固定索引的逐帧 PLY 序列导出，满足跨帧同一物理高斯保持同一顶点序号的交换规范

type NumericArray = ArrayLike<number>;

export type EqualCountPLYSequenceSource = {
    count: number;
    totalFrames: number;
    getProp: (name: string) => NumericArray | null | undefined;
    trajectory: Float32Array | null;
    keyframes: number;
    xyzStride: number;
    rotTrajectory: Float32Array | null;
    rotKeyframes: number;
    rotStride: number;
    dcTrajectory: Float32Array | null;
    dcKeyframes: number;
    dcStride: number;
    originalIndices: Float32Array | null;
    opacitySemantic?: 'logit' | 'probability';
    rotationSemantic?: 'wxyz' | 'xyzw';
};

type Interpolation = { k0: number; k1: number; alpha: number };

let equalCountExportRunning = false;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const sigmoid = (value: number) => 1 / (1 + Math.exp(-clamp(value, -20, 20)));
const logit = (value: number) => {
    const probability = clamp(value, 1e-7, 1 - 1e-7);
    return Math.log(probability / (1 - probability));
};

const interpolationAt = (frame: number, keyframes: number, stride: number): Interpolation => {
    if (keyframes <= 1) return { k0: 0, k1: 0, alpha: 0 };
    const safeStride = Math.max(1, stride);
    const keyframeIndex = clamp(Math.floor(frame / safeStride), 0, keyframes - 1);
    const k0 = Math.min(keyframeIndex, keyframes - 1);
    const k1 = Math.min(k0 + 1, keyframes - 1);
    const t0 = k0 * safeStride;
    const t1 = k1 * safeStride;
    const alpha = k0 === k1 || t0 === t1 ? 0 : clamp((frame - t0) / (t1 - t0), 0, 1);
    return { k0, k1, alpha };
};

const normalizeQuaternion = (q: [number, number, number, number]): [number, number, number, number] => {
    const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
};

const slerp = (
    q0Input: [number, number, number, number],
    q1Input: [number, number, number, number],
    alpha: number
): [number, number, number, number] => {
    const q0 = normalizeQuaternion(q0Input);
    let q1 = normalizeQuaternion(q1Input);
    let dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
    if (dot < 0) {
        q1 = [-q1[0], -q1[1], -q1[2], -q1[3]];
        dot = -dot;
    }
    dot = clamp(dot, 0, 1);
    if (dot > 0.9995) {
        return normalizeQuaternion([
            q0[0] + alpha * (q1[0] - q0[0]),
            q0[1] + alpha * (q1[1] - q0[1]),
            q0[2] + alpha * (q1[2] - q0[2]),
            q0[3] + alpha * (q1[3] - q0[3])
        ]);
    }
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const weight0 = Math.sin((1 - alpha) * theta) / sinTheta;
    const weight1 = Math.sin(alpha * theta) / sinTheta;
    return normalizeQuaternion([
        weight0 * q0[0] + weight1 * q1[0],
        weight0 * q0[1] + weight1 * q1[1],
        weight0 * q0[2] + weight1 * q1[2],
        weight0 * q0[3] + weight1 * q1[3]
    ]);
};

const read = (array: NumericArray | null | undefined, index: number, fallback: number) => {
    const value = array?.[index];
    return Number.isFinite(value) ? value as number : fallback;
};

const readDynamicQuaternion = (
    bank: Float32Array,
    offset: number,
    semantic: 'wxyz' | 'xyzw'
): [number, number, number, number] => semantic === 'xyzw'
    ? [bank[offset + 3], bank[offset], bank[offset + 1], bank[offset + 2]]
    : [bank[offset], bank[offset + 1], bank[offset + 2], bank[offset + 3]];

const buildFrame = (source: EqualCountPLYSequenceSource, frame: number) => {
    const count = source.count;
    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const z = new Float32Array(count);
    const rot0 = new Float32Array(count);
    const rot1 = new Float32Array(count);
    const rot2 = new Float32Array(count);
    const rot3 = new Float32Array(count);
    const scale0 = new Float32Array(count);
    const scale1 = new Float32Array(count);
    const scale2 = new Float32Array(count);
    const opacity = new Float32Array(count);
    const fdc0 = new Float32Array(count);
    const fdc1 = new Float32Array(count);
    const fdc2 = new Float32Array(count);

    const staticX = source.getProp('x');
    const staticY = source.getProp('y');
    const staticZ = source.getProp('z');
    const staticRot0 = source.getProp('rot_0');
    const staticRot1 = source.getProp('rot_1');
    const staticRot2 = source.getProp('rot_2');
    const staticRot3 = source.getProp('rot_3');
    const staticScale0 = source.getProp('scale_0');
    const staticScale1 = source.getProp('scale_1');
    const staticScale2 = source.getProp('scale_2');
    const staticOpacity = source.getProp('opacity');
    const staticFdc0 = source.getProp('f_dc_0');
    const staticFdc1 = source.getProp('f_dc_1');
    const staticFdc2 = source.getProp('f_dc_2');
    const lifetimeMu = source.getProp('lifetime_mu');
    const lifetimeW = source.getProp('lifetime_w');
    const lifetimeK = source.getProp('lifetime_k');
    const xyzInterpolation = interpolationAt(frame, source.keyframes, source.xyzStride);
    const rotInterpolation = interpolationAt(frame, source.rotKeyframes, source.rotStride);
    const dcInterpolation = interpolationAt(frame, source.dcKeyframes, source.dcStride);
    const rotationSemantic = source.rotationSemantic === 'xyzw' ? 'xyzw' : 'wxyz';
    const opacitySemantic = source.opacitySemantic === 'probability' ? 'probability' : 'logit';

    for (let i = 0; i < count; i++) {
        const originalIndex = source.originalIndices ? Math.round(source.originalIndices[i]) : i;

        if (source.trajectory && source.keyframes > 0) {
            const base = originalIndex * source.keyframes * 3;
            const offset0 = base + xyzInterpolation.k0 * 3;
            const offset1 = base + xyzInterpolation.k1 * 3;
            x[i] = source.trajectory[offset0] * (1 - xyzInterpolation.alpha) + source.trajectory[offset1] * xyzInterpolation.alpha;
            y[i] = source.trajectory[offset0 + 1] * (1 - xyzInterpolation.alpha) + source.trajectory[offset1 + 1] * xyzInterpolation.alpha;
            z[i] = source.trajectory[offset0 + 2] * (1 - xyzInterpolation.alpha) + source.trajectory[offset1 + 2] * xyzInterpolation.alpha;
        } else {
            x[i] = read(staticX, i, 0);
            y[i] = read(staticY, i, 0);
            z[i] = read(staticZ, i, 0);
        }

        let quaternion: [number, number, number, number];
        if (source.rotTrajectory && source.rotKeyframes > 0) {
            const base = originalIndex * source.rotKeyframes * 4;
            const q0 = readDynamicQuaternion(source.rotTrajectory, base + rotInterpolation.k0 * 4, rotationSemantic);
            const q1 = readDynamicQuaternion(source.rotTrajectory, base + rotInterpolation.k1 * 4, rotationSemantic);
            quaternion = slerp(q0, q1, rotInterpolation.alpha);
        } else {
            quaternion = normalizeQuaternion([
                read(staticRot0, i, 1), read(staticRot1, i, 0),
                read(staticRot2, i, 0), read(staticRot3, i, 0)
            ]);
        }
        rot0[i] = quaternion[0];
        rot1[i] = quaternion[1];
        rot2[i] = quaternion[2];
        rot3[i] = quaternion[3];

        scale0[i] = read(staticScale0, i, 0);
        scale1[i] = read(staticScale1, i, 0);
        scale2[i] = read(staticScale2, i, 0);

        let baseAlpha = read(staticOpacity, i, opacitySemantic === 'logit' ? 0 : 1);
        if (opacitySemantic === 'logit') baseAlpha = sigmoid(baseAlpha);
        let lifetimeAlpha = 1;
        if (lifetimeMu && lifetimeW) {
            const mu = read(lifetimeMu, i, 0);
            const width = Math.max(0, read(lifetimeW, i, 0));
            const sharpness = Math.max(1, read(lifetimeK, i, 10));
            lifetimeAlpha = sigmoid(sharpness * (frame - (mu - width)))
                * sigmoid(sharpness * ((mu + width) - frame));
        }
        opacity[i] = logit(clamp(baseAlpha * lifetimeAlpha, 0, 1));

        if (source.dcTrajectory && source.dcKeyframes > 0) {
            const base = originalIndex * source.dcKeyframes * 3;
            const offset0 = base + dcInterpolation.k0 * 3;
            const offset1 = base + dcInterpolation.k1 * 3;
            fdc0[i] = source.dcTrajectory[offset0] * (1 - dcInterpolation.alpha) + source.dcTrajectory[offset1] * dcInterpolation.alpha;
            fdc1[i] = source.dcTrajectory[offset0 + 1] * (1 - dcInterpolation.alpha) + source.dcTrajectory[offset1 + 1] * dcInterpolation.alpha;
            fdc2[i] = source.dcTrajectory[offset0 + 2] * (1 - dcInterpolation.alpha) + source.dcTrajectory[offset1 + 2] * dcInterpolation.alpha;
        } else {
            fdc0[i] = read(staticFdc0, i, 0);
            fdc1[i] = read(staticFdc1, i, 0);
            fdc2[i] = read(staticFdc2, i, 0);
        }
    }

    const result: Record<string, NumericArray | number> = {
        count, x, y, z,
        rot_0: rot0, rot_1: rot1, rot_2: rot2, rot_3: rot3,
        scale_0: scale0, scale_1: scale1, scale_2: scale2,
        opacity,
        f_dc_0: fdc0, f_dc_1: fdc1, f_dc_2: fdc2
    };
    for (let coefficient = 0; coefficient < 45; coefficient++) {
        const name = `f_rest_${coefficient}`;
        const values = source.getProp(name);
        if (values) result[name] = values;
    }
    return result;
};

const throwIfCancelled = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
};

const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
}[character] || character));

const createEqualCountExportProgress = (summary: string, destination: string) => {
    // #WDD-gpt  2026-07-16 - 为等点数逐帧写盘提供独立进度对话框、实时状态与取消控制
    document.getElementById('equal-count-export-progress')?.remove();
    const controller = new AbortController();
    const modal = document.createElement('div');
    modal.id = 'equal-count-export-progress';
    modal.className = 'equal-count-export-progress';
    modal.innerHTML = `
        <div class="equal-count-export-progress-card" role="dialog" aria-modal="true" aria-labelledby="equal-count-export-progress-title">
            <div class="equal-count-export-progress-kicker">${escapeHTML(t('export.equalCount.kicker'))}</div>
            <div id="equal-count-export-progress-title" class="equal-count-export-progress-title">${escapeHTML(t('export.equalCount.title'))}</div>
            <div class="equal-count-export-progress-summary">${escapeHTML(summary)}</div>
            <div class="equal-count-export-progress-destination" title="${escapeHTML(destination)}">${escapeHTML(t('export.equalCount.destination', { path: destination }))}</div>
            <div class="equal-count-export-progress-row">
                <span data-role="stage" aria-live="polite">${escapeHTML(t('export.equalCount.preparing'))}</span>
                <span data-role="percent">0%</span>
            </div>
            <div class="equal-count-export-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="equal-count-export-progress-fill" data-role="fill"></div>
            </div>
            <button class="ui-btn equal-count-export-progress-cancel" type="button" data-role="cancel">${escapeHTML(t('export.equalCount.cancel'))}</button>
        </div>
    `;
    document.body.appendChild(modal);
    const stage = modal.querySelector<HTMLElement>('[data-role="stage"]')!;
    const percent = modal.querySelector<HTMLElement>('[data-role="percent"]')!;
    const fill = modal.querySelector<HTMLElement>('[data-role="fill"]')!;
    const track = modal.querySelector<HTMLElement>('[role="progressbar"]')!;
    const cancel = modal.querySelector<HTMLButtonElement>('[data-role="cancel"]')!;

    const requestCancel = () => {
        if (controller.signal.aborted) return;
        controller.abort();
        cancel.disabled = true;
        stage.textContent = t('export.equalCount.cancelling');
    };
    cancel.addEventListener('click', requestCancel);

    const update = (value: number, message: string) => {
        const clamped = clamp(value, 0, 100);
        fill.style.width = `${clamped}%`;
        percent.textContent = `${Math.floor(clamped)}%`;
        stage.textContent = message;
        track.setAttribute('aria-valuenow', String(Math.floor(clamped)));
    };
    const showTerminalState = (message: string, completed: boolean) => {
        if (completed) update(100, message);
        else stage.textContent = message;
        cancel.removeEventListener('click', requestCancel);
        cancel.disabled = false;
        cancel.textContent = t('export.equalCount.close');
        cancel.onclick = () => modal.remove();
    };

    return {
        signal: controller.signal,
        update,
        complete: () => showTerminalState(t('export.equalCount.complete'), true),
        cancelled: () => showTerminalState(t('export.equalCount.cancelled'), false),
        close: () => modal.remove()
    };
};

const writeEqualCountPLYSequenceToDirectory = async (
    source: EqualCountPLYSequenceSource,
    directory: any,
    progress: ReturnType<typeof createEqualCountExportProgress>
) => {
    // #WDD-gpt  2026-07-16 - 每次只生成并写出一帧，避免缓存完整序列和 ZIP 导致数 GB 内存持续增长
    const digits = Math.max(3, String(source.totalFrames - 1).length);
    for (let frame = 0; frame < source.totalFrames; frame++) {
        throwIfCancelled(progress.signal);
        const frameNumber = frame + 1;
        const startPercent = (frame / source.totalFrames) * 100;
        progress.update(startPercent, t('export.equalCount.buildingFrame', {
            current: frameNumber,
            total: source.totalFrames
        }));

        let frameData: any = null;
        let buffer: ArrayBuffer | null = null;
        try {
            frameData = buildFrame(source, frame);
            throwIfCancelled(progress.signal);
            buffer = await PLYEncoder.encode(frameData);
            throwIfCancelled(progress.signal);

            const fileName = `frame_${String(frame).padStart(digits, '0')}.ply`;
            progress.update(startPercent + 80 / source.totalFrames, t('export.equalCount.writingFrame', {
                current: frameNumber,
                total: source.totalFrames,
                name: fileName
            }));
            const fileHandle = await directory.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            try {
                await writable.write(buffer);
            } finally {
                await writable.close();
            }
        } finally {
            frameData = null;
            buffer = null;
        }
        progress.update((frameNumber / source.totalFrames) * 100, t('export.equalCount.savedFrame', {
            current: frameNumber,
            total: source.totalFrames
        }));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
};

export const downloadEqualCountPLYSequence = async (viewer: any): Promise<void> => {
    // #WDD-gpt  2026-07-16 - 先选择目录，再以低内存逐帧写盘，并由独立对话框展示进度和取消状态
    if (equalCountExportRunning) {
        alert(t('export.equalCount.alreadyRunning'));
        return;
    }
    if (!viewer.is4DGS) {
        alert(t('export.equalCount.requires4D'));
        return;
    }
    const component = viewer.splatEntity?.gsplat as any;
    const resource = component?.asset?.resource || component?.instance?.splatData?._resource;
    const splatData = resource?.splatData || component?.instance?.splatData || viewer.lastParsedData;
    if (!splatData) {
        alert(t('export.equalCount.noData'));
        return;
    }

    // #WDD-gpt  2026-07-16 - 兼容 PlayCanvas resource、运行时 instance 与原始解析数据三种属性存放位置
    const getProp = (name: string): NumericArray | null => {
        if (typeof splatData.getProp === 'function') return splatData.getProp(name) || null;
        if (splatData[name] && typeof splatData[name].length === 'number') return splatData[name];
        const property = splatData.plyData?.elements?.[0]?.properties?.find((item: any) => item?.name === name);
        return property?.storage || null;
    };
    const count = Number(splatData.numSplats || splatData.count || getProp('x')?.length || 0);
    if (count <= 0) {
        alert(t('export.equalCount.noSplats'));
        return;
    }

    const totalFrames = Math.max(1, Math.floor(viewer.totalFrames || viewer.duration || 1));
    const source: EqualCountPLYSequenceSource = {
        count,
        totalFrames,
        getProp,
        trajectory: viewer.trajectoryData,
        keyframes: viewer.keyframes || 0,
        xyzStride: viewer.xyzStride || 1,
        rotTrajectory: viewer.rotTrajectoryData,
        rotKeyframes: viewer.rotKeyframes || 0,
        rotStride: viewer.rotStride || 1,
        dcTrajectory: viewer.dcTrajectoryData,
        dcKeyframes: viewer.dcKeyframes || 0,
        dcStride: viewer.dcStride || 1,
        originalIndices: viewer.originalIndices,
        opacitySemantic: viewer.lastParsedData?.opacitySemantic,
        rotationSemantic: viewer.lastParsedData?.rotationSemantic
    };

    const showDirectoryPicker = (window as any).showDirectoryPicker;
    if (typeof showDirectoryPicker !== 'function') {
        alert(t('export.equalCount.directoryUnsupported'));
        return;
    }

    equalCountExportRunning = true;
    let progress: ReturnType<typeof createEqualCountExportProgress> | null = null;
    try {
        const directory = await showDirectoryPicker({ mode: 'readwrite', id: 'equal-count-ply-sequence-export' });
        const summary = t('export.equalCount.summary', {
            count: count.toLocaleString(),
            frames: totalFrames.toLocaleString()
        });
        progress = createEqualCountExportProgress(summary, directory.name || t('export.equalCount.selectedFolder'));
        await writeEqualCountPLYSequenceToDirectory(source, directory, progress);
        progress.complete();
    } catch (error) {
        if ((error as any)?.name === 'AbortError') {
            progress?.cancelled();
        } else {
            progress?.close();
            console.error('[Equal-count PLY] Export failed', error);
            alert(t('export.equalCount.failed', {
                message: error instanceof Error ? error.message : String(error)
            }));
        }
    } finally {
        equalCountExportRunning = false;
    }
};
