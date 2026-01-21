import * as pc from 'playcanvas';
import JSZip from 'jszip';

// Helper to sigmoid (matches Python/Shader) #WDD 2026-01-16
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));
const logit = (v: number) => {
    const p = Math.max(1e-7, Math.min(1.0 - 1e-7, v));
    return Math.log(p / (1.0 - p));
};

export interface TextureParams {
    keyframes: number;
    xyzStride: number;
    rotKeyframes: number;
    rotStride: number;
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
        lifeTex: Float32Array,
        trajTex: Float32Array,
        rotTex: Float32Array,
        scalesTex: Float32Array, // #WDD 2026-01-16 Added for full texture sync
        params: TextureParams,
        staticData: any // Original parsed data for SH, static opacity etc.
    ): Promise<ArrayBuffer> {
        const { keyframes: K, xyzStride, rotKeyframes: Krot, rotStride } = params;

        // 3DGS PLY format: x,y,z (12), nx,ny,nz (12), f_dc_0,1,2 (12), opacity (4), scale_0,1,2 (12), rot_0,1,2,3 (16)
        // Plus f_rest_0..44 (45 * 4 = 180)
        // Total row size: 248 bytes
        const rowSize = 248;
        const outBuffer = new ArrayBuffer(numSplats * rowSize);
        const view = new DataView(outBuffer);

        const props = staticData.plyData.elements[0].properties;
        const getS = (n: string) => props.find((p: any) => p.name === n)?.storage;
        const sh0 = [getS('f_dc_0'), getS('f_dc_1'), getS('f_dc_2')];
        const s0 = getS('scale_0'), s1 = getS('scale_1'), s2 = getS('scale_2');
        const opacRaw = staticData.opacity; // RAW Linear Probability 0-1 #WDD 2026-01-16

        const f_rest: any[] = [];
        for (let i = 0; i < 45; i++) f_rest.push(getS(`f_rest_${i}`));

        let validCount = 0;

        for (let i = 0; i < numSplats; i++) {
            // 4. Opacity & Lifetime
            const lifi = i * 4;
            // mu and w are now raw frame values #WDD 2026-01-16
            const mu = lifeTex[lifi + 0];
            const w = lifeTex[lifi + 1];

            // Hard gate visibility
            const gate = (t >= (mu - w) && t <= (mu + w)) ? 1.0 : 0.0;

            // Opacity is stored as linear probability (0-1) in assets
            const linearAlpha = (opacRaw ? opacRaw[i] : 1.0) * gate;

            // Early discard matching shader (0.01)
            if (linearAlpha < 0.01) continue;

            const finalOpacLogit = logit(linearAlpha);

            // 2. Trajectory Interpolation
            let x = 0, y = 0, z = 0;
            if (K > 0 && trajTex) {
                const k0 = Math.min(Math.floor(t / xyzStride), K - 1);
                const k1 = Math.min(k0 + 1, K - 1);
                const u = (t - k0 * xyzStride) / xyzStride;

                // Shader fetches from uTrajectoryTexture using splatId * K + k
                const idx0 = (i * K + k0) * 4;
                const idx1 = (i * K + k1) * 4;

                x = trajTex[idx0 + 0] * (1 - u) + trajTex[idx1 + 0] * u;
                y = trajTex[idx0 + 1] * (1 - u) + trajTex[idx1 + 1] * u;
                z = trajTex[idx0 + 2] * (1 - u) + trajTex[idx1 + 2] * u;
            }

            // 3. Rotation Interpolation
            // 3. Rotation Interpolation
            let rW = 1.0, rX = 0.0, rY = 0.0, rZ = 0.0;
            if (Krot > 0 && rotTex) {
                const rk0 = Math.min(Math.floor(t / rotStride), Krot - 1);
                const rk1 = Math.min(rk0 + 1, Krot - 1);
                const rt = (t - rk0 * rotStride) / rotStride;

                const ridx0 = (i * Krot + rk0) * 4;
                const ridx1 = (i * Krot + rk1) * 4;

                // Texture is packed as [x, y, z, w] #WDD 2026-01-16
                let q0x = rotTex[ridx0 + 0], q0y = rotTex[ridx0 + 1], q0z = rotTex[ridx0 + 2], q0w = rotTex[ridx0 + 3];
                let q1x = rotTex[ridx1 + 0], q1y = rotTex[ridx1 + 1], q1z = rotTex[ridx1 + 2], q1w = rotTex[ridx1 + 3];

                if (q0x * q1x + q0y * q1y + q0z * q1z + q0w * q1w < 0) {
                    q1x = -q1x; q1y = -q1y; q1z = -q1z; q1w = -q1w;
                }

                rX = q0x * (1 - rt) + q1x * rt;
                rY = q0y * (1 - rt) + q1y * rt;
                rZ = q0z * (1 - rt) + q1z * rt;
                rW = q0w * (1 - rt) + q1w * rt;

                const rlen = Math.sqrt(rX * rX + rY * rY + rZ * rZ + rW * rW);
                rX /= rlen; rY /= rlen; rZ /= rlen; rW /= rlen;
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
            // f_dc (24-32)
            view.setFloat32(off + 24, sh0[0][i], true);
            view.setFloat32(off + 28, sh0[1][i], true);
            view.setFloat32(off + 32, sh0[2][i], true);
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
