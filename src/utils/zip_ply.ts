import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import JSZip from "jszip";

/**
 * TypeScript implementation of zip_ply.py (Browser Compatible)
 * 
 * Features:
 * - PLY parsing (Gaussian Splatting format)
 * - PCA compression for f_rest
 * - 2-stage Morton Sorting
 * - MiniPLAS optimization (Iterative smoothing)
 * - Quantization and attribute packing
 */

// --- Math Helpers ---
const C0 = 0.28209479177387814;
function sh2rgb(v: number) { return v * C0 + 0.5; }

function morton3D(x: number, y: number, z: number, maxBits: number): bigint {
    let m = 0n;
    for (let i = 0; i < maxBits; i++) {
        const mask = 1 << i;
        if (x & mask) m |= (1n << BigInt(3 * i));
        if (y & mask) m |= (1n << BigInt(3 * i + 1));
        if (z & mask) m |= (1n << BigInt(3 * i + 2));
    }
    return m;
}

function morton2D(x: number, y: number, maxBits: number): bigint {
    let m = 0n;
    for (let i = 0; i < maxBits; i++) {
        const mask = 1 << i;
        if (x & mask) m |= (1n << BigInt(2 * i));
        if (y & mask) m |= (1n << BigInt(2 * i + 1));
    }
    return m;
}

// --- PCA via Power Iteration (Robust fallback for missing tf.svd) ---
async function computePCA(data: tf.Tensor2D, k: number) {
    const N = data.shape[0];
    const D = data.shape[1];
    const mean = data.mean(0, true);
    const centered = data.sub(mean);

    // Covariance matrix [D, D]
    // Cov = (X^T * X) / (N - 1)
    const cov = centered.transpose().matMul(centered).div(tf.scalar(N - 1));

    // Power iteration for k eigenvectors
    const components: number[][] = [];
    let currentCov = cov;

    for (let i = 0; i < k; i++) {
        // Find largest eigenvector
        let v = tf.randomNormal([D, 1]);
        for (let iter = 0; iter < 50; iter++) {
            v = currentCov.matMul(v);
            v = v.div(v.norm());
        }
        const vArr = (await v.array()) as number[][];
        const flatV = vArr.map(row => row[0]);
        components.push(flatV);

        // Deflate covariance matrix: Cov = Cov - lambda * v * v^T
        const vTensor = tf.tensor2d(flatV, [D, 1]);
        const lambda = vTensor.transpose().matMul(currentCov).matMul(vTensor).dataSync()[0];
        const vvt = vTensor.matMul(vTensor.transpose());
        currentCov = currentCov.sub(vvt.mul(lambda));

        v.dispose();
        vTensor.dispose();
        vvt.dispose();
    }

    const compTensor = tf.tensor2d(components); // [k, D]
    const projected = centered.matMul(compTensor.transpose()); // [N, k]

    return { projected, components: compTensor, mean };
}

