
import * as pc from 'playcanvas';

export class PLY4Loader {
    private static readonly HEADER_PROBE_BYTES = 1024 * 1024;
    private static readonly BODY_CHUNK_BYTES = 64 * 1024 * 1024;
    private static readonly MAX_ESTIMATED_CPU_BYTES = 5000 * 1024 * 1024;

    constructor() { }

    async load(file: File | ArrayBuffer, progressCallback?: (progress: number, message: string) => void): Promise<any> {
        if (file instanceof File) {
            const strictPly4 = file.name.toLowerCase().endsWith('.ply4');
            return this.parsePLYFile(file, progressCallback, strictPly4);
        }
        return this.parsePLYBuffer(file, progressCallback);
    }

    private async parsePLYFile(file: File, onProgress?: (p: number, msg: string) => void, strictPly4 = false) {
        if (onProgress) onProgress(0, "Parsing PLY Header");

        const headerChunk = await file.slice(0, PLY4Loader.HEADER_PROBE_BYTES).arrayBuffer();
        const { headerEnd, headerText } = this.extractHeaderFromBuffer(headerChunk);
        const parsedHeader = this.parseHeaderText(headerText, { strictPly4 });
        this.ensureWithinBrowserMemoryBudget(parsedHeader);
        const data = this.createDataArrays(parsedHeader.vertexCount, parsedHeader.K_xyz, parsedHeader.K_rot, parsedHeader.K_dc, parsedHeader.fdcNames, parsedHeader.frestNames);

        if (!parsedHeader.isBinary) {
            throw new Error("PLY4 Loader: ASCII PLY not supported yet (optimization needed). Please use binary.");
        }

        if (onProgress) onProgress(10, "Reading Body");

        const rowSize = parsedHeader.propertyTypes.reduce((sum, p) => sum + p.size, 0);
        const expectedSize = headerEnd + parsedHeader.vertexCount * rowSize;
        console.log(`[PLY4] File Size: ${file.size}, Header End: ${headerEnd}, Expected Total Size: ${expectedSize}`);

        if (file.size < expectedSize) {
            console.error(`[PLY4] File too small! Missing ${expectedSize - file.size} bytes.`);
        }

        const propOffsets = this.buildPropertyOffsets(parsedHeader.propertyTypes);
        const xyzBankNames = this.buildXYZBankNames(parsedHeader.K_xyz);
        const rotBankNames = this.buildRotBankNames(parsedHeader.K_rot);
        const dcBankNames = this.buildDCBankNames(parsedHeader.K_dc);
        const rowsPerChunk = Math.max(1, Math.floor(PLY4Loader.BODY_CHUNK_BYTES / rowSize));
        const totalChunks = Math.max(1, Math.ceil(parsedHeader.vertexCount / rowsPerChunk));

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const startRow = chunkIndex * rowsPerChunk;
            const rowCount = Math.min(rowsPerChunk, parsedHeader.vertexCount - startRow);
            const byteStart = headerEnd + startRow * rowSize;
            const byteEnd = byteStart + rowCount * rowSize;
            const chunkBuffer = await file.slice(byteStart, byteEnd).arrayBuffer();
            const view = new DataView(chunkBuffer);

            this.parseRowsIntoData(
                view,
                0,
                rowCount,
                rowSize,
                parsedHeader.isLittleEndian,
                propOffsets,
                data,
                parsedHeader.K_xyz,
                parsedHeader.K_rot,
                parsedHeader.K_dc,
                xyzBankNames,
                rotBankNames,
                dcBankNames,
                parsedHeader.fdcNames,
                parsedHeader.frestNames,
                startRow
            );

            if (onProgress) {
                const progress = 10 + ((startRow + rowCount) / parsedHeader.vertexCount) * 80;
                onProgress(progress, "Reading Vertices");
            }
        }

