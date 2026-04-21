const safeLogit = (v: number) => {
    const p = Math.max(1e-7, Math.min(1.0 - 1e-7, v));
    return Math.log(p / (1.0 - p));
};

const normalizeOpacityToLogit = (v: number, semantic?: string) => {
    if (!Number.isFinite(v)) {
        return 0;
    }
    if (semantic === 'logit') {
        return v;
    }
    if (semantic === 'probability') {
        return safeLogit(v);
    }
    // Some loader paths keep opacity as linear probability, while PLY/PlayCanvas
    // expect the persisted attribute to be raw logit. Normalize here so PLY4
    // always stores the same semantic value when explicit metadata is unavailable.
    if (v >= 0 && v <= 1) {
        return safeLogit(v);
    }
    return v;
};

const extractTrailingIndex = (name: string) => {
    const match = name.match(/_(\d+)$/);
    return match ? parseInt(match[1], 10) : -1;
};

const sortIndexedNames = (names: string[]) => {
    return [...names].sort((a, b) => extractTrailingIndex(a) - extractTrailingIndex(b));
};

const collectIndexedNames = (source: any, regex: RegExp) => {
    return sortIndexedNames(Object.keys(source).filter((name) => regex.test(name)));
};

const convertQuatToWxyz = (quat: [number, number, number, number], semantic?: string) => {
    if (semantic === 'xyzw') {
        return [quat[3], quat[0], quat[1], quat[2]];
    }
    return quat;
};

const part1By2 = (n: number) => {
    let x = n & 0x000003ff;
    x = (x ^ (x << 16)) & 0xff0000ff;
    x = (x ^ (x << 8)) & 0x0300f00f;
    x = (x ^ (x << 4)) & 0x030c30c3;
    x = (x ^ (x << 2)) & 0x09249249;
    return x >>> 0;
};

