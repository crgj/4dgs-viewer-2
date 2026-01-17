import JSZip from 'jszip';
import * as pc from 'playcanvas';

// Helper to sigmoid (matches Python/Shader) #WDD 2026-01-16
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));
const logit = (v: number) => {
    const p = Math.max(1e-7, Math.min(1.0 - 1e-7, v));
    return Math.log(p / (1.0 - p));
};

/**
 * Image Decoder Interface #WDD 2026-01-16
 * Allows providing custom image decoding logic (e.g. for Node.js cli).
 */
export interface IImageDecoder {
    decode(blob: Blob | ArrayBuffer): Promise<{ data: Uint8Array, width: number, height: number }>;
}

/**
 * TrueSplatsLoader #WDD 2026-01-16
 * Handles .truesplats (ZIP) files containing static.sog and data.bin.
 */
export class TrueSplatsLoader {
    private app?: pc.Application;
    private decoder?: IImageDecoder;
    private lastResult: any = null;

    constructor(app?: pc.Application, decoder?: IImageDecoder) {
        this.app = app;
        this.decoder = decoder;
    }

    async load(file: File | ArrayBuffer, progressCallback?: (progress: number, message: string) => void
    ): Promise<any> {
        const buffer = file instanceof File ? await file.arrayBuffer() : file;
        const zip = new JSZip();
        await zip.loadAsync(buffer);

        const sogFile = zip.file('static.sog');
        const binFile = zip.file('data.bin');

        if (!sogFile || !binFile) {
            throw new Error("Invalid .truesplats format: missing static.sog or data.bin");
        }

        const sogBuffer = await sogFile.async('arraybuffer');
        const staticResult = await this.parseSOG(sogBuffer, (p: number, msg: string) => {
            if (progressCallback) progressCallback(p * 0.5, msg);
        });

        const binBuffer = await binFile.async('arraybuffer');
        const trajectoryResult = await this.parseBIN(binBuffer, staticResult.count, (p: number, msg: string) => {
            if (progressCallback) progressCallback(50 + p * 0.5, msg);
        });

        this.lastResult = {
            ...staticResult,
            trajectory: trajectoryResult.trajectory,
            keyframes: trajectoryResult.keyframes,
            frames: trajectoryResult.frames,
            rotTrajectory: trajectoryResult.rotTrajectory,
            rotKeyframes: trajectoryResult.rotKeyframes,
            xyzStride: trajectoryResult.xyzStride,
            rotStride: trajectoryResult.rotStride,
            bands: staticResult.bands // #WDD 2026-01-16 Ensure bands is passed through
        };
        return this.lastResult;
    }

