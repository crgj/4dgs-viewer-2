import JSZip from 'jszip';

// Matches Python log_transform & inverseLogTransform
const logTransform = (v: number) => Math.sign(v) * Math.log(Math.abs(v) + 1);
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));
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
const kmeans1D = (input: ArrayLike<number>, requestedK: number, iterations = 10) => {
    const data = Float32Array.from(input);
    const unique = new Set<number>();
    for (let i = 0; i < data.length; i++) unique.add(data[i]);
    const k = Math.min(requestedK, unique.size);
    if (k === 0) return { centroids: new Float32Array(0), labels: new Uint32Array(0) };

    let centroids = initializeCentroids1D(data, k);
    let labels = new Uint32Array(data.length);

    for (let iter = 0; iter < iterations; iter++) {
        for (let i = 0; i < data.length; i++) {
            let bestIdx = 0;
            let bestDist = Infinity;
            const value = data[i];
            for (let j = 0; j < centroids.length; j++) {
                const dist = Math.abs(value - centroids[j]);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = j;
                }
            }
            labels[i] = bestIdx;
        }

        const sums = new Float64Array(centroids.length);
        const counts = new Uint32Array(centroids.length);
        for (let i = 0; i < data.length; i++) {
            const label = labels[i];
            sums[label] += data[i];
            counts[label]++;
        }
        for (let j = 0; j < centroids.length; j++) {
            if (counts[j] > 0) {
                centroids[j] = sums[j] / counts[j];
            } else {
                centroids[j] = data[Math.floor(Math.random() * data.length)];
            }
        }
    }

    const order = Array.from({ length: centroids.length }, (_, i) => i).sort((a, b) => centroids[a] - centroids[b]);
    const sortedCentroids = new Float32Array(centroids.length);
    for (let i = 0; i < order.length; i++) sortedCentroids[i] = centroids[order[i]];
    centroids = sortedCentroids;

    for (let i = 0; i < data.length; i++) {
        let bestIdx = 0;
        let bestDist = Infinity;
        const value = data[i];
        for (let j = 0; j < centroids.length; j++) {
            const dist = Math.abs(value - centroids[j]);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = j;
            }
        }
        labels[i] = bestIdx;
    }

    return { centroids, labels };
};
const clusterSharedCodebook = (columns: Float32Array[], k: number, iterations = 10) => {
    const rows = columns[0]?.length || 0;
    const flattened = new Float32Array(rows * columns.length);
    for (let c = 0; c < columns.length; c++) flattened.set(columns[c], c * rows);
    const { centroids, labels } = kmeans1D(flattened, k, iterations);
    const labelList = columns.map((_, c) => labels.subarray(c * rows, (c + 1) * rows));
    return { centroids, labelsList: labelList };
};
const kmeansND = (input: Float32Array, n: number, d: number, requestedK: number, iterations = 10, batchSize = 1024) => {
    const k = Math.min(requestedK, n);
    const labels = new Uint32Array(n);
    const chosen = new Set<number>();
    while (chosen.size < k) chosen.add(Math.floor(Math.random() * n));
    let centroids = new Float32Array(k * d);
    Array.from(chosen).forEach((idx, c) => centroids.set(input.subarray(idx * d, idx * d + d), c * d));

    for (let iter = 0; iter < iterations; iter++) {
        const centroidNorms = new Float64Array(k);
        for (let c = 0; c < k; c++) {
            let sum = 0;
            for (let j = 0; j < d; j++) {
                const v = centroids[c * d + j];
                sum += v * v;
            }
            centroidNorms[c] = sum;
        }

        for (let start = 0; start < n; start += batchSize) {
            const end = Math.min(start + batchSize, n);
            for (let i = start; i < end; i++) {
                let bestIdx = 0;
                let bestMetric = Infinity;
                for (let c = 0; c < k; c++) {
                    let dot = 0;
                    for (let j = 0; j < d; j++) dot += input[i * d + j] * centroids[c * d + j];
                    const metric = centroidNorms[c] - 2 * dot;
                    if (metric < bestMetric) {
                        bestMetric = metric;
                        bestIdx = c;
                    }
                }
                labels[i] = bestIdx;
            }
        }

        const sums = new Float64Array(k * d);
        const counts = new Uint32Array(k);
        for (let i = 0; i < n; i++) {
            const label = labels[i];
            counts[label]++;
            for (let j = 0; j < d; j++) sums[label * d + j] += input[i * d + j];
        }
        const next = new Float32Array(centroids.length);
        for (let c = 0; c < k; c++) {
            if (counts[c] > 0) {
                for (let j = 0; j < d; j++) next[c * d + j] = sums[c * d + j] / counts[c];
            } else {
                next.set(centroids.subarray(c * d, c * d + d), c * d);
            }
        }
        centroids = next;
    }

    return { centroids, labels };
};

