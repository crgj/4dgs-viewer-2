export type ModelTransform = {
    pos: [number, number, number];
    rot: [number, number, number, number];
    scale: [number, number, number];
};

const finiteOr = (value: unknown, fallback: number) => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
};

const readVec3 = (value: any, fallback: [number, number, number]) => {
    if (Array.isArray(value) && value.length >= 3) {
        return [
            finiteOr(value[0], fallback[0]),
            finiteOr(value[1], fallback[1]),
            finiteOr(value[2], fallback[2])
        ] as [number, number, number];
    }
    if (value && typeof value === 'object') {
        return [
            finiteOr(value.x, fallback[0]),
            finiteOr(value.y, fallback[1]),
            finiteOr(value.z, fallback[2])
        ] as [number, number, number];
    }
    return [...fallback] as [number, number, number];
};

const readQuat = (value: any, fallback: [number, number, number, number]) => {
    if (Array.isArray(value) && value.length >= 4) {
        return [
            finiteOr(value[0], fallback[0]),
            finiteOr(value[1], fallback[1]),
            finiteOr(value[2], fallback[2]),
            finiteOr(value[3], fallback[3])
        ] as [number, number, number, number];
    }
    if (value && typeof value === 'object') {
        return [
            finiteOr(value.x, fallback[0]),
            finiteOr(value.y, fallback[1]),
            finiteOr(value.z, fallback[2]),
            finiteOr(value.w, fallback[3])
        ] as [number, number, number, number];
    }
    return [...fallback] as [number, number, number, number];
};

export const DEFAULT_MODEL_TRANSFORM: ModelTransform = {
    pos: [0, 0, 0],
    rot: [0, 0, 0, 1],
    scale: [1, 1, 1]
};

export const cloneModelTransform = (transform: ModelTransform): ModelTransform => ({
    pos: [...transform.pos] as [number, number, number],
    rot: [...transform.rot] as [number, number, number, number],
    scale: [...transform.scale] as [number, number, number]
});

export const normalizeModelTransform = (transform: any): ModelTransform | null => {
    if (!transform || typeof transform !== 'object') return null;
    const pos = readVec3(transform.pos, DEFAULT_MODEL_TRANSFORM.pos);
    const rot = readQuat(transform.rot, DEFAULT_MODEL_TRANSFORM.rot);
    const scale = readVec3(transform.scale, DEFAULT_MODEL_TRANSFORM.scale);
    return { pos, rot, scale };
};

export const normalizeLegacyModelTransform = (meta: any): ModelTransform | null => {
    if (!meta || typeof meta !== 'object') return null;
    if (!meta.modelPos && !meta.modelRot && !meta.modelScale) return null;
    return {
        pos: readVec3(meta.modelPos, DEFAULT_MODEL_TRANSFORM.pos),
        rot: readQuat(meta.modelRot, DEFAULT_MODEL_TRANSFORM.rot),
        scale: readVec3(meta.modelScale, DEFAULT_MODEL_TRANSFORM.scale)
    };
};

export const chooseExportModelTransform = ({
    entityTransform,
    sourceTransform,
    preserveSource
}: {
    entityTransform?: ModelTransform | null;
    sourceTransform?: ModelTransform | null;
    preserveSource?: boolean;
}): ModelTransform => {
    if (preserveSource && sourceTransform) {
        return cloneModelTransform(sourceTransform);
    }
    if (entityTransform) {
        return cloneModelTransform(entityTransform);
    }
    if (sourceTransform) {
        return cloneModelTransform(sourceTransform);
    }
    return cloneModelTransform(DEFAULT_MODEL_TRANSFORM);
};
