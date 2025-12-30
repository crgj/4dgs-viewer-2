import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import AdmZip from "adm-zip";
import { Command } from "commander";
import fse from "fs-extra";
import natsort from "natsort";
import * as tf from "@tensorflow/tfjs-node";

// -----------------------------
// Core math helpers
// -----------------------------
const C0 = 0.28209479177387814;

function rgb2sh(v: number): number {
    return (v - 0.5) / C0;
}

function clip(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}

function getMeta(val: number | number[], idx: number): number {
    if (Array.isArray(val)) return val[idx];
    return val;
}

function dequantizeScalar(q: number, B: number, xMin: number, xMax: number): number {
    const eps = 1e-8;
    const scale = (xMax - xMin + eps) / (Math.pow(2, B) - 1);
    return q * scale + xMin;
}

type DecodedData = Uint8Array | Uint16Array;

// -----------------------------
// Helper to read YUV directly to raw buffer
// -----------------------------
async function recImageYuvToRaw(
    inputYuv: string,
    bits: number,
    width: number,
    height: number
): Promise<DecodedData> {
    const bytesPer = bits > 8 ? 2 : 1;
    const planeBytes = width * height * bytesPer;
    const buf = await fse.readFile(inputYuv);

    if (buf.length < planeBytes * 3) {
        throw new Error(`Bad YUV size: ${inputYuv} expected >= ${planeBytes * 3}, got ${buf.length}`);
    }

    const yBuf = buf.subarray(0, planeBytes);
    const uBuf = buf.subarray(planeBytes, planeBytes * 2);
    const vBuf = buf.subarray(planeBytes * 2, planeBytes * 3);

    const N = width * height;
    if (bits <= 8) {
        const interleaved = new Uint8Array(N * 3);
        for (let i = 0; i < N; i++) {
            interleaved[i * 3 + 0] = yBuf[i];
            interleaved[i * 3 + 1] = uBuf[i];
            interleaved[i * 3 + 2] = vBuf[i];
        }
        return interleaved;
    } else {
        const interleaved = new Uint16Array(N * 3);
        const yView = new Uint16Array(yBuf.buffer, yBuf.byteOffset, N);
        const uView = new Uint16Array(uBuf.buffer, uBuf.byteOffset, N);
        const vView = new Uint16Array(vBuf.buffer, vBuf.byteOffset, N);
        for (let i = 0; i < N; i++) {
            interleaved[i * 3 + 0] = yView[i];
            interleaved[i * 3 + 1] = uView[i];
            interleaved[i * 3 + 2] = vView[i];
        }
        return interleaved;
    }
}

// -----------------------------
// Decode HEVC
// -----------------------------
function decodeHevc(binFile: string, yuvFile: string, decoderPath: string): void {
    const args = [`--BitstreamFile=${binFile}`, `--ReconFile=${yuvFile}`];
    const r = spawnSync(decoderPath, args, { stdio: "ignore" });
    if (r.status !== 0) {
        throw new Error(`HM decoder failed: ${decoderPath} ${args.join(" ")}`);
    }
}

function getResolutionFromYuv(yuvFile: string, bitDepth: number, channels = 3): { w: number; h: number } {
    const st = fs.statSync(yuvFile);
    const bytesPer = bitDepth > 8 ? 2 : 1;
    const pixels = st.size / (channels * bytesPer);
    const w = Math.floor(Math.sqrt(pixels));
    return { w, h: w };
}

function bitDepthFromBinName(name: string, meta: any): number {
    const n = name.toLowerCase();
    if (n.includes("f_dc")) return meta.f_dc_bd;
    if (n.includes("f_rest")) return meta.f_rest_bd;
    if (n.includes("lifetime")) return meta.lifetime_bd;
    if (n.includes("opacity")) return meta.opacity_bd;
    if (n.includes("rotation")) return meta.rot_bd;
    if (n.includes("scale")) return meta.scale_bd;
    if (n.includes("xyz_1")) return meta.xyz_MSB;
    if (n.includes("xyz_2")) return meta.xyz_bd - meta.xyz_MSB;
    return 8;
}

