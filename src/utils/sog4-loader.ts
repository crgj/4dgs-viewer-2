import JSZip from 'jszip';
import * as pc from 'playcanvas';

// Helper to sigmoid (matches Python/Shader)
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));
const logit = (v: number) => {
    const p = Math.max(1e-7, Math.min(1.0 - 1e-7, v));
    return Math.log(p / (1.0 - p));
};

export interface IImageDecoder {
    decode(blob: Blob | ArrayBuffer): Promise<{ data: Uint8Array, width: number, height: number }>;
}

/**
 * SOG4Loader
 * Handles .sog4 (Native SOG) files where temporal data is embedded as textures.
 */
export class SOG4Loader {
    private app?: pc.Application;
    private decoder?: IImageDecoder;
    private lastResult: any = null;

    constructor(app?: pc.Application, decoder?: IImageDecoder) {
        this.app = app;
        this.decoder = decoder;
    }

    async load(file: File | ArrayBuffer, progressCallback?: (progress: number, message: string) => void): Promise<any> {
        const buffer = file instanceof File ? await file.arrayBuffer() : file;
        const zip = new JSZip();

        progressCallback?.(0, "Parsing SOG4 Zip");
        await zip.loadAsync(buffer);

        const metaFile = zip.file('meta.json');
        if (!metaFile) throw new Error("Invalid .sog4 format: missing meta.json");
        const meta = JSON.parse(await metaFile.async('string'));

        if (meta?.custom?.raw_float_payload) {
            progressCallback?.(5, "Loading Raw Float Payload");
            this.lastResult = await this.loadRawFloatPayload(zip, meta, buffer, progressCallback);
            console.log("[SOG4] Load Complete", this.lastResult);
            return this.lastResult;
        }

        console.log("[SOG4] Meta:", meta);
        const count = meta.count;

        // --- 1. Load Static Textures ---
        progressCallback?.(10, "Decoding Static Textures");
        const props: any = {};

        const loadTexture = async (fileName: string) => {
            const file = zip.file(fileName);
            if (!file) return null;
            const buffer = await file.async('arraybuffer');

            if (this.decoder) {
                return await this.decoder.decode(buffer);
            }

            // Browser default
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

        // --- 2. Decode Static Attributes ---
        progressCallback?.(30, "Reconstructing Static Attributes");

        const inverseLogTransform = (v: number) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);

        const data: any = {
            x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
            rot_0: new Float32Array(count), rot_1: new Float32Array(count), rot_2: new Float32Array(count), rot_3: new Float32Array(count),
            scale_0: new Float32Array(count), scale_1: new Float32Array(count), scale_2: new Float32Array(count),
            opacity: new Float32Array(count),
            f_dc_0: new Float32Array(count), f_dc_1: new Float32Array(count), f_dc_2: new Float32Array(count),
            // Lifetime
            lifetime_mu: new Float32Array(count), lifetime_w: new Float32Array(count), lifetime_k: new Float32Array(count),
            t_start: new Float32Array(count), duration: new Float32Array(count),
            // 4DGS Params
            vx: new Float32Array(count), vy: new Float32Array(count), vz: new Float32Array(count),
            original_index: new Float32Array(count)
        };
        for (let i = 0; i < 45; i++) data[`f_rest_${i}`] = new Float32Array(count);
        for (let i = 0; i < count; i++) data.original_index[i] = i;

        // Reuse Logic from TrueSplatsLoader for Static (Means, Quats, Scales, SH, Opacity, Lifetime)
        // ... (This part is identical to TrueSplatsLoader, logic included inline for completeness)

        // Means
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

        // Rotations
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

        // Opacity
        // #WDD 2026-01-22: Parse Deleted Indices Set for fast lookup
        const deletedSet = new Set(meta.deleted_indices || []);

        if (props.opacity || props.sh0) {
            const texData = (props.opacity || props.sh0).data;
            for (let i = 0; i < count; i++) {
                if (deletedSet.has(i)) {
                    data.opacity[i] = 0; // Force hidden
                } else {
                    data.opacity[i] = texData[i * 4 + 3] / 255.0;
                }
            }
        }

        // Scales
        // #WDD 2026-03-30: Backward compatibility. Older SOG4 used linear scales; newer uses logTransform.
        // If meta.custom.scales_log === true, apply inverseLogTransform. Otherwise keep raw codebook values.
        const scalesAreLog = !!(meta.custom && meta.custom.scales_log === true);
        if (props.scales && meta.scales && meta.scales.codebook) {
            const cb = meta.scales.codebook;
            const texData = props.scales.data;
            for (let i = 0; i < count; i++) {
                const s0 = cb[texData[i * 4 + 0]];
                const s1 = cb[texData[i * 4 + 1]];
                const s2 = cb[texData[i * 4 + 2]];
                data.scale_0[i] = scalesAreLog ? inverseLogTransform(s0) : s0;
                data.scale_1[i] = scalesAreLog ? inverseLogTransform(s1) : s1;
                data.scale_2[i] = scalesAreLog ? inverseLogTransform(s2) : s2;
            }
        }

        // SH0
        if (props.sh0 && meta.sh0 && meta.sh0.codebook) {
            const cb = meta.sh0.codebook;
            const texData = props.sh0.data;
            for (let i = 0; i < count; i++) {
                data.f_dc_0[i] = cb[texData[i * 4 + 0]];
                data.f_dc_1[i] = cb[texData[i * 4 + 1]];
                data.f_dc_2[i] = cb[texData[i * 4 + 2]];

                if (deletedSet.has(i)) {
                    data.opacity[i] = -10.0; // Force hidden (logit space)
                } else if (texData[i * 4 + 3] !== undefined) {
                    const rawVal = texData[i * 4 + 3] / 255.0;
                    const p = Math.max(1e-6, Math.min(0.999999, rawVal));
                    data.opacity[i] = Math.log(p / (1.0 - p));
                }
            }
        }

        // SH Bands
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
                    for (let j = 0; j < numCoeffs; j++) data[`f_rest_${j}`][i] = palette[base + j];
                }
            }
        }

        // Params (Lifetime)
        data.t_start.fill(0);
        data.duration.fill(9999);
        if (props.params && meta.params) {
            const pCfg = meta.params;
            const cbMu = pCfg.codebook_mu || pCfg.codebook_mu_list || pCfg.codebook;
            const cbW = pCfg.codebook_w || pCfg.codebook_w_list || pCfg.codebook;
            const texData = props.params.data;
            if (cbMu && cbW) {
                for (let i = 0; i < count; i++) {
                    const muIdx = texData[i * 4 + 0];
                    const wIdx = texData[i * 4 + 1];
                    const mu = (muIdx < cbMu.length) ? cbMu[muIdx] : cbMu[0];
                    const w = (wIdx < cbW.length) ? cbW[wIdx] : cbW[0];
                    data.lifetime_mu[i] = mu;
                    data.lifetime_w[i] = w;
                    data.lifetime_k[i] = 10.0;
                    data.t_start[i] = mu - w;
                    data.duration[i] = 2.0 * w;
                }
            }
        } else if (props.lifetime && meta.lifetime) {
            const texData = props.lifetime.data;
            const minMu = meta.lifetime.mins?.[0] ?? 0;
            const maxMu = meta.lifetime.maxs?.[0] ?? 100;
            const minW = meta.lifetime.mins?.[1] ?? 0;
            const maxW = meta.lifetime.maxs?.[1] ?? 10;
            for (let i = 0; i < count; i++) {
                const mu = (texData[i * 4 + 0] / 255.0) * (maxMu - minMu) + minMu;
                const w = (texData[i * 4 + 1] / 255.0) * (maxW - minW) + minW;
                data.lifetime_mu[i] = mu;
                data.lifetime_w[i] = w;
                data.lifetime_k[i] = 10.0;
                data.t_start[i] = mu - w;
                data.duration[i] = 2.0 * w;
            }
        } else {
            // Fallback
            const midMu = (meta.lifetime?.maxs?.[0] ?? 100) / 2.0;
            const maxW = (meta.lifetime?.maxs?.[1] ?? 100);
            for (let i = 0; i < count; i++) {
                data.lifetime_mu[i] = midMu;
                data.lifetime_w[i] = maxW * 2.0;
                data.lifetime_k[i] = 10.0;
                data.duration[i] = 20000;
            }
        }

        // --- 3. Process Temporal Banks ---
        progressCallback?.(60, "Decoding Temporal Banks");

        // XYZ Banks
        let xyzData: Float32Array | null = null;
        let K_xyz = 0;
        let xyzStride = 0;

        if (meta.xyz_bank && Array.isArray(meta.xyz_bank)) {
            K_xyz = meta.xyz_bank.length;
            // Assuming strict bank order 0..K-1.
            // Result needs to be (N * K * 3).
            // Interleaved: Point 0 [Frames 0..K-1], Point 1 [Frames 0..K-1]...
            // Shader Layout: Each frame is an array.
            // Wait, TrueSplats `decodeBank` result is:
            // "base = i * K * C" -> data[base + k]
            // So it IS Interleaved! P0_K0, P0_K1,... P1_K0...

            xyzData = new Float32Array(count * K_xyz * 3);
            // #WDD 2026-01-18 Parse stride from custom metadata
            if (meta.custom && meta.custom.xyz_bank_keyframe_stride) {
                xyzStride = parseInt(meta.custom.xyz_bank_keyframe_stride);
            } else {
                xyzStride = meta.xyz_bank_stride || 1;
            }

            for (let k = 0; k < K_xyz; k++) {
                const bankMeta = meta.xyz_bank[k];
                if (!bankMeta) continue;

                // Decode this bank frame for ALL points
                // Reusing means decode logic
                let bankL_tex, bankU_tex;

                if (bankMeta.files) {
                    bankL_tex = await loadTexture(bankMeta.files[0]);
                    bankU_tex = await loadTexture(bankMeta.files[1]);
                }

                if (bankL_tex && bankU_tex) {
                    const mins = bankMeta.mins, maxs = bankMeta.maxs;
                    const bL = bankL_tex.data, bU = bankU_tex.data;

                    for (let i = 0; i < count; i++) {
                        const nx = (bU[i * 4 + 0] << 8) | bL[i * 4 + 0];
                        const ny = (bU[i * 4 + 1] << 8) | bL[i * 4 + 1];
                        const nz = (bU[i * 4 + 2] << 8) | bL[i * 4 + 2];

                        const x = inverseLogTransform((nx / 65535.0) * (maxs[0] - mins[0]) + mins[0]);
                        const y = inverseLogTransform((ny / 65535.0) * (maxs[1] - mins[1]) + mins[1]);
                        const z = inverseLogTransform((nz / 65535.0) * (maxs[2] - mins[2]) + mins[2]);

                        // Write to monolithic array
                        // Striding: i * (K * 3) + k * 3 + component
                        const base = i * K_xyz * 3 + k * 3;
                        xyzData[base + 0] = x;
                        xyzData[base + 1] = y;
                        xyzData[base + 2] = z;
                    }
                }
                progressCallback?.(60 + (k / K_xyz) * 20, `Decoding XYZ Bank ${k}`);
            }
        }

        // ROT Banks
        let rotData: Float32Array | null = null;
        let K_rot = 0;
        let rotStride = 0;

        if (meta.rot_bank && Array.isArray(meta.rot_bank)) {
            K_rot = meta.rot_bank.length;
            rotData = new Float32Array(count * K_rot * 4);
            // #WDD 2026-01-18 Parse stride from custom metadata
            if (meta.custom && meta.custom.rot_bank_keyframe_stride) {
                rotStride = parseInt(meta.custom.rot_bank_keyframe_stride);
            } else {
                rotStride = meta.rot_bank_stride || xyzStride || 1;
            }

            for (let k = 0; k < K_rot; k++) {
                const bankMeta = meta.rot_bank[k];
                if (!bankMeta) continue;

                let bankTex;
                if (bankMeta.files) bankTex = await loadTexture(bankMeta.files[0]);

                if (bankTex) {
                    const sqrt2 = Math.sqrt(2);
                    const texData = bankTex.data;

                    for (let i = 0; i < count; i++) {
                        // Reuse Quats logic
                        const r = texData[i * 4], g = texData[i * 4 + 1], b = texData[i * 4 + 2], a = texData[i * 4 + 3];
                        const key = a - 252;
                        const qvals = [r, g, b].map(v => (v / 255.0 * 2.0 - 1.0) / sqrt2);
                        const q = [0, 0, 0, 0];
                        let qIdx = 0, sumSq = 0;
                        for (let j = 0; j < 4; j++) {
                            if (j === key) continue;
                            q[j] = qvals[qIdx++];
                            sumSq += q[j] * q[j];
                        }
                        q[key] = Math.sqrt(Math.max(0, 1.0 - sumSq));

                        const base = i * K_rot * 4 + k * 4;
                        rotData[base + 0] = q[0];
                        rotData[base + 1] = q[1];
                        rotData[base + 2] = q[2];
                        rotData[base + 3] = q[3];
                    }
                }
            }
        }

        // F_DC Banks (Color)
        let dcData: Float32Array | null = null;
        let K_dc = 0;
        let dcStride = 0;

        if (meta.f_dc_bank && Array.isArray(meta.f_dc_bank)) {
            K_dc = meta.f_dc_bank.length;
            dcData = new Float32Array(count * K_dc * 3);

            // Parse stride from custom metadata or fallback
            if (meta.custom && meta.custom.features_dc_bank_keyframe_stride) {
                dcStride = parseInt(meta.custom.features_dc_bank_keyframe_stride);
            } else {
                dcStride = meta.f_dc_bank_stride || xyzStride || 1;
            }

            for (let k = 0; k < K_dc; k++) {
                const bankMeta = meta.f_dc_bank[k];
                if (!bankMeta) continue;

                let bankL_tex, bankU_tex;
                if (bankMeta.files) {
                    bankL_tex = await loadTexture(bankMeta.files[0]);
                    bankU_tex = await loadTexture(bankMeta.files[1]);
                }

                if (bankL_tex && bankU_tex) {
                    const mins = bankMeta.mins, maxs = bankMeta.maxs;
                    const bL = bankL_tex.data, bU = bankU_tex.data;

                    for (let i = 0; i < count; i++) {
                        const nx = (bU[i * 4 + 0] << 8) | bL[i * 4 + 0];
                        const ny = (bU[i * 4 + 1] << 8) | bL[i * 4 + 1];
                        const nz = (bU[i * 4 + 2] << 8) | bL[i * 4 + 2];

                        // f_dc values are stored as "means" (Log Transformed)
                        const r = inverseLogTransform((nx / 65535.0) * (maxs[0] - mins[0]) + mins[0]);
                        const g = inverseLogTransform((ny / 65535.0) * (maxs[1] - mins[1]) + mins[1]);
                        const b = inverseLogTransform((nz / 65535.0) * (maxs[2] - mins[2]) + mins[2]);

                        const base = i * K_dc * 3 + k * 3;
                        dcData[base + 0] = r;
                        dcData[base + 1] = g;
                        dcData[base + 2] = b;
                    }
                }
                progressCallback?.(80 + (k / K_dc) * 10, `Decoding Color Bank ${k}`);
            }
        }

        // --- 4. Final Data Assembly ---
        const plyProperties: any[] = [
            { name: 'x', type: 'float', storage: data.x },
            { name: 'y', type: 'float', storage: data.y },
            { name: 'z', type: 'float', storage: data.z },
            { name: 'rot_0', type: 'float', storage: data.rot_0 },
            { name: 'rot_1', type: 'float', storage: data.rot_1 },
            { name: 'rot_2', type: 'float', storage: data.rot_2 },
            { name: 'rot_3', type: 'float', storage: data.rot_3 },
            { name: 'scale_0', type: 'float', storage: data.scale_0 },
            { name: 'scale_1', type: 'float', storage: data.scale_1 },
            { name: 'scale_2', type: 'float', storage: data.scale_2 },
            { name: 'opacity', type: 'float', storage: data.opacity },
            { name: 'f_dc_0', type: 'float', storage: data.f_dc_0 },
            { name: 'f_dc_1', type: 'float', storage: data.f_dc_1 },
            { name: 'f_dc_2', type: 'float', storage: data.f_dc_2 },
            { name: 'original_index', type: 'float', storage: data.original_index },
            // Lifetime
            { name: 'lifetime_mu', type: 'float', storage: data.lifetime_mu },
            { name: 'lifetime_w', type: 'float', storage: data.lifetime_w },
            { name: 't_start', type: 'float', storage: data.t_start },
            { name: 'duration', type: 'float', storage: data.duration },
        ];

        for (let i = 0; i < 45; i++) {
            if (data[`f_rest_${i}`]) {
                plyProperties.push({ name: `f_rest_${i}`, type: 'float', storage: data[`f_rest_${i}`] });
            }
        }

        const plyData = {
            elements: [{
                name: 'vertex',
                count: count,
                properties: plyProperties
            }]
        };

        const calcFrames = (k: number, stride: number) => {
            const s = Number.isFinite(stride) && stride > 0 ? stride : 1;
            return k > 1 ? (k - 1) * s + 1 : 1;
        };
        const computedFrames = Math.max(
            calcFrames(K_xyz, xyzStride),
            calcFrames(K_rot, rotStride),
            calcFrames(K_dc, dcStride)
        );

        this.lastResult = {
            count: count,
            plyData: plyData,
            // 4D / Temporal
            // #WDD 2026-01-18 Parse total_frames from custom metadata
            frames: (meta.custom && meta.custom.total_frames) ? parseInt(meta.custom.total_frames) :
                (meta.total_frames || computedFrames),
            // Usually it's implied or in meta. Let's look for 'frames' or 'timeline' in meta? 
            // If not present, we assume K_xyz * xyzStride? 
            // Actually TrueSplats bin had T_total. meta.json might have it?
            // Fallback:
            trajectory: xyzData,
            rotTrajectory: rotData,
            dcTrajectory: dcData,
            keyframes: K_xyz,
            rotKeyframes: K_rot,
            dcKeyframes: K_dc,
            xyzStride: xyzStride,
            rotStride: rotStride,
            dcStride: dcStride,

            bands: meta.shN?.bands || 0,
            model_transform: meta.model_transform,
            cameras: meta.cameras,
            postProcessing: meta.postProcessing || { exposure: 1.0, brightness: 0.0, contrast: 0.0 }, // #WDD 2026-01-30

            // Buffers for saving
            sogBuffer: buffer, // The single zip is the source
            isSOG4: true
        };

        console.log("[SOG4] Load Complete", this.lastResult);
        return this.lastResult;
    }

    private async loadRawFloatPayload(zip: JSZip, meta: any, sourceBuffer: ArrayBuffer, progressCallback?: (progress: number, message: string) => void) {
        const payload = meta.custom.raw_float_payload;
        const metaCount = meta.count;
        const staticInfo = payload.static;
        const staticFile = zip.file(staticInfo.file);
        if (!staticFile) throw new Error(`Invalid raw SOG4 format: missing ${staticInfo.file}`);

        const staticBuffer = await staticFile.async('arraybuffer');
        const staticData = new Float32Array(staticBuffer);
        const fRestCount = staticInfo.f_rest_count || 0;
        const canonicalRowFloats = staticInfo.row_floats || (17 + fRestCount);

        let recovered = false;
        const recoveryWarnings: string[] = [];
        let staticCount = metaCount;
        let inputRowFloats = canonicalRowFloats;
        const staticExpected = metaCount * canonicalRowFloats;
        if (staticData.length !== staticExpected) {
            let resolved = false;

            if (metaCount > 0 && staticData.length % metaCount === 0) {
                const inferredRowFloats = staticData.length / metaCount;
                if (inferredRowFloats >= canonicalRowFloats && inferredRowFloats <= canonicalRowFloats + 8) {
                    inputRowFloats = inferredRowFloats;
                    recovered = true;
                    recoveryWarnings.push(
                        `Recovered raw static payload using legacy row width ${inferredRowFloats} instead of ${canonicalRowFloats}.`
                    );
                    resolved = true;
                }
            }

            if (!resolved && canonicalRowFloats > 0 && staticData.length % canonicalRowFloats === 0) {
                staticCount = staticData.length / canonicalRowFloats;
                inputRowFloats = canonicalRowFloats;
                recovered = true;
                recoveryWarnings.push(
                    `Recovered raw static payload using actual row count ${staticCount} instead of meta.count ${metaCount}.`
                );
                resolved = true;
            }

            if (!resolved) {
                for (let extra = 0; extra <= 8 && !resolved; extra++) {
                    const candidateRowFloats = canonicalRowFloats + extra;
                    if (candidateRowFloats <= 0 || staticData.length % candidateRowFloats !== 0) continue;
                    const inferredCount = staticData.length / candidateRowFloats;
                    if (!Number.isFinite(inferredCount) || inferredCount <= 0) continue;
                    staticCount = inferredCount;
                    inputRowFloats = candidateRowFloats;
                    recovered = true;
                    recoveryWarnings.push(
                        `Recovered raw static payload using inferred count ${inferredCount} and row width ${candidateRowFloats}.`
                    );
                    resolved = true;
                }
            }

            if (!resolved) {
                throw new Error(`Invalid raw static payload length: got ${staticData.length}, expected ${staticExpected}`);
            }
        }

        progressCallback?.(20, "Decoding Raw Static Data");
        const data: any = {
            x: new Float32Array(staticCount), y: new Float32Array(staticCount), z: new Float32Array(staticCount),
            rot_0: new Float32Array(staticCount), rot_1: new Float32Array(staticCount), rot_2: new Float32Array(staticCount), rot_3: new Float32Array(staticCount),
            scale_0: new Float32Array(staticCount), scale_1: new Float32Array(staticCount), scale_2: new Float32Array(staticCount),
            opacity: new Float32Array(staticCount),
            f_dc_0: new Float32Array(staticCount), f_dc_1: new Float32Array(staticCount), f_dc_2: new Float32Array(staticCount),
            lifetime_mu: new Float32Array(staticCount), lifetime_w: new Float32Array(staticCount), lifetime_k: new Float32Array(staticCount),
            t_start: new Float32Array(staticCount), duration: new Float32Array(staticCount),
            original_index: new Float32Array(staticCount)
        };
        for (let i = 0; i < fRestCount; i++) data[`f_rest_${i}`] = new Float32Array(staticCount);

        for (let i = 0; i < staticCount; i++) {
            let off = i * inputRowFloats;
            data.x[i] = staticData[off++];
            data.y[i] = staticData[off++];
            data.z[i] = staticData[off++];
            data.rot_0[i] = staticData[off++];
            data.rot_1[i] = staticData[off++];
            data.rot_2[i] = staticData[off++];
            data.rot_3[i] = staticData[off++];
            data.scale_0[i] = staticData[off++];
            data.scale_1[i] = staticData[off++];
            data.scale_2[i] = staticData[off++];
            data.opacity[i] = staticData[off++];
            data.f_dc_0[i] = staticData[off++];
            data.f_dc_1[i] = staticData[off++];
            data.f_dc_2[i] = staticData[off++];
            data.lifetime_mu[i] = staticData[off++];
            data.lifetime_w[i] = staticData[off++];
            data.lifetime_k[i] = staticData[off++];
            data.t_start[i] = data.lifetime_mu[i] - data.lifetime_w[i];
            data.duration[i] = 2.0 * data.lifetime_w[i];
            for (let j = 0; j < fRestCount; j++) data[`f_rest_${j}`][i] = staticData[off++];
            if (inputRowFloats - canonicalRowFloats >= 1) {
                data.original_index[i] = staticData[off];
            } else {
                data.original_index[i] = i;
            }
        }

        const loadFloatArray = async (entry: any, components: number) => {
            if (!entry?.file || !entry?.keyframes) return null;
            const file = zip.file(entry.file);
            if (!file) throw new Error(`Invalid raw SOG4 format: missing ${entry.file}`);
            const buffer = await file.async('arraybuffer');
            const arr = new Float32Array(buffer);
            const stride = entry.keyframes * components;
            if (!Number.isFinite(stride) || stride <= 0) return null;
            if (arr.length % stride !== 0) {
                throw new Error(`Invalid raw payload length for ${entry.file}: got ${arr.length}, expected a multiple of ${stride}`);
            }
            const inferredCount = arr.length / stride;
            if (inferredCount !== staticCount) {
                recovered = true;
                recoveryWarnings.push(
                    `Recovered raw bank ${entry.file} with count ${inferredCount}; static payload count is ${staticCount}.`
                );
            }
            return { arr, inferredCount };
        };

        progressCallback?.(55, "Decoding Raw Temporal Data");
        const xyzBankLoaded = await loadFloatArray(payload.xyz_bank, 3);
        const rotBankLoaded = await loadFloatArray(payload.rot_bank, 4);
        const dcBankLoaded = await loadFloatArray(payload.dc_bank, 3);

        const counts = [staticCount];
        if (xyzBankLoaded) counts.push(xyzBankLoaded.inferredCount);
        if (rotBankLoaded) counts.push(rotBankLoaded.inferredCount);
        if (dcBankLoaded) counts.push(dcBankLoaded.inferredCount);
        const count = Math.min(...counts);
        if (count <= 0 || !Number.isFinite(count)) {
            throw new Error('Failed to recover any valid raw payload rows.');
        }
        if (count !== staticCount) {
            recovered = true;
            recoveryWarnings.push(`Using common recovered count ${count} across raw payload segments.`);
        }

        const trimArray = (arr: Float32Array | null | undefined, rowWidth: number) => {
            if (!arr) return null;
            return arr.length === count * rowWidth ? arr : arr.subarray(0, count * rowWidth);
        };
        const xyzData = trimArray(xyzBankLoaded?.arr || null, (payload.xyz_bank?.keyframes || 0) * 3);
        const rotData = trimArray(rotBankLoaded?.arr || null, (payload.rot_bank?.keyframes || 0) * 4);
        const dcData = trimArray(dcBankLoaded?.arr || null, (payload.dc_bank?.keyframes || 0) * 3);

        const crop = (arr: Float32Array) => arr.length === count ? arr : arr.subarray(0, count);
        data.x = crop(data.x); data.y = crop(data.y); data.z = crop(data.z);
        data.rot_0 = crop(data.rot_0); data.rot_1 = crop(data.rot_1); data.rot_2 = crop(data.rot_2); data.rot_3 = crop(data.rot_3);
        data.scale_0 = crop(data.scale_0); data.scale_1 = crop(data.scale_1); data.scale_2 = crop(data.scale_2);
        data.opacity = crop(data.opacity);
        data.f_dc_0 = crop(data.f_dc_0); data.f_dc_1 = crop(data.f_dc_1); data.f_dc_2 = crop(data.f_dc_2);
        data.lifetime_mu = crop(data.lifetime_mu); data.lifetime_w = crop(data.lifetime_w); data.lifetime_k = crop(data.lifetime_k);
        data.t_start = crop(data.t_start); data.duration = crop(data.duration); data.original_index = crop(data.original_index);
        for (let i = 0; i < fRestCount; i++) data[`f_rest_${i}`] = crop(data[`f_rest_${i}`]);

        if (recovered) {
            console.warn('[SOG4] Raw payload recovered with compatibility fallback.', {
                metaCount,
                staticCount,
                finalCount: count,
                canonicalRowFloats,
                inputRowFloats,
                warnings: recoveryWarnings
            });
        }

        const plyProperties: any[] = [
            { name: 'x', type: 'float', storage: data.x },
            { name: 'y', type: 'float', storage: data.y },
            { name: 'z', type: 'float', storage: data.z },
            { name: 'rot_0', type: 'float', storage: data.rot_0 },
            { name: 'rot_1', type: 'float', storage: data.rot_1 },
            { name: 'rot_2', type: 'float', storage: data.rot_2 },
            { name: 'rot_3', type: 'float', storage: data.rot_3 },
            { name: 'scale_0', type: 'float', storage: data.scale_0 },
            { name: 'scale_1', type: 'float', storage: data.scale_1 },
            { name: 'scale_2', type: 'float', storage: data.scale_2 },
            { name: 'opacity', type: 'float', storage: data.opacity },
            { name: 'f_dc_0', type: 'float', storage: data.f_dc_0 },
            { name: 'f_dc_1', type: 'float', storage: data.f_dc_1 },
            { name: 'f_dc_2', type: 'float', storage: data.f_dc_2 },
            { name: 'original_index', type: 'float', storage: data.original_index },
            { name: 'lifetime_mu', type: 'float', storage: data.lifetime_mu },
            { name: 'lifetime_w', type: 'float', storage: data.lifetime_w },
            { name: 'lifetime_k', type: 'float', storage: data.lifetime_k },
            { name: 't_start', type: 'float', storage: data.t_start },
            { name: 'duration', type: 'float', storage: data.duration },
        ];
        for (let i = 0; i < fRestCount; i++) {
            plyProperties.push({ name: `f_rest_${i}`, type: 'float', storage: data[`f_rest_${i}`] });
        }

        progressCallback?.(95, "Assembling Raw SOG4 Result");
        return {
            count,
            plyData: {
                elements: [{
                    name: 'vertex',
                    count,
                    properties: plyProperties
                }]
            },
            frames: payload.total_frames || meta.total_frames || 1,
            trajectory: xyzData,
            rotTrajectory: rotData,
            dcTrajectory: dcData,
            keyframes: payload.xyz_bank?.keyframes || 0,
            rotKeyframes: payload.rot_bank?.keyframes || 0,
            dcKeyframes: payload.dc_bank?.keyframes || 0,
            xyzStride: payload.xyz_bank?.stride || 1,
            rotStride: payload.rot_bank?.stride || 1,
            dcStride: payload.dc_bank?.stride || 1,
            bands: fRestCount >= 45 ? 3 : (fRestCount >= 24 ? 2 : (fRestCount >= 9 ? 1 : 0)),
            model_transform: meta.model_transform,
            cameras: meta.cameras,
            postProcessing: meta.postProcessing || { exposure: 1.0, brightness: 0.0, contrast: 0.0 },
            opacitySemantic: 'logit',
            rotationSemantic: 'wxyz',
            sogBuffer: sourceBuffer,
            isSOG4: true,
            needsSOG4Rewrite: recovered,
            loadWarnings: recoveryWarnings
        };
    }

    static async save(
        data: any,
        overrides: any = {},
        progress?: (pct: number, message: string) => void
    ): Promise<Uint8Array> {
        if (!data.sogBuffer) throw new Error("Missing source SOG buffer for saving");

        const zip = new JSZip();
        await zip.loadAsync(data.sogBuffer);

        const metaFile = zip.file('meta.json');
        if (!metaFile) throw new Error("Invalid source SOG: missing meta.json");

        const meta = JSON.parse(await metaFile.async('string'));

        const decodeRgbaTexture = async (buffer: ArrayBuffer) => {
            const blob = new Blob([buffer]);
            const bitmap = await createImageBitmap(blob, {
                premultiplyAlpha: 'none',
                colorSpaceConversion: 'none',
                resizeQuality: 'pixelated'
            });
            const { width, height } = bitmap;
            const canvas: any = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(width, height)
                : Object.assign(document.createElement('canvas'), { width, height });
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error("Failed to get 2D context for texture decode");
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, width, height);
            bitmap.close();
            return { canvas, ctx, imageData, width, height };
        };

        const encodeCanvasToImage = async (canvas: any, fileName: string): Promise<ArrayBuffer> => {
            // #WDD 2026-03-26 Fix SOG4 save corruption: force lossless PNG even for .webp files
            const preferredType = 'image/png';
            if (typeof canvas.convertToBlob === 'function') {
                let blob = await canvas.convertToBlob({ type: preferredType });
                if (!blob || blob.size === 0) {
                    blob = await canvas.convertToBlob({ type: 'image/png' });
                }
                return await blob.arrayBuffer();
            }
            return await new Promise<ArrayBuffer>((resolve, reject) => {
                const tryType = (type: string, fallback: boolean) => {
                    canvas.toBlob(async (blob: Blob | null) => {
                        if (!blob || blob.size === 0) {
                            if (fallback) return tryType('image/png', false);
                            reject(new Error("Failed to encode texture"));
                            return;
                        }
                        resolve(await blob.arrayBuffer());
                    }, type);
                };
                tryType(preferredType, true);
            });
        };

        const report = (pct: number, message: string) => {
            if (progress) progress(Math.max(0, Math.min(100, pct)), message);
        };

        report(0, "Preparing export");

        // Apply overrides
        if (overrides.model_transform) meta.model_transform = overrides.model_transform;
        if (overrides.cameras) meta.cameras = overrides.cameras;
        // SOG4 doesn't support 'deleted_indices' in parsing yet, but we can store it
        if (overrides.deleted_indices && !overrides.apply_deleted) meta.deleted_indices = overrides.deleted_indices;

        if (overrides.apply_deleted && overrides.deleted_indices?.length) {
            const originalCount = meta.count as number;
            const deleted = new Set<number>();
            const mappedDeleted: number[] = [];
            const origIndices = overrides.original_indices as number[] | undefined;
            for (let i = 0; i < overrides.deleted_indices.length; i++) {
                const idx = overrides.deleted_indices[i];
                const mapped = origIndices ? Math.round(origIndices[idx]) : idx;
                if (mapped >= 0 && mapped < originalCount) {
                    deleted.add(mapped);
                    mappedDeleted.push(mapped);
                }
            }

            if (deleted.size === 0) {
                report(5, "No valid deleted splats after mapping; skipping compaction.");
                // Keep mapped deleted indices in meta so loader can hide them if desired
                meta.deleted_indices = mappedDeleted;
            } else {
                // Build keep list once for faster compaction per texture / payload
                const keepIndices: number[] = [];
                keepIndices.length = 0;
                for (let i = 0; i < originalCount; i++) {
                    if (!deleted.has(i)) keepIndices.push(i);
                }
                const keepCount = keepIndices.length;

                report(2, `Deleting ${deleted.size} / ${originalCount} splats...`);

                const rawPayload = meta?.custom?.raw_float_payload;
                if (rawPayload?.static?.file) {
                    const compactFloatFile = async (fileName: string, rowWidth: number) => {
                        const file = zip.file(fileName);
                        if (!file) throw new Error(`Invalid raw SOG4 format: missing ${fileName}`);
                        const buffer = await file.async('arraybuffer');
                        const src = new Float32Array(buffer);
                        const expected = originalCount * rowWidth;
                        if (src.length !== expected) {
                            throw new Error(`Invalid raw payload length for ${fileName}: got ${src.length}, expected ${expected}`);
                        }
                        const dst = new Float32Array(keepCount * rowWidth);
                        for (let i = 0; i < keepCount; i++) {
                            const srcIndex = keepIndices[i];
                            const srcBase = srcIndex * rowWidth;
                            const dstBase = i * rowWidth;
                            dst.set(src.subarray(srcBase, srcBase + rowWidth), dstBase);
                        }
                        zip.file(fileName, new Uint8Array(dst.buffer.slice(dst.byteOffset, dst.byteOffset + dst.byteLength)));
                    };

                    const targets: Array<{ file: string; rowWidth: number; label: string }> = [];
                    const staticRowFloats = rawPayload.static.row_floats || (17 + (rawPayload.static.f_rest_count || 0));
                    targets.push({ file: rawPayload.static.file, rowWidth: staticRowFloats, label: rawPayload.static.file });
                    if (rawPayload.xyz_bank?.file && rawPayload.xyz_bank?.keyframes) {
                        targets.push({
                            file: rawPayload.xyz_bank.file,
                            rowWidth: rawPayload.xyz_bank.keyframes * 3,
                            label: rawPayload.xyz_bank.file
                        });
                    }
                    if (rawPayload.rot_bank?.file && rawPayload.rot_bank?.keyframes) {
                        targets.push({
                            file: rawPayload.rot_bank.file,
                            rowWidth: rawPayload.rot_bank.keyframes * 4,
                            label: rawPayload.rot_bank.file
                        });
                    }
                    if (rawPayload.dc_bank?.file && rawPayload.dc_bank?.keyframes) {
                        targets.push({
                            file: rawPayload.dc_bank.file,
                            rowWidth: rawPayload.dc_bank.keyframes * 3,
                            label: rawPayload.dc_bank.file
                        });
                    }

                    for (let i = 0; i < targets.length; i++) {
                        const target = targets[i];
                        report((i / Math.max(targets.length, 1)) * 90, `Compressing ${i + 1}/${targets.length}: ${target.label}`);
                        await compactFloatFile(target.file, target.rowWidth);
                    }
                } else {
                    const calcNewSize = (count: number, maxWidth: number) => {
                        const width = Math.max(1, Math.min(maxWidth, Math.ceil(Math.sqrt(count))));
                        const height = Math.max(1, Math.ceil(count / width));
                        return { width, height };
                    };

                    const compactTexture = async (fileName: string) => {
                        const file = zip.file(fileName);
                        if (!file) return;
                        const buffer = await file.async('arraybuffer');
                        const { imageData: srcImage, width: srcWidth } = await decodeRgbaTexture(buffer);
                        const src = srcImage.data;
                        const { width, height } = calcNewSize(keepCount, srcWidth);
                        const canvas: any = (typeof OffscreenCanvas !== 'undefined')
                            ? new OffscreenCanvas(width, height)
                            : Object.assign(document.createElement('canvas'), { width, height });
                        const ctx = canvas.getContext('2d', { willReadFrequently: true });
                        if (!ctx) throw new Error("Failed to get 2D context for texture encode");
                        const dstImage = ctx.createImageData(width, height);

                        // Copy only kept indices (faster than per-index delete checks for each texture)
                        for (let w = 0; w < keepCount; w++) {
                            const i = keepIndices[w];
                            const si = i * 4;
                            const di = w * 4;
                            dstImage.data[di + 0] = src[si + 0];
                            dstImage.data[di + 1] = src[si + 1];
                            dstImage.data[di + 2] = src[si + 2];
                            dstImage.data[di + 3] = src[si + 3];
                        }

                        ctx.putImageData(dstImage, 0, 0);
                        const updated = await encodeCanvasToImage(canvas, fileName);
                        zip.file(fileName, updated);
                    };

                    const targets: string[] = [];
                    if (meta.means?.files?.[0]) targets.push(meta.means.files[0]);
                    if (meta.means?.files?.[1]) targets.push(meta.means.files[1]);
                    if (meta.quats?.files?.[0]) targets.push(meta.quats.files[0]);
                    if (meta.scales?.files?.[0]) targets.push(meta.scales.files[0]);
                    if (meta.sh0?.files?.[0]) targets.push(meta.sh0.files[0]);
                    if (meta.shN?.files?.[1]) targets.push(meta.shN.files[1]); // labels
                    if (meta.opacity?.files?.[0]) targets.push(meta.opacity.files[0]);
                    if (meta.lifetime?.files?.[0]) targets.push(meta.lifetime.files[0]);
                    if (meta.params?.files?.[0]) targets.push(meta.params.files[0]);
                    if (meta.xyz_bank && Array.isArray(meta.xyz_bank)) {
                        meta.xyz_bank.forEach((bank: any) => {
                            if (bank?.files?.[0]) targets.push(bank.files[0]);
                            if (bank?.files?.[1]) targets.push(bank.files[1]);
                        });
                    }
                    if (meta.rot_bank && Array.isArray(meta.rot_bank)) {
                        meta.rot_bank.forEach((bank: any) => {
                            if (bank?.files?.[0]) targets.push(bank.files[0]);
                        });
                    }
                    if (meta.f_dc_bank && Array.isArray(meta.f_dc_bank)) {
                        meta.f_dc_bank.forEach((bank: any) => {
                            if (bank?.files?.[0]) targets.push(bank.files[0]);
                            if (bank?.files?.[1]) targets.push(bank.files[1]);
                        });
                    }

                    const total = targets.length;
                    for (let i = 0; i < total; i++) {
                        const fileName = targets[i];
                        report((i / Math.max(total, 1)) * 90, `Compressing ${i + 1}/${total}: ${fileName}`);
                        await compactTexture(fileName);
                    }
                }

                meta.count = keepCount;
                meta.deleted_indices = [];
            }
        }

        report(92, "Updating metadata");
        // Write back meta
        // #WDD 2026-01-30 Add postProcessing to meta
        if (overrides.postProcessing) {
            meta.postProcessing = overrides.postProcessing;
        }

        zip.file('meta.json', JSON.stringify(meta, null, 2));

        // Generate new zip
        console.log("[SOG4] Re-zipping with updated metadata...");
        report(98, "Finalizing archive");
        const result = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
        report(100, "Done");
        return result;
    }
}