    private async parseSOG(buffer: ArrayBuffer, onProgress: (p: number, msg: string) => void) {
        onProgress(0, "Extracting SOG");
        const zip = new JSZip();
        await zip.loadAsync(buffer);

        const metaFile = zip.file('meta.json');
        if (!metaFile) throw new Error("SOG missing meta.json");
        const meta = JSON.parse(await metaFile.async('string'));

        console.log("[TrueSplats] Zip Contents:", Object.keys(zip.files));
        console.log("[TrueSplats] Meta JSON:", meta);

        const count = meta.count;
        onProgress(10, "Decoding Prop Textures");
        const props: any = {};
        const loadTexture = async (fileName: string) => {
            const file = zip.file(fileName);
            if (!file) return null;
            const buffer = await file.async('arraybuffer');

            if (this.decoder) {
                // Use injected decoder #WDD 2026-01-16
                return await this.decoder.decode(buffer);
            }

            // Browser default decoding
            const blob = new Blob([buffer]);
            const bitmap = await createImageBitmap(blob, {
                premultiplyAlpha: 'none',
                colorSpaceConversion: 'none',
                resizeQuality: 'pixelated'
            });
            const { width, height } = bitmap;
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return null;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(bitmap, 0, 0);
            const data = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
            bitmap.close();
            return { data, width, height };
        };

        if (meta.means?.files) {
            props.means_L = await loadTexture(meta.means.files[0]);
            props.means_U = await loadTexture(meta.means.files[1]);
        }
        if (meta.quats?.files) props.rotation = await loadTexture(meta.quats.files[0]);
        if (meta.scales?.files) props.scales = await loadTexture(meta.scales.files[0]);
        if (meta.sh0?.files) props.sh0 = await loadTexture(meta.sh0.files[0]);
        if (meta.shN?.files) {
            props.shN_cent = await loadTexture(meta.shN.files[0]);
            props.shN_labels = await loadTexture(meta.shN.files[1]);
        }
        if (meta.opacity?.files) props.opacity = await loadTexture(meta.opacity.files[0]);
        if (meta.lifetime?.files) props.lifetime = await loadTexture(meta.lifetime.files[0]);
        if (meta.params?.files) props.params = await loadTexture(meta.params.files[0]);

        console.log("[Debug] Loaded Props Keys:", Object.keys(props));
        for (const k of Object.keys(props)) {
            console.log(`[Debug] Property ${k}: ${props[k].width}x${props[k].height}, dataLen=${props[k].data.length}`);
        }

        const inverseLogTransform = (v: number) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
        const inverseSigmoid = (y: number) => {
            y = Math.max(1e-6, Math.min(1 - 1e-6, y));
            return Math.log(y / (1 - y));
        };

        onProgress(80, "Reconstructing Properties");
        const bands = meta.shN?.bands || 0; // #WDD 2026-01-16
        const data: any = {
            x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
            opacity: new Float32Array(count),
            scale_0: new Float32Array(count), scale_1: new Float32Array(count), scale_2: new Float32Array(count),
            rot_0: new Float32Array(count), rot_1: new Float32Array(count), rot_2: new Float32Array(count), rot_3: new Float32Array(count),
            f_dc_0: new Float32Array(count), f_dc_1: new Float32Array(count), f_dc_2: new Float32Array(count),
            lifetime_mu: new Float32Array(count), lifetime_w: new Float32Array(count), lifetime_k: new Float32Array(count),
            vx: new Float32Array(count), vy: new Float32Array(count), vz: new Float32Array(count),
            t_start: new Float32Array(count), duration: new Float32Array(count),
            original_index: new Float32Array(count) // #WDD 2026-01-16: Track reordering
        };
        for (let i = 0; i < 45; i++) data[`f_rest_${i}`] = new Float32Array(count);

        // --- Means ---
        if (props.means_U && props.means_L && meta.means) {
            const mins = meta.means.mins, maxs = meta.means.maxs;
            const dataU = props.means_U.data, dataL = props.means_L.data;
            for (let i = 0; i < count; i++) {
                const nx = (dataU[i * 4 + 0] << 8) | dataL[i * 4 + 0];
                const ny = (dataU[i * 4 + 1] << 8) | dataL[i * 4 + 1];
                const nz = (dataU[i * 4 + 2] << 8) | dataL[i * 4 + 2];
                data.x[i] = inverseLogTransform((nx / 65535.0) * (maxs[0] - mins[0]) + mins[0]);
                data.y[i] = inverseLogTransform((ny / 65535.0) * (maxs[1] - mins[1]) + mins[1]);
                data.z[i] = inverseLogTransform((nz / 65535.0) * (maxs[2] - mins[2]) + mins[2]);
            }
        }

        // --- Rotations ---
        if (props.rotation) {
            const sqrt2 = Math.sqrt(2);
            const texData = props.rotation.data;
            for (let i = 0; i < count; i++) {
                const r = texData[i * 4], g = texData[i * 4 + 1], b = texData[i * 4 + 2], a = texData[i * 4 + 3];
                const k = a - 252;
                const qvals = [r, g, b].map(v => (v / 255.0 * 2.0 - 1.0) / sqrt2);
                const q = [0, 0, 0, 0];
                let qIdx = 0, sumSq = 0;
                for (let j = 0; j < 4; j++) {
                    if (j === k) continue;
                    q[j] = qvals[qIdx++];
                    sumSq += q[j] * q[j];
                }
                q[k] = Math.sqrt(Math.max(0, 1.0 - sumSq));
                data.rot_0[i] = q[0]; data.rot_1[i] = q[1]; data.rot_2[i] = q[2]; data.rot_3[i] = q[3];
            }
        }

        // --- Opacity ---
        if (props.opacity || props.sh0) {
            const texData = (props.opacity || props.sh0).data;
            for (let i = 0; i < count; i++) {
                // #WDD 2026-01-16 Store as Logit (Matches standard PLY)
                data.opacity[i] = logit(texData[i * 4 + 3] / 255.0);
            }
        }

        // --- Scales ---
        if (props.scales && meta.scales && meta.scales.codebook) {
            const cb = meta.scales.codebook;
            const texData = props.scales.data;
            for (let i = 0; i < count; i++) {
                data.scale_0[i] = cb[texData[i * 4 + 0]];
                data.scale_1[i] = cb[texData[i * 4 + 1]];
                data.scale_2[i] = cb[texData[i * 4 + 2]];
            }
            console.log(`[Debug] First 3 Scales: [${data.scale_0[0].toFixed(2)}, ${data.scale_1[0].toFixed(2)}, ${data.scale_2[0].toFixed(2)}]`);
        }

        // --- DC Coefficients ---
        if (props.sh0 && meta.sh0 && meta.sh0.codebook) {
            const cb = meta.sh0.codebook;
            const texData = props.sh0.data;
            for (let i = 0; i < count; i++) {
                data.f_dc_0[i] = cb[texData[i * 4 + 0]];
                data.f_dc_1[i] = cb[texData[i * 4 + 1]];
                data.f_dc_2[i] = cb[texData[i * 4 + 2]];
            }
        }

        // --- SH Bands (f_rest) ---
        if (meta.shN && props.shN_cent && props.shN_labels) {
            const shCfg = meta.shN;
            const cb = shCfg.codebook;
            const paletteSize = shCfg.count;
            const bands = shCfg.bands || 3;
            const numCoeffs = bands === 1 ? 9 : (bands === 2 ? 24 : 45);
            const cpc = numCoeffs / 3;

            const palette = new Float32Array(paletteSize * numCoeffs);
            const centTex = props.shN_cent.data;
            const cWidth = props.shN_cent.width;

            for (let i = 0; i < paletteSize; i++) {
                const row = Math.floor(i / 64);
                const colBase = (i % 64) * cpc;
                for (let j = 0; j < cpc; j++) {
                    const pxIdx = row * cWidth + colBase + j;
                    if (pxIdx * 4 < centTex.length) {
                        palette[i * numCoeffs + cpc * 0 + j] = cb[centTex[pxIdx * 4 + 0]];
                        palette[i * numCoeffs + cpc * 1 + j] = cb[centTex[pxIdx * 4 + 1]];
                        palette[i * numCoeffs + cpc * 2 + j] = cb[centTex[pxIdx * 4 + 2]];
                    }
                }
            }

            const labelsTex = props.shN_labels.data;
            for (let i = 0; i < count; i++) {
                const label = labelsTex[i * 4 + 0] | (labelsTex[i * 4 + 1] << 8);
                const base = label * numCoeffs;
                if (base + numCoeffs <= palette.length) {
                    for (let j = 0; j < numCoeffs; j++) {
                        data[`f_rest_${j}`][i] = palette[base + j];
                    }
                }
            }
        }

        // Initialize defaults for visibility
        data.t_start.fill(0);
        data.duration.fill(9999);

        console.log("[Debug] meta.params:", meta.params);
        console.log("[Debug] props.params valid:", !!props.params);

        // --- Lifetime (mu, w) ---
        // Priority 1: Clustered Params (New Python Script Format)
        if (props.params && meta.params) {
            console.log("[TrueSplats] Params Block Entered (Clustered Lifetime)");
            console.log("[Debug] meta.params keys:", Object.keys(meta.params));
            const pCfg = meta.params;
            const cbMu = pCfg.codebook_mu || pCfg.codebook_mu_list || pCfg.codebook; // Fallback attempts?
            const cbW = pCfg.codebook_w || pCfg.codebook_w_list || pCfg.codebook;

            if (!cbMu || !cbW) {
                console.error("[TrueSplats] Missing codebook_mu or codebook_w in meta.params!", pCfg);
            } else {

                // const cbP = pCfg.codebook_is_param; // Unused for now

                const texData = props.params.data;
                let minMu = Infinity, maxMu = -Infinity;

                const isVQ = Array.isArray(cbMu[0]);
                if (isVQ) console.log("[TrueSplats] Detected Vector Quantized (VQ) Codebook. Len:", cbMu.length);
                else console.log(`[TrueSplats] Detected Scalar Codebooks. MuLen: ${cbMu.length}, WLen: ${cbW.length}`);

                console.log(`[TrueSplats] Sample Indices from params.webp (R,G,B):`, texData[0], texData[1], texData[2]);

                for (let i = 0; i < count; i++) {
                    // R -> mu index (or VQ index), G -> w index (unused if VQ?)
                    const muIdx = texData[i * 4 + 0];
                    const wIdx = texData[i * 4 + 1];

                    let mu = 0, w = 100;

                    if (isVQ) {
                        // Combined Codebook: entries are [mu, w]
                        // We use muIdx as the cluster index
                        const entry = (muIdx < cbMu.length) ? cbMu[muIdx] : cbMu[0];
                        if (Array.isArray(entry) && entry.length >= 2) {
                            mu = entry[0];
                            w = entry[1];
                        } else {
                            mu = entry; // Fallback? weird
                            w = (wIdx < cbW.length) ? cbW[wIdx] : cbW[0];
                        }
                    } else {
                        // Scalar Codebooks (Separable)
                        mu = (muIdx < cbMu.length) ? cbMu[muIdx] : cbMu[0];
                        w = (wIdx < cbW.length) ? cbW[wIdx] : cbW[0];
                    }

                    data.lifetime_mu[i] = mu;
                    data.lifetime_w[i] = w;
                    data.lifetime_k[i] = 10.0;
                    data.t_start[i] = mu - w;
                    data.duration[i] = 2.0 * w;

                    if (mu < minMu) minMu = mu;
                    if (mu > maxMu) maxMu = mu;
                }
                console.log(`[Reconstruct] Clustered Params - mu range: [${minMu.toFixed(2)}, ${maxMu.toFixed(2)}]`);

                // #WDD 2026-01-16 Debug 50 points
                console.log("[Debug] First 50 mu/w:");
                for (let k = 0; k < 50 && k < count; k++) {
                    console.log(`Pt ${k}: (${data.lifetime_mu[k].toFixed(2)}, ${data.lifetime_w[k].toFixed(2)})`);
                }
            }
        }
        // Priority 2: Linear Normalized Lifetime (Old Format / Fallback)
        else if (props.lifetime && meta.lifetime) {
            console.log("[TrueSplats] Lifetime Block Entered (Linear)");
            const texData = props.lifetime.data;
            const minMu = meta.lifetime.mins?.[0] ?? 0;
            const maxMu = meta.lifetime.maxs?.[0] ?? 100;
            const minW = meta.lifetime.mins?.[1] ?? 0;
            const maxW = meta.lifetime.maxs?.[1] ?? 10;
            console.log(`[Reconstruct] mu range: [${minMu}, ${maxMu}], w range: [${minW}, ${maxW}]`);
            for (let i = 0; i < count; i++) {
                const mu = (texData[i * 4 + 0] / 255.0) * (maxMu - minMu) + minMu;
                const w = (texData[i * 4 + 1] / 255.0) * (maxW - minW) + minW;
                data.lifetime_mu[i] = mu;
                data.lifetime_w[i] = w;
                data.lifetime_k[i] = 10.0;
                data.t_start[i] = mu - w;
                data.duration[i] = 2.0 * w;
            }
            console.log(`[Debug] First 3 mu/w: (${data.lifetime_mu[0].toFixed(2)}, ${data.lifetime_w[0].toFixed(2)}), (${data.lifetime_mu[1].toFixed(2)}, ${data.lifetime_w[1].toFixed(2)}), (${data.lifetime_mu[2].toFixed(2)}, ${data.lifetime_w[2].toFixed(2)})`);
        } else {
            console.warn("[TrueSplats] No lifetime data found, using defaults (visible).");
            // Set defaults to ensure visibility
            const midMu = (meta.lifetime?.maxs?.[0] ?? 100) / 2.0;
            const maxW = (meta.lifetime?.maxs?.[1] ?? 100);
            for (let i = 0; i < count; i++) {
                data.lifetime_mu[i] = midMu;
                data.lifetime_w[i] = maxW * 2.0; // Wide enough to cover everything
                data.lifetime_k[i] = 10.0; // Sharp edges (though w is wide so it doesn't matter)
                data.t_start[i] = 0;
                data.duration[i] = 9999;
            }
        }

        for (let i = 0; i < count; i++) {
            data.original_index[i] = i;
        }

        const properties: any[] = [
            { name: 'x', type: 'float', storage: data.x },
            { name: 'y', type: 'float', storage: data.y },
            { name: 'z', type: 'float', storage: data.z },
            { name: 'nx', type: 'float', storage: new Float32Array(count) },
            { name: 'ny', type: 'float', storage: new Float32Array(count) },
            { name: 'nz', type: 'float', storage: new Float32Array(count) },
            { name: 'opacity', type: 'float', storage: data.opacity },
            { name: 'scale_0', type: 'float', storage: data.scale_0 },
            { name: 'scale_1', type: 'float', storage: data.scale_1 },
            { name: 'scale_2', type: 'float', storage: data.scale_2 },
            { name: 'rot_0', type: 'float', storage: data.rot_0 },
            { name: 'rot_1', type: 'float', storage: data.rot_1 },
            { name: 'rot_2', type: 'float', storage: data.rot_2 },
            { name: 'rot_3', type: 'float', storage: data.rot_3 },
            { name: 'f_dc_0', type: 'float', storage: data.f_dc_0 },
            { name: 'f_dc_1', type: 'float', storage: data.f_dc_1 },
            { name: 'f_dc_2', type: 'float', storage: data.f_dc_2 },
            { name: 'lifetime_mu', type: 'float', storage: data.lifetime_mu },
            { name: 'lifetime_w', type: 'float', storage: data.lifetime_w },
            { name: 'lifetime_k', type: 'float', storage: data.lifetime_k },
            { name: 'original_index', type: 'float', storage: data.original_index }, // #WDD 2026-01-16: Track reordering
        ];
        for (let i = 0; i < 45; i++) {
            if (data[`f_rest_${i}`]) {
                properties.push({
                    name: `f_rest_${i}`, type: 'float', storage: data[`f_rest_${i}`]
                });
            }
        }
        return {
            ...data,
            plyData: { elements: [{ name: 'vertex', count, properties }] },
            count,
            is4DGS: true,
            maxMu: meta.lifetime?.maxs?.[0] ?? meta.maxMu ?? meta.maxs?.mu ?? 100, // #WDD 2026-01-16 Unified maxMu lookup
            bands // #WDD 2026-01-16
        };
    }