        if (onProgress) onProgress(100, "Done");
        return this.buildResult(data, parsedHeader);
    }

    private parsePLYBuffer(buffer: ArrayBuffer, onProgress?: (p: number, msg: string) => void) {
        if (onProgress) onProgress(0, "Parsing PLY Header");

        const { headerEnd, headerText } = this.extractHeaderFromBuffer(buffer);
        const parsedHeader = this.parseHeaderText(headerText);
        this.ensureWithinBrowserMemoryBudget(parsedHeader);
        const data = this.createDataArrays(parsedHeader.vertexCount, parsedHeader.K_xyz, parsedHeader.K_rot, parsedHeader.K_dc, parsedHeader.fdcNames, parsedHeader.frestNames);

        if (!parsedHeader.isBinary) {
            throw new Error("PLY4 Loader: ASCII PLY not supported yet (optimization needed). Please use binary.");
        }

        if (onProgress) onProgress(10, "Reading Body");

        console.log(`[PLY4] Buffer Length: ${buffer.byteLength}, Header End: ${headerEnd}`);

        // Read Binary Body
        const bodyStart = headerEnd; // headerEnd is already the start of the body
        const view = new DataView(buffer);
        // Note: DataView starts at 0, so we use absolute offsets.

        const rowSize = parsedHeader.propertyTypes.reduce((sum, p) => sum + p.size, 0);
        const expectedSize = bodyStart + parsedHeader.vertexCount * rowSize;
        console.log(`[PLY4] VertexCount: ${parsedHeader.vertexCount}, RowSize: ${rowSize}, Expected Total Size: ${expectedSize}`);

        if (buffer.byteLength < expectedSize) {
            console.error(`[PLY4] Buffer too small! Missing ${expectedSize - buffer.byteLength} bytes.`);
            // Proceeding might crash, but let's try to read what we can or just truncate count
        }

        const propOffsets = this.buildPropertyOffsets(parsedHeader.propertyTypes);
        const xyzBankNames = this.buildXYZBankNames(parsedHeader.K_xyz);
        const rotBankNames = this.buildRotBankNames(parsedHeader.K_rot);
        const dcBankNames = this.buildDCBankNames(parsedHeader.K_dc);
        this.parseRowsIntoData(
            view,
            bodyStart,
            parsedHeader.vertexCount,
            rowSize,
            parsedHeader.isLittleEndian,
            propOffsets,
            data,
            parsedHeader.K_xyz,
            parsedHeader.K_rot,
            parsedHeader.K_dc,
            xyzBankNames,
            rotBankNames,
            dcBankNames,
            parsedHeader.fdcNames,
            parsedHeader.frestNames,
            0
        );

        if (onProgress) onProgress(100, "Done");
        return this.buildResult(data, parsedHeader);
    }

    private extractHeaderFromBuffer(buffer: ArrayBuffer): { headerEnd: number; headerText: string } {
        const view = new Uint8Array(buffer);
        const searchLen = Math.min(PLY4Loader.HEADER_PROBE_BYTES, view.length);
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
                const headerEnd = newlineIdx + 1;
                return {
                    headerEnd,
                    headerText: decoder.decode(buffer.slice(0, headerEnd))
                };
            }
        }

        throw new Error(`PLY4 Loader: Could not find end_header within first ${PLY4Loader.HEADER_PROBE_BYTES / 1024} KB.`);
    }

    private parseHeaderText(headerText: string, options: { strictPly4?: boolean } = {}) {
        const headerLines = headerText.split('\n');
        let isBinary = false;
        let isLittleEndian = true;
        let vertexCount = 0;
        const propertyTypes: { name: string, type: string, size: number, typeCode: string }[] = [];
        let totalFrames = 0;
        let xyzStride = 1;
        let rotStride = 1;
        let dcStride = 1;
        let hasTotalFramesComment = false;
        let hasXYZStrideComment = false;
        let hasRotStrideComment = false;
        let hasDCStrideComment = false;
        let modelPos: pc.Vec3 | null = null;
        let modelRot: pc.Quat | null = null;
        let modelScale: pc.Vec3 | null = null;
        const cameras: any[] = [];
        const extraComments: string[] = [];
        const fdcNames: string[] = [];
        const frestNames: string[] = [];

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
            } else if (parts[0] === 'element' && parts[1] === 'vertex') {
                vertexCount = parseInt(parts[2], 10);
            } else if (parts[0] === 'property') {
                const type = parts[1];
                const name = parts[2];
                let size = 4;
                if (type === 'char' || type === 'uchar' || type === 'int8' || type === 'uint8') size = 1;
                else if (type === 'short' || type === 'ushort' || type === 'int16' || type === 'uint16') size = 2;
                else if (type === 'int' || type === 'uint' || type === 'int32' || type === 'uint32' || type === 'float' || type === 'float32') size = 4;
                else if (type === 'double' || type === 'float64') size = 8;
                propertyTypes.push({ name, type, size, typeCode: type });
                if (name.startsWith('f_dc_') && !name.startsWith('f_dc_bank_')) {
                    fdcNames.push(name);
                } else if (name.startsWith('f_rest_')) {
                    frestNames.push(name);
                }
            } else if (parts[0] === 'comment' && parts.length >= 3) {
                const key = parts[1];
                const values = parts.slice(2);
                if (key === 'total_frames') {
                    hasTotalFramesComment = true;
                    totalFrames = parseInt(values[0], 10);
                } else if (key === 'xyz_bank_keyframe_stride') {
                    hasXYZStrideComment = true;
                    xyzStride = parseInt(values[0], 10);
                } else if (key === 'rot_bank_keyframe_stride') {
                    hasRotStrideComment = true;
                    rotStride = parseInt(values[0], 10);
                } else if (key === 'features_dc_bank_keyframe_stride') {
                    hasDCStrideComment = true;
                    dcStride = parseInt(values[0], 10);
                } else if (key === 'model_pos' && values.length >= 3) {
                    modelPos = new pc.Vec3(parseFloat(values[0]), parseFloat(values[1]), parseFloat(values[2]));
                } else if (key === 'model_rot' && values.length >= 4) {
                    modelRot = new pc.Quat(parseFloat(values[0]), parseFloat(values[1]), parseFloat(values[2]), parseFloat(values[3]));
                } else if (key === 'model_scale' && values.length >= 3) {
                    modelScale = new pc.Vec3(parseFloat(values[0]), parseFloat(values[1]), parseFloat(values[2]));
                } else if (key === 'camera_preset') {
                    const jsonText = line.trim().slice('comment camera_preset '.length);
                    try {
                        const preset = JSON.parse(jsonText);
                        if (preset && typeof preset === 'object') {
                            cameras.push(preset);
                        }
                    } catch (err) {
                        console.warn('[PLY4] Failed to parse camera preset comment:', err);
                        extraComments.push(line.trim().slice('comment '.length));
                    }
                } else {
                    extraComments.push(line.trim().slice('comment '.length));
                }
            }
        }

        let maxK_xyz = -1;
        let maxK_rot = -1;
        let maxK_dc = -1;
        propertyTypes.forEach((p) => {
            if (p.name.startsWith('xyz_bank_')) {
                const parts = p.name.split('_');
                if (parts.length >= 4) {
                    const index = parseInt(parts[2], 10);
                    if (Number.isInteger(index)) maxK_xyz = Math.max(maxK_xyz, index);
                }
            }
            if (p.name.startsWith('rot_bank_')) {
                const parts = p.name.split('_');
                if (parts.length >= 4) {
                    const index = parseInt(parts[2], 10);
                    if (Number.isInteger(index)) maxK_rot = Math.max(maxK_rot, index);
                }
            }
            if (p.name.startsWith('f_dc_bank_')) {
                const parts = p.name.split('_');
                if (parts.length >= 5) {
                    const index = parseInt(parts[3], 10);
                    if (Number.isInteger(index)) maxK_dc = Math.max(maxK_dc, index);
                }
            }
        });

        fdcNames.sort((a, b) => this.extractTrailingIndex(a) - this.extractTrailingIndex(b));
        frestNames.sort((a, b) => this.extractTrailingIndex(a) - this.extractTrailingIndex(b));

        const K_xyz = maxK_xyz + 1;
        const K_rot = maxK_rot > -1 ? maxK_rot + 1 : 0;
        const K_dc = maxK_dc > -1 ? maxK_dc + 1 : 0;
        const hasPly4Metadata = hasTotalFramesComment || hasXYZStrideComment || hasRotStrideComment || hasDCStrideComment;
        const hasBankProperties = K_xyz > 0 || K_rot > 0 || K_dc > 0;
        const isStrictPly4 = options.strictPly4 || hasPly4Metadata || hasBankProperties;

        if (isStrictPly4) {
            this.validateStrictPly4({
                isBinary,
                isLittleEndian,
                vertexCount,
                propertyTypes,
                totalFrames,
                xyzStride,
                rotStride,
                dcStride,
                hasTotalFramesComment,
                hasXYZStrideComment,
                hasRotStrideComment,
                hasDCStrideComment,
                K_xyz,
                K_rot,
                K_dc,
                fdcNames,
                frestNames
            });
        }

        console.log(`[PLY4] Meta: Frames=${totalFrames}, K_xyz=${K_xyz} (Stride ${xyzStride}), K_rot=${K_rot} (Stride ${rotStride}), K_dc=${K_dc} (Stride ${dcStride})`);

        return { isBinary, isLittleEndian, vertexCount, propertyTypes, totalFrames, xyzStride, rotStride, dcStride, modelPos, modelRot, modelScale, cameras, extraComments, K_xyz, K_rot, K_dc, fdcNames, frestNames, isStrictPly4 };
    }

    private validateStrictPly4(parsedHeader: {
        isBinary: boolean;
        isLittleEndian: boolean;
        vertexCount: number;
        propertyTypes: { name: string; type: string }[];
        totalFrames: number;
        xyzStride: number;
        rotStride: number;
        dcStride: number;
        hasTotalFramesComment: boolean;
        hasXYZStrideComment: boolean;
        hasRotStrideComment: boolean;
        hasDCStrideComment: boolean;
        K_xyz: number;
        K_rot: number;
        K_dc: number;
        fdcNames: string[];
        frestNames: string[];
    }) {
        if (!parsedHeader.isBinary || !parsedHeader.isLittleEndian) {
            throw new Error('PLY4 Loader: Strict PLY4 requires format `binary_little_endian 1.0`.');
        }
        if (parsedHeader.vertexCount < 0) {
            throw new Error('PLY4 Loader: Invalid vertex count.');
        }

        const invalidType = parsedHeader.propertyTypes.find((prop) => prop.type !== 'float' && prop.type !== 'float32');
        if (invalidType) {
            throw new Error(`PLY4 Loader: Strict PLY4 requires all vertex properties to be float32. Invalid property: ${invalidType.name} (${invalidType.type}).`);
        }

        if (!parsedHeader.hasTotalFramesComment || !Number.isInteger(parsedHeader.totalFrames) || parsedHeader.totalFrames < 1) {
            throw new Error('PLY4 Loader: Strict PLY4 requires `comment total_frames <int>` with value >= 1.');
        }
        if (parsedHeader.K_xyz < 1) {
            throw new Error('PLY4 Loader: Strict PLY4 requires at least one XYZ bank keyframe group.');
        }
        if (!parsedHeader.hasXYZStrideComment || !Number.isInteger(parsedHeader.xyzStride) || parsedHeader.xyzStride < 1) {
            throw new Error('PLY4 Loader: Strict PLY4 requires `comment xyz_bank_keyframe_stride <int>` with value >= 1.');
        }
        if (parsedHeader.K_rot > 0 && (!parsedHeader.hasRotStrideComment || !Number.isInteger(parsedHeader.rotStride) || parsedHeader.rotStride < 1)) {
            throw new Error('PLY4 Loader: Strict PLY4 requires `comment rot_bank_keyframe_stride <int>` when ROT bank properties exist.');
        }
        if (parsedHeader.K_dc > 0 && (!parsedHeader.hasDCStrideComment || !Number.isInteger(parsedHeader.dcStride) || parsedHeader.dcStride < 1)) {
            throw new Error('PLY4 Loader: Strict PLY4 requires `comment features_dc_bank_keyframe_stride <int>` when DC bank properties exist.');
        }

        const expectedDC = ['f_dc_0', 'f_dc_1', 'f_dc_2'];
        if (parsedHeader.fdcNames.length !== expectedDC.length || parsedHeader.fdcNames.some((name, index) => name !== expectedDC[index])) {
            throw new Error('PLY4 Loader: Strict PLY4 requires exactly `f_dc_0`, `f_dc_1`, `f_dc_2` in order.');
        }
        if (parsedHeader.frestNames.some((name, index) => name !== `f_rest_${index}`)) {
            throw new Error('PLY4 Loader: Strict PLY4 requires contiguous `f_rest_0 ... f_rest_N` properties.');
        }

        const expectedPropertyNames: string[] = [
            'x', 'y', 'z',
            'nx', 'ny', 'nz',
            ...expectedDC,
            ...parsedHeader.frestNames,
            'opacity',
            'scale_0', 'scale_1', 'scale_2',
            'lifetime_mu', 'lifetime_w'
        ];
        for (let k = 0; k < parsedHeader.K_xyz; k++) {
            expectedPropertyNames.push(`xyz_bank_${k}_x`, `xyz_bank_${k}_y`, `xyz_bank_${k}_z`);
        }
        for (let k = 0; k < parsedHeader.K_rot; k++) {
            expectedPropertyNames.push(`rot_bank_${k}_x`, `rot_bank_${k}_y`, `rot_bank_${k}_z`, `rot_bank_${k}_w`);
        }
        for (let k = 0; k < parsedHeader.K_dc; k++) {
            expectedPropertyNames.push(`f_dc_bank_${k}_0`, `f_dc_bank_${k}_1`, `f_dc_bank_${k}_2`);
        }

        const actualPropertyNames = parsedHeader.propertyTypes.map((prop) => prop.name);
        if (actualPropertyNames.length !== expectedPropertyNames.length) {
            throw new Error(
                `PLY4 Loader: Strict PLY4 property count mismatch. Expected ${expectedPropertyNames.length}, got ${actualPropertyNames.length}.`
            );
        }
        const mismatchIndex = expectedPropertyNames.findIndex((name, index) => actualPropertyNames[index] !== name);
        if (mismatchIndex !== -1) {
            throw new Error(
                `PLY4 Loader: Strict PLY4 property order mismatch at index ${mismatchIndex}. ` +
                `Expected \`${expectedPropertyNames[mismatchIndex]}\`, got \`${actualPropertyNames[mismatchIndex]}\`.`
            );
        }
    }

    private createDataArrays(count: number, K_xyz: number, K_rot: number, K_dc: number, fdcNames: string[], frestNames: string[]) {
        const data: any = {
            x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
            nx: new Float32Array(count), ny: new Float32Array(count), nz: new Float32Array(count),
            opacity: new Float32Array(count),
            scale_0: new Float32Array(count), scale_1: new Float32Array(count), scale_2: new Float32Array(count),
            rot_0: new Float32Array(count), rot_1: new Float32Array(count), rot_2: new Float32Array(count), rot_3: new Float32Array(count),
            lifetime_mu: new Float32Array(count), lifetime_w: new Float32Array(count), lifetime_k: new Float32Array(count),
            xyzBank: K_xyz > 0 ? new Float32Array(count * K_xyz * 3) : null,
            rotBank: K_rot > 0 ? new Float32Array(count * K_rot * 4) : null,
            dcBank: K_dc > 0 ? new Float32Array(count * K_dc * 3) : null
        };
        for (const name of fdcNames) data[name] = new Float32Array(count);
        for (const name of frestNames) data[name] = new Float32Array(count);
        return data;
    }

    private ensureWithinBrowserMemoryBudget(parsedHeader: { vertexCount: number; K_xyz: number; K_rot: number; K_dc: number; fdcNames: string[]; frestNames: string[] }) {
        const estimatedBytes = this.estimateCpuAllocationBytes(parsedHeader.vertexCount, parsedHeader.K_xyz, parsedHeader.K_rot, parsedHeader.K_dc, parsedHeader.fdcNames.length, parsedHeader.frestNames.length);
        if (estimatedBytes > PLY4Loader.MAX_ESTIMATED_CPU_BYTES) {
            throw new Error(
                `PLY4 is too large for browser memory in this viewer. ` +
                `Estimated decode memory: ${this.formatBytes(estimatedBytes)} ` +
                `(limit ${this.formatBytes(PLY4Loader.MAX_ESTIMATED_CPU_BYTES)}).`
            );
        }
    }

    private estimateCpuAllocationBytes(count: number, K_xyz: number, K_rot: number, K_dc: number, fdcCount: number, frestCount: number) {
        const bytesPerFloat = 4;
        const baseFloats = count * (17 + fdcCount);
        const fRestFloats = count * frestCount;
        const xyzFloats = count * K_xyz * 3;
        const rotFloats = count * K_rot * 4;
        const dcFloats = count * K_dc * 3;
        return (baseFloats + fRestFloats + xyzFloats + rotFloats + dcFloats) * bytesPerFloat;
    }

    private extractTrailingIndex(name: string) {
        const match = name.match(/_(\d+)$/);
        return match ? parseInt(match[1], 10) : -1;
    }

    private formatBytes(bytes: number) {
        return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
    }

    private buildPropertyOffsets(propertyTypes: { name: string; size: number }[]) {
        const propOffsets: Record<string, number> = {};
        let currentOffset = 0;
        propertyTypes.forEach((p) => {
            propOffsets[p.name] = currentOffset;
            currentOffset += p.size;
        });
        return propOffsets;
    }

    private buildXYZBankNames(K_xyz: number) {
        return Array.from({ length: K_xyz }, (_, k) => [`xyz_bank_${k}_x`, `xyz_bank_${k}_y`, `xyz_bank_${k}_z`]);
    }

    private buildRotBankNames(K_rot: number) {
        return Array.from({ length: K_rot }, (_, k) => [`rot_bank_${k}_x`, `rot_bank_${k}_y`, `rot_bank_${k}_z`, `rot_bank_${k}_w`]);
    }

    private buildDCBankNames(K_dc: number) {
        return Array.from({ length: K_dc }, (_, k) => [`f_dc_bank_${k}_0`, `f_dc_bank_${k}_1`, `f_dc_bank_${k}_2`]);
    }

    private parseRowsIntoData(
        view: DataView,
        bodyStart: number,
        rowCount: number,
        rowSize: number,
        isLittleEndian: boolean,
        propOffsets: Record<string, number>,
        data: any,
        K_xyz: number,
        K_rot: number,
        K_dc: number,
        xyzBankNames: string[][],
        rotBankNames: string[][],
        dcBankNames: string[][],
        fdcNames: string[],
        frestNames: string[],
        globalStartRow: number
    ) {
        const getFloat = (name: string, rowBase: number) => {
            if (propOffsets[name] === undefined) return 0;
            const offset = rowBase + propOffsets[name];
            if (offset + 4 > view.byteLength) return 0;
            return view.getFloat32(offset, isLittleEndian);
        };

        const hasProp = (name: string) => propOffsets[name] !== undefined;

        for (let localRow = 0; localRow < rowCount; localRow++) {
            const i = globalStartRow + localRow;
            const rowBase = bodyStart + localRow * rowSize;

            data.x[i] = getFloat('x', rowBase);
            data.y[i] = getFloat('y', rowBase);
            data.z[i] = getFloat('z', rowBase);
            // Keep raw logit opacity from PLY4. PlayCanvas GSplatData will apply sigmoid
            // when building the splat color texture, matching the Python reference path.
            data.opacity[i] = getFloat('opacity', rowBase);
            data.scale_0[i] = getFloat('scale_0', rowBase);
            data.scale_1[i] = getFloat('scale_1', rowBase);
            data.scale_2[i] = getFloat('scale_2', rowBase);
            for (const name of fdcNames) {
                data[name][i] = getFloat(name, rowBase);
            }

            for (const name of frestNames) {
                data[name][i] = getFloat(name, rowBase);
            }

            data.lifetime_mu[i] = getFloat('lifetime_mu', rowBase);
            data.lifetime_w[i] = getFloat('lifetime_w', rowBase);
            data.lifetime_k[i] = hasProp('lifetime_k') ? getFloat('lifetime_k', rowBase) : 10.0;

            if (K_xyz > 0) {
                for (let k = 0; k < K_xyz; k++) {
                    const bIdx = (i * K_xyz + k) * 3;
                    data.xyzBank[bIdx + 0] = getFloat(xyzBankNames[k][0], rowBase);
                    data.xyzBank[bIdx + 1] = getFloat(xyzBankNames[k][1], rowBase);
                    data.xyzBank[bIdx + 2] = getFloat(xyzBankNames[k][2], rowBase);
                }
            }

            if (K_rot > 0) {
                for (let k = 0; k < K_rot; k++) {
                    const bIdx = (i * K_rot + k) * 4;
                    const qx = getFloat(rotBankNames[k][0], rowBase);
                    const qy = getFloat(rotBankNames[k][1], rowBase);
                    const qz = getFloat(rotBankNames[k][2], rowBase);
                    const qw = getFloat(rotBankNames[k][3], rowBase);
                    data.rotBank[bIdx + 0] = qx;
                    data.rotBank[bIdx + 1] = qy;
                    data.rotBank[bIdx + 2] = qz;
                    data.rotBank[bIdx + 3] = qw;
                }
            }

            if (hasProp('rot_0')) {
                data.rot_0[i] = getFloat('rot_0', rowBase);
                data.rot_1[i] = getFloat('rot_1', rowBase);
                data.rot_2[i] = getFloat('rot_2', rowBase);
                data.rot_3[i] = getFloat('rot_3', rowBase);
            } else if (K_rot > 0) {
                const base = i * K_rot * 4;
                data.rot_0[i] = data.rotBank[base + 3];
                data.rot_1[i] = data.rotBank[base + 0];
                data.rot_2[i] = data.rotBank[base + 1];
                data.rot_3[i] = data.rotBank[base + 2];
            } else {
                data.rot_0[i] = 1;
                data.rot_1[i] = 0;
                data.rot_2[i] = 0;
                data.rot_3[i] = 0;
            }

            if (K_dc > 0) {
                for (let k = 0; k < K_dc; k++) {
                    const bIdx = (i * K_dc + k) * 3;
                    data.dcBank[bIdx + 0] = getFloat(dcBankNames[k][0], rowBase);
                    data.dcBank[bIdx + 1] = getFloat(dcBankNames[k][1], rowBase);
                    data.dcBank[bIdx + 2] = getFloat(dcBankNames[k][2], rowBase);
                }
            }
        }
    }

    private buildResult(data: any, parsedHeader: any) {
        const fdcNames = Object.keys(data).filter((name) => /^f_dc_\d+$/.test(name)).sort((a, b) => this.extractTrailingIndex(a) - this.extractTrailingIndex(b));
        const frestNames = Object.keys(data).filter((name) => /^f_rest_\d+$/.test(name)).sort((a, b) => this.extractTrailingIndex(a) - this.extractTrailingIndex(b));

        const properties: any[] = [
            { name: 'x', type: 'float', storage: data.x },
            { name: 'y', type: 'float', storage: data.y },
            { name: 'z', type: 'float', storage: data.z },
            { name: 'nx', type: 'float', storage: data.nx },
            { name: 'ny', type: 'float', storage: data.ny },
            { name: 'nz', type: 'float', storage: data.nz },
        ];
        for (const name of fdcNames) {
            properties.push({ name, type: 'float', storage: data[name] });
        }
        for (const name of frestNames) {
            properties.push({ name, type: 'float', storage: data[name] });
        }
        properties.push(
            { name: 'opacity', type: 'float', storage: data.opacity },
            { name: 'scale_0', type: 'float', storage: data.scale_0 },
            { name: 'scale_1', type: 'float', storage: data.scale_1 },
            { name: 'scale_2', type: 'float', storage: data.scale_2 },
            { name: 'rot_0', type: 'float', storage: data.rot_0 },
            { name: 'rot_1', type: 'float', storage: data.rot_1 },
            { name: 'rot_2', type: 'float', storage: data.rot_2 },
            { name: 'rot_3', type: 'float', storage: data.rot_3 },
            { name: 'lifetime_mu', type: 'float', storage: data.lifetime_mu },
            { name: 'lifetime_w', type: 'float', storage: data.lifetime_w },
            { name: 'lifetime_k', type: 'float', storage: data.lifetime_k },
        );

        return {
            x: data.x, y: data.y, z: data.z,
            opacity: data.opacity,
            opacitySemantic: 'logit',
            rotationSemantic: 'xyzw',
            scale_0: data.scale_0, scale_1: data.scale_1, scale_2: data.scale_2,
            rot_0: data.rot_0, rot_1: data.rot_1, rot_2: data.rot_2, rot_3: data.rot_3,
            f_dc_0: data.f_dc_0, f_dc_1: data.f_dc_1, f_dc_2: data.f_dc_2,
            plyData: {
                elements: [{
                    name: 'vertex',
                    count: parsedHeader.vertexCount,
                    properties
                }]
            },
            count: parsedHeader.vertexCount,
            is4DGS: parsedHeader.K_xyz > 0,
            trajectory: data.xyzBank,
            keyframes: parsedHeader.K_xyz,
            frames: parsedHeader.totalFrames > 0 ? parsedHeader.totalFrames : 1,
            xyzStride: parsedHeader.xyzStride,
            rotTrajectory: data.rotBank,
            rotKeyframes: parsedHeader.K_rot,
            rotStride: parsedHeader.rotStride,
            dcTrajectory: data.dcBank,
            dcKeyframes: parsedHeader.K_dc,
            dcStride: parsedHeader.dcStride,
            bands: frestNames.length >= 45 ? 3 : (frestNames.length >= 24 ? 2 : (frestNames.length >= 9 ? 1 : 0)),
            strictPly4: parsedHeader.isStrictPly4,
            cameras: parsedHeader.cameras,
            meta: {
                modelPos: parsedHeader.modelPos,
                modelRot: parsedHeader.modelRot,
                modelScale: parsedHeader.modelScale,
                extraComments: parsedHeader.extraComments
            }
        };
    }
}
