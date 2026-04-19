import JSZip from 'jszip';
import { encodeTextureImage } from './webp-lossless';

export type SOG4EncodeProgressMeta = {
    stageId: string;
    stageLabel: string;
    stagePct: number;
    overallPct: number;
    detail?: string;
};

// Matches Python log_transform & inverseLogTransform
const logTransform = (v: number) => Math.sign(v) * Math.log(Math.abs(v) + 1);
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));
const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
const yieldToBrowser = () => new Promise<void>((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => resolve());
        return;
    }
    setTimeout(resolve, 0);
});
const createYieldController = (budgetMs = 12) => {
    let lastYield = nowMs();
    return async (force = false) => {
        const now = nowMs();
        if (!force && now - lastYield < budgetMs) {
            return;
        }
        await yieldToBrowser();
        lastYield = nowMs();
    };
};
const extractTrailingIndex = (name: string) => {
    const match = name.match(/_(\d+)$/);
    return match ? parseInt(match[1], 10) : -1;
};
const clampU8 = (v: number) => Math.max(0, Math.min(255, Math.trunc(v)));
const normalizeU16 = (val: number, minV: number, maxV: number) => {
    const invRange = 1.0 / ((maxV - minV) + 1e-9);
    const norm = (val - minV) * invRange;
    return Math.max(0, Math.min(65535, Math.trunc(norm * 65535)));
};
const createPaddedSize = (count: number) => {
    const width = Math.max(4, Math.ceil(Math.sqrt(count) / 4) * 4);
    const height = Math.max(4, Math.ceil((count / width) / 4) * 4);
    return { width, height, paddedSize: width * height };
};
const roundPow2 = (value: number) => {
    if (!Number.isFinite(value) || value <= 1) return 1;
    return 2 ** Math.round(Math.log2(value));
};
const chooseShnPaletteSize = (count: number, numCoeffs: number) => {
    const coeffPenalty = numCoeffs >= 45 ? 0.5 : (numCoeffs >= 24 ? 0.75 : 1.0);
    const target = Math.sqrt(Math.max(count, 1)) * 8 * coeffPenalty;
    const minPalette = count >= 16384 ? 512 : 256;
    const maxPalette = numCoeffs >= 45 ? 4096 : 8192;
    return Math.max(minPalette, Math.min(count, Math.min(maxPalette, roundPow2(target))));
};
const chooseShnIterations = (iterations: number, count: number, numCoeffs: number) => {
    const cap = (count >= 120000 || numCoeffs >= 45) ? 3 : 4;
    return Math.max(2, Math.min(iterations, cap));
};
const resolveTotalFrames = (data: any) => {
    const explicit = Number(data?.frames ?? data?.total_frames ?? data?.custom?.total_frames);
    if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.round(explicit));
    const calcFrames = (keyframes: number, stride: number) => {
        const k = Number.isFinite(keyframes) ? Math.max(0, Math.round(keyframes)) : 0;
        const s = Number.isFinite(stride) && stride > 0 ? stride : 1;
        return k > 1 ? (k - 1) * s + 1 : (k === 1 ? 1 : 0);
    };
    return Math.max(
        1,
        calcFrames(data?.keyframes || 0, data?.xyzStride || 1),
        calcFrames(data?.rotKeyframes || 0, data?.rotStride || 1),
        calcFrames(data?.dcKeyframes || 0, data?.dcStride || 1)
    );
};
const initializeCentroids1D = (data: Float32Array, k: number) => {
    const sorted = Float32Array.from(data).sort();
    const centroids = new Float32Array(k);
    const n = sorted.length;
    for (let i = 0; i < k; i++) {
        const quantile = (2 * i + 1) / (2 * k);
        const index = Math.min(Math.floor(quantile * n), n - 1);
        centroids[i] = sorted[index];
    }
    return centroids;
};
// #WDD 2026-04-03 修复浏览器在sog4导出时卡死的问题：
// 1. 在kmeans系列函数中去除了原本O(N)复杂度的随机Set.add初始化，改为按步长快速取点；
// 2. 将 kmeansND 的 batchSize 改为根据 K 和 D 动态计算；
// 3. 在所有耗时循环加入 pct 的进度回调避免UI假死。
// #WDD 2026-04-03 进一步优化SHN导出速度：在大量数据的情况下（如大于10万或20万点），kmeans训练将提取子集(subsample)进行迭代收敛，迭代结束后再作一次全量匹配操作，时间复杂度从 O(N*...*iter) 降为 O(N*... + TrainN*...*iter)，带来约10倍级加速的同时保证结果的正确性。
const kmeans1D = async (
    input: ArrayLike<number>,
    requestedK: number,
    iterations = 10,
    scheduler?: (force?: boolean, pct?: number) => Promise<void>
) => {
    const data = Float32Array.from(input);
    const n = data.length;
    const k = Math.min(requestedK, n);
    if (k === 0) return { centroids: new Float32Array(0), labels: new Uint32Array(0) };

    const step = Math.max(1, Math.floor(n / k));
    let centroids = new Float32Array(k);
    for (let c = 0; c < k; c++) {
        centroids[c] = data[Math.min(n - 1, c * step)];
    }
    
    // Subsample setup
    const maxTrain = 200000;
    const useSubsample = n > maxTrain;
    const trainN = useSubsample ? maxTrain : n;
    let trainData = data;
    if (useSubsample) {
        trainData = new Float32Array(trainN);
        const trainStep = n / trainN;
        for (let i = 0; i < trainN; i++) {
            trainData[i] = data[Math.min(n - 1, Math.floor(i * trainStep))];
        }
    }
    
    let labels = new Uint32Array(n);
    let trainLabels = useSubsample ? new Uint32Array(trainN) : labels;

    for (let iter = 0; iter < iterations; iter++) {
        for (let i = 0; i < trainN; i++) {
            let bestIdx = 0;
            let bestDist = Infinity;
            const value = trainData[i];
            for (let j = 0; j < k; j++) {
                const dist = Math.abs(value - centroids[j]);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = j;
                }
            }
            trainLabels[i] = bestIdx;
            if ((i & 4095) === 0) {
                await scheduler?.(false, (iter + i / trainN) / (iterations + 1));
            }
        }

        const sums = new Float64Array(k);
        const counts = new Uint32Array(k);
        for (let i = 0; i < trainN; i++) {
            const label = trainLabels[i];
            sums[label] += trainData[i];
            counts[label]++;
            if ((i & 4095) === 0) {
                await scheduler?.(false, (iter + 0.5 + 0.5 * (i / trainN)) / (iterations + 1));
            }
        }
        for (let j = 0; j < k; j++) {
            if (counts[j] > 0) {
                centroids[j] = sums[j] / counts[j];
            } else {
                centroids[j] = trainData[Math.floor(Math.random() * trainN)];
            }
        }
        await scheduler?.(true, (iter + 1) / (iterations + 1));
    }

    const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => centroids[a] - centroids[b]);
    const sortedCentroids = new Float32Array(k);
    for (let i = 0; i < k; i++) sortedCentroids[i] = centroids[order[i]];
    centroids = sortedCentroids;

    for (let i = 0; i < n; i++) {
        let bestIdx = 0;
        let bestDist = Infinity;
        const value = data[i];
        for (let j = 0; j < k; j++) {
            const dist = Math.abs(value - centroids[j]);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = j;
            }
        }
        labels[i] = bestIdx;
        if ((i & 4095) === 0) {
            await scheduler?.(false, (iterations + i / n) / (iterations + 1));
        }
    }
    
    if (scheduler) await scheduler(true, 1.0);

    return { centroids, labels };
};
const clusterSharedCodebook = async (
    columns: Float32Array[],
    k: number,
    iterations = 10,
    scheduler?: (force?: boolean, pct?: number) => Promise<void>
) => {
    const rows = columns[0]?.length || 0;
    const flattened = new Float32Array(rows * columns.length);
    for (let c = 0; c < columns.length; c++) flattened.set(columns[c], c * rows);
    const { centroids, labels } = await kmeans1D(flattened, k, iterations, scheduler);
    const labelList = columns.map((_, c) => labels.subarray(c * rows, (c + 1) * rows));
    return { centroids, labelsList: labelList };
};
const kmeansND = async (
    input: Float32Array,
    n: number,
    d: number,
    requestedK: number,
    iterations = 10,
    batchSizeOverride?: number, // Ignored now, using dynamic batch mapping
    scheduler?: (force?: boolean, pct?: number) => Promise<void>
) => {
    const k = Math.min(requestedK, n);
    const labels = new Uint32Array(n);
    
    // Subsample training data to max 100,000 points
    const maxTrain = 100000;
    const useSubsample = n > maxTrain;
    const trainN = useSubsample ? maxTrain : n;
    
    let centroids = new Float32Array(k * d);
    const step = Math.max(1, Math.floor(n / k));
    for (let c = 0; c < k; c++) {
        const idx = Math.min(n - 1, c * step);
        centroids.set(input.subarray(idx * d, idx * d + d), c * d);
    }
    
    let trainInput = input;
    if (useSubsample) {
        trainInput = new Float32Array(trainN * d);
        const trainStep = n / trainN;
        for (let i = 0; i < trainN; i++) {
            const idx = Math.min(n - 1, Math.floor(i * trainStep));
            trainInput.set(input.subarray(idx * d, idx * d + d), i * d);
        }
    }
    
    const trainLabels = useSubsample ? new Uint32Array(trainN) : labels;
    const batchSize = Math.max(16, Math.floor(100000 / (k * d + 1)));

    for (let iter = 0; iter < iterations; iter++) {
        const centroidNorms = new Float64Array(k);
        for (let c = 0; c < k; c++) {
            let sum = 0;
            const cOffset = c * d;
            for (let j = 0; j < d; j++) {
                sum += centroids[cOffset + j] * centroids[cOffset + j];
            }
            centroidNorms[c] = sum;
        }

        for (let start = 0; start < trainN; start += batchSize) {
            const end = Math.min(start + batchSize, trainN);
            for (let i = start; i < end; i++) {
                let bestIdx = 0;
                let bestMetric = Infinity;
                const iOffset = i * d;
                for (let c = 0; c < k; c++) {
                    let dot = 0;
                    const cOffset = c * d;
                    for (let j = 0; j < d; j++) dot += trainInput[iOffset + j] * centroids[cOffset + j];
                    const metric = centroidNorms[c] - 2 * dot;
                    if (metric < bestMetric) {
                        bestMetric = metric;
                        bestIdx = c;
                    }
                }
                trainLabels[i] = bestIdx;
            }
            if (scheduler) {
                await scheduler(false, (iter + start / trainN) / (iterations + 1));
            }
        }

        const sums = new Float64Array(k * d);
        const counts = new Uint32Array(k);
        for (let i = 0; i < trainN; i++) {
            const label = trainLabels[i];
            counts[label]++;
            const iOffset = i * d;
            const lOffset = label * d;
            for (let j = 0; j < d; j++) sums[lOffset + j] += trainInput[iOffset + j];
            if ((i & 4095) === 0 && scheduler) {
                await scheduler(false, (iter + 0.5 + 0.5 * (i / trainN)) / (iterations + 1));
            }
        }
        const next = new Float32Array(centroids.length);
        for (let c = 0; c < k; c++) {
            if (counts[c] > 0) {
                const cOffset = c * d;
                for (let j = 0; j < d; j++) next[cOffset + j] = sums[cOffset + j] / counts[c];
            } else {
                next.set(centroids.subarray(c * d, c * d + d), c * d);
            }
        }
        centroids = next;
        if (scheduler) await scheduler(true, (iter + 1) / (iterations + 1));
    }

    if (useSubsample) {
        const centroidNorms = new Float64Array(k);
        for (let c = 0; c < k; c++) {
            let sum = 0;
            const cOffset = c * d;
            for (let j = 0; j < d; j++) sum += centroids[cOffset + j] * centroids[cOffset + j];
            centroidNorms[c] = sum;
        }

        for (let start = 0; start < n; start += batchSize) {
            const end = Math.min(start + batchSize, n);
            for (let i = start; i < end; i++) {
                let bestIdx = 0;
                let bestMetric = Infinity;
                const iOffset = i * d;
                for (let c = 0; c < k; c++) {
                    let dot = 0;
                    const cOffset = c * d;
                    for (let j = 0; j < d; j++) dot += input[iOffset + j] * centroids[cOffset + j];
                    const metric = centroidNorms[c] - 2 * dot;
                    if (metric < bestMetric) {
                        bestMetric = metric;
                        bestIdx = c;
                    }
                }
                labels[i] = bestIdx;
            }
            if (scheduler) {
                await scheduler(false, (iterations + start / n) / (iterations + 1));
            }
        }
    }
    if (scheduler) await scheduler(true, 1.0);

    return { centroids, labels };
};