export class SOG4Encoder {
    static async encode(data: any, overrides: any = {}, progress?: (pct: number, msg: string) => void): Promise<Uint8Array> {
        let count = data.count || data.plyData?.elements[0]?.count || 0;
        if (count === 0) throw new Error("No data to encode.");

        progress?.(0, "Initializing SOG4 Encoder...");

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
            const origIndices = overrides.original_indices as number[] | undefined;
            const deletedSet = new Set<number>();
            for (let i = 0; i < deleted.length; i++) {
                const idx = deleted[i];
                const mapped = origIndices ? Math.round(origIndices[idx]) : idx;
                if (mapped >= 0 && mapped < originalCount) deletedSet.add(mapped);
            }

            if (deletedSet.size > 0) {
                progress?.(2, `Filtering deleted splats (${deletedSet.size}/${originalCount})...`);
                const keepIndices: number[] = [];
                for (let i = 0; i < originalCount; i++) {
                    if (!deletedSet.has(i)) keepIndices.push(i);
                }
                sourceIndices = new Uint32Array(keepIndices);
                count = sourceIndices.length;
            }
        }

        const zip = new JSZip();
        const getSourceIndex = (i: number) => sourceIndices ? sourceIndices[i] : i;
        const meta: any = {
            version: 2,
            asset: { generator: 'master_ply_to_sog_native' },
            count: count,
            model_transform: data.model_transform || overrides.model_transform || { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] },
            cameras: data.cameras || overrides.cameras || [],
            postProcessing: data.postProcessing || overrides.postProcessing || { exposure: 1.0, brightness: 0.0, contrast: 0.0 }
        };
        const fRestNames = Object.keys(p).filter((name) => /^f_rest_\d+$/.test(name)).sort((a, b) => extractTrailingIndex(a) - extractTrailingIndex(b));
        const opacitySemantic = data.opacitySemantic;
        const rawMode = overrides.rawFloatPayload === true;

        if (rawMode) {
            progress?.(5, "Encoding Raw Float Payload...");
            const staticRowFloats = 17 + fRestNames.length;
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

            meta.total_frames = data.frames || 1;
            meta.custom = Object.assign({}, data.custom || overrides.custom || {}, {
                raw_float_payload: {
                    version: 1,
                    total_frames: data.frames || 1,
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
            progress?.(98, "Zipping Raw SOG4...");
            const result = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
            progress?.(100, "Done");
            return result;
        }
        if (data.custom || overrides.custom) {
            meta.custom = Object.assign({}, data.custom || {}, overrides.custom || {});
        }

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
            tex.ctx.putImageData(tex.img, 0, 0);
            let blob;
            const preferredType = chooseImageType(fileName);
            if (typeof tex.canvas.convertToBlob === 'function') {
                blob = await tex.canvas.convertToBlob({ type: preferredType, quality: 1 });
                if ((!blob || blob.size === 0) && preferredType !== 'image/png') {
                    blob = await tex.canvas.convertToBlob({ type: 'image/png' });
                }
            } else {
                blob = await new Promise<Blob>((res, rej) => {
                    const tryType = (type: string, fallback: boolean) => {
                        tex.canvas.toBlob((b: Blob) => {
                            if (!b || b.size === 0) {
                                if (fallback && type !== 'image/png') return tryType('image/png', false);
                                rej();
                                return;
                            }
                            res(b);
                        }, type, 1);
                    };
                    tryType(preferredType, true);
                });
            }
            return await blob.arrayBuffer();
        };
        const saveTex = async (tex: any, name: string) => {
            zip.file(name, await renderTex(tex, name));
        };
        const maxParallel = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
            ? Math.floor(navigator.hardwareConcurrency / 2)
            : 2));

        progress?.(10, "Encoding Means (XYZ)...");
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
        }
        await saveTex(mL, 'means_l.webp'); await saveTex(mU, 'means_u.webp');

        progress?.(30, "Encoding Rotations...");
        meta.quats = { files: ['quats'] };
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
        }
        await saveTex(qTex, 'quats');

        progress?.(45, "Encoding Scales & Opacity...");
        const scale0 = new Float32Array(count), scale1 = new Float32Array(count), scale2 = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            scale0[i] = p.scale_0?.[src] || 0;
            scale1[i] = p.scale_1?.[src] || 0;
            scale2[i] = p.scale_2?.[src] || 0;
        }
        const { centroids: scaleCb, labelsList: scaleLabels } = clusterSharedCodebook([scale0, scale1, scale2], 256, iterations);
        meta.scales = { codebook: Array.from(scaleCb), files: ['scales'] };
        const sTex = createTex();
        for (let i = 0; i < count; i++) {
            sTex.data[i * 4] = scaleLabels[0][i];
            sTex.data[i * 4 + 1] = scaleLabels[1][i];
            sTex.data[i * 4 + 2] = scaleLabels[2][i];
            sTex.data[i * 4 + 3] = 255;
        }
        await saveTex(sTex, 'scales');

        const sh0_0 = new Float32Array(count), sh0_1 = new Float32Array(count), sh0_2 = new Float32Array(count);
        const opacArray = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            sh0_0[i] = p.f_dc_0?.[src] || 0;
            sh0_1[i] = p.f_dc_1?.[src] || 0;
            sh0_2[i] = p.f_dc_2?.[src] || 0;
            opacArray[i] = p.opacity?.[src] ?? 0;
        }
        const { centroids: shCb, labelsList: shLabels } = clusterSharedCodebook([sh0_0, sh0_1, sh0_2], 256, iterations);
        meta.sh0 = { codebook: Array.from(shCb), files: ['sh0'] };
        const sh0Tex = createTex();
        for (let i = 0; i < count; i++) {
            let opac = opacArray[i];
            if (opac > 1.0 || opac < 0.0) opac = sigmoid(opac);
            sh0Tex.data[i * 4] = shLabels[0][i];
            sh0Tex.data[i * 4 + 1] = shLabels[1][i];
            sh0Tex.data[i * 4 + 2] = shLabels[2][i];
            sh0Tex.data[i * 4 + 3] = clampU8(opac * 255);
        }
        await saveTex(sh0Tex, 'sh0');

        if (fRestNames.length > 0) {
            progress?.(52, `Encoding SHN (${fRestNames.length})...`);
            const numCoeffs = fRestNames.length;
            const shData = new Float32Array(count * numCoeffs);
            for (let i = 0; i < count; i++) {
                const src = getSourceIndex(i);
                for (let j = 0; j < numCoeffs; j++) shData[i * numCoeffs + j] = p[fRestNames[j]]?.[src] || 0;
            }

            const paletteScale = Math.pow(2, Math.floor(Math.log2(Math.max(count / 1024, Number.MIN_VALUE))));
            const paletteSize = Math.max(Math.min(64, paletteScale) * 1024, 16);
            const { centroids: shCentroids, labels: shLabelsND } = kmeansND(shData, count, numCoeffs, paletteSize, iterations);
            const { centroids: shCodebook, labels: centroidLabels } = kmeans1D(shCentroids, 256, iterations);

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
            }
            cCtx.putImageData(cImg, 0, 0);
            zip.file('shN_centroids.webp', await renderTex({ canvas: cCanvas, ctx: cCtx, img: cImg }, 'shN_centroids.webp'));

            const labelsTex = createTex();
            for (let i = 0; i < count; i++) {
                labelsTex.data[i * 4 + 0] = shLabelsND[i] & 0xFF;
                labelsTex.data[i * 4 + 1] = (shLabelsND[i] >> 8) & 0xFF;
                labelsTex.data[i * 4 + 3] = 255;
            }
            await saveTex(labelsTex, 'shN_labels.webp');
            const bandsMap: Record<number, number> = { 9: 1, 24: 2, 45: 3 };
            meta.shN = {
                count: paletteSize,
                bands: bandsMap[numCoeffs] || 0,
                codebook: Array.from(shCodebook),
                files: ['shN_centroids.webp', 'shN_labels.webp']
            };
        }

        progress?.(60, "Encoding Temporal Banks...");
        const totalBankFrames =
            ((data.keyframes > 0 && (data.trajectory || data.xyzBank)) ? data.keyframes : 0) +
            ((data.dcKeyframes > 0 && data.dcTrajectory) ? data.dcKeyframes : 0) +
            ((data.rotKeyframes > 0 && (data.rotTrajectory || data.rotBank)) ? data.rotKeyframes : 0);
        let completedBankFrames = 0;
        const reportBankFrame = (label: string, frameIdx: number, frameCount: number) => {
            completedBankFrames++;
            const pct = totalBankFrames > 0 ? 60 + (completedBankFrames / totalBankFrames) * 24 : 84;
            progress?.(pct, `${label} ${frameIdx + 1}/${frameCount} (${completedBankFrames}/${Math.max(totalBankFrames, 1)})`);
        };
        const mapFrames = async <T>(frameCount: number, label: string, worker: (frameIdx: number) => Promise<T>): Promise<T[]> => {
            const results = new Array<T>(frameCount);
            let nextFrame = 0;
            const runners = Array.from({ length: Math.min(maxParallel, Math.max(frameCount, 1)) }, async () => {
                while (true) {
                    const frameIdx = nextFrame++;
                    if (frameIdx >= frameCount) return;
                    results[frameIdx] = await worker(frameIdx);
                    reportBankFrame(label, frameIdx, frameCount);
                }
            });
            await Promise.all(runners);
            return results;
        };
        const packBank16 = async (numFrames: number, stride: number, bankData: Float32Array, prefix: string, useLog: boolean, label: string) => {
            return await mapFrames(numFrames, label, async (k) => {
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
            const frames = await packBank16(data.keyframes, data.xyzStride, data.trajectory, 'xyz_bank', true, 'Encoding XYZ bank');
            meta.xyz_bank = frames.map(({ mins, maxs, files }) => ({ mins, maxs, files }));
            frames.forEach(({ buffers }) => buffers.forEach(({ name, buffer }) => zip.file(name, buffer)));
            meta.xyz_bank_stride = data.xyzStride;
        } else if (data.xyzBank) {
            const frames = await packBank16(data.keyframes || 100, data.xyzStride || 1, data.xyzBank, 'xyz_bank', true, 'Encoding XYZ bank');
            meta.xyz_bank = frames.map(({ mins, maxs, files }) => ({ mins, maxs, files }));
            frames.forEach(({ buffers }) => buffers.forEach(({ name, buffer }) => zip.file(name, buffer)));
            meta.xyz_bank_stride = data.xyzStride || 1;
        }

        if (data.dcKeyframes > 0 && data.dcTrajectory) {
            const frames = await packBank16(data.dcKeyframes, data.dcStride, data.dcTrajectory, 'f_dc_bank', true, 'Encoding Color bank');
            meta.f_dc_bank = frames.map(({ mins, maxs, files }) => ({ mins, maxs, files }));
            frames.forEach(({ buffers }) => buffers.forEach(({ name, buffer }) => zip.file(name, buffer)));
            meta.f_dc_bank_stride = data.dcStride;
        } else if (data.dcBank) {
            // Unlikely to have dcBank from trueSplats, but just in case
        }

        if (data.rotKeyframes > 0 && (data.rotTrajectory || data.rotBank)) {
            const numFrames = data.rotKeyframes;
            const bankData = data.rotTrajectory || data.rotBank;
            const arr = await mapFrames(numFrames, 'Encoding Rotation bank', async (k) => {
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
                }
                const fn = `rot_bank_${k}`;
                return { files: [fn], buffer: await renderTex(bTex, fn), name: fn };
            });
            meta.rot_bank = arr.map(({ files }) => ({ files }));
            arr.forEach(({ name, buffer }) => zip.file(name, buffer));
            meta.rot_bank_stride = data.rotStride;
        }

        if (p.lifetime_mu && p.lifetime_w) {
            progress?.(85, "Encoding Params...");
            const mu = new Float32Array(count);
            const w = new Float32Array(count);
            const isParam = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                const src = getSourceIndex(i);
                mu[i] = p.lifetime_mu[src];
                w[i] = p.lifetime_w[src];
                isParam[i] = p.is_param?.[src] || 0;
            }
            const { centroids: muCb, labels: muLabels } = kmeans1D(mu, 256, iterations);
            const { centroids: wCb, labels: wLabels } = kmeans1D(w, 256, iterations);
            const { centroids: pCb, labels: pLabels } = kmeans1D(isParam, 256, iterations);
            const pTex = createTex();
            for (let i = 0; i < count; i++) {
                pTex.data[i * 4] = muLabels[i];
                pTex.data[i * 4 + 1] = wLabels[i];
                pTex.data[i * 4 + 2] = pLabels[i];
                pTex.data[i * 4 + 3] = 255;
            }
            meta.params = {
                codebook_mu: Array.from(muCb),
                codebook_w: Array.from(wCb),
                codebook_is_param: Array.from(pCb),
                files: ['params.webp']
            };
            await saveTex(pTex, 'params.webp');
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

        progress?.(98, "Zipping and Finalizing SOG4...");
        zip.file('meta.json', JSON.stringify(meta, null, 2));
        const result = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
        progress?.(100, "Done");
        return result;
    }
}
