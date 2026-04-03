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

const normalizeQuatOrder = (
    quat: [number, number, number, number],
    semantic: string | undefined,
    target: 'wxyz' | 'xyzw'
) => {
    const source = semantic === 'xyzw'
        ? { x: quat[0], y: quat[1], z: quat[2], w: quat[3] }
        : { w: quat[0], x: quat[1], y: quat[2], z: quat[3] };

    return target === 'xyzw'
        ? [source.x, source.y, source.z, source.w]
        : [source.w, source.x, source.y, source.z];
};

const isNumericArrayLike = (value: unknown): value is ArrayLike<number> => {
    if (!value || typeof value !== 'object') return false;
    return typeof (value as { length?: unknown }).length === 'number';
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
        
        const propertyMap = new Map<string, ArrayLike<number>>();
        if (data.plyData?.elements?.[0]?.properties) {
            data.plyData.elements[0].properties.forEach((prop: any) => {
                if (prop?.name && isNumericArrayLike(prop.storage)) {
                    propertyMap.set(prop.name, prop.storage);
                }
            });
        }
        const getStorage = (name: string): ArrayLike<number> | undefined => {
            if (isNumericArrayLike(data[name])) {
                return data[name];
            }
            return propertyMap.get(name);
        };
        const requireStorage = (name: string): ArrayLike<number> => {
            const storage = getStorage(name);
            if (!storage || storage.length < count) {
                throw new Error(`PLY4 Encoder: Missing required property \`${name}\`.`);
            }
            return storage;
        };
        const allKeys = new Set<string>([...Object.keys(data), ...propertyMap.keys()]);
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
        if (K_xyz < 1) {
            throw new Error('PLY4 Encoder: Strict PLY4 requires at least one XYZ bank keyframe group.');
        }
        if (xyzStride < 1 || rotStride < 1 || dcStride < 1) {
            throw new Error('PLY4 Encoder: Keyframe stride values must be >= 1.');
        }

        const fdcNames = sortIndexedNames([...allKeys].filter((name) => /^f_dc_\d+$/.test(name)));
        const frestNames = sortIndexedNames([...allKeys].filter((name) => /^f_rest_\d+$/.test(name)));
        const expectedDC = ['f_dc_0', 'f_dc_1', 'f_dc_2'];
        if (fdcNames.length !== expectedDC.length || fdcNames.some((name, index) => name !== expectedDC[index])) {
            throw new Error('PLY4 Encoder: Strict PLY4 requires exactly `f_dc_0`, `f_dc_1`, `f_dc_2`.');
        }
        if (frestNames.some((name, index) => name !== `f_rest_${index}`)) {
            throw new Error('PLY4 Encoder: Strict PLY4 requires contiguous `f_rest_0 ... f_rest_N` properties.');
        }
        const x = requireStorage('x');
        const y = requireStorage('y');
        const z = requireStorage('z');
        const opacity = requireStorage('opacity');
        const scale0 = requireStorage('scale_0');
        const scale1 = requireStorage('scale_1');
        const scale2 = requireStorage('scale_2');
        const lifetimeMu = requireStorage('lifetime_mu');
        const lifetimeW = requireStorage('lifetime_w');
        const xyzBank = data.trajectory || data.xyzBank;
        const rotBank = data.rotTrajectory || data.rotBank;
        const dcBank = data.dcTrajectory || data.dcBank;
        const modelPos = overrides.model_pos || data.meta?.modelPos;
        const modelRot = overrides.model_rot || data.meta?.modelRot;
        const modelScale = overrides.model_scale || data.meta?.modelScale;
        const cameras = Array.isArray(overrides.cameras) ? overrides.cameras : (Array.isArray(data.cameras) ? data.cameras : []);
        const extraComments = [
            ...(Array.isArray(data.meta?.extraComments) ? data.meta.extraComments : []),
            ...(Array.isArray(overrides.extraComments) ? overrides.extraComments : [])
        ].filter((value) => typeof value === 'string' && value.length > 0);
        if (!(xyzBank instanceof Float32Array) || xyzBank.length < count * K_xyz * 3) {
            throw new Error('PLY4 Encoder: Missing or truncated XYZ bank data.');
        }
        if (K_rot > 0 && (!(rotBank instanceof Float32Array) || rotBank.length < count * K_rot * 4)) {
            throw new Error('PLY4 Encoder: Missing or truncated ROT bank data.');
        }
        if (K_dc > 0 && (!(dcBank instanceof Float32Array) || dcBank.length < count * K_dc * 3)) {
            throw new Error('PLY4 Encoder: Missing or truncated DC bank data.');
        }

        // 3. Define Property Structure & Header
        let header = `ply\nformat binary_little_endian 1.0\n`;
        header += `comment total_frames ${totalFrames}\n`;
        header += `comment xyz_bank_keyframe_stride ${xyzStride}\n`;
        if (K_rot > 0) header += `comment rot_bank_keyframe_stride ${rotStride}\n`;
        if (K_dc > 0) header += `comment features_dc_bank_keyframe_stride ${dcStride}\n`;
        if (modelPos) {
            header += `comment model_pos ${modelPos.x} ${modelPos.y} ${modelPos.z}\n`;
        }
        if (modelRot) {
            header += `comment model_rot ${modelRot.x} ${modelRot.y} ${modelRot.z} ${modelRot.w}\n`;
        }
        if (modelScale) {
            header += `comment model_scale ${modelScale.x} ${modelScale.y} ${modelScale.z}\n`;
        }
        for (const camera of cameras) {
            header += `comment camera_preset ${JSON.stringify(camera)}\n`;
        }
        for (const comment of extraComments) {
            header += `comment ${comment}\n`;
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
        const staticPropsCount = 3 + 3 + fdcNames.length + frestNames.length + 1 + 3 + 2;
        const bankPropsCount = K_xyz * 3 + K_rot * 4 + K_dc * 3;
        const rowSize = (staticPropsCount + bankPropsCount) * 4;
        
        const outBuffer = new ArrayBuffer(finalCount * rowSize);
        const view = new DataView(outBuffer);
        const opacitySemantic = data.opacitySemantic;
        const rotationSemantic = data.rotationSemantic === 'xyzw' ? 'xyzw' : 'wxyz';

        const mortonCodes = new Uint32Array(finalCount);
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (const src of indices) {
            const px = Number(x[src] ?? 0);
            const py = Number(y[src] ?? 0);
            const pz = Number(z[src] ?? 0);
            if (px < minX) minX = px;
            if (py < minY) minY = py;
            if (pz < minZ) minZ = pz;
            if (px > maxX) maxX = px;
            if (py > maxY) maxY = py;
            if (pz > maxZ) maxZ = pz;
        }
        const extentX = Math.max(maxX - minX, 1e-12);
        const extentY = Math.max(maxY - minY, 1e-12);
        const extentZ = Math.max(maxZ - minZ, 1e-12);
        for (let i = 0; i < finalCount; i++) {
            const src = indices[i];
            const nx = Math.max(0, Math.min(1023, Math.floor(((Number(x[src] ?? 0) - minX) * 1024) / extentX)));
            const ny = Math.max(0, Math.min(1023, Math.floor(((Number(y[src] ?? 0) - minY) * 1024) / extentY)));
            const nz = Math.max(0, Math.min(1023, Math.floor(((Number(z[src] ?? 0) - minZ) * 1024) / extentZ)));
            mortonCodes[i] = (((part1By2(nz) << 2) + (part1By2(ny) << 1) + part1By2(nx)) >>> 0);
        }
        const mortonOrder = Array.from({ length: finalCount }, (_, i) => i);
        mortonOrder.sort((a, b) => {
            const diff = mortonCodes[a] - mortonCodes[b];
            if (diff !== 0) return diff;
            return indices[a] - indices[b];
        });

        // 6. Fill Binary Data
        for (let i = 0; i < finalCount; i++) {
            const orgIdx = indices[mortonOrder[i]];
            const rowOff = i * rowSize;
            let ptr = rowOff;

            const writeF = (v: number) => {
                view.setFloat32(ptr, v || 0, true);
                ptr += 4;
            };

            // Basic
            writeF(Number(x[orgIdx] ?? 0));
            writeF(Number(y[orgIdx] ?? 0));
            writeF(Number(z[orgIdx] ?? 0));
            writeF(0);
            writeF(0);
            writeF(0);
            
            // Persist opacity as raw logit, matching PLY reference semantics.
            for (const name of fdcNames) {
                const storage = getStorage(name);
                writeF(storage ? Number(storage[orgIdx] ?? 0) : 0);
            }

            for (const name of frestNames) {
                const storage = getStorage(name);
                writeF(storage ? Number(storage[orgIdx] ?? 0) : 0);
            }

            writeF(normalizeOpacityToLogit(Number(opacity[orgIdx] ?? 0), opacitySemantic));
            writeF(Number(scale0[orgIdx] ?? 0));
            writeF(Number(scale1[orgIdx] ?? 0));
            writeF(Number(scale2[orgIdx] ?? 0));
            writeF(Number(lifetimeMu[orgIdx] ?? 0));
            writeF(Number(lifetimeW[orgIdx] ?? 0));

            // Banks
            if (K_xyz > 0) {
                const base = orgIdx * K_xyz * 3;
                for (let k = 0; k < K_xyz * 3; k++) writeF(xyzBank[base + k]);
            }
            if (K_rot > 0) {
                const base = orgIdx * K_rot * 4;
                for (let k = 0; k < K_rot; k++) {
                    const off = base + k * 4;
                    const bankQuat = normalizeQuatOrder([
                        rotBank[off + 0],
                        rotBank[off + 1],
                        rotBank[off + 2],
                        rotBank[off + 3]
                    ], rotationSemantic, 'xyzw');
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
