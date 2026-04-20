import * as pc from 'playcanvas';
import JSZip from 'jszip';

// Helper to sigmoid (matches Python/Shader) #WDD 2026-01-16
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));
const logit = (v: number) => {
    const p = Math.max(1e-7, Math.min(1.0 - 1e-7, v));
    return Math.log(p / (1.0 - p));
};

const getRenderedBaseAlpha = (rawOpacity: number, semantic: string | undefined) => {
    const prob = semantic === 'logit' ? sigmoid(rawOpacity) : rawOpacity;
    const clampedProb = Math.max(0.0, Math.min(1.0, prob));
    const quantized = Math.max(0, Math.min(255, Math.floor(clampedProb * 255.0)));
    return quantized / 255.0;
};

const evalLifetimeOpacity = (mu: number, w: number, k: number, t: number, globalTotalFrames: number) => {
    const segmentMax = globalTotalFrames > 0 ? Math.max(0, globalTotalFrames - 1) : 1e20;
    if (t < 0 || t > segmentMax) return 0.0;

    const lifeStart = mu - w;
    const lifeEnd = mu + w;
    if (lifeEnd <= 0 || lifeStart >= segmentMax || lifeEnd <= lifeStart) return 0.0;

    const argLeft = k * (t - lifeStart);
    const left = 1.0 / (1.0 + Math.exp(-argLeft));
    const argRight = -k * (t - lifeEnd);
    const right = 1.0 / (1.0 + Math.exp(-argRight));
    return left * right;
};

const slerpQuat = (
    q0: [number, number, number, number],
    q1: [number, number, number, number],
    t: number
): [number, number, number, number] => {
    let dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];

    if (dot < 0) {
        q1 = [-q1[0], -q1[1], -q1[2], -q1[3]];
        dot = -dot;
    }

    if (dot > 0.9995) {
        const result: [number, number, number, number] = [
            q0[0] + t * (q1[0] - q0[0]),
            q0[1] + t * (q1[1] - q0[1]),
            q0[2] + t * (q1[2] - q0[2]),
            q0[3] + t * (q1[3] - q0[3])
        ];
        const len = Math.hypot(result[0], result[1], result[2], result[3]) || 1.0;
        return [result[0] / len, result[1] / len, result[2] / len, result[3] / len];
    }

    const theta0 = Math.acos(dot);
    const theta = theta0 * t;
    const sinTheta = Math.sin(theta);
    const sinTheta0 = Math.sin(theta0);
    const s0 = Math.cos(theta) - dot * sinTheta / sinTheta0;
    const s1 = sinTheta / sinTheta0;

    return [
        q0[0] * s0 + q1[0] * s1,
        q0[1] * s0 + q1[1] * s1,
        q0[2] * s0 + q1[2] * s1,
        q0[3] * s0 + q1[3] * s1
    ];
};

export interface TextureParams {
    keyframes: number;
    xyzStride: number;
    rotKeyframes: number;
    rotStride: number;
    dcKeyframes?: number;
    dcStride?: number;
    texWidth: number;
}

export class PlyExporter {

