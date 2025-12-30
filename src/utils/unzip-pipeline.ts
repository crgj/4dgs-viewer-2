import JSZip from 'jszip';

// Interface definitions matching the metadata structure
interface Metadata {
    f_dc_bd: number; f_dc_min: number[]; f_dc_max: number[];
    f_rest_bd: number; f_rest_min: number[]; f_rest_max: number[];
    opacity_bd: number; opacity_min: number; opacity_max: number;
    scale_bd: number; scale_min: number[]; scale_max: number[];
    rot_bd: number; rot_min: number[]; rot_max: number[];
    lifetime_bd: number; lifetime_min: number[]; lifetime_max: number[];
    xyz_bd: number; xyz_MSB: number; xyz_min: number[]; xyz_max: number[];
    AC_dim: number;
    "comment frames"?: number;
}

interface PCAMeta {
    components: number[][]; // K x 45 or 45 x K
    mean: number[] | number[][]; // 1 x 45
}

// Helpers
function dequantize(q: number, bits: number, min: number, max: number): number {
    const eps = 1e-8;
    const range = Math.pow(2, bits) - 1;
    const scale = (max - min + eps) / range;
    return q * scale + min;
}

const C0 = 0.28209479177387814;
function rgb2sh(x: number): number {
    return (x - 0.5) / C0;
}

function clip(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}

function getMeta(val: number | number[], idx: number): number {
    if (Array.isArray(val)) return val[idx];
    return val;
}

// HEVC Decoder Wrapper (libde265)
declare const libde265: any;

class HevcDecoder {
    decoder: any;

    constructor() {
        console.log(`[Decoder] Initializing HevcDecoder...`);
        if (typeof libde265 === 'undefined') {
            console.error(`[Decoder] libde265 is UNDEFINED!`);
            throw new Error("libde265.js not loaded. Please check index.html");
        }
        try {
            this.decoder = new libde265.Decoder();
        } catch (e) {
            console.error(`[Decoder] Failed to create decoder instance:`, e);
            throw e;
        }
    }

    decode(data: Uint8Array): { width: number, height: number, data: Uint16Array | Uint8Array, bits: number } {
        this.decoder.push_data(data);
        this.decoder.flush();

        let width = 0;
        let height = 0;
        let decodedData: Uint8Array | Uint16Array | null = null;
        let really16 = false;
        let err: any = null;

        this.decoder.set_image_callback((image: any) => {
            try {
                console.log(`[Decoder] callback fired!`);
                width = image.get_width();
                height = image.get_height();

                const N = width * height;
                const y = image.get_y_plane();
                const u = image.get_u_plane();
                const v = image.get_v_plane();
                const sY = image.get_y_stride();
                const sU = image.get_u_stride();
                const sV = image.get_v_stride();

                // libde265 strides are often in bytes. Detection for 10-bit in Uint8Array:
                really16 = (y instanceof Uint16Array) || (sY >= width * 2);

                const strideY = (y instanceof Uint16Array) ? (sY >> 1) : sY;
                const strideU = (u instanceof Uint16Array) ? (sU >> 1) : sU;
                const strideV = (v instanceof Uint16Array) ? (sV >> 1) : sV;

                console.log(`[Decoder] dims: ${width}x${height}, actually_16: ${really16}, type: ${y.constructor.name}, stride_y: ${sY}`);

                if (really16) {
                    decodedData = new Uint16Array(N * 3);
                } else {
                    decodedData = new Uint8Array(N * 3);
                }

                console.log(`[Decoder] Starting pixel loop...`);
                for (let r = 0; r < height; r++) {
                    const rowOff = r * width;
                    for (let c = 0; c < width; c++) {
                        const idx = rowOff + c;
                        if (y instanceof Uint16Array) {
                            decodedData[idx * 3 + 0] = y[r * strideY + c];
                            decodedData[idx * 3 + 1] = u[r * strideU + c];
                            decodedData[idx * 3 + 2] = v[r * strideV + c];
                        } else if (really16) {
                            const y0 = y[r * sY + c * 2];
                            const y1 = y[r * sY + c * 2 + 1];
                            decodedData[idx * 3 + 0] = y0 | (y1 << 8);

                            const u0 = u[r * sU + c * 2];
                            const u1 = u[r * sU + c * 2 + 1];
                            decodedData[idx * 3 + 1] = u0 | (u1 << 8);

                            const v0 = v[r * sV + c * 2];
                            const v1 = v[r * sV + c * 2 + 1];
                            decodedData[idx * 3 + 2] = v0 | (v1 << 8);
                        } else {
                            decodedData[idx * 3 + 0] = y[r * strideY + c];
                            decodedData[idx * 3 + 1] = u[r * strideU + c];
                            decodedData[idx * 3 + 2] = v[r * strideV + c];
                        }
                    }
                }
                console.log(`[Decoder] Pixel loop finished!`);
            } catch (e) {
                console.error(`[Decoder] Error inside callback:`, e);
                err = e;
            }
        });

        this.decoder.decode((error: any) => {
            if (error && !libde265.de265_isOK(error)) err = error;
        });

        if (err) throw err;
        if (!decodedData) throw new Error("No frame produced");

        return { width, height, data: decodedData, bits: really16 ? 10 : 8 };
    }

