import JSZip from 'jszip';
import * as pc from 'playcanvas';

/**
 * TrueSplatsLoader #WDD 2026-01-15
 * Handles .truesplats (ZIP) files containing static.sog and data.bin.
 */
export class TrueSplatsLoader {
    private app: pc.Application;

    constructor(app: pc.Application) {
        this.app = app;
    }

    async load(file: File | ArrayBuffer, onProgress?: (p: number, msg: string) => void): Promise<any> {
        const buffer = file instanceof File ? await file.arrayBuffer() : file;
        const zip = new JSZip();
        await zip.loadAsync(buffer);

        const sogFile = zip.file('static.sog');
        const binFile = zip.file('data.bin');

        if (!sogFile || !binFile) {
            throw new Error("Invalid .truesplats format: missing static.sog or data.bin");
        }

        const sogBuffer = await sogFile.async('arraybuffer');
        const staticResult = await this.parseSOG(sogBuffer, (p, msg) => {
            if (onProgress) onProgress(p * 0.5, msg);
        });

        const binBuffer = await binFile.async('arraybuffer');
        const trajectoryResult = await this.parseBIN(binBuffer, staticResult.count, (p, msg) => {
            if (onProgress) onProgress(50 + p * 0.5, msg);
        });

        // Apply trajectory to properties
        const props = staticResult.plyData.elements[0].properties;
        const pVx = props.find((p: any) => p.name === 'vx');
        const pVy = props.find((p: any) => p.name === 'vy');
        const pVz = props.find((p: any) => p.name === 'vz');
        if (pVx && pVy && pVz && trajectoryResult.vx) {
            (pVx.storage as any).set(trajectoryResult.vx);
            (pVy.storage as any).set(trajectoryResult.vy);
            (pVz.storage as any).set(trajectoryResult.vz);
        }

        return {
            ...staticResult,
            trajectory: trajectoryResult
        };
    }

    private async parseSOG(buffer: ArrayBuffer, onProgress: (p: number, msg: string) => void) {
        onProgress(0, "Extracting SOG");
        const zip = new JSZip();
        await zip.loadAsync(buffer);

        const metaFile = zip.file('meta.json');
        if (!metaFile) throw new Error("SOG missing meta.json");
        const meta = JSON.parse(await metaFile.async('string'));

        const count = meta.count;
        onProgress(10, "Decoding Prop Textures");
        const props: Record<string, Uint8Array> = {};
        for (const [propName, fileName] of Object.entries(meta.files)) {
            const file = zip.file(fileName as string);
            if (!file) continue;
            const blob = await file.async('blob');
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) continue;
            ctx.drawImage(bitmap, 0, 0);
            props[propName] = new Uint8Array(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer);
            bitmap.close();
        }

        onProgress(80, "Reconstructing Properties");
        const data: any = {
            x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
            opacity: new Float32Array(count),
            scale_0: new Float32Array(count), scale_1: new Float32Array(count), scale_2: new Float32Array(count),
            rot_0: new Float32Array(count), rot_1: new Float32Array(count), rot_2: new Float32Array(count), rot_3: new Float32Array(count),
            f_dc_0: new Float32Array(count), f_dc_1: new Float32Array(count), f_dc_2: new Float32Array(count),
            lifetime_mu: new Float32Array(count), lifetime_w: new Float32Array(count), lifetime_k: new Float32Array(count),
            vx: new Float32Array(count), vy: new Float32Array(count), vz: new Float32Array(count),
            t_start: new Float32Array(count), duration: new Float32Array(count)
        };
        for (let i = 0; i < 45; i++) data[`f_rest_${i}`] = new Float32Array(count);

        // --- Reconstruction: Means ---
        if (props.means_U && props.means_L) {
            const min = meta.mins.means, max = meta.maxs.means;
            for (let i = 0; i < count; i++) {
                for (let j = 0; j < 3; j++) {
                    const val = (props.means_U[i * 4 + j] << 8) | props.means_L[i * 4 + j];
                    const lx = (val / 65535.0) * (max[j] - min[j]) + min[j];
                    const v = Math.sign(lx) * (Math.exp(Math.abs(lx)) - 1);
                    if (j === 0) data.x[i] = v; else if (j === 1) data.y[i] = v; else data.z[i] = v;
                }
            }
        }

        // --- Reconstruction: Rotations ---
        if (props.rotation) {
            const sqrt2 = Math.sqrt(2);
            for (let i = 0; i < count; i++) {
                const r = props.rotation[i * 4], g = props.rotation[i * 4 + 1], b = props.rotation[i * 4 + 2], a = props.rotation[i * 4 + 3];
                const k = a % 4;
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

        // --- Reconstruction: Opacity ---
        if (props.opacity) {
            for (let i = 0; i < count; i++) {
                const alpha = Math.max(0.0001, Math.min(0.9999, props.opacity[i * 4 + 3] / 255.0));
                data.opacity[i] = Math.log(alpha / (1 - alpha));
            }
        }

        // --- Reconstruction: Lifetime (mu, w) ---
        if (props.lifetime) {
            const minMu = meta.mins.mu || 0, maxMu = meta.maxs.mu || 100;
            const minW = meta.mins.w || 0, maxW = meta.maxs.w || 10;
            for (let i = 0; i < count; i++) {
                const mu = (props.lifetime[i * 4 + 0] / 255.0) * (maxMu - minMu) + minMu;
                const w = (props.lifetime[i * 4 + 1] / 255.0) * (maxW - minW) + minW;
                data.lifetime_mu[i] = mu;
                data.lifetime_w[i] = w;
                data.lifetime_k[i] = 10.0;
                data.t_start[i] = mu - w;
                data.duration[i] = 2.0 * w;
            }
        }

        // Package as elements
        const properties = Object.entries(data).map(([name, storage]) => ({ name, type: 'float', storage }));
        return {
            plyData: { elements: [{ name: 'vertex', count, properties }] },
            count,
            is4DGS: true,
            maxMu: meta.maxs.mu || 100
        };
    }

    private async parseBIN(buffer: ArrayBuffer, count: number, onProgress: (p: number, msg: string) => void) {
        onProgress(0, "Decoding Trajectory");
        const frames = new DataView(buffer).getUint32(0, true);
        const offsets = new Int16Array(buffer, 4);

        // Calculate average velocity from DPCM offsets
        // Each frame (except frame 0) has 'count' offsets (x, y, z)
        const vx = new Float32Array(count);
        const vy = new Float32Array(count);
        const vz = new Float32Array(count);

        if (frames > 1) {
            const totalOffsets = (frames - 1) * count * 3;
            // Only scan if we have data
            if (offsets.length >= totalOffsets) {
                for (let i = 0; i < count; i++) {
                    let sumX = 0, sumY = 0, sumZ = 0;
                    for (let f = 0; f < frames - 1; f++) {
                        const idx = (f * count + i) * 3;
                        sumX += offsets[idx];
                        sumY += offsets[idx + 1];
                        sumZ += offsets[idx + 2];
                    }
                    // Scale factor? Let's assume 1.0 for now or find in meta
                    vx[i] = sumX / (frames - 1) / 1000.0; // Assume 1/1000 scale for int16
                    vy[i] = sumY / (frames - 1) / 1000.0;
                    vz[i] = sumZ / (frames - 1) / 1000.0;
                }
            }
        }

        return { frames, vx, vy, vz };
    }
}
