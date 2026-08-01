import JSZip from 'jszip';
import type { IImageDecoder } from './sog4-loader';

// #WDD 2026-07-31 原始 PlayCanvas 官方 SOG v2 格式解析器
// 文档: https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/
// 解码算法与官方 v2 规范对齐(means 16-bit L/U + log、quats smallest-three、
// scales codebook + exp、sh0 codebook + alpha)。
//
// 与项目内 SOG4Loader/TrueSplatsLoader 的关键差异:
//   1. opacity: 官方 v2 的 alpha 是已 sigmoid 的线性值[0,1]。
//      本项目渲染管线(序列路径)会对 opacity 再做一次 sigmoid(见 PlayCanvas gsplat-data.js),
//      因此解析时用 logit() 转回 logit 域,避免双重 sigmoid 导致画面全不透明。
//   2. scales: 官方 v2 固定 Math.exp(codebook[idx]),不走 SOG4 的 meta.custom.scales_log 开关。
//   3. manifest 仅识别 version === 2;项目私有字段(custom/lifetime/params)在官方 v2 中不存在。

const SH_C0 = 0.28209479177387814;

// SH_C0 在渲染端由 PlayCanvas GSplatData 应用(参见 gsplat-data.js:58: 0.5 + cr[i]*SH_C0);
// 本解析器直接输出原始 codebook 值,不在此处预乘,与 PLY/现有 SOG 路径保持一致。
void SH_C0;

// logit: 把[0,1]概率转回 logit 域(与 sog4-loader.ts:8 的 logit 定义一致)
const logit = (v: number) => {
    const p = Math.max(1e-7, Math.min(1.0 - 1e-7, v));
    return Math.log(p / (1.0 - p));
};

// 官方 SOG v2 的 means 使用对称 log 变换: n = sign(x) * (exp(|x|) - 1)
const inverseLogTransform = (v: number) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);

export interface SOGv2ParseResult {
    count: number;
    bands: number;
    plyData: {
        elements: Array<{
            name: string;
            count: number;
            properties: Array<{ name: string; type: string; storage: Float32Array }>;
        }>;
    };
}

/**
 * SOGv2Loader
 * 解析 PlayCanvas 官方 SOG v2 格式(.sog): 一个 ZIP,内含 meta.json + PNG/WebP 纹理。
 * 产出与 loadSogSequence 期望一致的结构(count/bands/plyData.elements[0]),
 * 使其可当作单帧序列读入。
 */
export class SOGv2Loader {
    private decoder?: IImageDecoder;

    constructor(decoder?: IImageDecoder) {
        this.decoder = decoder;
    }

    /**
     * 嗅探 buffer 是否为官方 SOG v2(供 loadSogSequence 在版本间分流)。
     * 返回 2 表示官方 v2;其他(含非 SOG zip)返回解析出的 version 或 null。
     */
    static async detectVersion(buffer: ArrayBuffer): Promise<number | null> {
        try {
            const zip = new JSZip();
            await zip.loadAsync(buffer);
            const metaFile = zip.file('meta.json');
            if (!metaFile) return null;
            const meta = JSON.parse(await metaFile.async('string'));
            const v = meta?.version;
            return typeof v === 'number' ? v : null;
        } catch {
            return null;
        }
    }