// -----------------------------
// PLY Writer
// -----------------------------
function writePlyBinary(outPath: string, vertices: Float32Array, propNames: string[], commentFrames?: number) {
    const propCount = propNames.length;
    const N = vertices.length / propCount;

    const lines: string[] = [];
    lines.push("ply");
    lines.push("format binary_little_endian 1.0");
    if (commentFrames !== undefined && commentFrames !== null) {
        lines.push(`comment frames ${commentFrames}`);
    }
    lines.push(`element vertex ${N}`);
    for (const p of propNames) lines.push(`property float ${p}`);
    lines.push("end_header\n");

    const header = Buffer.from(lines.join("\n"), "ascii");
    const body = Buffer.alloc(vertices.length * 4);
    for (let i = 0; i < vertices.length; i++) {
        body.writeFloatLE(vertices[i], i * 4);
    }

    fs.writeFileSync(outPath, Buffer.concat([header, body]));
}

function globSyncSimple(pattern: string): string[] {
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);
    if (!fs.existsSync(dir)) return [];
    const suffix = base.replace("*", "");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(suffix));
    return files.map((f) => path.join(dir, f));
}

// -----------------------------
// Reconstruction GS
// -----------------------------
async function recGs(
    decodedBuffers: DecodedData[],
    width: number,
    height: number,
    meta: any,
    pca: any,
    outDir: string
) {
    const PCA_dim: number = meta.AC_dim;
    const pcaImgs = PCA_dim / 3;
    const N = width * height;

    const propNames: string[] = [];
    propNames.push("x", "y", "z", "nx", "ny", "nz");
    propNames.push("f_dc_0", "f_dc_1", "f_dc_2");
    for (let i = 0; i < 45; i++) propNames.push(`f_rest_${i}`);
    propNames.push("opacity");
    propNames.push("scale_0", "scale_1", "scale_2");
    propNames.push("rot_0", "rot_1", "rot_2", "rot_3");
    propNames.push("lifetime_mu", "lifetime_w", "lifetime_k");

    const totalProps = propNames.length;
    const out = new Float32Array(N * totalProps);

    const OFF_XYZ = 0;
    const OFF_NORM = 3;
    const OFF_FDC = 6;
    const OFF_FREST = 9;
    const OFF_OPA = 54;
    const OFF_SCALE = 55;
    const OFF_ROT = 58;
    const OFF_LIFE = 62;

    for (let i = 0; i < N; i++) {
        out[i * totalProps + OFF_NORM + 0] = 0;
        out[i * totalProps + OFF_NORM + 1] = 0;
        out[i * totalProps + OFF_NORM + 2] = 0;
    }

    // 1) f_dc
    {
        const idx = 0;
        const bd = meta.f_dc_bd;
        const maxv = Math.pow(2, bd) - 1;
        const data = decodedBuffers[idx];

        for (let i = 0; i < N; i++) {
            const r = data[i * 3 + 0];
            const g = data[i * 3 + 1];
            const b = data[i * 3 + 2];
            const rr = dequantizeScalar(clip(r, 0, maxv), bd, getMeta(meta.f_dc_min, 0), getMeta(meta.f_dc_max, 0));
            const gg = dequantizeScalar(clip(g, 0, maxv), bd, getMeta(meta.f_dc_min, 1), getMeta(meta.f_dc_max, 1));
            const bb = dequantizeScalar(clip(b, 0, maxv), bd, getMeta(meta.f_dc_min, 2), getMeta(meta.f_dc_max, 2));
            const o = i * totalProps + OFF_FDC;
            out[o + 0] = rgb2sh(rr);
            out[o + 1] = rgb2sh(gg);
            out[o + 2] = rgb2sh(bb);
        }
    }

    // 2) f_rest
    const enc = new Float32Array(N * PCA_dim);
    {
        const index_st = 1;
        const index_end = PCA_dim / 3;
        const bd = meta.f_rest_bd;
        const maxv = Math.pow(2, bd) - 1;
        const N_imgs = PCA_dim / 3;

        for (let k = index_st; k <= index_end; k++) {
            const data = decodedBuffers[k];
            const k_idx = k - 1;

            for (let i = 0; i < N; i++) {
                const r = data[i * 3 + 0];
                const g = data[i * 3 + 1];
                const b = data[i * 3 + 2];
                const rIdx = 0 * N_imgs + k_idx;
                const gIdx = 1 * N_imgs + k_idx;
                const bIdx = 2 * N_imgs + k_idx;
                const rr = dequantizeScalar(clip(r, 0, maxv), bd, getMeta(meta.f_rest_min, rIdx), getMeta(meta.f_rest_max, rIdx));
                const gg = dequantizeScalar(clip(g, 0, maxv), bd, getMeta(meta.f_rest_min, gIdx), getMeta(meta.f_rest_max, gIdx));
                const bb = dequantizeScalar(clip(b, 0, maxv), bd, getMeta(meta.f_rest_min, bIdx), getMeta(meta.f_rest_max, bIdx));
                const encBase = i * PCA_dim;
                enc[encBase + rIdx] = rr;
                enc[encBase + gIdx] = gg;
                enc[encBase + bIdx] = bb;
            }
        }
    }

    // PCA Recover
    {
        const components: number[][] = pca.components;
        let mean: any = pca.mean;
        if (Array.isArray(mean) && Array.isArray(mean[0])) mean = mean[0];
        const compT = tf.tensor2d(components);
        let compFinal: tf.Tensor;
        if (compT.shape[0] === PCA_dim) compFinal = compT;
        else if (compT.shape[1] === PCA_dim) compFinal = compT.transpose();
        else throw new Error("PCA shape mismatch");
        const encT = tf.tensor2d(enc, [N, PCA_dim]);
        const meanT = tf.tensor1d(mean);
        const res = tf.add(tf.matMul(encT, compFinal), meanT);
        const resData = (await res.data()) as Float32Array;
        const fullDim = 45;
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < fullDim; j++) {
                out[i * totalProps + OFF_FREST + j] = resData[i * fullDim + j];
            }
        }
        tf.dispose([compT, encT, meanT, res, compFinal]);
    }

    // 3) lifetime
    {
        const idx = 1 + pcaImgs;
        const bd = meta.lifetime_bd;
        const maxv = Math.pow(2, bd) - 1;
        const data = decodedBuffers[idx];
        for (let i = 0; i < N; i++) {
            const mu = dequantizeScalar(clip(data[i * 3 + 0], 0, maxv), bd, getMeta(meta.lifetime_min, 0), getMeta(meta.lifetime_max, 0));
            const w = dequantizeScalar(clip(data[i * 3 + 1], 0, maxv), bd, getMeta(meta.lifetime_min, 1), getMeta(meta.lifetime_max, 1));
            const k = dequantizeScalar(clip(data[i * 3 + 2], 0, maxv), bd, getMeta(meta.lifetime_min, 2), getMeta(meta.lifetime_max, 2));
            const o = i * totalProps + OFF_LIFE;
            out[o + 0] = mu;
            out[o + 1] = w;
            out[o + 2] = k;
        }
    }

    // 4) opacity
    {
        const idx = 2 + pcaImgs;
        const bd = meta.opacity_bd;
        const maxv = Math.pow(2, bd) - 1;
        const data = decodedBuffers[idx];
        for (let i = 0; i < N; i++) {
            const op = dequantizeScalar(clip(data[i * 3 + 0], 0, maxv), bd, getMeta(meta.opacity_min, 0), getMeta(meta.opacity_max, 0));
            out[i * totalProps + OFF_OPA] = op;
        }
    }

    // 5) rotation
    {
        const idx = 3 + pcaImgs;
        const bd = meta.rot_bd;
        const maxv = Math.pow(2, bd) - 1;
        const d1 = decodedBuffers[idx];
        const d2 = decodedBuffers[idx + 1];
        for (let i = 0; i < N; i++) {
            const q0 = dequantizeScalar(clip(d1[i * 3 + 0], 0, maxv), bd, getMeta(meta.rot_min, 0), getMeta(meta.rot_max, 0));
            const q1 = dequantizeScalar(clip(d1[i * 3 + 1], 0, maxv), bd, getMeta(meta.rot_min, 1), getMeta(meta.rot_max, 1));
            const q2 = dequantizeScalar(clip(d1[i * 3 + 2], 0, maxv), bd, getMeta(meta.rot_min, 2), getMeta(meta.rot_max, 2));
            const q3 = dequantizeScalar(clip(d2[i * 3 + 0], 0, maxv), bd, getMeta(meta.rot_min, 3), getMeta(meta.rot_max, 3));
            const o = i * totalProps + OFF_ROT;
            out[o + 0] = q0;
            out[o + 1] = q1;
            out[o + 2] = q2;
            out[o + 3] = q3;
        }
    }

    // 6) scale
    {
        const idx = 5 + pcaImgs;
        const bd = meta.scale_bd;
        const maxv = Math.pow(2, bd) - 1;
        const data = decodedBuffers[idx];
        for (let i = 0; i < N; i++) {
            const sx = dequantizeScalar(clip(data[i * 3 + 0], 0, maxv), bd, getMeta(meta.scale_min, 0), getMeta(meta.scale_max, 0));
            const sy = dequantizeScalar(clip(data[i * 3 + 1], 0, maxv), bd, getMeta(meta.scale_min, 1), getMeta(meta.scale_max, 1));
            const sz = dequantizeScalar(clip(data[i * 3 + 2], 0, maxv), bd, getMeta(meta.scale_min, 2), getMeta(meta.scale_max, 2));
            const o = i * totalProps + OFF_SCALE;
            out[o + 0] = sx;
            out[o + 1] = sy;
            out[o + 2] = sz;
        }
    }

    // 7) xyz
    {
        const idx = 6 + pcaImgs;
        const xyz_bd = meta.xyz_bd;
        const xyz_MSB = meta.xyz_MSB;
        const xyz_LSB = xyz_bd - xyz_MSB;
        const d1 = decodedBuffers[idx];
        const d2 = decodedBuffers[idx + 1];
        const m1 = Math.pow(2, xyz_MSB) - 1;
        const m2 = Math.pow(2, xyz_LSB) - 1;
        for (let i = 0; i < N; i++) {
            const hx = clip(d1[i * 3 + 0], 0, m1) >>> 0;
            const hy = clip(d1[i * 3 + 1], 0, m1) >>> 0;
            const hz = clip(d1[i * 3 + 2], 0, m1) >>> 0;
            const lx = clip(d2[i * 3 + 0], 0, m2) >>> 0;
            const ly = clip(d2[i * 3 + 1], 0, m2) >>> 0;
            const lz = clip(d2[i * 3 + 2], 0, m2) >>> 0;
            const xq = ((hx << xyz_LSB) | lx) >>> 0;
            const yq = ((hy << xyz_LSB) | ly) >>> 0;
            const zq = ((hz << xyz_LSB) | lz) >>> 0;
            const x = dequantizeScalar(xq, xyz_bd, getMeta(meta.xyz_min, 0), getMeta(meta.xyz_max, 0));
            const y = dequantizeScalar(yq, xyz_bd, getMeta(meta.xyz_min, 1), getMeta(meta.xyz_max, 1));
            const z = dequantizeScalar(zq, xyz_bd, getMeta(meta.xyz_min, 2), getMeta(meta.xyz_max, 2));
            const o = i * totalProps + OFF_XYZ;
            out[o + 0] = x;
            out[o + 1] = y;
            out[o + 2] = z;
        }
    }

    await fse.ensureDir(outDir);
    const outPly = path.join(outDir, "point_cloud.ply");
    writePlyBinary(outPly, out, propNames, meta["comment frames"]);

    // Print first 10 points for comparison
    console.log("--- First 10 Points Debug ---");
    // Reuse existing OFF_* if they are global or in scope. 
    // They are defined inside recGs already in some versions, but let's be safe.
    const _totalProps = propNames.length;

    for (let i = 0; i < 10; i++) {
        const offset = i * _totalProps;
        const p: any = { index: i };
        p.xyz = [out[offset + 0], out[offset + 1], out[offset + 2]];
        p.f_dc = [out[offset + 6], out[offset + 7], out[offset + 8]];
        p.opacity = out[offset + 54];
        p.scale = [out[offset + 55], out[offset + 56], out[offset + 57]];
        p.rot = [out[offset + 58], out[offset + 59], out[offset + 60], out[offset + 61]];
        p.life = [out[offset + 62], out[offset + 63], out[offset + 64]];
        console.log(`Pt ${i}:`, JSON.stringify(p));
    }
}