    private async parseBIN(buffer: ArrayBuffer, count: number, onProgress: (p: number, msg: string) => void) {
        onProgress(0, "Reading Header");
        const dv = new DataView(buffer);
        const magic = dv.getUint32(0, true);
        if (magic !== 0x5A444C54) throw new Error("Invalid BIN magic (expected TLDZ)");

        const N = dv.getUint32(8, true);
        const K_xyz = dv.getUint32(12, true);
        const K_rot = dv.getUint32(16, true);
        const scale = dv.getFloat32(20, true);
        const T_total = dv.getUint32(24, true);
        const xyz_stride = dv.getUint32(28, true);
        const rot_stride = dv.getUint32(32, true);

        console.log(`[TrueSplats] BIN Header: N=${N}, T=${T_total}, K_xyz=${K_xyz}, K_rot=${K_rot}, Scale=${scale}`);

        onProgress(10, "Decompressing Zlib Payload");
        const compressed = new Uint8Array(buffer, 36);
        let decompressed: Uint8Array;

        try {
            const ds = new (globalThis as any).DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(compressed);
            writer.close();
            decompressed = new Uint8Array(await new Response(ds.readable).arrayBuffer());
        } catch (e) {
            try {
                const zlib = (await import('zlib')).default;
                decompressed = new Uint8Array(zlib.inflateSync(compressed));
            } catch (err) {
                console.error("Zlib Fallback Error:", err);
                throw new Error("Decompression failed. No DecompressionStream or zlib found.");
            }
        }

        let off = 0;
        const decodeBank = (K: number, C: number, label: string) => {
            const bank_dv = new DataView(decompressed.buffer, decompressed.byteOffset);
            const data = new Float32Array(N * K * C);
            const MODE_INT8 = 0, MODE_INT16 = 1, MODE_FLOAT = 2;

            for (let i = 0; i < N; i++) {
                const mode = decompressed[off++];
                const base = i * K * C;

                if (mode === MODE_FLOAT) {
                    for (let k = 0; k < K * C; k++) {
                        data[base + k] = bank_dv.getFloat32(off, true);
                        off += 4;
                    }
                } else {
                    const vals: number[] = [];
                    for (let j = 0; j < C; j++) {
                        vals.push(bank_dv.getFloat32(off, true));
                        off += 4;
                    }
                    for (let j = 0; j < C; j++) data[base + j] = vals[j];

                    if (mode === MODE_INT8) {
                        for (let k = 1; k < K; k++) {
                            for (let j = 0; j < C; j++) {
                                vals[j] += bank_dv.getInt8(off++) / scale;
                                data[base + k * C + j] = vals[j];
                            }
                        }
                    } else if (mode === MODE_INT16) {
                        for (let k = 1; k < K; k++) {
                            for (let j = 0; j < C; j++) {
                                vals[j] += bank_dv.getInt16(off, true) / scale;
                                off += 2;
                                data[base + k * C + j] = vals[j];
                            }
                        }
                    }
                }
            }
            return data;
        };

        const xyzData = decodeBank(K_xyz, 3, "XYZ");
        let rotData: Float32Array | null = null;
        if (K_rot > 0) {
            rotData = decodeBank(K_rot, 4, "ROT");
        }

        return {
            frames: T_total,
            trajectory: xyzData, keyframes: K_xyz, xyzStride: xyz_stride,
            rotTrajectory: rotData, rotKeyframes: K_rot, rotStride: rot_stride
        };
    }

