
import * as pc from 'playcanvas';

/**
 * PLY4Encoder: Lossless exporter for 4D Gaussian Splatting data.
 * #WDD 2026-03-31: Created for high-fidelity comparison with SOG4.
 */
export class PLY4Encoder {
    /**
     * Encodes 4DGS data into a PLY4 binary buffer.
     * @param data The lastParsedData object from the viewer.
     * @param overrides Options like deleted_indices, model_transform, etc.
     */
    static async encode(data: any, overrides: any = {}, progress?: (pct: number, msg: string) => void): Promise<ArrayBuffer> {
        let count = data.count || 0;
        if (count === 0) throw new Error("No data to encode.");

        progress?.(0, "Initializing PLY4 Encoder...");

        // 1. Filtering Deleted Points
        let indices: number[] = [];
        const selectionData = overrides.selectionData; 
        
        for (let i = 0; i < count; i++) {
            // Check if point is deleted (G channel in selectionData)
            if (selectionData && selectionData[i * 4 + 1] > 0) {
                continue;
            }
            indices.push(i);
        }
        
        const finalCount = indices.length;
        progress?.(10, `Exporting ${finalCount} / ${count} non-deleted points...`);

        // 2. Prepare Metadata
        const totalFrames = data.frames || 1;
        const xyzStride = data.xyzStride || 1;
        const rotStride = data.rotStride || 1;
        const dcStride = data.dcStride || 1;
        const K_xyz = data.keyframes || 0;
        const K_rot = data.rotKeyframes || 0;
        const K_dc = data.dcKeyframes || 0;

        // 3. Define Property Structure & Header
        // Basic: x,y,z, opacity, scale_0..2, rot_0..3, f_dc_0..2, f_rest_0..44
        // Plus Banks
        let header = `ply\nformat binary_little_endian 1.0\n`;
        header += `comment total_frames ${totalFrames}\n`;
        if (K_xyz > 0) header += `comment xyz_bank_keyframe_stride ${xyzStride}\n`;
        if (K_rot > 0) header += `comment rot_bank_keyframe_stride ${rotStride}\n`;
        if (K_dc > 0) header += `comment features_dc_bank_keyframe_stride ${dcStride}\n`;
        
        // #WDD 2026-03-31: Save Model Transform in Header
        if (overrides.model_pos) {
            header += `comment model_pos ${overrides.model_pos.x} ${overrides.model_pos.y} ${overrides.model_pos.z}\n`;
        }
        if (overrides.model_rot) {
            header += `comment model_rot ${overrides.model_rot.x} ${overrides.model_rot.y} ${overrides.model_rot.z} ${overrides.model_rot.w}\n`;
        }
        if (overrides.model_scale) {
            header += `comment model_scale ${overrides.model_scale.x} ${overrides.model_scale.y} ${overrides.model_scale.z}\n`;
        }
        
        header += `element vertex ${finalCount}\n`;
        header += `property float x\nproperty float y\nproperty float z\n`;
        header += `property float opacity\n`;
        header += `property float scale_0\nproperty float scale_1\nproperty float scale_2\n`;
        header += `property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\n`;
        header += `property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n`;
        
        // SH3 (45 coefficients)
        for (let i = 0; i < 45; i++) {
            header += `property float f_rest_${i}\n`;
        }

        // Lifetime params
        header += `property float lifetime_mu\nproperty float lifetime_w\nproperty float lifetime_k\n`;

        // Banks
        if (K_xyz > 0) {
            for (let k = 0; k < K_xyz; k++) {
                header += `property float xyz_bank_${k}_x\nproperty float xyz_bank_${k}_y\nproperty float xyz_bank_${k}_z\n`;
            }
        }
        if (K_rot > 0) {
            for (let k = 0; k < K_rot; k++) {
                header += `property float rot_bank_${k}_x\nproperty float rot_bank_${k}_y\nproperty float rot_bank_${k}_z\nproperty float rot_bank_${k}_w\n`;
            }
        }
        if (K_dc > 0) {
            for (let k = 0; k < K_dc; k++) {
                header += `property float f_dc_bank_${k}_0\nproperty float f_dc_bank_${k}_1\nproperty float f_dc_bank_${k}_2\n`;
            }
        }
        
        header += `end_header\n`;

        // 4. Calculate Binary Size
        // Each property is a float (4 bytes).
        // Row = (3 + 1 + 3 + 4 + 3 + 45 + 3) * 4 + (K_xyz*3 + K_rot*4 + K_dc*3) * 4
        const staticPropsCount = 3 + 1 + 3 + 4 + 3 + 45 + 3; // 62 props
        const bankPropsCount = K_xyz * 3 + K_rot * 4 + K_dc * 3;
        const rowSize = (staticPropsCount + bankPropsCount) * 4;
        
        const outBuffer = new ArrayBuffer(finalCount * rowSize);
        const view = new DataView(outBuffer);
        
        // 5. Unpack Source Arrays
        const p: any = {};
        if (data.plyData?.elements?.[0]?.properties) {
            data.plyData.elements[0].properties.forEach((prop: any) => p[prop.name] = prop.storage);
        } else {
            // Handle flat storage
            p.x = data.x; p.y = data.y; p.z = data.z;
            p.opacity = data.opacity;
            p.scale_0 = data.scale_0; p.scale_1 = data.scale_1; p.scale_2 = data.scale_2;
            p.rot_0 = data.rot_0; p.rot_1 = data.rot_1; p.rot_2 = data.rot_2; p.rot_3 = data.rot_3;
            p.f_dc_0 = data.f_dc_0; p.f_dc_1 = data.f_dc_1; p.f_dc_2 = data.f_dc_2;
            for (let j = 0; j < 45; j++) p[`f_rest_${j}`] = data[`f_rest_${j}`];
            p.lifetime_mu = data.lifetime_mu;
            p.lifetime_w = data.lifetime_w;
            p.lifetime_k = data.lifetime_k;
        }

        const xyzBank = data.trajectory || data.xyzBank;
        const rotBank = data.rotTrajectory || data.rotBank;
        const dcBank = data.dcTrajectory || data.dcBank;

        // 6. Fill Binary Data
        for (let i = 0; i < finalCount; i++) {
            const orgIdx = indices[i];
            const rowOff = i * rowSize;
            let ptr = rowOff;

            const writeF = (v: number) => {
                view.setFloat32(ptr, v || 0, true);
                ptr += 4;
            };

            // Basic
            writeF(p.x[orgIdx]); writeF(p.y[orgIdx]); writeF(p.z[orgIdx]);
            
            // #WDD 2026-03-31: Use raw opacity value. 
            // The viewer's data already contains the correct logit or sigmoid values.
            let opac = p.opacity[orgIdx];
            writeF(opac);

            // #WDD 2026-03-31: 直接写入原始 scale 值，内部已是 log-space，不需要再次 log()
            writeF(p.scale_0[orgIdx]);
            writeF(p.scale_1[orgIdx]);
            writeF(p.scale_2[orgIdx]);
            
            // #WDD 2026-03-31: 内部格式 rot_0=x, rot_1=y, rot_2=z, rot_3=w，直接对应 PLY 属性名，无需 Swizzle
            writeF(p.rot_0[orgIdx]); // x
            writeF(p.rot_1[orgIdx]); // y
            writeF(p.rot_2[orgIdx]); // z
            writeF(p.rot_3[orgIdx]); // w
            writeF(p.f_dc_0[orgIdx]); writeF(p.f_dc_1[orgIdx]); writeF(p.f_dc_2[orgIdx]);

            for (let j = 0; j < 45; j++) {
                writeF(p[`f_rest_${j}`] ? p[`f_rest_${j}`][orgIdx] : 0);
            }

            writeF(p.lifetime_mu[orgIdx]); writeF(p.lifetime_w[orgIdx]); writeF(p.lifetime_k ? p.lifetime_k[orgIdx] : 10.0);

            // Banks
            if (K_xyz > 0 && xyzBank) {
                const base = orgIdx * K_xyz * 3;
                for (let k = 0; k < K_xyz * 3; k++) writeF(xyzBank[base + k]);
            }
            if (K_rot > 0 && rotBank) {
                const base = orgIdx * K_rot * 4;
                for (let k = 0; k < K_rot; k++) {
                    const off = base + k * 4;
                    // #WDD 2026-03-31: 内部 rotBank 格式是 [x, y, z, w]，直接按顺序写入
                    // rot_bank_k_x / rot_bank_k_y / rot_bank_k_z / rot_bank_k_w
                    writeF(rotBank[off + 0]); // x
                    writeF(rotBank[off + 1]); // y
                    writeF(rotBank[off + 2]); // z
                    writeF(rotBank[off + 3]); // w
                }
            }
            if (K_dc > 0 && dcBank) {
                const base = orgIdx * K_dc * 3;
                for (let k = 0; k < K_dc * 3; k++) writeF(dcBank[base + k]);
            }

            if (i % 5000 === 0) {
                progress?.(10 + (i / finalCount) * 85, `Writing vertices ${i}/${finalCount}...`);
            }
        }

        // 7. Final Assembly
        const headerBuf = new TextEncoder().encode(header);
        const finalBuf = new Uint8Array(headerBuf.byteLength + outBuffer.byteLength);
        finalBuf.set(headerBuf);
        finalBuf.set(new Uint8Array(outBuffer), headerBuf.byteLength);

        progress?.(100, "Encoding Complete.");
        return finalBuf.buffer;
    }
}