// -----------------------------
// MAIN
// -----------------------------
async function unzipAndRestore(zipFile: string, outDir: string | null, decoder: string) {
    const absZip = path.resolve(zipFile);
    const base = path.basename(absZip, path.extname(absZip));
    const baseName = base.endsWith("_compressed") ? base.replace("_compressed", "") : base;
    const outputRoot = outDir ? path.resolve(outDir) : path.dirname(absZip);
    const restoreDir = path.join(outputRoot, `${baseName}_restored`);
    const tempDir = path.join(restoreDir, "temp");

    await fse.ensureDir(restoreDir);
    await fse.ensureDir(tempDir);

    console.log(`Extracting ${absZip} -> ${tempDir}`);
    const zip = new AdmZip(absZip);
    zip.extractAllTo(tempDir, true);

    const metaPath = path.join(tempDir, "metadata.json");
    const pcaPath = path.join(tempDir, "pca_AC_all.json");
    if (!fs.existsSync(metaPath)) throw new Error("metadata.json missing");
    if (!fs.existsSync(pcaPath)) throw new Error("pca_AC_all.json missing");

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const pca = JSON.parse(fs.readFileSync(pcaPath, "utf-8"));

    const bins = globSyncSimple(path.join(tempDir, "*.bin"));
    // @ts-ignore
    const natsortFn = (natsort.default || natsort) as any;
    const sorter = natsortFn();
    bins.sort(sorter);
    console.log("Sorted Bins (Node):", bins.map(b => path.basename(b)));

    if (bins.length === 0) throw new Error("No .bin files found");

    let width = 0;
    let height = 0;
    const decodedBuffers: DecodedData[] = [];

    console.log(`Decoding with HM: ${decoder}`);
    for (const bf of bins) {
        const yuv = path.join(tempDir, path.basename(bf).replace(".bin", "_de.yuv"));
        decodeHevc(bf, yuv, decoder);
        const bd = bitDepthFromBinName(path.basename(bf), meta);
        if (width === 0) {
            const wh = getResolutionFromYuv(yuv, bd);
            width = wh.w;
            height = wh.h;
            console.log(`Resolution: ${width}x${height}`);
        }
        const data = await recImageYuvToRaw(yuv, bd, width, height);
        decodedBuffers.push(data);
    }

    console.log("Reconstructing PLY...");
    await recGs(decodedBuffers, width, height, meta, pca, restoreDir);

    const outPly = path.join(restoreDir, "point_cloud.ply");
    const finalPly = path.join(restoreDir, `${baseName}_restored.ply`);
    await fse.copyFile(outPly, finalPly);
    console.log(`Final PLY: ${finalPly}`);

    // Cleanup
    await fse.remove(tempDir);
    await fse.remove(outPly);
}

// CLI
async function main() {
    const program = new Command();
    program
        .argument("<zipFile>", "Path to .gszip")
        .option("--out <dir>", "Output directory")
        .option("--decoder <path>", "Decoder path")
        .parse(process.argv);

    const zipFile = program.args[0];
    const opts = program.opts();

    if (!zipFile || !fs.existsSync(zipFile)) {
        console.error("Zip file not found");
        process.exit(1);
    }

    let decoder = opts.decoder;
    if (!decoder) {
        // Use relative path from the script location
        const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
        decoder = path.join(projectRoot, "public/HM/TAppDecoderStatic");
    }
    if (!path.isAbsolute(decoder)) {
        decoder = path.resolve(process.cwd(), decoder);
    }

    if (!fs.existsSync(decoder)) {
        console.error(`Decoder not found at ${decoder}`);
        process.exit(1);
    }

    try {
        await unzipAndRestore(zipFile, opts.out, decoder);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

main();
