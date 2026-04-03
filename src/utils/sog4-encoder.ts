import JSZip from 'jszip';

// Matches Python log_transform & inverseLogTransform
const logTransform = (v: number) => Math.sign(v) * Math.log(Math.abs(v) + 1);
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));
const extractTrailingIndex = (name: string) => {
    const match = name.match(/_(\d+)$/);
    return match ? parseInt(match[1], 10) : -1;
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
        // #WDD 2026-03-30: Mark scales as log-transformed for backward compatible decoding.
        meta.custom = Object.assign({}, data.custom || overrides.custom || meta.custom || {}, { scales_log: true });

        const width = Math.max(1, Math.min(2048, Math.ceil(Math.sqrt(count))));
        const height = Math.max(1, Math.ceil(count / width));

        const createTex = () => {
            const canvas: any = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(width, height)
                : Object.assign(document.createElement('canvas'), { width, height });
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const img = ctx.createImageData(width, height);
            return { canvas, ctx, img, data: img.data };
        };

        const chooseImageType = (fileName: string) => fileName.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/png';

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
        // 1. MEANS
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
        meta.means = { mins: [minX, minY, minZ], maxs: [maxX, maxY, maxZ], files: ['means_L.webp', 'means_U.webp'] };
        const mL = createTex(), mU = createTex();
        for (let i = 0; i < count; i++) {
            const valX = Math.round(((lx[i] - minX) / (maxX - minX || 1)) * 65535);
            const valY = Math.round(((ly[i] - minY) / (maxY - minY || 1)) * 65535);
            const valZ = Math.round(((lz[i] - minZ) / (maxZ - minZ || 1)) * 65535);
            const di = i * 4;
            mL.data[di] = valX & 0xFF; mU.data[di] = (valX >> 8) & 0xFF;
            mL.data[di + 1] = valY & 0xFF; mU.data[di + 1] = (valY >> 8) & 0xFF;
            mL.data[di + 2] = valZ & 0xFF; mU.data[di + 2] = (valZ >> 8) & 0xFF;
            mL.data[di + 3] = 255; mU.data[di + 3] = 255;
        }
        await saveTex(mL, 'means_L.webp'); await saveTex(mU, 'means_U.webp');

        progress?.(30, "Encoding Rotations...");
        // 2. QUATS
        meta.quats = { files: ['rotation.webp'] };
        const qTex = createTex();
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            const di = i * 4;
            // #WDD 2026-03-30: Normalize quaternion to ensure smallest-three reconstruction is unit length
            const qr = p.rot_0?.[src] || 1, qi = p.rot_1?.[src] || 0, qj = p.rot_2?.[src] || 0, qk = p.rot_3?.[src] || 0;
            const qlen = Math.sqrt(qr*qr + qi*qi + qj*qj + qk*qk);
            const q = [qr/qlen, qi/qlen, qj/qlen, qk/qlen];
            
            let maxIdx = 0, maxVal = -1;
            for (let j = 0; j < 4; j++) {
                const absV = Math.abs(q[j]);
                if (absV > maxVal) { maxVal = absV; maxIdx = j; }
            }
            if (q[maxIdx] < 0) { for (let j = 0; j < 4; j++) q[j] = -q[j]; }
            let writeIdx = 0;
            for (let j = 0; j < 4; j++) {
                if (j === maxIdx) continue;
                qTex.data[di + writeIdx++] = Math.max(0, Math.min(255, Math.round(((q[j] * Math.SQRT2) * 0.5 + 0.5) * 255)));
            }
            qTex.data[di + 3] = 252 + maxIdx;
        }
        await saveTex(qTex, 'rotation.webp');

        progress?.(45, "Encoding Scales & Opacity...");
        // 3. SCALES (Uniform 256 Codebook)
        let minS = 1e9, maxS = -1e9;
        const ls0 = new Float32Array(count), ls1 = new Float32Array(count), ls2 = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            // #WDD 2026-03-30: Apply logTransform to scales to match SOG4Loader expectations for positions/colors
            ls0[i] = logTransform(p.scale_0[src] || 0);
            ls1[i] = logTransform(p.scale_1[src] || 0);
            ls2[i] = logTransform(p.scale_2[src] || 0);
            if (ls0[i] < minS) minS = ls0[i]; if (ls0[i] > maxS) maxS = ls0[i];
            if (ls1[i] < minS) minS = ls1[i]; if (ls1[i] > maxS) maxS = ls1[i];
            if (ls2[i] < minS) minS = ls2[i]; if (ls2[i] > maxS) maxS = ls2[i];
        }
        const scaleCb = new Array(256).fill(0).map((_, i) => minS + (i / 255) * (maxS - minS || 1));
        meta.scales = { codebook: scaleCb, files: ['scales.webp'] };
        const sTex = createTex();
        for (let i = 0; i < count; i++) {
            // Encode using the logged values
            sTex.data[i * 4] = Math.max(0, Math.min(255, Math.round(((ls0[i] - minS) / (maxS - minS || 1)) * 255)));
            sTex.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(((ls1[i] - minS) / (maxS - minS || 1)) * 255)));
            sTex.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(((ls2[i] - minS) / (maxS - minS || 1)) * 255)));
            sTex.data[i * 4 + 3] = 255;
        }
        await saveTex(sTex, 'scales.webp');

        // 4. SH0 & OPACITY (Uniform 256 Codebook for SH0, Linear A channel for Opacity)
        let minSH = 1e9, maxSH = -1e9;
        const opacArray = p.opacity || new Float32Array((sourceIndices ? sourceIndices.length : count)).fill(1.0);
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            if (p.f_dc_0[src] < minSH) minSH = p.f_dc_0[src]; if (p.f_dc_0[src] > maxSH) maxSH = p.f_dc_0[src];
            if (p.f_dc_1[src] < minSH) minSH = p.f_dc_1[src]; if (p.f_dc_1[src] > maxSH) maxSH = p.f_dc_1[src];
            if (p.f_dc_2[src] < minSH) minSH = p.f_dc_2[src]; if (p.f_dc_2[src] > maxSH) maxSH = p.f_dc_2[src];
        }
        const shCb = new Array(256).fill(0).map((_, i) => minSH + (i / 255) * (maxSH - minSH || 1));
        meta.sh0 = { codebook: shCb, files: ['sh0.webp'] };
        const sh0Tex = createTex();
        for (let i = 0; i < count; i++) {
            const src = getSourceIndex(i);
            sh0Tex.data[i * 4] = Math.max(0, Math.min(255, Math.round(((p.f_dc_0[src] - minSH) / (maxSH - minSH || 1)) * 255)));
            sh0Tex.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(((p.f_dc_1[src] - minSH) / (maxSH - minSH || 1)) * 255)));
            sh0Tex.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(((p.f_dc_2[src] - minSH) / (maxSH - minSH || 1)) * 255)));
            let opac = opacArray[src];
            if (opac > 1.0 || opac < 0.0) opac = sigmoid(opac); // Assuming if it's outside 0-1, it's logit
            sh0Tex.data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(opac * 255)));
        }
        await saveTex(sh0Tex, 'sh0.webp');

        progress?.(60, "Encoding Temporal Banks...");
        // 5. BANKS (XYZ, ROT, DC)
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
                    const ix = Math.round(((transformed[si] - minB) / (maxB - minB || 1)) * 65535);
                    const iy = Math.round(((transformed[si + 1] - minB) / (maxB - minB || 1)) * 65535);
                    const iz = Math.round(((transformed[si + 2] - minB) / (maxB - minB || 1)) * 65535);
                    const di = i * 4;
                    bL.data[di] = ix & 0xFF; bU.data[di] = (ix >> 8) & 0xFF;
                    bL.data[di + 1] = iy & 0xFF; bU.data[di + 1] = (iy >> 8) & 0xFF;
                    bL.data[di + 2] = iz & 0xFF; bU.data[di + 2] = (iz >> 8) & 0xFF;
                    bL.data[di + 3] = 255; bU.data[di + 3] = 255;
                }
                const fnL = `${prefix}_${k}_L.webp`;
                const fnU = `${prefix}_${k}_U.webp`;
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
                        bTex.data[di + writeIdx++] = Math.max(0, Math.min(255, Math.round(((q[j] * Math.SQRT2) * 0.5 + 0.5) * 255)));
                    }
                    bTex.data[di + 3] = 252 + maxIdx;
                }
                const fn = `rot_bank_${k}.webp`;
                return { files: [fn], buffer: await renderTex(bTex, fn), name: fn };
            });
            meta.rot_bank = arr.map(({ files }) => ({ files }));
            arr.forEach(({ name, buffer }) => zip.file(name, buffer));
            meta.rot_bank_stride = data.rotStride;
        }

        // Lifetime parameter fallback mappings
        if (p.lifetime_mu && p.lifetime_w) {
            progress?.(85, "Encoding Lifetime Params...");
            let minMu = 1e9, maxMu = -1e9, minW = 1e9, maxW = -1e9;
            for (let i = 0; i < count; i++) {
                const src = getSourceIndex(i);
                if (p.lifetime_mu[src] < minMu) minMu = p.lifetime_mu[src];
                if (p.lifetime_mu[src] > maxMu) maxMu = p.lifetime_mu[src];
                if (p.lifetime_w[src] < minW) minW = p.lifetime_w[src];
                if (p.lifetime_w[src] > maxW) maxW = p.lifetime_w[src];
            }
            const lTex = createTex();
            for (let i = 0; i < count; i++) {
                const src = getSourceIndex(i);
                lTex.data[i * 4] = Math.max(0, Math.min(255, Math.round(((p.lifetime_mu[src] - minMu) / (maxMu - minMu || 1)) * 255)));
                lTex.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(((p.lifetime_w[src] - minW) / (maxW - minW || 1)) * 255)));
                lTex.data[i * 4 + 2] = 0;
                lTex.data[i * 4 + 3] = 255;
            }
            meta.lifetime = { mins: [minMu, minW], maxs: [maxMu, maxW], files: ['lifetime.webp'] };
            await saveTex(lTex, 'lifetime.webp');
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
