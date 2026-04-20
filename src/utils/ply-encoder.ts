/**
 * Encoder for standard 3D Gaussian Splatting PLY format.
 */
export class PLYEncoder {
    /**
     * Encode frame data into a standard 3DGS PLY binary buffer.
     */
    static async encode(data: any, progress?: (pct: number, msg: string) => void): Promise<ArrayBuffer> {
        const count = data.count || 0;
        if (count === 0) return new ArrayBuffer(0);

        // 1. Collect names for SH properties
        const fdcNames: string[] = ['f_dc_0', 'f_dc_1', 'f_dc_2'];
        const frestNames: string[] = [];
        for (let i = 0; i < 45; i++) {
            const key = `f_rest_${i}`;
            if (data[key]) frestNames.push(key);
        }

        // 2. Build Header
        let header = "ply\nformat binary_little_endian 1.0\n";
        header += `element vertex ${count}\n`;
        header += `property float x\nproperty float y\nproperty float z\n`;
        header += `property float nx\nproperty float ny\nproperty float nz\n`;
        
        for (const name of fdcNames) header += `property float ${name}\n`;
        for (const name of frestNames) header += `property float ${name}\n`;
        
        header += `property float opacity\n`;
        header += `property float scale_0\nproperty float scale_1\nproperty float scale_2\n`;
        header += `property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\n`;
        header += `end_header\n`;

        // 3. Calculate Binary Size
        // x,y,z(3) + nx,ny,nz(3) + dc(3) + rest(N) + opacity(1) + scale(3) + rot(4)
        const staticPropsCount = 3 + 3 + fdcNames.length + frestNames.length + 1 + 3 + 4;
        const rowSize = staticPropsCount * 4;
        const outBuffer = new ArrayBuffer(count * rowSize);
        const view = new DataView(outBuffer);
        let offset = 0;

        const writeF = (val: number) => {
            view.setFloat32(offset, val || 0, true);
            offset += 4;
        };

        // 4. Fill Data
        for (let i = 0; i < count; i++) {
            // Position & Normal
            writeF(data.x[i]);
            writeF(data.y[i]);
            writeF(data.z[i]);
            writeF(0); writeF(0); writeF(0); // nx, ny, nz

            // SH (Colors)
            for (const name of fdcNames) writeF(data[name]?.[i] ?? 0);
            for (const name of frestNames) writeF(data[name]?.[i] ?? 0);

            // Opacity & Scale
            writeF(data.opacity[i]);
            writeF(data.scale_0[i]);
            writeF(data.scale_1[i]);
            writeF(data.scale_2[i]);

            // Rotation
            writeF(data.rot_0?.[i] ?? 1);
            writeF(data.rot_1?.[i] ?? 0);
            writeF(data.rot_2?.[i] ?? 0);
            writeF(data.rot_3?.[i] ?? 0);

            if (i % 10000 === 0) {
                progress?.((i / count) * 95, `Writing vertices ${i}/${count}...`);
                // #WDD 2026-04-19 增加让出主线程 避免卡死
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // 5. Final Assembly
        const headerBuf = new TextEncoder().encode(header);
        const finalBuf = new Uint8Array(headerBuf.byteLength + outBuffer.byteLength);
        finalBuf.set(headerBuf);
        finalBuf.set(new Uint8Array(outBuffer), headerBuf.byteLength);

        progress?.(100, "Encoding Complete.");
        return finalBuf.buffer;
    }
}