// --- MiniPLAS Implementation ---
async function optimizeMapping(
    indices: Int32Array,
    params: Float32Array, // [N, C] where N = sidelen*sidelen
    sidelen: number,
    channels: number,
    iterations: number = 3
) {
    console.log(`Starting MiniPLAS optimization (${iterations} iterations)...`);

    const getParam = (idx: number, c: number) => params[idx * channels + c];

    // Simple box-blur targets
    const targets = new Float32Array(sidelen * sidelen * channels);

    for (let iter = 0; iter < iterations; iter++) {
        // 1. Compute Target (Simple 3x3 box blur for local smoothness)
        for (let y = 0; y < sidelen; y++) {
            for (let x = 0; x < sidelen; x++) {
                for (let c = 0; c < channels; c++) {
                    let sum = 0, count = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const nx = (x + dx + sidelen) % sidelen;
                            const ny = (y + dy + sidelen) % sidelen;
                            sum += getParam(indices[ny * sidelen + nx], c);
                            count++;
                        }
                    }
                    targets[(y * sidelen + x) * channels + c] = sum / count;
                }
            }
        }

        // 2. Greedy Swaps (Random pairs to minimize distance to target)
        let improvements = 0;
        for (let i = 0; i < sidelen * sidelen * 2; i++) {
            const idx1 = Math.floor(Math.random() * (sidelen * sidelen));
            const y = Math.floor(idx1 / sidelen);
            const x = Math.floor(idx1 % sidelen);

            const dx = Math.floor(Math.random() * 3) - 1;
            const dy = Math.floor(Math.random() * 3) - 1;
            const nx = (x + dx + sidelen) % sidelen;
            const ny = (y + dy + sidelen) % sidelen;
            const idx2 = ny * sidelen + nx;

            if (idx1 === idx2) continue;

            const orig1 = indices[idx1];
            const orig2 = indices[idx2];

            let diff = 0;
            for (let c = 0; c < channels; c++) {
                const t1 = targets[idx1 * channels + c];
                const t2 = targets[idx2 * channels + c];
                const v1 = getParam(orig1, c);
                const v2 = getParam(orig2, c);

                const curDist = (v1 - t1) ** 2 + (v2 - t2) ** 2;
                const newDist = (v2 - t1) ** 2 + (v1 - t2) ** 2;
                diff += (newDist - curDist);
            }

            if (diff < 0) {
                indices[idx1] = orig2;
                indices[idx2] = orig1;
                improvements++;
            }
        }
        console.log(`  Iter ${iter + 1}: ${improvements} swaps applied`);
    }
}

