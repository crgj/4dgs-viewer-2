type SplatProperty = {
    name: string;
    type?: string;
    storage?: unknown;
};

const KEYFRAME_COUNT = 2;
const TOTAL_FRAMES = 2;
const KEYFRAME_STRIDE = 1;
const LIFETIME_CENTER = (TOTAL_FRAMES - 1) * 0.5;
const LIFETIME_HALF_WIDTH = (TOTAL_FRAMES + 1) * 0.5;
const LIFETIME_SHARPNESS = 10;

const getVertexProperties = (parsed: any): SplatProperty[] => {
    const properties = parsed?.plyData?.elements?.[0]?.properties;
    if (!Array.isArray(properties)) {
        throw new Error('Static PLY conversion requires plyData.elements[0].properties.');
    }
    return properties;
};

const readFloatProperty = (parsed: any, properties: SplatProperty[], name: string, count: number): Float32Array => {
    const topLevel = parsed?.[name];
    const property = properties.find((entry) => entry.name === name)?.storage;
    const values = topLevel instanceof Float32Array
        ? topLevel
        : property instanceof Float32Array
            ? property
            : null;

    if (!values || values.length < count) {
        throw new Error(`Static PLY conversion requires a complete '${name}' Gaussian property.`);
    }
    return values;
};

const writeFloatProperty = (parsed: any, properties: SplatProperty[], name: string, values: Float32Array) => {
    const property = properties.find((entry) => entry.name === name);
    if (property) {
        property.type = 'float';
        property.storage = values;
    } else {
        properties.push({ name, type: 'float', storage: values });
    }
    parsed[name] = values;
};

const duplicateKeyframes = (components: Float32Array[], count: number): Float32Array => {
    const componentCount = components.length;
    const result = new Float32Array(count * KEYFRAME_COUNT * componentCount);
    for (let index = 0; index < count; index++) {
        for (let keyframe = 0; keyframe < KEYFRAME_COUNT; keyframe++) {
            const offset = (index * KEYFRAME_COUNT + keyframe) * componentCount;
            for (let component = 0; component < componentCount; component++) {
                result[offset + component] = components[component][index];
            }
        }
    }
    return result;
};

export const convertStaticSplatToTwoKeyframePLY4 = (parsed: any): any => {
    const count = Number(parsed?.count ?? parsed?.plyData?.elements?.[0]?.count ?? 0);
    if (!Number.isInteger(count) || count <= 0) {
        throw new Error('Static PLY conversion requires a positive Gaussian count.');
    }

    const properties = getVertexProperties(parsed);
    const x = readFloatProperty(parsed, properties, 'x', count);
    const y = readFloatProperty(parsed, properties, 'y', count);
    const z = readFloatProperty(parsed, properties, 'z', count);
    const rot0 = readFloatProperty(parsed, properties, 'rot_0', count);
    const rot1 = readFloatProperty(parsed, properties, 'rot_1', count);
    const rot2 = readFloatProperty(parsed, properties, 'rot_2', count);
    const rot3 = readFloatProperty(parsed, properties, 'rot_3', count);
    const dc0 = readFloatProperty(parsed, properties, 'f_dc_0', count);
    const dc1 = readFloatProperty(parsed, properties, 'f_dc_1', count);
    const dc2 = readFloatProperty(parsed, properties, 'f_dc_2', count);

    const lifetimeMu = new Float32Array(count);
    const lifetimeW = new Float32Array(count);
    const lifetimeK = new Float32Array(count);
    lifetimeMu.fill(LIFETIME_CENTER);
    lifetimeW.fill(LIFETIME_HALF_WIDTH);
    lifetimeK.fill(LIFETIME_SHARPNESS);

    // #WDD-gpt 2026-07-31 - 在创建 GSplatData 前补齐 PLY4 标准双关键帧和全时段生命周期，确保静态 PLY 使用完整 4D 编辑链路。
    parsed.trajectory = duplicateKeyframes([x, y, z], count);
    parsed.keyframes = KEYFRAME_COUNT;
    parsed.xyzStride = KEYFRAME_STRIDE;
    parsed.rotTrajectory = duplicateKeyframes([rot0, rot1, rot2, rot3], count);
    parsed.rotKeyframes = KEYFRAME_COUNT;
    parsed.rotStride = KEYFRAME_STRIDE;
    parsed.dcTrajectory = duplicateKeyframes([dc0, dc1, dc2], count);
    parsed.dcKeyframes = KEYFRAME_COUNT;
    parsed.dcStride = KEYFRAME_STRIDE;
    parsed.frames = TOTAL_FRAMES;
    parsed.is4DGS = true;
    parsed.opacitySemantic = parsed.opacitySemantic || 'logit';
    parsed.rotationSemantic = 'wxyz';

    writeFloatProperty(parsed, properties, 'lifetime_mu', lifetimeMu);
    writeFloatProperty(parsed, properties, 'lifetime_w', lifetimeW);
    writeFloatProperty(parsed, properties, 'lifetime_k', lifetimeK);

    return parsed;
};

