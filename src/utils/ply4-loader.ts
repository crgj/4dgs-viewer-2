
import * as pc from 'playcanvas';

// Helper to sigmoid (matches Python/Shader)
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));

export class PLY4Loader {
    constructor() { }

    async load(file: File | ArrayBuffer, progressCallback?: (progress: number, message: string) => void): Promise<any> {
        const buffer = file instanceof File ? await file.arrayBuffer() : file;
        const result = this.parsePLY(buffer, progressCallback);
        return result;
    }

    private parsePLY(buffer: ArrayBuffer, onProgress?: (p: number, msg: string) => void) {
        if (onProgress) onProgress(0, "Parsing PLY Header");

        const decoder = new TextDecoder('ascii');
        const headerEnd = this.findHeaderEnd(buffer);
        const headerText = decoder.decode(buffer.slice(0, headerEnd));
        const headerLines = headerText.split('\n');

        let isBinary = false;
        let isLittleEndian = true;
        let vertexCount = 0;
        let propertyTypes: { name: string, type: string, size: number, typeCode: string }[] = [];
        let totalFrames = 0;
        let xyzStride = 1;
        let rotStride = 1;

        // Parse Header
        for (const line of headerLines) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] === 'format') {
                if (parts[1] === 'binary_little_endian') {
                    isBinary = true;
                    isLittleEndian = true;
                } else if (parts[1] === 'binary_big_endian') {
                    isBinary = true;
                    isLittleEndian = false;
                } else if (parts[1] === 'ascii') {
                    isBinary = false;
                }
            } else if (parts[0] === 'element') {
                if (parts[1] === 'vertex') {
                    vertexCount = parseInt(parts[2]);
                }
            } else if (parts[0] === 'property') {
                const type = parts[1];
                const name = parts[2];
                let size = 4; // Default size, will be overwritten if specific type matches

                // Simple mapping for common PLY types
                if (type === 'char' || type === 'uchar' || type === 'int8' || type === 'uint8') size = 1;
                else if (type === 'short' || type === 'ushort' || type === 'int16' || type === 'uint16') size = 2;
                else if (type === 'int' || type === 'uint' || type === 'int32' || type === 'uint32' || type === 'float' || type === 'float32') size = 4;
                else if (type === 'double' || type === 'float64') size = 8;

                propertyTypes.push({ name, type, size, typeCode: type });
            } else if (parts[0] === 'comment') {
                // Parse metadata
                if (line.includes('total_frames')) totalFrames = parseInt(parts[parts.indexOf('total_frames') + 1]);
                if (line.includes('xyz_bank_keyframe_stride')) xyzStride = parseInt(parts[parts.indexOf('xyz_bank_keyframe_stride') + 1]);
                if (line.includes('rot_bank_keyframe_stride')) rotStride = parseInt(parts[parts.indexOf('rot_bank_keyframe_stride') + 1]);
            }
        }

        if (onProgress) onProgress(10, "Reading Body");

        // Identify Bank Structure
        let maxK_xyz = -1;
        let maxK_rot = -1;

        propertyTypes.forEach(p => {
            // xyz_bank_{k}_{c}
            if (p.name.startsWith('xyz_bank_')) {
                const parts = p.name.split('_');
                if (parts.length >= 4) {
                    const k = parseInt(parts[2]);
                    if (!isNaN(k) && k > maxK_xyz) maxK_xyz = k;
                }
            }
            // rot_bank_{k}_{c}
            if (p.name.startsWith('rot_bank_')) {
                const parts = p.name.split('_');
                if (parts.length >= 4) {
                    const k = parseInt(parts[2]);
                    if (!isNaN(k) && k > maxK_rot) maxK_rot = k;
                }
            }
        });

        const K_xyz = maxK_xyz + 1;
        const K_rot = maxK_rot > -1 ? maxK_rot + 1 : 0;

        console.log(`[PLY4] Meta: Frames=${totalFrames}, K_xyz=${K_xyz} (Stride ${xyzStride}), K_rot=${K_rot} (Stride ${rotStride})`);

        // Prepare Data Arrays
        const count = vertexCount;
        const data: any = {
            x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
            opacity: new Float32Array(count),
            scale_0: new Float32Array(count), scale_1: new Float32Array(count), scale_2: new Float32Array(count),
            rot_0: new Float32Array(count), rot_1: new Float32Array(count), rot_2: new Float32Array(count), rot_3: new Float32Array(count),
            f_dc_0: new Float32Array(count), f_dc_1: new Float32Array(count), f_dc_2: new Float32Array(count),
            lifetime_mu: new Float32Array(count), lifetime_w: new Float32Array(count), lifetime_k: new Float32Array(count),

            // Banks (Flattened)
            xyzBank: K_xyz > 0 ? new Float32Array(count * K_xyz * 3) : null,
            rotBank: K_rot > 0 ? new Float32Array(count * K_rot * 4) : null
        };
        for (let i = 0; i < 45; i++) data[`f_rest_${i}`] = new Float32Array(count);

        if (!isBinary) {
            throw new Error("PLY4 Loader: ASCII PLY not supported yet (optimization needed). Please use binary.");
        }

        console.log(`[PLY4] Buffer Length: ${buffer.byteLength}, Header End: ${headerEnd}`);

        // Read Binary Body
        const bodyStart = headerEnd; // headerEnd is already the start of the body
        const view = new DataView(buffer);
        // Note: DataView starts at 0, so we use absolute offsets.

        const rowSize = propertyTypes.reduce((sum, p) => sum + p.size, 0);
        const expectedSize = bodyStart + vertexCount * rowSize;
        console.log(`[PLY4] VertexCount: ${vertexCount}, RowSize: ${rowSize}, Expected Total Size: ${expectedSize}`);

        if (buffer.byteLength < expectedSize) {
            console.error(`[PLY4] Buffer too small! Missing ${expectedSize - buffer.byteLength} bytes.`);
            // Proceeding might crash, but let's try to read what we can or just truncate count
        }

        // Indices of properties
        const pIdx: Record<string, number> = {};
        propertyTypes.forEach((p, i) => pIdx[p.name] = i);
        // Pre-calculate offsets for fast access
        const propOffsets: Record<string, number> = {};
        let currentOffset = 0;
        propertyTypes.forEach(p => {
            propOffsets[p.name] = currentOffset;
            currentOffset += p.size;
        });

        const getFloat = (name: string, rowBase: number) => {
            if (propOffsets[name] === undefined) return 0;
            const offset = rowBase + propOffsets[name];
            if (offset + 4 > buffer.byteLength) {
                // console.warn(`[PLY4] OOB Read for ${name} at ${offset}`);
                return 0;
            }
            // Assume float32 for now
            return view.getFloat32(offset, isLittleEndian);
        };

        // Cache property names for fast iteration
        const xyzBankNames: string[][] = []; // [k][0=x,1=y,2=z]
        for (let k = 0; k < K_xyz; k++) {
            xyzBankNames[k] = [`xyz_bank_${k}_x`, `xyz_bank_${k}_y`, `xyz_bank_${k}_z`];
        }
        const rotBankNames: string[][] = []; // [k][0=x,1=y,2=z,3=w]
        for (let k = 0; k < K_rot; k++) {
            rotBankNames[k] = [`rot_bank_${k}_x`, `rot_bank_${k}_y`, `rot_bank_${k}_z`, `rot_bank_${k}_w`];
        }

        // F_REST
        const fRestNames: string[] = [];
        for (let i = 0; i < 45; i++) fRestNames.push(`f_rest_${i}`);

        for (let i = 0; i < count; i++) {
            const rowBase = bodyStart + i * rowSize;

            data.x[i] = getFloat('x', rowBase);
            data.y[i] = getFloat('y', rowBase);
            data.z[i] = getFloat('z', rowBase);

            // Opacity: PLY is Logit. Convert to Linear.
            const opacLogit = getFloat('opacity', rowBase);
            data.opacity[i] = sigmoid(opacLogit);

            data.scale_0[i] = getFloat('scale_0', rowBase);
            data.scale_1[i] = getFloat('scale_1', rowBase);
            data.scale_2[i] = getFloat('scale_2', rowBase);

            // Rot may be empty or not present if K_rot > 0? 
            // Usually standard PLY has rot_0..3. If not, use rot_bank_0 ?? 
            // In the python script: 
            // "Interpolate ROT... if rot_bank is None... curr_rot... slerp"
            // The PLY export normally DOES NOT include rot_0..3 if K_rot > 0 bank is used? 
            // Wait, extract_to_ply DOES NOT write rot_0...3 explicitly for static props?
            // "Construct PLY attributes... 1. xyz... 2. f_dc..."
            // It writes 'rot_0' etc in save_per_frame_ply but extract_checkpoint_to_ply writes BANKS.
            // Ah, extract_checkpoint_to_ply writes: 
            // "Banks ... xyz_bank_{k}_{c} ... rot_bank_{k}_{c}"
            // It does NOT write rot_0..3 static columns explicitly unless they are in the bank?
            // Wait, look at extract_checkpoint_to_ply: 
            // It writes f_dc, f_rest, opacity, scale, mu, w.
            // AND Banks. 
            // It does NOT write standard `rot_0, rot_1, rot_2, rot_3` columns.
            // So we need to take rot from frame 0 of rot_bank.

            const r0 = getFloat('rot_0', rowBase); // Might be 0 if not present
            // So check if rot_bank exists

            data.f_dc_0[i] = getFloat('f_dc_0', rowBase);
            data.f_dc_1[i] = getFloat('f_dc_1', rowBase);
            data.f_dc_2[i] = getFloat('f_dc_2', rowBase);

            for (let j = 0; j < 45; j++) {
                data[`f_rest_${j}`][i] = getFloat(fRestNames[j], rowBase);
            }

            data.lifetime_mu[i] = getFloat('lifetime_mu', rowBase);
            data.lifetime_w[i] = getFloat('lifetime_w', rowBase);
            data.lifetime_k[i] = 10.0;

            // BANK DATA
            if (K_xyz > 0) {
                for (let k = 0; k < K_xyz; k++) {
                    const bx = getFloat(xyzBankNames[k][0], rowBase);
                    const by = getFloat(xyzBankNames[k][1], rowBase);
                    const bz = getFloat(xyzBankNames[k][2], rowBase);
                    const bIdx = (i * K_xyz + k) * 3;
                    data.xyzBank[bIdx + 0] = bx;
                    data.xyzBank[bIdx + 1] = by;
                    data.xyzBank[bIdx + 2] = bz;

                    // Fill frame 0 if static x,y,z are missing or 0? 
                    // The python script sets `arr['x'] = xyz[:, 0]` (Frame 0 from bank)
                    // So data.x should be fine.
                }
            }

            if (K_rot > 0) {
                for (let k = 0; k < K_rot; k++) {
                    const br = getFloat(rotBankNames[k][0], rowBase);
                    const bg = getFloat(rotBankNames[k][1], rowBase);
                    const bb = getFloat(rotBankNames[k][2], rowBase);
                    const ba = getFloat(rotBankNames[k][3], rowBase);
                    const bIdx = (i * K_rot + k) * 4;
                    data.rotBank[bIdx + 0] = br;
                    data.rotBank[bIdx + 1] = bg;
                    data.rotBank[bIdx + 2] = bb;
                    data.rotBank[bIdx + 3] = ba;
                }
                // Fill rot_0..3 from frame 0
                data.rot_0[i] = data.rotBank[i * K_rot * 4 + 0];
                data.rot_1[i] = data.rotBank[i * K_rot * 4 + 1];
                data.rot_2[i] = data.rotBank[i * K_rot * 4 + 2];
                data.rot_3[i] = data.rotBank[i * K_rot * 4 + 3];
            } else {
                // Try to read standard or default
                data.rot_0[i] = getFloat('rot_0', rowBase) || 1;
                data.rot_1[i] = getFloat('rot_1', rowBase) || 0;
                data.rot_2[i] = getFloat('rot_2', rowBase) || 0;
                data.rot_3[i] = getFloat('rot_3', rowBase) || 0;
            }

            if (i % 10000 === 0 && onProgress) {
                onProgress(10 + (i / count) * 80, "Reading Vertices");
            }
        }

        if (onProgress) onProgress(100, "Done");

        // Create properties array for GSplatData
        const properties: any[] = [
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
            { name: 'lifetime_mu', type: 'float', storage: data.lifetime_mu },
            { name: 'lifetime_w', type: 'float', storage: data.lifetime_w },
            { name: 'lifetime_k', type: 'float', storage: data.lifetime_k },
        ];

        // Add f_rest properties
        for (let i = 0; i < 45; i++) {
            if (data[`f_rest_${i}`]) {
                properties.push({ name: `f_rest_${i}`, type: 'float', storage: data[`f_rest_${i}`] });
            }
        }

        // Construct standard Result object compatible with TrueSplatsLoader output
        // See TrueSplatsLoader.ts

        // Return compatible object
        return {
            x: data.x, y: data.y, z: data.z,
            opacity: data.opacity,
            scale_0: data.scale_0, scale_1: data.scale_1, scale_2: data.scale_2,
            rot_0: data.rot_0, rot_1: data.rot_1, rot_2: data.rot_2, rot_3: data.rot_3,
            f_dc_0: data.f_dc_0, f_dc_1: data.f_dc_1, f_dc_2: data.f_dc_2,
            // ...

            // GSplatData Structure
            plyData: {
                elements: [{
                    name: 'vertex',
                    count: count,
                    properties: properties
                }]
            },

            count: count,
            is4DGS: K_xyz > 0,

            // Trajectory Data
            trajectory: data.xyzBank,
            keyframes: K_xyz,
            frames: totalFrames > 0 ? totalFrames : 1,
            xyzStride: xyzStride,

            rotTrajectory: data.rotBank,
            rotKeyframes: K_rot,
            rotStride: rotStride,

            bands: 3
        };
    }

    private findHeaderEnd(buffer: ArrayBuffer): number {
        const view = new Uint8Array(buffer);
        const searchLen = Math.min(10000, view.length); // Search first 10KB
        const decoder = new TextDecoder('ascii');
        const text = decoder.decode(view.slice(0, searchLen));

        const idx = text.indexOf('end_header');
        if (idx !== -1) {
            // Find the newline after end_header
            let newlineIdx = idx + 10; // skip 'end_header'
            while (newlineIdx < searchLen && text.charCodeAt(newlineIdx) !== 10) { // 10 is \n
                newlineIdx++;
            }
            if (newlineIdx < searchLen) {
                return newlineIdx + 1; // Return index AFTER \n
            }
        }

        // Fallback: manual search if chunk was too small? 
        // Unlikely for PLY header.
        console.error("[PLY4] Could not find end_header!");
        return 0;
    }
}