export class SOG4Encoder {
    static async encode(
        data: any,
        overrides: any = {},
        progress?: (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => void
    ): Promise<Uint8Array> {
        let count = data.count || data.plyData?.elements[0]?.count || 0;
        if (count === 0) throw new Error("No data to encode.");

        const scheduler = createYieldController(overrides.yieldBudgetMs ?? 12);
        const emitProgress = (
            overallPct: number,
            msg: string,
            meta?: Partial<SOG4EncodeProgressMeta>
        ) => {
            progress?.(overallPct, msg, {
                stageId: meta?.stageId || 'overall',
                stageLabel: meta?.stageLabel || msg,
                stagePct: Math.min(100, Math.max(0, meta?.stagePct ?? overallPct)),
                overallPct,
                detail: meta?.detail || msg
            });
        };

        emitProgress(0, "Initializing SOG4 Encoder...", {
            stageId: 'prepare',
            stageLabel: 'Prepare',
            stagePct: 0
        });

        // Unpack plyData arrays if not natively on data
        let p: any = {};
        if (data.plyData && data.plyData.elements && data.plyData.elements[0].properties) {
            const props = data.plyData.elements[0].properties;
            for (let i = 0; i < props.length; i++) p[props[i].name] = props[i].storage;
        } else {
            p = data; // Fallback to flat
        }

        // Optional: Apply deletions BEFORE encoding (faster than post-compaction)
        let sourceIndices: Uint32Array | null = null;
        const deleted = overrides.apply_deleted && Array.isArray(overrides.deleted_indices) ? overrides.deleted_indices : null;
        if (deleted && deleted.length > 0) {
            const originalCount = count;
            const origIndices = overrides.original_indices as ArrayLike<number> | undefined;
            const deletedSet = new Set<number>();
            for (let i = 0; i < deleted.length; i++) {
                const idx = deleted[i];
                const mapped = origIndices ? Math.round(origIndices[idx]) : idx;
                if (mapped >= 0 && mapped < originalCount) deletedSet.add(mapped);
            }

            if (deletedSet.size > 0) {
                emitProgress(2, `Filtering deleted splats (${deletedSet.size}/${originalCount})...`, {
                    stageId: 'filter',
                    stageLabel: 'Filter Deleted',
                    stagePct: 5
                });
                const keepIndices: number[] = [];
                for (let i = 0; i < originalCount; i++) {
                    if (!deletedSet.has(i)) keepIndices.push(i);
                    if ((i & 8191) === 0) {
                        await scheduler();
                    }
                }
                sourceIndices = new Uint32Array(keepIndices);
                count = sourceIndices.length;
            }
        }

        const zip = new JSZip();
        const getSourceIndex = (i: number) => sourceIndices ? sourceIndices[i] : i;
        const totalFrames = resolveTotalFrames(data);
        const meta: any = {
            version: 2,
            asset: { generator: 'master_ply_to_sog_native' },
            count: count,
            total_frames: totalFrames,
            model_transform: overrides.model_transform || data.model_transform || { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
            cameras: overrides.cameras || data.cameras || [],
            postProcessing: overrides.postProcessing || data.postProcessing || { exposure: 1.0, brightness: 0.0, contrast: 0.0 }
        };
        const fRestNames = Object.keys(p).filter((name) => /^f_rest_\d+$/.test(name)).sort((a, b) => extractTrailingIndex(a) - extractTrailingIndex(b));
        const opacitySemantic = data.opacitySemantic;
        const rawMode = overrides.rawFloatPayload === true;
        emitProgress(5, "Prepared source arrays", {
            stageId: 'prepare',
            stageLabel: 'Prepare',
            stagePct: 100
        });

        if (rawMode) {
            emitProgress(5, "Encoding Raw Float Payload...", {
                stageId: 'raw_payload',
                stageLabel: 'Raw Payload',
                stagePct: 0
            });
            const originalIndexSource = (overrides.original_indices as ArrayLike<number> | undefined) || p.original_index;
            const staticRowFloats = 18 + fRestNames.length;
            const staticData = new Float32Array(count * staticRowFloats);
            for (let i = 0; i < count; i++) {
                const src = getSourceIndex(i);
                let off = i * staticRowFloats;
                staticData[off++] = p.x?.[src] || 0;
                staticData[off++] = p.y?.[src] || 0;
                staticData[off++] = p.z?.[src] || 0;
                staticData[off++] = p.rot_0?.[src] ?? 1;
                staticData[off++] = p.rot_1?.[src] ?? 0;
                staticData[off++] = p.rot_2?.[src] ?? 0;
                staticData[off++] = p.rot_3?.[src] ?? 0;
                staticData[off++] = p.scale_0?.[src] || 0;
                staticData[off++] = p.scale_1?.[src] || 0;
                staticData[off++] = p.scale_2?.[src] || 0;
                const rawOpacity = p.opacity?.[src] ?? 0;
                staticData[off++] = opacitySemantic === 'probability' ? Math.log(Math.max(1e-7, Math.min(1 - 1e-7, rawOpacity)) / Math.max(1e-7, 1 - Math.max(1e-7, Math.min(1 - 1e-7, rawOpacity)))) : rawOpacity;
                staticData[off++] = p.f_dc_0?.[src] || 0;
                staticData[off++] = p.f_dc_1?.[src] || 0;
                staticData[off++] = p.f_dc_2?.[src] || 0;
                staticData[off++] = p.lifetime_mu?.[src] || 0;
                staticData[off++] = p.lifetime_w?.[src] || 0;
                staticData[off++] = p.lifetime_k?.[src] ?? 10.0;
                for (const name of fRestNames) {
                    staticData[off++] = p[name]?.[src] || 0;
                }
                staticData[off++] = originalIndexSource?.[src] ?? src;
                if ((i & 4095) === 0) {
                    emitProgress(5 + (i / Math.max(count, 1)) * 85, `Encoding Raw Float Payload ${i}/${count}`, {
                        stageId: 'raw_payload',
                        stageLabel: 'Raw Payload',
                        stagePct: (i / Math.max(count, 1)) * 100
                    });
                    await scheduler();
                }
            }

            const saveFloat32 = (name: string, arr: Float32Array) => {
                zip.file(name, new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)));
            };

            saveFloat32('raw_static.bin', staticData);

            const buildCompactedBank = (bank: Float32Array | null | undefined, keyframes: number, components: number) => {
                if (!bank || keyframes <= 0) return null;
                const compact = new Float32Array(count * keyframes * components);
                for (let i = 0; i < count; i++) {
                    const src = getSourceIndex(i);
                    const srcBase = src * keyframes * components;
                    const dstBase = i * keyframes * components;
                    compact.set(bank.subarray(srcBase, srcBase + keyframes * components), dstBase);
                }
                return compact;
            };

            const xyzBank = buildCompactedBank(data.trajectory || data.xyzBank, data.keyframes || 0, 3);
            const rotBank = buildCompactedBank(data.rotTrajectory || data.rotBank, data.rotKeyframes || 0, 4);
            const dcBank = buildCompactedBank(data.dcTrajectory || data.dcBank, data.dcKeyframes || 0, 3);

            if (xyzBank) saveFloat32('raw_xyz_bank.bin', xyzBank);
            if (rotBank) saveFloat32('raw_rot_bank.bin', rotBank);
            if (dcBank) saveFloat32('raw_dc_bank.bin', dcBank);

            meta.total_frames = totalFrames;
            meta.custom = Object.assign({}, data.custom || overrides.custom || {}, {
                raw_float_payload: {
                    version: 1,
                    total_frames: totalFrames,
                    static: {
                        file: 'raw_static.bin',
                        row_floats: staticRowFloats,
                        f_rest_count: fRestNames.length
                    },
                    xyz_bank: xyzBank ? {
                        file: 'raw_xyz_bank.bin',
                        keyframes: data.keyframes || 0,
                        stride: data.xyzStride || 1
                    } : null,
                    rot_bank: rotBank ? {
                        file: 'raw_rot_bank.bin',
                        keyframes: data.rotKeyframes || 0,
                        stride: data.rotStride || 1
                    } : null,
                    dc_bank: dcBank ? {
                        file: 'raw_dc_bank.bin',
                        keyframes: data.dcKeyframes || 0,
                        stride: data.dcStride || 1
                    } : null
                }
            });

            zip.file('meta.json', JSON.stringify(meta, null, 2));
            emitProgress(98, "Zipping Raw SOG4...", {
                stageId: 'zip',
                stageLabel: 'Package ZIP',
                stagePct: 0
            });
            const result = await zip.generateAsync(
                { type: 'uint8array', compression: 'STORE' },
                (metadata) => {
                    emitProgress(98 + (metadata.percent / 100) * 2, `Zipping Raw SOG4 ${metadata.percent.toFixed(0)}%`, {
                        stageId: 'zip',
                        stageLabel: 'Package ZIP',
                        stagePct: metadata.percent
                    });
                }
            );
            emitProgress(100, "Done", {
                stageId: 'zip',
                stageLabel: 'Package ZIP',
                stagePct: 100
            });
            return result;
        }
        const customOut: any = { total_frames: totalFrames };
        if (data.meta) {
            const m = data.meta;
            if (m.modelPos)   customOut['model_pos'] = `${m.modelPos.x} ${m.modelPos.y} ${m.modelPos.z}`;
            if (m.modelRot)   customOut['model_rot'] = `${m.modelRot.x} ${m.modelRot.y} ${m.modelRot.z} ${m.modelRot.w}`;
            if (m.modelScale) customOut['model_scale'] = `${m.modelScale.x} ${m.modelScale.y} ${m.modelScale.z}`;
        }
        meta.custom = Object.assign({}, data.custom || {}, overrides.custom || {}, meta.custom || {}, customOut);

        const { width, height, paddedSize } = createPaddedSize(count);
        const iterations = Number.isFinite(overrides.iterations) ? overrides.iterations : 5;

        const createTex = () => {
            const canvas: any = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(width, height)
                : Object.assign(document.createElement('canvas'), { width, height });
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const img = ctx.createImageData(width, height);
            return { canvas, ctx, img, data: img.data };
        };

        const chooseImageType = (fileName: string) => fileName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/webp';

        const renderTex = async (tex: any, fileName: string): Promise<ArrayBuffer> => {
            return await encodeTextureImage(tex, fileName);
        };
        const saveTex = async (tex: any, name: string) => {
            zip.file(name, await renderTex(tex, name));
            await scheduler();
        };
        const cpuHint = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
            ? Math.floor(navigator.hardwareConcurrency / 2)
            : 2;
        const maxParallel = count > 150000
            ? 1
            : Math.max(1, Math.min(2, cpuHint));

        emitProgress(10, "Encoding Means (XYZ)...", {
            stageId: 'means',
            stageLabel: 'Means (XYZ)',
            stagePct: 0
        });
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
        const lx = new Float32Array(count), ly = new Float32Array(count), lz = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            lx[i] = logTransform(p.x?.[src] || 0);
            ly[i] = logTransform(p.y?.[src] || 0);
            lz[i] = logTransform(p.z?.[src] || 0);
            if (lx[i] < minX) minX = lx[i]; if (lx[i] > maxX) maxX = lx[i];
            if (ly[i] < minY) minY = ly[i]; if (ly[i] > maxY) maxY = ly[i];
            if (lz[i] < minZ) minZ = lz[i]; if (lz[i] > maxZ) maxZ = lz[i];
            if ((i & 4095) === 0) {
                emitProgress(10 + (i / Math.max(count, 1)) * 12, `Encoding Means (XYZ) ${i}/${count}`, {
                    stageId: 'means',
                    stageLabel: 'Means (XYZ)',
                    stagePct: (i / Math.max(count, 1)) * 80
                });
                await scheduler();
            }
        }
        meta.means = { mins: [minX, minY, minZ], maxs: [maxX, maxY, maxZ], files: ['means_l.webp', 'means_u.webp'] };
        const mL = createTex(), mU = createTex();
        for (let i = 0; i < count; i++) {
            const valX = normalizeU16(lx[i], minX, maxX);
            const valY = normalizeU16(ly[i], minY, maxY);
            const valZ = normalizeU16(lz[i], minZ, maxZ);
            const di = i * 4;
            mL.data[di] = valX & 0xFF; mU.data[di] = (valX >> 8) & 0xFF;
            mL.data[di + 1] = valY & 0xFF; mU.data[di + 1] = (valY >> 8) & 0xFF;
            mL.data[di + 2] = valZ & 0xFF; mU.data[di + 2] = (valZ >> 8) & 0xFF;
            mL.data[di + 3] = 255; mU.data[di + 3] = 255;
            if ((i & 4095) === 0) {
                emitProgress(18 + (i / Math.max(count, 1)) * 4, `Packing Means ${i}/${count}`, {
                    stageId: 'means',
                    stageLabel: 'Means (XYZ)',
                    stagePct: 80 + (i / Math.max(count, 1)) * 18
                });
                await scheduler();
            }
        }
        await saveTex(mL, 'means_l.webp'); await saveTex(mU, 'means_u.webp');
        emitProgress(22, "Means encoded", {
            stageId: 'means',
            stageLabel: 'Means (XYZ)',
            stagePct: 100
        });