/**
 * PLY4Encoder: Lossless exporter for 4D Gaussian Splatting data.
 * #WDD 2026-03-31: Created for high-fidelity comparison with SOG4.
 * #WDD 2026-04-03: Updated to WXYZ rotation order per master_ply_format(1).md.
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
        
        const p: any = {};
        if (data.plyData?.elements?.[0]?.properties) {
            data.plyData.elements[0].properties.forEach((prop: any) => p[prop.name] = prop.storage);
        } else {
            p.x = data.x; p.y = data.y; p.z = data.z;
            p.opacity = data.opacity;
            p.scale_0 = data.scale_0; p.scale_1 = data.scale_1; p.scale_2 = data.scale_2;
            p.rot_0 = data.rot_0; p.rot_1 = data.rot_1; p.rot_2 = data.rot_2; p.rot_3 = data.rot_3;
            p.lifetime_mu = data.lifetime_mu;
            p.lifetime_w = data.lifetime_w;
            p.lifetime_k = data.lifetime_k;
            for (const key of Object.keys(data)) {
                if ((/^f_dc_\d+$/).test(key) || (/^f_rest_\d+$/).test(key)) {
                    p[key] = data[key];
                }
            }
        }

        const fdcNames = collectIndexedNames(p, /^f_dc_\d+$/);
        const frestNames = collectIndexedNames(p, /^f_rest_\d+$/);
        const expectedDC = ['f_dc_0', 'f_dc_1', 'f_dc_2'];
        if (fdcNames.length !== expectedDC.length || fdcNames.some((name, index) => name !== expectedDC[index])) {
            throw new Error('PLY4 Encoder: Master PLY requires exactly `f_dc_0`, `f_dc_1`, `f_dc_2`.');
        }
        if (frestNames.some((name, index) => name !== `f_rest_${index}`)) {
            throw new Error('PLY4 Encoder: Master PLY requires contiguous `f_rest_0 ... f_rest_N` properties.');
        }

        // 2. Prepare Metadata
        const totalFrames = data.frames || 1;
        const xyzStride = data.xyzStride || 1;
        const rotStride = data.rotStride || 1;
        const dcStride = data.dcStride || 1;
        const K_xyz = data.keyframes || 0;
        const K_rot = data.rotKeyframes || 0;
        const K_dc = data.dcKeyframes || 0;
        const finalCount = indices.length;
        progress?.(10, `Exporting ${finalCount} / ${count} non-deleted points...`);

        if (K_xyz < 1) {
            throw new Error('PLY4 Encoder: Master PLY requires at least one XYZ bank keyframe group.');
        }
        if (xyzStride < 1 || rotStride < 1 || dcStride < 1) {
            throw new Error('PLY4 Encoder: Keyframe stride values must be >= 1.');
        }

        // Resolve model_transform and cameras from overrides or data
        const modelTransform = overrides.model_transform || data.model_transform || null;
        const cameras = overrides.cameras || data.cameras || null;

        // 3. Define Property Structure & Header
        let header = `ply\nformat binary_little_endian 1.0\n`;
        header += `comment total_frames ${totalFrames}\n`;
        header += `comment xyz_bank_keyframe_stride ${xyzStride}\n`;
        if (K_rot > 0) {
            header += `comment rot_bank_keyframe_stride ${rotStride}\n`;
            header += `comment rot_bank_component_order wxyz\n`; // #WDD 2026-04-03 Added explicit component order
        }
        if (K_dc > 0) header += `comment features_dc_bank_keyframe_stride ${dcStride}\n`;

        // Write model_transform into header comments
        if (modelTransform) {
            const mt = modelTransform;
            if (mt.pos && Array.isArray(mt.pos) && mt.pos.length >= 3) {
                header += `comment model_pos ${mt.pos[0]} ${mt.pos[1]} ${mt.pos[2]}\n`;
            }
            if (mt.rot && Array.isArray(mt.rot) && mt.rot.length >= 4) {
                header += `comment model_rot ${mt.rot[0]} ${mt.rot[1]} ${mt.rot[2]} ${mt.rot[3]}\n`;
            }
            if (mt.scale && Array.isArray(mt.scale) && mt.scale.length >= 3) {
                header += `comment model_scale ${mt.scale[0]} ${mt.scale[1]} ${mt.scale[2]}\n`;
            }
        }

        // Write camera presets into header comments
        if (cameras && Array.isArray(cameras) && cameras.length > 0) {
            for (const cam of cameras) {
                if (!cam || !cam.pos || !Array.isArray(cam.pos)) continue;
                // #WDD-gpt 2026-04-20 - 相机预设名写入 header 时做编码，避免空格破坏 PLY4 comment 解析
                const encodedName = encodeURIComponent(cam.name || 'unnamed');
                header += `comment camera ${encodedName} ${cam.pos[0]} ${cam.pos[1]} ${cam.pos[2]} ${cam.pitch ?? 0} ${cam.yaw ?? 0}\n`;
            }
        }

        header += `element vertex ${finalCount}\n`;
        header += `property float x\nproperty float y\nproperty float z\n`;
        header += `property float nx\nproperty float ny\nproperty float nz\n`;
        for (const name of fdcNames) {
            header += `property float ${name}\n`;
        }
        for (const name of frestNames) {
            header += `property float ${name}\n`;
        }
        header += `property float opacity\n`;
        header += `property float scale_0\nproperty float scale_1\nproperty float scale_2\n`;
        header += `property float lifetime_mu\nproperty float lifetime_w\n`;
        for (let k = 0; k < K_xyz; k++) {
            header += `property float xyz_bank_${k}_x\nproperty float xyz_bank_${k}_y\nproperty float xyz_bank_${k}_z\n`;
        }
        if (K_rot > 0) {
            for (let k = 0; k < K_rot; k++) {
                // #WDD 2026-04-03 Updated order to WXYZ to match master_ply_format(1).md
                header += `property float rot_bank_${k}_w\nproperty float rot_bank_${k}_x\nproperty float rot_bank_${k}_y\nproperty float rot_bank_${k}_z\n`;
            }
        }
        if (K_dc > 0) {
            for (let k = 0; k < K_dc; k++) {
                header += `property float f_dc_bank_${k}_0\nproperty float f_dc_bank_${k}_1\nproperty float f_dc_bank_${k}_2\n`;
            }
        }
        
        header += `end_header\n`;

        // 4. Calculate Binary Size
        const staticPropsCount = 3 + 3 + fdcNames.length + frestNames.length + 1 + 3 + 2;
        const bankPropsCount = K_xyz * 3 + K_rot * 4 + K_dc * 3;
        const rowSize = (staticPropsCount + bankPropsCount) * 4;
        
        const outBuffer = new ArrayBuffer(finalCount * rowSize);
        const view = new DataView(outBuffer);
        
        const xyzBank = data.trajectory || data.xyzBank;
        const rotBank = data.rotTrajectory || data.rotBank;
        const dcBank = data.dcTrajectory || data.dcBank;
        const opacitySemantic = data.opacitySemantic;
        const rotationSemantic = data.rotationSemantic;

        if (!(xyzBank instanceof Float32Array) || xyzBank.length < count * K_xyz * 3) {
            throw new Error('PLY4 Encoder: Missing or truncated XYZ bank data.');
        }
        if (K_rot > 0 && (!(rotBank instanceof Float32Array) || rotBank.length < count * K_rot * 4)) {
            throw new Error('PLY4 Encoder: Missing or truncated ROT bank data.');
        }
        if (K_dc > 0 && (!(dcBank instanceof Float32Array) || dcBank.length < count * K_dc * 3)) {
            throw new Error('PLY4 Encoder: Missing or truncated DC bank data.');
        }

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (const idx of indices) {
            const x = Number(p.x?.[idx] ?? 0);
            const y = Number(p.y?.[idx] ?? 0);
            const z = Number(p.z?.[idx] ?? 0);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
        const extentX = Math.max(maxX - minX, 1e-12);
        const extentY = Math.max(maxY - minY, 1e-12);
        const extentZ = Math.max(maxZ - minZ, 1e-12);
        const mortonCode = (idx: number) => {
            const x = Math.max(0, Math.min(1023, Math.floor(((Number(p.x?.[idx] ?? 0) - minX) * 1024) / extentX)));
            const y = Math.max(0, Math.min(1023, Math.floor(((Number(p.y?.[idx] ?? 0) - minY) * 1024) / extentY)));
            const z = Math.max(0, Math.min(1023, Math.floor(((Number(p.z?.[idx] ?? 0) - minZ) * 1024) / extentZ)));
            return (((part1By2(z) << 2) | (part1By2(y) << 1) | part1By2(x)) >>> 0);
        };
        indices.sort((a, b) => {
            const diff = mortonCode(a) - mortonCode(b);
            return diff !== 0 ? diff : a - b;
        });

        // 6. Fill Binary Data
        for (let i = 0; i < finalCount; i++) {
            const orgIdx = indices[i];
            const rowOff = i * rowSize;
            let ptr = rowOff;

            const writeF = (v: number) => {
                view.setFloat32(ptr, v || 0, true);
                ptr += 4;
            };

            // For 4DGS exports, persist the static anchor from bank 0 instead of the
            // live GSplat position arrays, which the runtime mutates during playback.
            if (K_xyz > 0) {
                const base = orgIdx * K_xyz * 3;
                writeF(xyzBank[base + 0]);
                writeF(xyzBank[base + 1]);
                writeF(xyzBank[base + 2]);
            } else {
                writeF(p.x[orgIdx]);
                writeF(p.y[orgIdx]);
                writeF(p.z[orgIdx]);
            }
            writeF(0); writeF(0); writeF(0);

            for (const name of fdcNames) {
                writeF(p[name] ? p[name][orgIdx] : 0);
            }

            for (const name of frestNames) {
                writeF(p[name] ? p[name][orgIdx] : 0);
            }

            writeF(normalizeOpacityToLogit(p.opacity[orgIdx], opacitySemantic));
            writeF(p.scale_0[orgIdx]);
            writeF(p.scale_1[orgIdx]);
            writeF(p.scale_2[orgIdx]);
            writeF(p.lifetime_mu[orgIdx]);
            writeF(p.lifetime_w[orgIdx]);

            // Banks
            if (K_xyz > 0) {
                const base = orgIdx * K_xyz * 3;
                for (let k = 0; k < K_xyz * 3; k++) writeF(xyzBank[base + k]);
            }
            if (K_rot > 0) {
                const base = orgIdx * K_rot * 4;
                for (let k = 0; k < K_rot; k++) {
                    const off = base + k * 4;
                    const bankQuat = convertQuatToWxyz([
                        rotBank[off + 0],
                        rotBank[off + 1],
                        rotBank[off + 2],
                        rotBank[off + 3]
                    ], rotationSemantic);
                    writeF(bankQuat[0]);
                    writeF(bankQuat[1]);
                    writeF(bankQuat[2]);
                    writeF(bankQuat[3]);
                }
            }
            if (K_dc > 0) {
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