    free() {
        if (this.decoder && typeof this.decoder.delete === 'function') {
            this.decoder.delete();
            this.decoder = null;
        }
    }
}

export class UnzipPipeline {
    async process(file: File, onProgress?: (p: number, status: string) => void): Promise<{ buffer: ArrayBuffer, frameCount: number | null }> {
        if (onProgress) onProgress(0, "EXTRACTING ARCHIVE");
        console.log("Starting Decompression Pipeline (Browser)...");
        const zip = new JSZip();
        await zip.loadAsync(file);

        // 1. Read Metadata
        const metaFile = zip.file('metadata.json');
        const pcaFile = zip.file('pca_AC_all.json');
        if (!metaFile || !pcaFile) throw new Error("Critical metadata missing in gszip");

        const metadata: Metadata = JSON.parse(await metaFile.async('string'));
        const pcaData: PCAMeta = JSON.parse(await pcaFile.async('string'));

        // 2. Map and Decode HEVC files
        const binFiles = Object.keys(zip.files).filter(name => name.endsWith('.bin')).sort((a, b) => {
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        });

        console.log(`[Unzip] Found ${binFiles.length} bin files:`, binFiles);

        const decodedBuffers: (Uint8Array | Uint16Array)[] = [];
        let width = 0;
        let height = 0;

        const decoder = new HevcDecoder();
        try {
            for (let i = 0; i < binFiles.length; i++) {
                const name = binFiles[i];
                if (onProgress) onProgress(Math.floor((i / binFiles.length) * 50), `DECODING HEVC: ${name}`);
                console.log(`[Unzip] Decoding ${name}...`);
                const zipFile = zip.file(name);
                if (!zipFile) continue;
                const buffer = await zipFile.async('uint8array');
                const result = decoder.decode(buffer);
                if (width === 0) {
                    width = result.width;
                    height = result.height;
                }
                decodedBuffers.push(result.data);
                console.log(`[Unzip] Decoded ${name} successfully.`);
            }
        } finally {
            decoder.free();
        }

        // 3. Reconstruction
        if (onProgress) onProgress(50, "RECONSTRUCTING ATTRIBUTES");
        console.log(`Reconstructing Attributes for ${width}x${height} points...`);
        const N = width * height;
        const acDim = metadata.AC_dim;
        const pcaImgs = acDim / 3;

        const propNames = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"];
        for (let i = 0; i < 45; i++) propNames.push(`f_rest_${i}`);
        propNames.push("opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "lifetime_mu", "lifetime_w", "lifetime_k");

        const totalProps = propNames.length;
        const out = new Float32Array(N * totalProps);

        // Offsets
        const OFF_XYZ = 0;
        const OFF_NORM = 3;
        const OFF_FDC = 6;
        const OFF_FREST = 9;
        const OFF_OPA = 54;
        const OFF_SCALE = 55;
        const OFF_ROT = 58;
        const OFF_LIFE = 62;

        // 1) f_dc
        {
            if (onProgress) onProgress(55, "RECONSTRUCTING COLORS");
            const data = decodedBuffers[0];
            const bd = metadata.f_dc_bd;
            const maxv = Math.pow(2, bd) - 1;
            for (let i = 0; i < N; i++) {
                const r = dequantize(clip(data[i * 3 + 0], 0, maxv), bd, getMeta(metadata.f_dc_min, 0), getMeta(metadata.f_dc_max, 0));
                const g = dequantize(clip(data[i * 3 + 1], 0, maxv), bd, getMeta(metadata.f_dc_min, 1), getMeta(metadata.f_dc_max, 1));
                const b = dequantize(clip(data[i * 3 + 2], 0, maxv), bd, getMeta(metadata.f_dc_min, 2), getMeta(metadata.f_dc_max, 2));
                out[i * totalProps + OFF_FDC + 0] = rgb2sh(r);
                out[i * totalProps + OFF_FDC + 1] = rgb2sh(g);
                out[i * totalProps + OFF_FDC + 2] = rgb2sh(b);
            }
        }

        // 2) f_rest (Inverse PCA)
        {
            if (onProgress) onProgress(60, "INVERSE PCA: SPHERICAL HARMONICS");
            const bd = metadata.f_rest_bd;
            const maxv = Math.pow(2, bd) - 1;
            const nImgs = acDim / 3;

            let mean = pcaData.mean;
            if (Array.isArray(mean) && Array.isArray(mean[0])) mean = mean[0] as number[];
            const pcaMean = mean as number[];

            const pcaComp = pcaData.components;
            const isTransposed = pcaComp.length === acDim;

            for (let i = 0; i < N; i++) {
                const recovered = new Float32Array(acDim);
                for (let k = 0; k < nImgs; k++) {
                    const data = decodedBuffers[1 + k];
                    const rIdx = 0 * nImgs + k;
                    const gIdx = 1 * nImgs + k;
                    const bIdx = 2 * nImgs + k;
                    recovered[rIdx] = dequantize(clip(data[i * 3 + 0], 0, maxv), bd, getMeta(metadata.f_rest_min, rIdx), getMeta(metadata.f_rest_max, rIdx));
                    recovered[gIdx] = dequantize(clip(data[i * 3 + 1], 0, maxv), bd, getMeta(metadata.f_rest_min, gIdx), getMeta(metadata.f_rest_max, gIdx));
                    recovered[bIdx] = dequantize(clip(data[i * 3 + 2], 0, maxv), bd, getMeta(metadata.f_rest_min, bIdx), getMeta(metadata.f_rest_max, bIdx));
                }

                for (let j = 0; j < 45; j++) {
                    let sum = pcaMean[j] || 0;
                    for (let k_latent = 0; k_latent < acDim; k_latent++) {
                        const compVal = isTransposed ? pcaComp[k_latent][j] : pcaComp[j][k_latent];
                        sum += recovered[k_latent] * compVal;
                    }
                    out[i * totalProps + OFF_FREST + j] = sum;
                }
            }
        }

        // 3) lifetime
        {
            if (onProgress) onProgress(75, "RECONSTRUCTING LIFETIME");
            const data = decodedBuffers[1 + pcaImgs];
            const bd = metadata.lifetime_bd;
            const maxv = Math.pow(2, bd) - 1;
            for (let i = 0; i < N; i++) {
                out[i * totalProps + OFF_LIFE + 0] = dequantize(clip(data[i * 3 + 0], 0, maxv), bd, getMeta(metadata.lifetime_min, 0), getMeta(metadata.lifetime_max, 0));
                out[i * totalProps + OFF_LIFE + 1] = dequantize(clip(data[i * 3 + 1], 0, maxv), bd, getMeta(metadata.lifetime_min, 1), getMeta(metadata.lifetime_max, 1));
                out[i * totalProps + OFF_LIFE + 2] = dequantize(clip(data[i * 3 + 2], 0, maxv), bd, getMeta(metadata.lifetime_min, 2), getMeta(metadata.lifetime_max, 2));
            }
        }

        // 4) opacity
        {
            if (onProgress) onProgress(80, "RECONSTRUCTING OPACITY");
            const data = decodedBuffers[2 + pcaImgs];
            const bd = metadata.opacity_bd;
            const maxv = Math.pow(2, bd) - 1;
            for (let i = 0; i < N; i++) {
                out[i * totalProps + OFF_OPA] = dequantize(clip(data[i * 3 + 0], 0, maxv), bd, getMeta(metadata.opacity_min, 0), getMeta(metadata.opacity_max, 0));
            }
        }

        // 5) rotation
        {
            if (onProgress) onProgress(85, "RECONSTRUCTING ROTATION");
            const d1 = decodedBuffers[3 + pcaImgs];
            const d2 = decodedBuffers[4 + pcaImgs];
            const bd = metadata.rot_bd;
            const maxv = Math.pow(2, bd) - 1;
            for (let i = 0; i < N; i++) {
                out[i * totalProps + OFF_ROT + 0] = dequantize(clip(d1[i * 3 + 0], 0, maxv), bd, getMeta(metadata.rot_min, 0), getMeta(metadata.rot_max, 0));
                out[i * totalProps + OFF_ROT + 1] = dequantize(clip(d1[i * 3 + 1], 0, maxv), bd, getMeta(metadata.rot_min, 1), getMeta(metadata.rot_max, 1));
                out[i * totalProps + OFF_ROT + 2] = dequantize(clip(d1[i * 3 + 2], 0, maxv), bd, getMeta(metadata.rot_min, 2), getMeta(metadata.rot_max, 2));
                out[i * totalProps + OFF_ROT + 3] = dequantize(clip(d2[i * 3 + 0], 0, maxv), bd, getMeta(metadata.rot_min, 3), getMeta(metadata.rot_max, 3));
            }
        }

        // 6) scale
        {
            if (onProgress) onProgress(90, "RECONSTRUCTING SCALES");
            const data = decodedBuffers[5 + pcaImgs];
            const bd = metadata.scale_bd;
            const maxv = Math.pow(2, bd) - 1;
            for (let i = 0; i < N; i++) {
                out[i * totalProps + OFF_SCALE + 0] = dequantize(clip(data[i * 3 + 0], 0, maxv), bd, getMeta(metadata.scale_min, 0), getMeta(metadata.scale_max, 0));
                out[i * totalProps + OFF_SCALE + 1] = dequantize(clip(data[i * 3 + 1], 0, maxv), bd, getMeta(metadata.scale_min, 1), getMeta(metadata.scale_max, 1));
                out[i * totalProps + OFF_SCALE + 2] = dequantize(clip(data[i * 3 + 2], 0, maxv), bd, getMeta(metadata.scale_min, 2), getMeta(metadata.scale_max, 2));
            }
        }

        // 7) xyz (Bit Merged)
        {
            if (onProgress) onProgress(95, "RECONSTRUCTING XYZ COORDINATES");
            const d1 = decodedBuffers[6 + pcaImgs];
            const d2 = decodedBuffers[7 + pcaImgs];
            const xyz_bd = metadata.xyz_bd;
            const xyz_MSB = metadata.xyz_MSB;
            const xyz_LSB = xyz_bd - xyz_MSB;
            const m1 = Math.pow(2, xyz_MSB) - 1;
            const m2 = Math.pow(2, xyz_LSB) - 1;
            for (let i = 0; i < N; i++) {
                const hx = clip(d1[i * 3 + 0], 0, m1);
                const hy = clip(d1[i * 3 + 1], 0, m1);
                const hz = clip(d1[i * 3 + 2], 0, m1);
                const lx = clip(d2[i * 3 + 0], 0, m2);
                const ly = clip(d2[i * 3 + 1], 0, m2);
                const lz = clip(d2[i * 3 + 2], 0, m2);
                const xq = (hx << xyz_LSB) | lx;
                const yq = (hy << xyz_LSB) | ly;
                const zq = (hz << xyz_LSB) | lz;
                const x = dequantize(xq, xyz_bd, getMeta(metadata.xyz_min, 0), getMeta(metadata.xyz_max, 0));
                const y = dequantize(yq, xyz_bd, getMeta(metadata.xyz_min, 1), getMeta(metadata.xyz_max, 1));
                const z = dequantize(zq, xyz_bd, getMeta(metadata.xyz_min, 2), getMeta(metadata.xyz_max, 2));
                out[i * totalProps + OFF_XYZ + 0] = x;
                out[i * totalProps + OFF_XYZ + 1] = y;
                out[i * totalProps + OFF_XYZ + 2] = z;

                if (i === 0) {
                    console.log(`[Unzip] Pt 0 XYZ: (${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)})`);
                    console.log(`[Unzip] Pt 0 Opacity: ${out[i * totalProps + OFF_OPA].toFixed(4)}`);
                }
            }
        }

        // 4. Construct PLY Binary
        if (onProgress) onProgress(98, "GENERATING PLY BINARY");
        console.log("Encoding results to PLY binary...");
        let header = "ply\nformat binary_little_endian 1.0\n";
        if (metadata["comment frames"] !== undefined) {
            header += `comment frames ${metadata["comment frames"]}\n`;
        }
        header += `element vertex ${N}\n`;
        for (const p of propNames) header += `property float ${p}\n`;
        header += "end_header\n";

        const headerData = new TextEncoder().encode(header);
        const finalBuffer = new Uint8Array(headerData.length + out.byteLength);
        finalBuffer.set(headerData);
        finalBuffer.set(new Uint8Array(out.buffer), headerData.length);

        console.log("Decompression and Reconstruction Finished.");
        if (onProgress) onProgress(100, "COMPLETED");
        return { buffer: finalBuffer.buffer, frameCount: metadata["comment frames"] || null };
    }
}