        emitProgress(24, "Encoding Rotations...", {
            stageId: 'rotations',
            stageLabel: 'Rotations',
            stagePct: 0
        });
        meta.quats = { files: ['quats.webp'] };
        const qTex = createTex();
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            const di = i * 4;
            const qr = p.rot_0?.[src] || 1, qi = p.rot_1?.[src] || 0, qj = p.rot_2?.[src] || 0, qk = p.rot_3?.[src] || 0;
            const qlen = Math.sqrt(qr*qr + qi*qi + qj*qj + qk*qk);
            const q = [qr/qlen, qi/qlen, qj/qlen, qk/qlen];
            
            let maxIdx = 0, maxVal = -1;
            for (let j = 0; j < 4; j++) {
                const absV = Math.abs(q[j]);
                if (absV > maxVal) { maxVal = absV; maxIdx = j; }
            }
            if (q[maxIdx] < 0) {
                for (let j = 0; j < 4; j++) q[j] = -q[j];
            }
            let writeIdx = 0;
            for (let j = 0; j < 4; j++) {
                if (j === maxIdx) continue;
                qTex.data[di + writeIdx++] = clampU8(255 * (((q[j] * Math.SQRT2) * 0.5) + 0.5));
            }
            qTex.data[di + 3] = 252 + maxIdx;
            if ((i & 4095) === 0) {
                emitProgress(24 + (i / Math.max(count, 1)) * 10, `Encoding Rotations ${i}/${count}`, {
                    stageId: 'rotations',
                    stageLabel: 'Rotations',
                    stagePct: (i / Math.max(count, 1)) * 85
                });
                await scheduler();
            }
        }
        await saveTex(qTex, 'quats.webp');
        emitProgress(34, "Rotations encoded", {
            stageId: 'rotations',
            stageLabel: 'Rotations',
            stagePct: 100
        });

        emitProgress(36, "Encoding Scales & Opacity...", {
            stageId: 'scales_opacity',
            stageLabel: 'Scales & Opacity',
            stagePct: 0
        });
        const scale0 = new Float32Array(count), scale1 = new Float32Array(count), scale2 = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            scale0[i] = p.scale_0?.[src] || 0;
            scale1[i] = p.scale_1?.[src] || 0;
            scale2[i] = p.scale_2?.[src] || 0;
            if ((i & 4095) === 0) {
                emitProgress(36 + (i / Math.max(count, 1)) * 6, `Collecting Scales ${i}/${count}`, {
                    stageId: 'scales_opacity',
                    stageLabel: 'Scales & Opacity',
                    stagePct: (i / Math.max(count, 1)) * 35
                });
                await scheduler();
            }
        }
        const { centroids: scaleCb, labelsList: scaleLabels } = await clusterSharedCodebook([scale0, scale1, scale2], 256, iterations, scheduler);
        meta.scales = { codebook: Array.from(scaleCb), files: ['scales.webp'] };
        const sTex = createTex();
        for (let i = 0; i < count; i++) {
            sTex.data[i * 4] = scaleLabels[0][i];
            sTex.data[i * 4 + 1] = scaleLabels[1][i];
            sTex.data[i * 4 + 2] = scaleLabels[2][i];
            sTex.data[i * 4 + 3] = 255;
            if ((i & 4095) === 0) {
                emitProgress(42 + (i / Math.max(count, 1)) * 4, `Packing Scales ${i}/${count}`, {
                    stageId: 'scales_opacity',
                    stageLabel: 'Scales & Opacity',
                    stagePct: 35 + (i / Math.max(count, 1)) * 20
                });
                await scheduler();
            }
        }
        await saveTex(sTex, 'scales.webp');

        const sh0_0 = new Float32Array(count), sh0_1 = new Float32Array(count), sh0_2 = new Float32Array(count);
        const opacArray = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            sh0_0[i] = p.f_dc_0?.[src] || 0;
            sh0_1[i] = p.f_dc_1?.[src] || 0;
            sh0_2[i] = p.f_dc_2?.[src] || 0;
            opacArray[i] = p.opacity?.[src] ?? 0;
            if ((i & 4095) === 0) {
                emitProgress(46 + (i / Math.max(count, 1)) * 2, `Collecting SH0 ${i}/${count}`, {
                    stageId: 'scales_opacity',
                    stageLabel: 'Scales & Opacity',
                    stagePct: 55 + (i / Math.max(count, 1)) * 10
                });
                await scheduler();
            }
        }
        const { centroids: shCb, labelsList: shLabels } = await clusterSharedCodebook([sh0_0, sh0_1, sh0_2], 256, iterations, scheduler);
        meta.sh0 = { codebook: Array.from(shCb), files: ['sh0.webp'] };
        const sh0Tex = createTex();
        for (let i = 0; i < count; i++) {
            let opac = opacArray[i];
            if (opac > 1.0 || opac < 0.0) opac = sigmoid(opac);
            sh0Tex.data[i * 4] = shLabels[0][i];
            sh0Tex.data[i * 4 + 1] = shLabels[1][i];
            sh0Tex.data[i * 4 + 2] = shLabels[2][i];
            sh0Tex.data[i * 4 + 3] = clampU8(opac * 255);
            if ((i & 4095) === 0) {
                emitProgress(48 + (i / Math.max(count, 1)) * 4, `Packing SH0 ${i}/${count}`, {
                    stageId: 'scales_opacity',
                    stageLabel: 'Scales & Opacity',
                    stagePct: 70 + (i / Math.max(count, 1)) * 20
                });
                await scheduler();
            }
        }
        await saveTex(sh0Tex, 'sh0.webp');
        emitProgress(52, "Scales & opacity encoded", {
            stageId: 'scales_opacity',
            stageLabel: 'Scales & Opacity',
            stagePct: 100
        });

        if (fRestNames.length > 0) {
            emitProgress(52, `Encoding SHN (${fRestNames.length})...`, {
                stageId: 'shn',
                stageLabel: `SHN (${fRestNames.length})`,
                stagePct: 0
            });
            const numCoeffs = fRestNames.length;
            const shData = new Float32Array(count * numCoeffs);
            for (let i = 0; i < count; i++) {
                const src = getSourceIndex(i);
                for (let j = 0; j < numCoeffs; j++) shData[i * numCoeffs + j] = p[fRestNames[j]]?.[src] || 0;
                if ((i & 1023) === 0) {
                    emitProgress(52 + (i / Math.max(count, 1)) * 2, `Collecting SHN ${i}/${count}`, {
                        stageId: 'shn',
                        stageLabel: `SHN (${fRestNames.length})`,
                        stagePct: (i / Math.max(count, 1)) * 10
                    });
                    await scheduler();
                }
            }

            const paletteSize = chooseShnPaletteSize(count, numCoeffs);
            const shnIterations = chooseShnIterations(iterations, count, numCoeffs);
            emitProgress(54, `SHN palette size ${paletteSize}, iterations ${shnIterations}`, {
                stageId: 'shn',
                stageLabel: `SHN (${fRestNames.length})`,
                stagePct: 10
            });
            
            const wrappedSchedulerND = async (force?: boolean, pct?: number) => {
                if (pct !== undefined) {
                    emitProgress(54 + pct * 3, `Clustering SHN ND (${Math.round(pct * 100)}%)`, {
                        stageId: 'shn',
                        stageLabel: `SHN (${fRestNames.length})`,
                        stagePct: 10 + pct * 40
                    });
                }
                await scheduler(force);
            };
            const wrappedScheduler1D = async (force?: boolean, pct?: number) => {
                if (pct !== undefined) {
                    emitProgress(57 + pct * 1, `Clustering SHN 1D (${Math.round(pct * 100)}%)`, {
                        stageId: 'shn',
                        stageLabel: `SHN (${fRestNames.length})`,
                        stagePct: 50 + pct * 10
                    });
                }
                await scheduler(force);
            };

            const { centroids: shCentroids, labels: shLabelsND } = await kmeansND(shData, count, numCoeffs, paletteSize, shnIterations, 1024, wrappedSchedulerND);
            const { centroids: shCodebook, labels: centroidLabels } = await kmeans1D(shCentroids, 256, shnIterations, wrappedScheduler1D);

            const coeffsPerColor = numCoeffs / 3;
            const cWidth = 64 * coeffsPerColor;
            const cHeight = Math.ceil(paletteSize / 64);
            const cCanvas: any = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(cWidth, cHeight)
                : Object.assign(document.createElement('canvas'), { width: cWidth, height: cHeight });
            const cCtx = cCanvas.getContext('2d', { willReadFrequently: true });
            const cImg = cCtx.createImageData(cWidth, cHeight);
            for (let i = 0; i < paletteSize; i++) {
                for (let j = 0; j < coeffsPerColor; j++) {
                    const pixelIdx = Math.floor(i / 64) * cWidth + (i % 64) * coeffsPerColor + j;
                    cImg.data[pixelIdx * 4 + 0] = centroidLabels[i * numCoeffs + coeffsPerColor * 0 + j];
                    cImg.data[pixelIdx * 4 + 1] = centroidLabels[i * numCoeffs + coeffsPerColor * 1 + j];
                    cImg.data[pixelIdx * 4 + 2] = centroidLabels[i * numCoeffs + coeffsPerColor * 2 + j];
                    cImg.data[pixelIdx * 4 + 3] = 255;
                }
                if ((i & 255) === 0) {
                    emitProgress(58 + (i / Math.max(paletteSize, 1)) * 1, `Packing SHN centroids ${i}/${paletteSize}`, {
                        stageId: 'shn',
                        stageLabel: `SHN (${fRestNames.length})`,
                        stagePct: 60 + (i / Math.max(paletteSize, 1)) * 15
                    });
                    await scheduler();
                }
            }
            cCtx.putImageData(cImg, 0, 0);
            zip.file('shN_centroids.webp', await renderTex({ canvas: cCanvas, ctx: cCtx, img: cImg }, 'shN_centroids.webp'));
            await scheduler();

            const labelsTex = createTex();
            for (let i = 0; i < count; i++) {
                labelsTex.data[i * 4 + 0] = shLabelsND[i] & 0xFF;
                labelsTex.data[i * 4 + 1] = (shLabelsND[i] >> 8) & 0xFF;
                labelsTex.data[i * 4 + 3] = 255;
                if ((i & 4095) === 0) {
                    emitProgress(59 + (i / Math.max(count, 1)) * 1, `Packing SHN labels ${i}/${count}`, {
                        stageId: 'shn',
                        stageLabel: `SHN (${fRestNames.length})`,
                        stagePct: 75 + (i / Math.max(count, 1)) * 25
                    });
                    await scheduler();
                }
            }
            await saveTex(labelsTex, 'shN_labels.webp');
            const bandsMap: Record<number, number> = { 9: 1, 24: 2, 45: 3 };
            meta.shN = {
                count: paletteSize,
                bands: bandsMap[numCoeffs] || 0,
                codebook: Array.from(shCodebook),
                files: ['shN_centroids.webp', 'shN_labels.webp']
            };
            emitProgress(60, "SHN encoded", {
                stageId: 'shn',
                stageLabel: `SHN (${fRestNames.length})`,
                stagePct: 100
            });
        }

        emitProgress(60, "Encoding Temporal Banks...", {
            stageId: 'temporal',
            stageLabel: 'Temporal Banks',
            stagePct: 0
        });
        const totalBankFrames =
            ((data.keyframes > 0 && (data.trajectory || data.xyzBank)) ? data.keyframes : 0) +
            ((data.dcKeyframes > 0 && data.dcTrajectory) ? data.dcKeyframes : 0) +
            ((data.rotKeyframes > 0 && (data.rotTrajectory || data.rotBank)) ? data.rotKeyframes : 0);
        let completedBankFrames = 0;
        const reportBankFrame = (stageId: string, stageLabel: string, frameIdx: number, frameCount: number) => {
            completedBankFrames++;
            const pct = totalBankFrames > 0 ? 60 + (completedBankFrames / totalBankFrames) * 24 : 84;
            emitProgress(pct, `${stageLabel} ${frameIdx + 1}/${frameCount} (${completedBankFrames}/${Math.max(totalBankFrames, 1)})`, {
                stageId,
                stageLabel,
                stagePct: ((frameIdx + 1) / Math.max(frameCount, 1)) * 100
            });
        };
        const mapFrames = async <T>(frameCount: number, stageId: string, stageLabel: string, worker: (frameIdx: number) => Promise<T>): Promise<T[]> => {
            const results = new Array<T>(frameCount);
            let nextFrame = 0;
            const runners = Array.from({ length: Math.min(maxParallel, Math.max(frameCount, 1)) }, async () => {
                while (true) {
                    const frameIdx = nextFrame++;
                    if (frameIdx >= frameCount) return;
                    results[frameIdx] = await worker(frameIdx);
                    reportBankFrame(stageId, stageLabel, frameIdx, frameCount);
                }
            });
            await Promise.all(runners);
            return results;
        };
        const packBank16 = async (numFrames: number, stride: number, bankData: Float32Array, prefix: string, useLog: boolean, stageId: string, stageLabel: string) => {
            return await mapFrames(numFrames, stageId, stageLabel, async (k) => {
                let minB = 1e9, maxB = -1e9;
                const transformed = new Float32Array(count * 3);
                for (let i = 0; i < count; i++) {
                    const src = getSourceIndex(i);
                    const base = src * numFrames * 3 + k * 3;
                    const di = i * 3;
                    const vx = useLog ? logTransform(bankData[base]) : bankData[base];
                    const vy = useLog ? logTransform(bankData[base + 1]) : bankData[base + 1];
                    const vz = useLog ? logTransform(bankData[base + 2]) : bankData[base + 2];
                    transformed[di] = vx;
                    transformed[di + 1] = vy;
                    transformed[di + 2] = vz;
                    if (vx < minB) minB = vx; if (vx > maxB) maxB = vx;
                    if (vy < minB) minB = vy; if (vy > maxB) maxB = vy;
                    if (vz < minB) minB = vz; if (vz > maxB) maxB = vz;
                    if ((i & 4095) === 0) {
                        await scheduler();
                    }
                }
                const bL = createTex(), bU = createTex();
                for (let i = 0; i < count; i++) {
                    const si = i * 3;
                    const ix = normalizeU16(transformed[si], minB, maxB);
                    const iy = normalizeU16(transformed[si + 1], minB, maxB);
                    const iz = normalizeU16(transformed[si + 2], minB, maxB);
                    const di = i * 4;
                    bL.data[di] = ix & 0xFF; bU.data[di] = (ix >> 8) & 0xFF;
                    bL.data[di + 1] = iy & 0xFF; bU.data[di + 1] = (iy >> 8) & 0xFF;
                    bL.data[di + 2] = iz & 0xFF; bU.data[di + 2] = (iz >> 8) & 0xFF;
                    bL.data[di + 3] = 255; bU.data[di + 3] = 255;
                    if ((i & 4095) === 0) {
                        await scheduler();
                    }
                }
                const fnL = `${prefix}_${k}_l.webp`;
                const fnU = `${prefix}_${k}_u.webp`;
                return {
                    mins: [minB, minB, minB],
                    maxs: [maxB, maxB, maxB],
                    files: [fnL, fnU],
                    buffers: [
                        { name: fnL, buffer: await renderTex(bL, fnL) },
                        { name: fnU, buffer: await renderTex(bU, fnU) }
                    ]
                };
            });
        };

        if (data.keyframes > 0 && data.trajectory && data.trajectory.length >= count * data.keyframes * 3) {
            emitProgress(60, "Encoding XYZ bank...", {
                stageId: 'xyz_bank',
                stageLabel: 'XYZ Bank',
                stagePct: 0
            });
            const frames = await packBank16(data.keyframes, data.xyzStride, data.trajectory, 'xyz_bank', true, 'xyz_bank', 'XYZ Bank');
            meta.xyz_bank = frames.map(({ mins, maxs, files }) => ({ mins, maxs, files }));
            frames.forEach(({ buffers }) => buffers.forEach(({ name, buffer }) => zip.file(name, buffer)));
            meta.xyz_bank_stride = data.xyzStride;
            meta.custom.xyz_bank_keyframe_stride = data.xyzStride;
            emitProgress(70, "XYZ bank encoded", {
                stageId: 'xyz_bank',
                stageLabel: 'XYZ Bank',
                stagePct: 100
            });
        } else if (data.xyzBank) {
            emitProgress(60, "Encoding XYZ bank...", {
                stageId: 'xyz_bank',
                stageLabel: 'XYZ Bank',
                stagePct: 0
            });
            const frames = await packBank16(data.keyframes || 100, data.xyzStride || 1, data.xyzBank, 'xyz_bank', true, 'xyz_bank', 'XYZ Bank');
            meta.xyz_bank = frames.map(({ mins, maxs, files }) => ({ mins, maxs, files }));
            frames.forEach(({ buffers }) => buffers.forEach(({ name, buffer }) => zip.file(name, buffer)));
            meta.xyz_bank_stride = data.xyzStride || 1;
            meta.custom.xyz_bank_keyframe_stride = data.xyzStride || 1;
            emitProgress(70, "XYZ bank encoded", {
                stageId: 'xyz_bank',
                stageLabel: 'XYZ Bank',
                stagePct: 100
            });
        }

        if (data.dcKeyframes > 0 && data.dcTrajectory) {
            emitProgress(70, "Encoding Color bank...", {
                stageId: 'color_bank',
                stageLabel: 'Color Bank',
                stagePct: 0
            });
            const frames = await packBank16(data.dcKeyframes, data.dcStride, data.dcTrajectory, 'f_dc_bank', true, 'color_bank', 'Color Bank');
            meta.f_dc_bank = frames.map(({ mins, maxs, files }) => ({ mins, maxs, files }));
            frames.forEach(({ buffers }) => buffers.forEach(({ name, buffer }) => zip.file(name, buffer)));
            meta.f_dc_bank_stride = data.dcStride;
            meta.custom.features_dc_bank_keyframe_stride = data.dcStride;
            emitProgress(76, "Color bank encoded", {
                stageId: 'color_bank',
                stageLabel: 'Color Bank',
                stagePct: 100
            });
        } else if (data.dcBank) {
            // Unlikely to have dcBank from trueSplats, but just in case
        }

        if (data.rotKeyframes > 0 && (data.rotTrajectory || data.rotBank)) {
            const numFrames = data.rotKeyframes;
            const bankData = data.rotTrajectory || data.rotBank;
            emitProgress(76, "Encoding Rotation bank...", {
                stageId: 'rotation_bank',
                stageLabel: 'Rotation Bank',
                stagePct: 0
            });
            const arr = await mapFrames(numFrames, 'rotation_bank', 'Rotation Bank', async (k) => {
                const bTex = createTex();
                for (let i = 0; i < count; i++) {
                    const src = getSourceIndex(i);
                    const base = src * numFrames * 4 + k * 4;
                    const bqr = bankData[base], bqi = bankData[base + 1], bqj = bankData[base + 2], bqk = bankData[base + 3];
                    const bqlen = Math.sqrt(bqr*bqr + bqi*bqi + bqj*bqj + bqk*bqk);
                    const q = [bqr/bqlen, bqi/bqlen, bqj/bqlen, bqk/bqlen];
                    
                    let maxIdx = 0, maxVal = -1;
                    for (let j = 0; j < 4; j++) {
                        const absV = Math.abs(q[j]);
                        if (absV > maxVal) { maxVal = absV; maxIdx = j; }
                    }
                    if (q[maxIdx] < 0) { for (let j = 0; j < 4; j++) q[j] = -q[j]; }
                    let writeIdx = 0, di = i * 4;
                    for (let j = 0; j < 4; j++) {
                        if (j === maxIdx) continue;
                        bTex.data[di + writeIdx++] = clampU8(((q[j] * Math.SQRT2) * 0.5 + 0.5) * 255);
                    }
                    bTex.data[di + 3] = 252 + maxIdx;
                    if ((i & 4095) === 0) {
                        await scheduler();
                    }
                }
                const fn = `rot_bank_${k}.webp`;
                return { files: [fn], buffer: await renderTex(bTex, fn), name: fn };
            });
            meta.rot_bank = arr.map(({ files }) => ({ files }));
            arr.forEach(({ name, buffer }) => zip.file(name, buffer));
            meta.rot_bank_stride = data.rotStride;
            meta.custom.rot_bank_keyframe_stride = data.rotStride;
            emitProgress(84, "Rotation bank encoded", {
                stageId: 'rotation_bank',
                stageLabel: 'Rotation Bank',
                stagePct: 100
            });
        }

        if (p.lifetime_mu && p.lifetime_w) {
            emitProgress(85, "Encoding Params...", {
                stageId: 'params.webp',
                stageLabel: 'Params',
                stagePct: 0
            });
            const mu = new Float32Array(count);
            const w = new Float32Array(count);
            const isParam = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                const src = getSourceIndex(i);
                mu[i] = p.lifetime_mu[src];
                w[i] = p.lifetime_w[src];
                isParam[i] = p.is_param?.[src] || 0;
                if ((i & 4095) === 0) {
                    emitProgress(85 + (i / Math.max(count, 1)) * 3, `Collecting Params ${i}/${count}`, {
                        stageId: 'params.webp',
                        stageLabel: 'Params',
                        stagePct: (i / Math.max(count, 1)) * 35
                    });
                    await scheduler();
                }
            }
            const { centroids: muCb, labels: muLabels } = await kmeans1D(mu, 256, iterations, scheduler);
            const { centroids: wCb, labels: wLabels } = await kmeans1D(w, 256, iterations, scheduler);
            const { centroids: pCb, labels: pLabels } = await kmeans1D(isParam, 256, iterations, scheduler);
            const pTex = createTex();
            for (let i = 0; i < count; i++) {
                pTex.data[i * 4] = muLabels[i];
                pTex.data[i * 4 + 1] = wLabels[i];
                pTex.data[i * 4 + 2] = pLabels[i];
                pTex.data[i * 4 + 3] = 255;
                if ((i & 4095) === 0) {
                    emitProgress(88 + (i / Math.max(count, 1)) * 3, `Packing Params ${i}/${count}`, {
                        stageId: 'params.webp',
                        stageLabel: 'Params',
                        stagePct: 65 + (i / Math.max(count, 1)) * 30
                    });
                    await scheduler();
                }
            }
            meta.params = {
                codebook_mu: Array.from(muCb),
                codebook_w: Array.from(wCb),
                codebook_is_param: Array.from(pCb),
                files: ['params.webp']
            };
            await saveTex(pTex, 'params.webp');
            emitProgress(92, "Params encoded", {
                stageId: 'params.webp',
                stageLabel: 'Params',
                stagePct: 100
            });
        }

        // Apply any deletes if requested explicitly
        if (overrides.apply_deleted && overrides.deleted_indices?.length) {
            // Note: because we just built the ZIP from clean Data Arrays, we theoretically shouldn't have 'deleted' 
            // points in the original arrays if we already filtered `data`. BUT normally we filter after load.
            // If the user expects to delete from 'lastParsedData', it is easiest if 'lastParsedData' is ALREADY filtered 
            // by trueSplatsLoader BEFORE passing into encode. In `main.ts`, we'll see if they pre-filter.
            // But since encode acts on data.xyz, etc. we just wrote EVERYTHING.
            // SOG4Loader.save will handle it if we return the ZIP bytes!
            // Wait, we can just return the ZIP, then SOG4Loader.save natively parses and strips the ZIP.
            // It's more CPU work but safely re-uses our robust `compactTexture`!
        }

        emitProgress(98, "Zipping and Finalizing SOG4...", {
            stageId: 'zip',
            stageLabel: 'Package ZIP',
            stagePct: 0
        });
        zip.file('meta.json', JSON.stringify(meta, null, 2));
        const result = await zip.generateAsync(
            { type: 'uint8array', compression: 'STORE' },
            (metadata) => {
                emitProgress(98 + (metadata.percent / 100) * 2, `Zipping and Finalizing SOG4 ${metadata.percent.toFixed(0)}%`, {
                    stageId: 'zip',
                    stageLabel: 'Package ZIP',
                    stagePct: metadata.percent
                });
            }
        );
        emitProgress(100, "Done", {
            stageId: 'zip',
            stageLabel: 'Package ZIP',
            stagePct: 100
        });
        return result;
    }
}
