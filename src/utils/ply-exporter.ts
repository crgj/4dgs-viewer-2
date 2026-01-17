import {
    GSplatData,
    Vec3,
    Quat
} from 'playcanvas';
import JSZip from 'jszip';

// Helper to sigmoid (matches Python/Shader)
const sigmoid = (x: number) => 1.0 / (1.0 + Math.exp(-x));
const logit = (x: number) => Math.log(x / (1.0 - x));

export class PlyExporter {

    static async exportSequence(data: any, totalFrames: number, filenamePrefix: string = "frame") {
        const zip = new JSZip();

        console.log("Starting PLY Sequence Export...");
        console.log(`Total Points: ${data.count}, Frames: ${totalFrames}`);

        // Data Accessors
        // Note: The loader attaches extra data to GSplatData
        const traj = data.trajectory as Float32Array; // [N * K * 3]
        const rotTraj = data.rotTrajectory as Float32Array; // [N * K * 4]

        const mus = data.lifetime_mu as Float32Array;
        const ws = data.lifetime_w as Float32Array;

        const K_xyz = data.keyframes || 0;
        const K_rot = data.rotKeyframes || 0;
        const xyzStride = data.xyzStride || 1;
        const rotStride = data.rotStride || xyzStride;

        // Static/Base Props (reconstruct from component arrays if needed, or assume data has them)
        // GSplatData struct usually separates them.
        // But our custom loader might have them accessable.
        // Let's look at how main.ts handles them. 
        // main.ts gets 'data' from loader.
        // The loader returns { plyData: ..., count: ... } and likely attaches arrays.
        // Wait, standard GSplatData stores component data in `data.component[i]`.
        // But for "Export", we want the RAW values.
        // Let's access the plyData elements directly if possible.

        // Actually, the easiest way is to re-read the component data.
        const vertexElement = data.plyData.elements[0];

        // Helpers to get property array
        const getProp = (name: string) => {
            const prop = vertexElement.properties.find((p: any) => p.name === name);
            return prop ? prop.storage : null; // Float32Array
        };

        const xArr = getProp('x');
        const yArr = getProp('y');
        const zArr = getProp('z');
        const f_dc_0 = getProp('f_dc_0');
        const f_dc_1 = getProp('f_dc_1');
        const f_dc_2 = getProp('f_dc_2');
        const opacity = getProp('opacity');
        const scale_0 = getProp('scale_0');
        const scale_1 = getProp('scale_1');
        const scale_2 = getProp('scale_2');
        const rot_0 = getProp('rot_0');
        const rot_1 = getProp('rot_1');
        const rot_2 = getProp('rot_2');
        const rot_3 = getProp('rot_3');

        // Re-usable vectors
        const p0 = new Vec3();
        const p1 = new Vec3();
        const pMix = new Vec3();

        const q0 = new Quat();
        const q1 = new Quat();
        const qMix = new Quat();

        for (let t = 0; t < totalFrames; t++) {
            let validCount = 0;
            // First pass: Count valid
            // Or just build huge array and slice? 
            // Better to push to array.

            // We'll construct a string header + binary body? 
            // Or just ASCII for simplicity? Binary is fast.
            // Let's do ASCII PLY for maximum compatibility if small, or Binary Little Endian.
            // Binary is better for logic.

            // Buffers to hold frame data
            const indices: number[] = [];

            // 1. Filter & Interpolate (Simulate Shader)
            for (let i = 0; i < data.count; i++) {
                const mu = mus[i];
                const w = ws[i];

                // --- LIFETIME CHECK (Matching Shader Hard Cutoff) ---
                // "if (t < (mu - w) || t > (mu + w)) visibility = 0.0"
                if (t < (mu - w) || t > (mu + w)) {
                    continue;
                }

                // Sigmoid gate for opacity logic (Soft fade inside window)
                // Reference python script: gate = sigmoid(...) * sigmoid(...)
                const argLeft = 10.0 * (t - (mu - w));
                const argRight = 10.0 * ((mu + w) - t);
                const gate = sigmoid(argLeft) * sigmoid(argRight);

                // Base Opacity
                // Standard 3DGS stores opacity as Logit.
                // Our loader stores it as 0-1 probability likely?
                // Let's check loader. Loader: "opacity[i] = texData / 255.0". Yes 0-1.
                // So we need inv_sigmoid to save back as logit? Or save as is?
                // Python script reconstruct logic: "base_opac_active = sigmoid(opac_logit)"
                // So input PLY meant logit.
                // But our loader decoded it to 0-1.
                // Let's assume `opacity` array here is 0-1.
                const opacBase = opacity ? opacity[i] : 1.0;

                // Final Opacity
                const opacActive = opacBase * gate;
                if (opacActive < 0.01) continue; // Skip invisible

                indices.push(i);
            }

            const N = indices.length;
            if (N === 0) continue;

            // 2. Build PLY Body (Binary Little Endian)
            // Stride per vertex: 
            // x,y,z (12) + nx,ny,nz (12) + f_dc(3*4=12) + f_rest(0) + opacity(4) + scale(12) + rot(16)
            // Total: 68 bytes per point?
            // Need standard 3DGS PLY property layout.
            // x,y,z, nx,ny,nz, f_dc_0,1,2, opacity, scale_0,1,2, rot_0,1,2,3

            const rowSize = 3 * 4 + 3 * 4 + 3 * 4 + 4 + 3 * 4 + 4 * 4; // 12+12+12+4+12+16 = 68 bytes
            const buffer = new ArrayBuffer(N * rowSize);
            const view = new DataView(buffer);

            let offset = 0;

            // XYZ Interpolation Helpers
            const kXYZ = K_xyz;
            const strideXYZ = xyzStride;

            // Traj Logic
            const idx0 = Math.floor(t / strideXYZ);
            let idx1 = idx0 + 1;
            const t_local_xyz = (t - idx0 * strideXYZ) / strideXYZ;

            // Clamp indices
            let i0_xyz = idx0;
            let i1_xyz = idx1;
            if (i0_xyz >= kXYZ - 1) i0_xyz = kXYZ - 1;
            if (i1_xyz >= kXYZ) i1_xyz = kXYZ - 1; // Clamp to last
            // Wait, interpolation logic: if t > max, clamp? 
            // Shader does bounds check.
            if (i0_xyz >= kXYZ) i0_xyz = kXYZ - 1;
            if (i1_xyz >= kXYZ) i1_xyz = kXYZ - 1;

            for (let k = 0; k < N; k++) {
                const i = indices[k];

                // Position
                let px = 0, py = 0, pz = 0;
                if (traj && kXYZ > 0) {
                    // Fetch P0
                    const base0 = (i * kXYZ + i0_xyz) * 3;
                    p0.set(traj[base0], traj[base0 + 1], traj[base0 + 2]);

                    // Fetch P1
                    const base1 = (i * kXYZ + i1_xyz) * 3;
                    p1.set(traj[base1], traj[base1 + 1], traj[base1 + 2]);

                    pMix.lerp(p0, p1, t_local_xyz);
                    px = pMix.x; py = pMix.y; pz = pMix.z;
                } else {
                    px = xArr ? xArr[i] : 0;
                    py = yArr ? yArr[i] : 0;
                    pz = zArr ? zArr[i] : 0;
                }

                // Write XYZ
                view.setFloat32(offset + 0, px, true);
                view.setFloat32(offset + 4, py, true);
                view.setFloat32(offset + 8, pz, true);

                // Normals (Zero)
                view.setFloat32(offset + 12, 0, true);
                view.setFloat32(offset + 16, 0, true);
                view.setFloat32(offset + 20, 0, true);

                // f_dc
                view.setFloat32(offset + 24, f_dc_0 ? f_dc_0[i] : 0, true);
                view.setFloat32(offset + 28, f_dc_1 ? f_dc_1[i] : 0, true);
                view.setFloat32(offset + 32, f_dc_2 ? f_dc_2[i] : 0, true);

                // Re-calculate opacity for this point at this time `t`
                const mu = mus[i];
                const w = ws[i];
                const argLeft = 10.0 * (t - (mu - w));
                const argRight = 10.0 * ((mu + w) - t);
                const gate = sigmoid(argLeft) * sigmoid(argRight);

                const opacBase = opacity ? opacity[i] : 1.0;
                const opacActive = opacBase * gate;

                // NOTE: Using the calculated `opacActive` which includes the Lifetime Fade.
                const oa = opacBase * 1.0; // Wait, should we bake the gate?
                // User requirement: "Separate by lifetime".
                // If the point is visible, we should probably output its *original* opacity, 
                // but if we want to "bake" the fade in/out, we use opacActive.
                // Let's use `opacActive` to be WYSIWYG.
                let finalOpac = opacActive;
                if (finalOpac < 0.0001) finalOpac = 0.0001;
                if (finalOpac > 0.9999) finalOpac = 0.9999;
                view.setFloat32(offset + 36, logit(finalOpac), true);

                // Scale (Log)
                view.setFloat32(offset + 40, scale_0 ? Math.log(scale_0[i]) : -10, true);
                view.setFloat32(offset + 44, scale_1 ? Math.log(scale_1[i]) : -10, true);
                view.setFloat32(offset + 48, scale_2 ? Math.log(scale_2[i]) : -10, true);

                // Rotation
                // Interpolation todo if traj exists. 
                // For now use static.
                view.setFloat32(offset + 52, rot_0 ? rot_0[i] : 1, true);
                view.setFloat32(offset + 56, rot_1 ? rot_1[i] : 0, true);
                view.setFloat32(offset + 60, rot_2 ? rot_2[i] : 0, true);
                view.setFloat32(offset + 64, rot_3 ? rot_3[i] : 0, true);

                offset += rowSize;
            }

            // Header
            const header = `ply
format binary_little_endian 1.0
element vertex ${N}
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
end_header
`;

            // Combine Header + Body
            const headerBlob = new Blob([header]);
            const bodyBlob = new Blob([buffer]);
            const combined = new Blob([headerBlob, bodyBlob]);

            zip.file(`${filenamePrefix}_${t.toString().padStart(4, '0')}.ply`, combined);

            if (t % 10 === 0) console.log(`Processed Frame ${t}`);
        }

        console.log("Zipping...");
        return await zip.generateAsync({ type: "blob" });
    }
}