    async parse(buffer: ArrayBuffer, onProgress: (p: number, msg: string) => void): Promise<SOGv2ParseResult> {
        onProgress(0, 'Extracting SOG v2');
        const zip = new JSZip();
        await zip.loadAsync(buffer);

        const metaFile = zip.file('meta.json');
        if (!metaFile) throw new Error('SOG v2 missing meta.json');
        const meta = JSON.parse(await metaFile.async('string'));

        if (meta.version !== 2) {
            throw new Error(
                `Unsupported SOG version: ${meta.version}. ` +
                `This loader only supports PlayCanvas SOG v2. ` +
                `For project SOG4/TrueSplats .sog, use the default loader.`
            );
        }

        const count: number = meta.count;
        if (!count || count <= 0) throw new Error('SOG v2: invalid count in meta.json');

        onProgress(10, 'Decoding SOG v2 Textures');
        const props: any = {};

        const loadTexture = async (fileName: string) => {
            const file = zip.file(fileName);
            if (!file) return null;
            const buf = await file.async('arraybuffer');

            if (this.decoder) {
                return await this.decoder.decode(buf);
            }

            // Browser default decoding — 与 SOG4Loader/TrueSplatsLoader 一致:
            // 关闭颜色空间转换,保持原始 8-bit 整数(官方规范要求)。
            const blob = new Blob([buf]);
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

        // 官方 v2 字段结构
        if (meta.means?.files) {
            props.means_L = await loadTexture(meta.means.files[0]); // lower bits
            props.means_U = await loadTexture(meta.means.files[1]); // upper bits
        }
        if (meta.quats?.files) props.rotation = await loadTexture(meta.quats.files[0]);
        if (meta.scales?.files) props.scales = await loadTexture(meta.scales.files[0]);
        if (meta.sh0?.files) props.sh0 = await loadTexture(meta.sh0.files[0]);
        if (meta.shN?.files) {
            props.shN_cent = await loadTexture(meta.shN.files[0]);
            props.shN_labels = await loadTexture(meta.shN.files[1]);
        }

        onProgress(30, 'Reconstructing SOG v2 Attributes');

        const data: any = {
            x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
            rot_0: new Float32Array(count), rot_1: new Float32Array(count),
            rot_2: new Float32Array(count), rot_3: new Float32Array(count),
            scale_0: new Float32Array(count), scale_1: new Float32Array(count), scale_2: new Float32Array(count),
            opacity: new Float32Array(count),
            f_dc_0: new Float32Array(count), f_dc_1: new Float32Array(count), f_dc_2: new Float32Array(count)
        };
        // 预分配全部 45 个 f_rest,按实际 bands 填充,其余保持 0。
        for (let i = 0; i < 45; i++) data[`f_rest_${i}`] = new Float32Array(count);

        // --- Means (positions) ---
        // 16-bit 量化: q = (U << 8) | L;反量化到 log 域后再 unlog。
        if (props.means_U && props.means_L && meta.means) {
            const mins = meta.means.mins, maxs = meta.means.maxs;
            const dataU = props.means_U.data, dataL = props.means_L.data;
            for (let i = 0; i < count; i++) {
                const qx = (dataU[i * 4 + 0] << 8) | dataL[i * 4 + 0];
                const qy = (dataU[i * 4 + 1] << 8) | dataL[i * 4 + 1];
                const qz = (dataU[i * 4 + 2] << 8) | dataL[i * 4 + 2];
                data.x[i] = inverseLogTransform((qx / 65535.0) * (maxs[0] - mins[0]) + mins[0]);
                data.y[i] = inverseLogTransform((qy / 65535.0) * (maxs[1] - mins[1]) + mins[1]);
                data.z[i] = inverseLogTransform((qz / 65535.0) * (maxs[2] - mins[2]) + mins[2]);
            }
        }

        // --- Rotations (smallest-three) ---
        // RGB 存三个分量,A 存 mode(252..255)标识被省略的分量;输出 WXYZ 顺序。
        if (props.rotation) {
            const sqrt2 = Math.sqrt(2);
            const texData = props.rotation.data;
            for (let i = 0; i < count; i++) {
                const r = texData[i * 4], g = texData[i * 4 + 1], b = texData[i * 4 + 2], a = texData[i * 4 + 3];
                const k = a - 252; // mode: 哪个分量被省略
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

        // --- Opacity (关键: 转回 logit 域) ---
        // 官方 v2 的 alpha 是线性概率值[0,1];项目渲染管线会对 opacity 再 sigmoid,
        // 故此处用 logit() 还原,避免双重 sigmoid。
        if (props.sh0) {
            const texData = props.sh0.data;
            for (let i = 0; i < count; i++) {
                data.opacity[i] = logit(texData[i * 4 + 3] / 255.0);
            }
        }

        // --- Scales (官方 v2 固定 exp) ---
        // 注意: 不走 SOG4 的 meta.custom.scales_log 分支——官方 codebook 已是 log 域。
        if (props.scales && meta.scales && meta.scales.codebook) {
            const cb = meta.scales.codebook;
            const texData = props.scales.data;
            for (let i = 0; i < count; i++) {
                data.scale_0[i] = Math.exp(cb[texData[i * 4 + 0]]);
                data.scale_1[i] = Math.exp(cb[texData[i * 4 + 1]]);
                data.scale_2[i] = Math.exp(cb[texData[i * 4 + 2]]);
            }
        }

        // --- DC Coefficients (sh0) ---
        // 官方 v2: rgb 为 codebook 索引,f_dc = codebook[idx](注意这里不乘 SH_C0,
        // 该系数由 PlayCanvas GSplatData 在渲染时应用,与 PLY 路径保持一致)。
        let bands = 0;
        if (props.sh0 && meta.sh0 && meta.sh0.codebook) {
            const cb = meta.sh0.codebook;
            const texData = props.sh0.data;
            for (let i = 0; i < count; i++) {
                data.f_dc_0[i] = cb[texData[i * 4 + 0]];
                data.f_dc_1[i] = cb[texData[i * 4 + 1]];
                data.f_dc_2[i] = cb[texData[i * 4 + 2]];
            }
        }

        // --- SH Bands (shN, 可选高阶球谐) ---
        // palette(codebook) + labels(16-bit 索引) 解码,移植自 truesplats-loader.ts:237-272。
        if (meta.shN && props.shN_cent && props.shN_labels) {
            const shCfg = meta.shN;
            const cb = shCfg.codebook;
            const paletteSize = shCfg.count;
            bands = shCfg.bands || 3;
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

        // 装配 properties —— 仅含序列渲染所需核心字段,不含 TrueSplats 私有的 lifetime 等。
        const properties: Array<{ name: string; type: string; storage: Float32Array }> = [
            { name: 'x', type: 'float', storage: data.x },
            { name: 'y', type: 'float', storage: data.y },
            { name: 'z', type: 'float', storage: data.z },
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
        ];
        // 只把非全零(实际填充过)的 f_rest 加入,避免多余空数组。
        const fRestCount = bands === 1 ? 9 : (bands === 2 ? 24 : (bands === 3 ? 45 : 0));
        for (let i = 0; i < fRestCount; i++) {
            properties.push({ name: `f_rest_${i}`, type: 'float', storage: data[`f_rest_${i}`] });
        }

        onProgress(80, 'SOG v2 Attributes Ready');

        return {
            count,
            bands,
            plyData: {
                elements: [{ name: 'vertex', count, properties }]
            }
        };
    }
}