    /**
     * Reconstructs a PLY frame using the EXACT logic sent to the GPU.
     * #WDD 2026-01-16: Verification path for 4D pipeline sync.
     */
    static async exportFrameFromTextures(
        numSplats: number,
        t: number,
        duration: number,
        lifeTex: Float32Array | null,
        trajTex: Float32Array | null,
        rotTex: Float32Array | null,
        dcTex: Float32Array | null,
        scalesTex: Float32Array, // #WDD 2026-01-16 Added for full texture sync
        params: TextureParams,
        staticData: any // Original parsed data for SH, static opacity etc.
    ): Promise<ArrayBuffer> {
        const { keyframes: K, xyzStride, rotKeyframes: Krot, rotStride, dcKeyframes = 0, dcStride = 1 } = params;

        // 3DGS PLY format: x,y,z (12), nx,ny,nz (12), f_dc_0,1,2 (12), opacity (4), scale_0,1,2 (12), rot_0,1,2,3 (16)
        // Plus f_rest_0..44 (45 * 4 = 180)
        // Total row size: 248 bytes
        const rowSize = 248;
        const outBuffer = new ArrayBuffer(numSplats * rowSize);
        const view = new DataView(outBuffer);

        const getS = (n: string) => {
            if (typeof staticData?.getProp === 'function') {
                return staticData.getProp(n);
            }
            const props = staticData?.plyData?.elements?.[0]?.properties;
            return props?.find((p: any) => p.name === n)?.storage;
        };
        const sh0 = [getS('f_dc_0'), getS('f_dc_1'), getS('f_dc_2')];
        const opacRaw = getS('opacity');
        const origIndices = staticData.originalIndices as Float32Array | null | undefined;
        const opacitySemantic = staticData.opacitySemantic;
        const rotationSemantic = staticData.rotationSemantic === 'xyzw' ? 'xyzw' : 'wxyz';

        const f_rest: any[] = [];
        for (let i = 0; i < 45; i++) f_rest.push(getS(`f_rest_${i}`));

        let validCount = 0;
        const hasLifetime = !!lifeTex && lifeTex.length >= numSplats * 4;

        for (let i = 0; i < numSplats; i++) {
            const oidx = origIndices ? Math.round(origIndices[i]) : i;

            // 4. Opacity & Lifetime
            const baseAlpha = getRenderedBaseAlpha(opacRaw ? opacRaw[i] : 1.0, opacitySemantic);
            let alphaMult = 1.0;
            if (hasLifetime && lifeTex) {
                const lifi = i * 4;
                const mu = lifeTex[lifi + 0];
                const w = lifeTex[lifi + 1];
                const k = Math.max(lifeTex[lifi + 2] || 10.0, 1.0);
                alphaMult = evalLifetimeOpacity(mu, w, k, t, duration);
            }
            const linearAlpha = baseAlpha * alphaMult;

            // Early discard matching shader (0.01)
            if (linearAlpha < 0.01) continue;

            const finalOpacLogit = logit(linearAlpha);

            // 2. Trajectory Interpolation
            let x = getS('x')?.[i] ?? 0, y = getS('y')?.[i] ?? 0, z = getS('z')?.[i] ?? 0;
            if (K > 0 && trajTex) {
                const keyframeMax = Math.max(0, (K - 1) * xyzStride);
                const maxTime = Math.max(0, Math.min(duration - 1, keyframeMax));
                const tClamped = Math.max(0, Math.min(t, maxTime));
                const idx = xyzStride > 0 ? Math.floor(tClamped / xyzStride) : 0;
                const k0 = K <= 1 ? 0 : Math.min(Math.max(0, idx), K - 1);
                const k1 = K <= 1 ? 0 : Math.min(k0 + 1, K - 1);
                const t0 = k0 * xyzStride;
                const t1 = k1 * xyzStride;
                const u = (k0 === k1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));

                const base = oidx * K * 3;
                const idx0 = base + k0 * 3;
                const idx1 = base + k1 * 3;

                x = trajTex[idx0 + 0] * (1 - u) + trajTex[idx1 + 0] * u;
                y = trajTex[idx0 + 1] * (1 - u) + trajTex[idx1 + 1] * u;
                z = trajTex[idx0 + 2] * (1 - u) + trajTex[idx1 + 2] * u;
            }

            // 3. Rotation Interpolation
            let rW = 1.0, rX = 0.0, rY = 0.0, rZ = 0.0;
            if (Krot > 0 && rotTex) {
                const keyframeMax = Math.max(0, (Krot - 1) * rotStride);
                const maxTime = Math.max(0, Math.min(duration - 1, keyframeMax));
                const tClamped = Math.max(0, Math.min(t, maxTime));
                const idx = rotStride > 0 ? Math.floor(tClamped / rotStride) : 0;
                const rk0 = Krot <= 1 ? 0 : Math.min(Math.max(0, idx), Krot - 1);
                const rk1 = Krot <= 1 ? 0 : Math.min(rk0 + 1, Krot - 1);
                const t0 = rk0 * rotStride;
                const t1 = rk1 * rotStride;
                const rt = (rk0 === rk1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));

                const base = oidx * Krot * 4;
                const ridx0 = base + rk0 * 4;
                const ridx1 = base + rk1 * 4;

                const q0 = rotationSemantic === 'xyzw'
                    ? [rotTex[ridx0 + 0], rotTex[ridx0 + 1], rotTex[ridx0 + 2], rotTex[ridx0 + 3]] as [number, number, number, number]
                    : [rotTex[ridx0 + 1], rotTex[ridx0 + 2], rotTex[ridx0 + 3], rotTex[ridx0 + 0]] as [number, number, number, number];
                const q1 = rotationSemantic === 'xyzw'
                    ? [rotTex[ridx1 + 0], rotTex[ridx1 + 1], rotTex[ridx1 + 2], rotTex[ridx1 + 3]] as [number, number, number, number]
                    : [rotTex[ridx1 + 1], rotTex[ridx1 + 2], rotTex[ridx1 + 3], rotTex[ridx1 + 0]] as [number, number, number, number];

                const qr = slerpQuat(q0, q1, rt);
                rX = qr[0];
                rY = qr[1];
                rZ = qr[2];
                rW = qr[3];
            } else {
                const srW = getS('rot_0'), srX = getS('rot_1'), srY = getS('rot_2'), srZ = getS('rot_3');
                rW = srW[i]; rX = srX[i]; rY = srY[i]; rZ = srZ[i];
            }

