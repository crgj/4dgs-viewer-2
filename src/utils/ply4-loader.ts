
import * as pc from 'playcanvas';

// Helper to sigmoid (matches Python/Shader)
const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));

export class PLY4Loader {
    private static readonly HEADER_PROBE_BYTES = 1024 * 1024;
    private static readonly BODY_CHUNK_BYTES = 64 * 1024 * 1024;

    constructor() { }

    async load(file: File | ArrayBuffer, progressCallback?: (progress: number, message: string) => void): Promise<any> {
        if (file instanceof File) {
            return this.parsePLYFile(file, progressCallback);
        }
        return this.parsePLYBuffer(file, progressCallback);
    }

    private async parsePLYFile(file: File, onProgress?: (p: number, msg: string) => void) {
        if (onProgress) onProgress(0, "Parsing PLY Header");

        const headerChunk = await file.slice(0, PLY4Loader.HEADER_PROBE_BYTES).arrayBuffer();
        const { headerEnd, headerText } = this.extractHeaderFromBuffer(headerChunk);
        const parsedHeader = this.parseHeaderText(headerText);
        const data = this.createDataArrays(parsedHeader.vertexCount, parsedHeader.K_xyz, parsedHeader.K_rot, parsedHeader.K_dc);

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
        const fRestNames = this.buildFRestNames();

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
                fRestNames,
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
        const data = this.createDataArrays(parsedHeader.vertexCount, parsedHeader.K_xyz, parsedHeader.K_rot, parsedHeader.K_dc);

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
        const fRestNames = this.buildFRestNames();

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
            fRestNames,
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

    private parseHeaderText(headerText: string) {
        const headerLines = headerText.split('\n');
        let isBinary = false;
        let isLittleEndian = true;
        let vertexCount = 0;
        const propertyTypes: { name: string, type: string, size: number, typeCode: string }[] = [];
        let totalFrames = 0;
        let xyzStride = 1;
        let rotStride = 1;
        let dcStride = 1;
        let modelPos: pc.Vec3 | null = null;
        let modelRot: pc.Quat | null = null;
        let modelScale: pc.Vec3 | null = null;

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
            } else if (parts[0] === 'comment') {
                if (line.includes('total_frames')) totalFrames = parseInt(parts[parts.indexOf('total_frames') + 1], 10);
                if (line.includes('xyz_bank_keyframe_stride')) xyzStride = parseInt(parts[parts.indexOf('xyz_bank_keyframe_stride') + 1], 10);
                if (line.includes('rot_bank_keyframe_stride')) rotStride = parseInt(parts[parts.indexOf('rot_bank_keyframe_stride') + 1], 10);
                if (line.includes('features_dc_bank_keyframe_stride')) dcStride = parseInt(parts[parts.indexOf('features_dc_bank_keyframe_stride') + 1], 10);
                if (line.includes('model_pos')) {
                    const idx = parts.indexOf('model_pos');
                    modelPos = new pc.Vec3(parseFloat(parts[idx + 1]), parseFloat(parts[idx + 2]), parseFloat(parts[idx + 3]));
                }
                if (line.includes('model_rot')) {
                    const idx = parts.indexOf('model_rot');
                    modelRot = new pc.Quat(parseFloat(parts[idx + 1]), parseFloat(parts[idx + 2]), parseFloat(parts[idx + 3]), parseFloat(parts[idx + 4]));
                }
                if (line.includes('model_scale')) {
                    const idx = parts.indexOf('model_scale');
                    modelScale = new pc.Vec3(parseFloat(parts[idx + 1]), parseFloat(parts[idx + 2]), parseFloat(parts[idx + 3]));
                }
            }
        }

        let maxK_xyz = -1;
        let maxK_rot = -1;
        let maxK_dc = -1;
        propertyTypes.forEach((p) => {
            if (p.name.startsWith('xyz_bank_')) {
                const parts = p.name.split('_');
                if (parts.length >= 4) maxK_xyz = Math.max(maxK_xyz, parseInt(parts[2], 10) || -1);
            }
            if (p.name.startsWith('rot_bank_')) {
                const parts = p.name.split('_');
                if (parts.length >= 4) maxK_rot = Math.max(maxK_rot, parseInt(parts[2], 10) || -1);
            }
            if (p.name.startsWith('f_dc_bank_')) {
                const parts = p.name.split('_');
                if (parts.length >= 5) maxK_dc = Math.max(maxK_dc, parseInt(parts[3], 10) || -1);
            }
        });

        const K_xyz = maxK_xyz + 1;
        const K_rot = maxK_rot > -1 ? maxK_rot + 1 : 0;
        const K_dc = maxK_dc > -1 ? maxK_dc + 1 : 0;