    /**
     * Reconstructs frame data as pc.GSplatData compatible elements.
     * Use this for bit-perfect static verification. #WDD 2026-01-16
     */
    public getFrameElements(t: number): any[] {
        if (!this.lastResult) return [];
        const res = this.lastResult;
        const count = res.count;
        const traj = res.trajectory, rotTraj = res.rotTrajectory;

        const props_orig = res.plyData.elements[0].properties;
        const getPropOrig = (name: string) => props_orig.find((p: any) => p.name === name)?.storage;

        const x = getPropOrig('x'), y = getPropOrig('y'), z = getPropOrig('z');
        const r0 = getPropOrig('rot_0'), r1 = getPropOrig('rot_1'), r2 = getPropOrig('rot_2'), r3 = getPropOrig('rot_3');
        const opacity = res.opacity; // LOGIT
        const muArr = res.lifetime_mu, wArr = res.lifetime_w;

        const slerp = (out: number[], q0: number[], q1: number[], alpha: number) => {
            let cos_theta = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
            const q1copy = [q1[0], q1[1], q1[2], q1[3]];
            if (cos_theta < 0) { cos_theta = -cos_theta; for (let j = 0; j < 4; j++) q1copy[j] = -q1copy[j]; }
            if (cos_theta > 0.9995) { for (let j = 0; j < 4; j++) out[j] = q0[j] * (1 - alpha) + q1copy[j] * alpha; }
            else {
                const theta_0 = Math.acos(Math.min(1.0, cos_theta)), sin_theta_0 = Math.sin(theta_0);
                const theta = theta_0 * alpha, sin_theta = Math.sin(theta);
                const s0 = Math.cos(theta) - cos_theta * sin_theta / sin_theta_0, s1 = sin_theta / sin_theta_0;
                for (let j = 0; j < 4; j++) out[j] = s0 * q0[j] + s1 * q1copy[j];
            }
            const norm = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]);
            if (norm > 1e-10) for (let j = 0; j < 4; j++) out[j] /= norm;
        };

        const outX = new Float32Array(count), outY = new Float32Array(count), outZ = new Float32Array(count);
        const outR0 = new Float32Array(count), outR1 = new Float32Array(count), outR2 = new Float32Array(count), outR3 = new Float32Array(count);
        const outOpac = new Float32Array(count);

        for (let i = 0; i < count; i++) {
            // Position
            if (traj && res.keyframes > 0) {
                const K = res.keyframes, stride = res.xyzStride;
                const idx0 = Math.min(Math.floor(t / stride), K - 1), idx1 = Math.min(idx0 + 1, K - 1);
                const u = (t - idx0 * stride) / stride, b0 = (i * K + idx0) * 3, b1 = (i * K + idx1) * 3;
                outX[i] = traj[b0] * (1 - u) + traj[b1] * u;
                outY[i] = traj[b0 + 1] * (1 - u) + traj[b1 + 1] * u;
                outZ[i] = traj[b0 + 2] * (1 - u) + traj[b1 + 2] * u;
            } else { outX[i] = x ? x[i] : 0; outY[i] = y ? y[i] : 0; outZ[i] = z ? z[i] : 0; }

            // Rotation
            if (rotTraj && res.rotKeyframes > 0) {
                const K = res.rotKeyframes, stride = res.rotStride;
                const idx0 = Math.min(Math.floor(t / stride), K - 1), idx1 = Math.min(idx0 + 1, K - 1);
                const u = (t - idx0 * stride) / stride, b0 = (i * K + idx0) * 4, b1 = (i * K + idx1) * 4;
                const qReady = [0, 0, 0, 0];
                slerp(qReady, [rotTraj[b0], rotTraj[b0 + 1], rotTraj[b0 + 2], rotTraj[b0 + 3]], [rotTraj[b1], rotTraj[b1 + 1], rotTraj[b1 + 2], rotTraj[b1 + 3]], u);
                outR0[i] = qReady[0]; outR1[i] = qReady[1]; outR2[i] = qReady[2]; outR3[i] = qReady[3];
            } else {
                outR0[i] = r0 ? r0[i] : 1;
                outR1[i] = r1 ? r1[i] : 0;
                outR2[i] = r2 ? r2[i] : 0;
                outR3[i] = r3 ? r3[i] : 0;
            }

            // Opacity
            const mu = muArr ? muArr[i] : 25, w = wArr ? wArr[i] : 100;
            const gate = sigmoid(10.0 * (t - (mu - w))) * sigmoid(10.0 * ((mu + w) - t));
            // opacity[i] is already LOGIT from SOG
            const finalP = (opacity ? sigmoid(opacity[i]) : 1.0) * gate;
            outOpac[i] = finalP >= 0.01 ? logit(finalP) : -10.0;
        }

        const elements = [JSON.parse(JSON.stringify(res.plyData.elements[0]))];
        const props = elements[0].properties;
        props.find((p: any) => p.name === 'x').storage = outX;
        props.find((p: any) => p.name === 'y').storage = outY;
        props.find((p: any) => p.name === 'z').storage = outZ;
        props.find((p: any) => p.name === 'rot_0').storage = outR0;
        props.find((p: any) => p.name === 'rot_1').storage = outR1;
        props.find((p: any) => p.name === 'rot_2').storage = outR2;
        props.find((p: any) => p.name === 'rot_3').storage = outR3;
        props.find((p: any) => p.name === 'opacity').storage = outOpac;
        return elements;
    }

    public async exportFrame(t: number): Promise<ArrayBuffer> {
        const els = this.getFrameElements(t);
        const vertexElement = els[0];
        const count = vertexElement.count;
        const props = vertexElement.properties;
        const getProp = (name: string) => props.find((p: any) => p.name === name)?.storage;

        const x = getProp('x'), y = getProp('y'), z = getProp('z');
        const r0 = getProp('rot_0'), r1 = getProp('rot_1'), r2 = getProp('rot_2'), r3 = getProp('rot_3');
        const opacity = getProp('opacity');
        const s0 = getProp('scale_0'), s1 = getProp('scale_1'), s2 = getProp('scale_2');
        const f_dc_0 = getProp('f_dc_0'), f_dc_1 = getProp('f_dc_1'), f_dc_2 = getProp('f_dc_2');

        const numRest = 45; // Max SH bands
        const f_rest: any[] = [];
        for (let j = 0; j < numRest; j++) f_rest.push(getProp(`f_rest_${j}`));

        const rowSize = 12 + 12 + 12 + numRest * 4 + 4 + 12 + 16;
        const bodyBuffer = new ArrayBuffer(count * rowSize);
        const view = new DataView(bodyBuffer);

        for (let i = 0; i < count; i++) {
            const off = i * rowSize;
            view.setFloat32(off + 0, x[i], true);
            view.setFloat32(off + 4, y[i], true);
            view.setFloat32(off + 8, z[i], true);
            view.setFloat32(off + 24, f_dc_0[i], true);
            view.setFloat32(off + 28, f_dc_1[i], true);
            view.setFloat32(off + 32, f_dc_2[i], true);
            let subOff = off + 36;
            for (let j = 0; j < numRest; j++) { view.setFloat32(subOff, f_rest[j] ? f_rest[j][i] : 0, true); subOff += 4; }
            view.setFloat32(subOff, opacity[i], true); subOff += 4;
            view.setFloat32(subOff, s0[i], true); view.setFloat32(subOff + 4, s1[i], true); view.setFloat32(subOff + 8, s2[i], true); subOff += 12;
            view.setFloat32(subOff, r0[i], true); view.setFloat32(subOff + 4, r1[i], true); view.setFloat32(subOff + 8, r2[i], true); view.setFloat32(subOff + 12, r3[i], true);
        }

        let header = `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n`;
        for (let j = 0; j < numRest; j++) header += `property float f_rest_${j}\n`;
        header += `property float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n`;
        const headerBuf = new TextEncoder().encode(header);
        const finalBuf = new Uint8Array(headerBuf.byteLength + bodyBuffer.byteLength);
        finalBuf.set(headerBuf, 0);
        finalBuf.set(new Uint8Array(bodyBuffer), headerBuf.byteLength);
        return finalBuf.buffer;
    }
}