            // Write Row (Binary Little Endian)
            const off = validCount * rowSize;
            view.setFloat32(off + 0, x, true);
            view.setFloat32(off + 4, y, true);
            view.setFloat32(off + 8, z, true);
            // nx, ny, nz (12-20)
            view.setFloat32(off + 12, 0, true);
            view.setFloat32(off + 16, 0, true);
            view.setFloat32(off + 20, 0, true);

            let dc0 = sh0[0]?.[i] ?? 0;
            let dc1 = sh0[1]?.[i] ?? 0;
            let dc2 = sh0[2]?.[i] ?? 0;
            if (dcKeyframes > 0 && dcTex) {
                const keyframeMax = Math.max(0, (dcKeyframes - 1) * dcStride);
                const maxTime = Math.max(0, Math.min(duration - 1, keyframeMax));
                const tClamped = Math.max(0, Math.min(t, maxTime));
                const idx = dcStride > 0 ? Math.floor(tClamped / dcStride) : 0;
                const dk0 = dcKeyframes <= 1 ? 0 : Math.min(Math.max(0, idx), dcKeyframes - 1);
                const dk1 = dcKeyframes <= 1 ? 0 : Math.min(dk0 + 1, dcKeyframes - 1);
                const t0 = dk0 * dcStride;
                const t1 = dk1 * dcStride;
                const u = (dk0 === dk1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));

                const base = oidx * dcKeyframes * 3;
                const idx0 = base + dk0 * 3;
                const idx1 = base + dk1 * 3;
                dc0 = dcTex[idx0 + 0] * (1 - u) + dcTex[idx1 + 0] * u;
                dc1 = dcTex[idx0 + 1] * (1 - u) + dcTex[idx1 + 1] * u;
                dc2 = dcTex[idx0 + 2] * (1 - u) + dcTex[idx1 + 2] * u;
            }
            // f_dc (24-32)
            view.setFloat32(off + 24, dc0, true);
            view.setFloat32(off + 28, dc1, true);
            view.setFloat32(off + 32, dc2, true);
            // opacity
            view.setFloat32(off + 36, finalOpacLogit, true);
            // scale
            const scIdx = i * 4;
            view.setFloat32(off + 40, scalesTex[scIdx + 0], true);
            view.setFloat32(off + 44, scalesTex[scIdx + 1], true);
            view.setFloat32(off + 48, scalesTex[scIdx + 2], true);
            // rotation (Standard PLY is W,X,Y,Z order)
            view.setFloat32(off + 52, rW, true);
            view.setFloat32(off + 56, rX, true);
            view.setFloat32(off + 60, rY, true);
            view.setFloat32(off + 64, rZ, true);

            // f_rest (68 - 248)
            for (let j = 0; j < 45; j++) {
                view.setFloat32(off + 68 + j * 4, f_rest[j] ? f_rest[j][i] : 0, true);
            }

            validCount++;
        }

        const header = `ply
format binary_little_endian 1.0
element vertex ${validCount}
property float x
property float y
property float z
property float nx
property float ny
property float nz
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
${Array.from({ length: 45 }, (_, j) => `property float f_rest_${j}`).join('\n')}
end_header
`;
        const headArr = new TextEncoder().encode(header);
        const final = new Uint8Array(headArr.length + validCount * rowSize);
        final.set(headArr);
        final.set(new Uint8Array(outBuffer, 0, validCount * rowSize), headArr.length);

        return final.buffer;
    }

    static async exportSequence(data: any, totalFrames: number, filenamePrefix: string = "frame") {
        const zip = new JSZip();
        // Placeholder or simple CPU implementation if needed, but texture-path is preferred for debug.
        // For now, let's keep it as is or leave empty if not used.
        return await zip.generateAsync({ type: "blob" });
    }
}