        console.log(`[PLY4] Meta: Frames=${totalFrames}, K_xyz=${K_xyz} (Stride ${xyzStride}), K_rot=${K_rot} (Stride ${rotStride}), K_dc=${K_dc} (Stride ${dcStride})`);

        return { isBinary, isLittleEndian, vertexCount, propertyTypes, totalFrames, xyzStride, rotStride, dcStride, modelPos, modelRot, modelScale, K_xyz, K_rot, K_dc };
    }

    private createDataArrays(count: number, K_xyz: number, K_rot: number, K_dc: number) {
        const data: any = {
            x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
            opacity: new Float32Array(count),
            scale_0: new Float32Array(count), scale_1: new Float32Array(count), scale_2: new Float32Array(count),
            rot_0: new Float32Array(count), rot_1: new Float32Array(count), rot_2: new Float32Array(count), rot_3: new Float32Array(count),
            f_dc_0: new Float32Array(count), f_dc_1: new Float32Array(count), f_dc_2: new Float32Array(count),
            lifetime_mu: new Float32Array(count), lifetime_w: new Float32Array(count), lifetime_k: new Float32Array(count),
            xyzBank: K_xyz > 0 ? new Float32Array(count * K_xyz * 3) : null,
            rotBank: K_rot > 0 ? new Float32Array(count * K_rot * 4) : null,
            dcBank: K_dc > 0 ? new Float32Array(count * K_dc * 3) : null
        };
        for (let i = 0; i < 45; i++) data[`f_rest_${i}`] = new Float32Array(count);
        return data;
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

    private buildFRestNames() {
        return Array.from({ length: 45 }, (_, i) => `f_rest_${i}`);
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
        fRestNames: string[],
        globalStartRow: number
    ) {
        const getFloat = (name: string, rowBase: number) => {
            if (propOffsets[name] === undefined) return 0;
            const offset = rowBase + propOffsets[name];
            if (offset + 4 > view.byteLength) return 0;
            return view.getFloat32(offset, isLittleEndian);
        };

        for (let localRow = 0; localRow < rowCount; localRow++) {
            const i = globalStartRow + localRow;
            const rowBase = bodyStart + localRow * rowSize;

            data.x[i] = getFloat('x', rowBase);
            data.y[i] = getFloat('y', rowBase);
            data.z[i] = getFloat('z', rowBase);
            data.opacity[i] = sigmoid(getFloat('opacity', rowBase));
            data.scale_0[i] = getFloat('scale_0', rowBase);
            data.scale_1[i] = getFloat('scale_1', rowBase);
            data.scale_2[i] = getFloat('scale_2', rowBase);
            data.f_dc_0[i] = getFloat('f_dc_0', rowBase);
            data.f_dc_1[i] = getFloat('f_dc_1', rowBase);
            data.f_dc_2[i] = getFloat('f_dc_2', rowBase);

            for (let j = 0; j < 45; j++) {
                data[`f_rest_${j}`][i] = getFloat(fRestNames[j], rowBase);
            }

            data.lifetime_mu[i] = getFloat('lifetime_mu', rowBase);
            data.lifetime_w[i] = getFloat('lifetime_w', rowBase);
            data.lifetime_k[i] = 10.0;

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
                    data.rotBank[bIdx + 0] = getFloat(rotBankNames[k][0], rowBase);
                    data.rotBank[bIdx + 1] = getFloat(rotBankNames[k][1], rowBase);
                    data.rotBank[bIdx + 2] = getFloat(rotBankNames[k][2], rowBase);
                    data.rotBank[bIdx + 3] = getFloat(rotBankNames[k][3], rowBase);
                }
                data.rot_0[i] = data.rotBank[i * K_rot * 4 + 0];
                data.rot_1[i] = data.rotBank[i * K_rot * 4 + 1];
                data.rot_2[i] = data.rotBank[i * K_rot * 4 + 2];
                data.rot_3[i] = data.rotBank[i * K_rot * 4 + 3];
            } else {
                data.rot_0[i] = getFloat('rot_0', rowBase) || 1;
                data.rot_1[i] = getFloat('rot_1', rowBase) || 0;
                data.rot_2[i] = getFloat('rot_2', rowBase) || 0;
                data.rot_3[i] = getFloat('rot_3', rowBase) || 0;
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
        for (let i = 0; i < 45; i++) {
            properties.push({ name: `f_rest_${i}`, type: 'float', storage: data[`f_rest_${i}`] });
        }

        return {
            x: data.x, y: data.y, z: data.z,
            opacity: data.opacity,
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
            bands: data.f_rest_44 ? 3 : (data.f_rest_23 ? 2 : (data.f_rest_8 ? 1 : 0)),
            meta: {
                modelPos: parsedHeader.modelPos,
                modelRot: parsedHeader.modelRot,
                modelScale: parsedHeader.modelScale
            }
        };
    }
}