// -----------------------------
// PLY Parser
// -----------------------------
async function parsePly(buffer: ArrayBuffer) {
    const view = new Uint8Array(buffer);
    let headerEndOffset = 0;
    const target = new TextEncoder().encode("end_header");

    // Scan for end_header
    for (let i = 0; i < Math.min(view.length, 5000); i++) {
        let match = true;
        for (let j = 0; j < target.length; j++) {
            if (view[i + j] !== target[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            let ptr = i + target.length;
            // Skip newline(s)
            while (ptr < view.length && (view[ptr] === 0x0A || view[ptr] === 0x0D || view[ptr] === 0x20)) {
                ptr++;
            }
            headerEndOffset = ptr;
            break;
        }
    }

    if (headerEndOffset === 0) throw new Error("Invalid PLY header: end_header not found");

    const textDecoder = new TextDecoder();
    const headerStr = textDecoder.decode(buffer.slice(0, headerEndOffset));
    const headerLines = headerStr.split(/\r?\n/);

    let count = 0;
    const props: { name: string, type: string, offset: number }[] = [];
    const comments: string[] = [];
    let currentOffset = 0;

    const typeSizes: Record<string, number> = {
        'char': 1, 'uchar': 1, 'int8': 1, 'uint8': 1,
        'short': 2, 'ushort': 2, 'int16': 2, 'uint16': 2,
        'int': 4, 'uint': 4, 'int32': 4, 'uint32': 4,
        'float': 4, 'float32': 4,
        'double': 8, 'float64': 8
    };

    for (const line of headerLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length === 0) continue;

        if (parts[0] === "comment") {
            comments.push(parts.slice(1).join(" "));
        } else if (parts[0] === "element" && parts[1] === "vertex") {
            count = parseInt(parts[2]);
        } else if (parts[0] === "property") {
            const type = parts[1];
            const name = parts[2];
            const size = typeSizes[type];
            if (!size) throw new Error(`Unsupported Property Type: ${type}`);
            props.push({ type, name, offset: currentOffset });
            currentOffset += size;
        }
    }

    const rowSize = currentOffset;
    if (headerEndOffset + count * rowSize > buffer.byteLength) {
        console.warn(`[PlyParser] buffer too short! Expected ${headerEndOffset + count * rowSize}, got ${buffer.byteLength}. Truncating count.`);
        count = Math.floor((buffer.byteLength - headerEndOffset) / rowSize);
    }

    // Prepare result containers (Float32 for all, converted)
    const resultProps: { [name: string]: Float32Array } = {};
    for (const p of props) resultProps[p.name] = new Float32Array(count);

    const dataView = new DataView(buffer, headerEndOffset);

    for (let i = 0; i < count; i++) {
        const rowStart = i * rowSize;

        for (const p of props) {
            const off = rowStart + p.offset;
            let val = 0;
            switch (p.type) {
                case 'char': case 'int8': val = dataView.getInt8(off); break;
                case 'uchar': case 'uint8': val = dataView.getUint8(off); break;
                case 'short': case 'int16': val = dataView.getInt16(off, true); break;
                case 'ushort': case 'uint16': val = dataView.getUint16(off, true); break;
                case 'int': case 'int32': val = dataView.getInt32(off, true); break;
                case 'uint': case 'uint32': val = dataView.getUint32(off, true); break;
                case 'float': case 'float32': val = dataView.getFloat32(off, true); break;
                case 'double': case 'float64': val = dataView.getFloat64(off, true); break;
            }
            resultProps[p.name][i] = val;
        }
    }

    return { count, properties: resultProps, comments };
}

// -----------------------------
// ZipPly Class
// -----------------------------
export class ZipPly {
    async compress(plyBuffer: ArrayBuffer, options: {
        pcaDim?: number,
        xyzBits?: number,
        attrBits?: number
    } = {}, onProgress?: (p: number, msg: string) => void) {
        // Standard Defaults
        const pcaDim = options.pcaDim ?? 12;
        const xyz_bd = options.xyzBits ?? 20;
        const xyz_MSB = Math.floor(xyz_bd / 2);
        const bd = options.attrBits ?? 10;

        await tf.ready();
        try {
            setWasmPaths('/');
            await tf.setBackend('wasm');
        } catch (e) {
            console.warn("WASM backend failed, falling back to default.", e);
        }

        if (onProgress) onProgress(0, "PARSING PLY...");
        console.log("Parsing PLY...");
        const ply = await parsePly(plyBuffer);
        const sidelen = Math.floor(Math.sqrt(ply.count));
        const N = sidelen * sidelen;

        // 1. PCA for f_rest
        if (onProgress) onProgress(10, "COMPUTING PCA COLORS...");
        console.log("Computing PCA...");
        const f_rest_keys = Array.from({ length: 45 }, (_, i) => `f_rest_${i}`);
        const fRestData = new Float32Array(N * 45);
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < 45; j++) {
                fRestData[i * 45 + j] = ply.properties[f_rest_keys[j]]?.[i] || 0;
            }
        }
        const { projected, components, mean } = await computePCA(tf.tensor2d(fRestData, [N, 45]), pcaDim);
        const pcaValues = await projected.data();

        // 2. 3D Morton Sorting (Initial localized order)
        if (onProgress) onProgress(20, "MORTON SORTING...");
        console.log("Morton sorting...");
        const x = ply.properties.x, y = ply.properties.y, z = ply.properties.z;

        // Helper to find min/max without stack overflow (spread operator fails on large arrays)
        const getMinMax = (arr: Float32Array) => {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < N; i++) {
                const v = arr[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
            return { min, max };
        };

        const xRange = getMinMax(x.subarray(0, N));
        const yRange = getMinMax(y.subarray(0, N));
        const zRange = getMinMax(z.subarray(0, N));
        const xmin = xRange.min, xmax = xRange.max;
        const ymin = yRange.min, ymax = yRange.max;
        const zmin = zRange.min, zmax = zRange.max;

        const codes3D = new BigUint64Array(N);
        for (let i = 0; i < N; i++) {
            const qx = Math.floor((x[i] - xmin) / (xmax - xmin + 1e-8) * 65535);
            const qy = Math.floor((y[i] - ymin) / (ymax - ymin + 1e-8) * 65535);
            const qz = Math.floor((z[i] - zmin) / (zmax - zmin + 1e-8) * 65535);
            codes3D[i] = morton3D(qx, qy, qz, 16);
        }
        const sort1 = Array.from({ length: N }, (_, i) => i).sort((a, b) => codes3D[a] < codes3D[b] ? -1 : 1);

        // 2D Morton Mapping
        const codes2D = new BigUint64Array(N);
        for (let i = 0; i < N; i++) {
            codes2D[i] = morton2D(i % sidelen, Math.floor(i / sidelen), 16);
        }
        const sort2 = Array.from({ length: N }, (_, i) => i).sort((a, b) => codes2D[a] < codes2D[b] ? -1 : 1);

        const finalToOrig = new Int32Array(N);
        for (let i = 0; i < N; i++) finalToOrig[sort2[i]] = sort1[i];

        // 3. MiniPLAS Optimization to refine mapping
        // We optimize for smoothness across position, color, and scale
        if (onProgress) onProgress(30, "MAPPING INIT...");
        const optimizeParams = new Float32Array(N * 9);
        for (let i = 0; i < N; i++) {
            optimizeParams[i * 9 + 0] = (x[i] - xmin) / (xmax - xmin + 1e-8);
            optimizeParams[i * 9 + 1] = (y[i] - ymin) / (ymax - ymin + 1e-8);
            optimizeParams[i * 9 + 2] = (z[i] - zmin) / (zmax - zmin + 1e-8);
            optimizeParams[i * 9 + 3] = sh2rgb(ply.properties.f_dc_0[i]);
            optimizeParams[i * 9 + 4] = sh2rgb(ply.properties.f_dc_1[i]);
            optimizeParams[i * 9 + 5] = sh2rgb(ply.properties.f_dc_2[i]);
            optimizeParams[i * 9 + 6] = ply.properties.scale_0[i];
            optimizeParams[i * 9 + 7] = ply.properties.scale_1[i];
            optimizeParams[i * 9 + 8] = ply.properties.scale_2[i];
        }

        // Manual iteration handling for progress updates
        console.log(`Starting MiniPLAS optimization...`);
        const iterations = 3;
        for (let iter = 0; iter < iterations; iter++) {
            if (onProgress) onProgress(40 + iter * 10, `OPTIMIZING MAPPING (ITER ${iter + 1})...`);
            await optimizeMapping(finalToOrig, optimizeParams, sidelen, 9, 1);
        }

        // 4. Packaging and Quantization
        if (onProgress) onProgress(70, "QUANTIZING AND PACKING...");
        console.log("Quantizing and packing...");
        const zip = new JSZip();
        const meta: any = {
            xyz_bd, xyz_MSB, AC_dim: pcaDim,
            f_dc_bd: bd, f_rest_bd: bd, opacity_bd: bd, scale_bd: bd, rot_bd: bd, lifetime_bd: bd,
            sidelen, ply_comments: ply.comments,
            xyz_min: [xmin, ymin, zmin], xyz_max: [xmax, ymax, zmax],
            compression_mode: "raw"
        };

        const pack = (name: string, data: Float32Array[], bits: number, pack3: boolean = true) => {
            const C = data.length;
            const mins = data.map(d => {
                let m = Infinity;
                for (let i = 0; i < N; i++) if (d[i] < m) m = d[i];
                return m;
            });
            const maxs = data.map(d => {
                let m = -Infinity;
                for (let i = 0; i < N; i++) if (d[i] > m) m = d[i];
                return m;
            });
            const limit = Math.pow(2, bits) - 1;
            const out = bits > 8 ? new Uint16Array(N * (pack3 ? 3 : C)) : new Uint8Array(N * (pack3 ? 3 : C));

            for (let i = 0; i < N; i++) {
                const orig = finalToOrig[i];
                for (let c = 0; c < C; c++) {
                    const q = Math.max(0, Math.min(limit, Math.round((data[c][orig] - mins[c]) / (maxs[c] - mins[c] + 1e-8) * limit)));
                    out[i * (pack3 ? 3 : C) + c] = q;
                }
                if (pack3 && C < 3) {
                    for (let c = C; c < 3; c++) out[i * 3 + c] = Math.floor(limit / 2);
                }
            }
            zip.file(name + ".bin", out.buffer);
            return { min: mins, max: maxs };
        };

        // XYZ split
        {
            const high = new Uint16Array(N * 3), low = new Uint16Array(N * 3);
            const lsb = xyz_bd - xyz_MSB;
            const limit = Math.pow(2, xyz_bd) - 1;
            const xyz = [x, y, z];
            for (let i = 0; i < N; i++) {
                const orig = finalToOrig[i];
                for (let c = 0; c < 3; c++) {
                    const q = Math.max(0, Math.min(limit, Math.round((xyz[c][orig] - meta.xyz_min[c]) / (meta.xyz_max[c] - meta.xyz_min[c] + 1e-8) * limit)));
                    high[i * 3 + c] = q >> lsb;
                    low[i * 3 + c] = q & ((1 << lsb) - 1);
                }
            }
            zip.file("xyz_1.bin", high.buffer);
            zip.file("xyz_2.bin", low.buffer);
        }

        // f_dc
        const f_dc = [ply.properties.f_dc_0, ply.properties.f_dc_1, ply.properties.f_dc_2].map(d => new Float32Array(d.subarray(0, N)).map(sh2rgb));
        const f_dc_q = pack("f_dc", f_dc, bd);
        meta.f_dc_min = f_dc_q.min; meta.f_dc_max = f_dc_q.max;

        // f_rest (PCA)
        const pcaMin = [], pcaMax = [];
        for (let j = 0; j < pcaDim; j++) {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < N; i++) {
                const val = pcaValues[i * pcaDim + j];
                if (val < min) min = val;
                if (val > max) max = val;
            }
            pcaMin.push(min); pcaMax.push(max);
        }
        meta.f_rest_min = pcaMin; meta.f_rest_max = pcaMax;

        for (let i = 0; i < pcaDim / 3; i++) {
            const out = bd > 8 ? new Uint16Array(N * 3) : new Uint8Array(N * 3);
            const limit = Math.pow(2, bd) - 1;
            for (let k = 0; k < N; k++) {
                const orig = finalToOrig[k];
                for (let c = 0; c < 3; c++) {
                    const idx = i + c * (pcaDim / 3);
                    const val = pcaValues[orig * pcaDim + idx];
                    out[k * 3 + c] = Math.max(0, Math.min(limit, Math.round((val - pcaMin[idx]) / (pcaMax[idx] - pcaMin[idx] + 1e-8) * limit)));
                }
            }
            zip.file(`f_rest_${(i + 1).toString().padStart(3, "0")}.bin`, out.buffer);
        }

        // Others
        const opacity_q = pack("opacity", [ply.properties.opacity], bd);
        meta.opacity_min = opacity_q.min[0]; meta.opacity_max = opacity_q.max[0];

        const scale_q = pack("scale", [ply.properties.scale_0, ply.properties.scale_1, ply.properties.scale_2], bd);
        meta.scale_min = scale_q.min; meta.scale_max = scale_q.max;

        const rot0_q = pack("rotation_0", [ply.properties.rot_0, ply.properties.rot_1, ply.properties.rot_2], bd);
        const rot1_q = pack("rotation_1", [ply.properties.rot_3], bd);
        meta.rot_min = [rot0_q.min[0], rot0_q.min[1], rot0_q.min[2], rot1_q.min[0]];
        meta.rot_max = [rot0_q.max[0], rot0_q.max[1], rot0_q.max[2], rot1_q.max[0]];

        if (ply.properties.lifetime_mu && ply.properties.lifetime_w && ply.properties.lifetime_k) {
            const life_q = pack("lifetime", [ply.properties.lifetime_mu, ply.properties.lifetime_w, ply.properties.lifetime_k], bd);
            meta.lifetime_min = life_q.min; meta.lifetime_max = life_q.max;
        }

        if (onProgress) onProgress(80, "PACKING METADATA...");
        zip.file("metadata.json", JSON.stringify(meta, null, 4));
        zip.file("pca_AC_all.json", JSON.stringify({
            components: await components.array(),
            mean: await mean.array()
        }, null, 4));

        if (onProgress) onProgress(90, "GENERATING ZIP FILE...");
        console.log("Generating zip...");
        const isNode = typeof process !== 'undefined' && process.release && process.release.name === 'node';
        const type = isNode ? 'nodebuffer' : 'blob';
        const result = await zip.generateAsync({
            type: type as any,
            compression: "DEFLATE"
        }, (meta) => {
            if (onProgress && meta.percent) onProgress(90 + (meta.percent * 0.1), `GENERATING ZIP (${Math.floor(meta.percent)}%)...`);
        });

        if (onProgress) onProgress(100, "COMPRESSION COMPLETE");
        return result;
    }
}


