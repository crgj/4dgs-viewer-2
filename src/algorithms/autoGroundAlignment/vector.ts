import type { CameraPose, GaussianPoint, Vec3 } from './types';

// #WDD-gpt 2026-05-16 - 提供无依赖 Vec3 与刚体变换工具，供算法和自测复用
export const EPS = 1e-9;

export const v = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
];
export const lengthSq = (a: Vec3) => dot(a, a);
export const length = (a: Vec3) => Math.sqrt(lengthSq(a));
export const distance = (a: Vec3, b: Vec3) => length(sub(a, b));
export const normalize = (a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 => {
    const l = length(a);
    return l > EPS ? mul(a, 1 / l) : [...fallback] as Vec3;
};

export const centroid = (points: Vec3[]): Vec3 => {
    if (!points.length) return [0, 0, 0];
    const c: Vec3 = [0, 0, 0];
    for (const p of points) {
        c[0] += p[0];
        c[1] += p[1];
        c[2] += p[2];
    }
    return [c[0] / points.length, c[1] / points.length, c[2] / points.length];
};

export const bboxOfPoints = (points: GaussianPoint[] | Vec3[]) => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const item of points as Array<GaussianPoint | Vec3>) {
        const p = Array.isArray(item) ? item : item.position;
        for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], p[i]);
            max[i] = Math.max(max[i], p[i]);
        }
    }
    if (!points.length) return { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
    return { min, max };
};

export const sceneScale = (points: GaussianPoint[]) => {
    const { min, max } = bboxOfPoints(points);
    return Math.max(EPS, distance(min, max));
};

export const applyMatrix = (m: number[][], p: Vec3): Vec3 => [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2]
];

export const matMul = (a: number[][], b: number[][]): number[][] => [
    [
        a[0][0] * b[0][0] + a[0][1] * b[1][0] + a[0][2] * b[2][0],
        a[0][0] * b[0][1] + a[0][1] * b[1][1] + a[0][2] * b[2][1],
        a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2] * b[2][2]
    ],
    [
        a[1][0] * b[0][0] + a[1][1] * b[1][0] + a[1][2] * b[2][0],
        a[1][0] * b[0][1] + a[1][1] * b[1][1] + a[1][2] * b[2][1],
        a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2] * b[2][2]
    ],
    [
        a[2][0] * b[0][0] + a[2][1] * b[1][0] + a[2][2] * b[2][0],
        a[2][0] * b[0][1] + a[2][1] * b[1][1] + a[2][2] * b[2][1],
        a[2][0] * b[0][2] + a[2][1] * b[1][2] + a[2][2] * b[2][2]
    ]
];

export const identity3 = (): number[][] => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export const rotationFromTo = (fromRaw: Vec3, toRaw: Vec3): number[][] => {
    const from = normalize(fromRaw);
    const to = normalize(toRaw);
    const c = Math.max(-1, Math.min(1, dot(from, to)));
    if (c > 1 - 1e-8) return identity3();
    let axis = cross(from, to);
    if (c < -1 + 1e-8) {
        axis = Math.abs(from[0]) < 0.8 ? cross(from, [1, 0, 0]) : cross(from, [0, 1, 0]);
    }
    axis = normalize(axis);
    const angle = Math.acos(c);
    return rotationAroundAxis(axis, angle);
};

export const rotationAroundAxis = (axisRaw: Vec3, angle: number): number[][] => {
    const axis = normalize(axisRaw);
    const [x, y, z] = axis;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    return [
        [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
        [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
        [t * x * z - s * y, t * y * z + s * x, t * z * z + c]
    ];
};

export const transformCameraPose = (camera: CameraPose, rotationMatrix: number[][], translation: Vec3): CameraPose => ({
    ...camera,
    position: add(applyMatrix(rotationMatrix, camera.position), translation),
    forward: camera.forward ? applyMatrix(rotationMatrix, camera.forward) : undefined,
    target: camera.target ? add(applyMatrix(rotationMatrix, camera.target), translation) : undefined
});

export const transformGaussianRotation = (originalRotation: unknown, alignmentRotation: number[][]): unknown => {
    const qAlign = quaternionFromRotationMatrix(alignmentRotation);
    if (Array.isArray(originalRotation) && originalRotation.length >= 4) {
        const q = multiplyQuat(qAlign, [Number(originalRotation[0]), Number(originalRotation[1]), Number(originalRotation[2]), Number(originalRotation[3])]);
        return q;
    }
    if (originalRotation && typeof originalRotation === 'object') {
        const r = originalRotation as { x?: number; y?: number; z?: number; w?: number };
        if ([r.x, r.y, r.z, r.w].every((x) => typeof x === 'number' && Number.isFinite(x))) {
            const q = multiplyQuat(qAlign, [r.x!, r.y!, r.z!, r.w!]);
            return { ...originalRotation, x: q[0], y: q[1], z: q[2], w: q[3] };
        }
    }
    return originalRotation;
};

const quaternionFromRotationMatrix = (m: number[][]): [number, number, number, number] => {
    const trace = m[0][0] + m[1][1] + m[2][2];
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 1;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = 0.25 * s;
        x = (m[2][1] - m[1][2]) / s;
        y = (m[0][2] - m[2][0]) / s;
        z = (m[1][0] - m[0][1]) / s;
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
        const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
        w = (m[2][1] - m[1][2]) / s;
        x = 0.25 * s;
        y = (m[0][1] + m[1][0]) / s;
        z = (m[0][2] + m[2][0]) / s;
    } else if (m[1][1] > m[2][2]) {
        const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
        w = (m[0][2] - m[2][0]) / s;
        x = (m[0][1] + m[1][0]) / s;
        y = 0.25 * s;
        z = (m[1][2] + m[2][1]) / s;
    } else {
        const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
        w = (m[1][0] - m[0][1]) / s;
        x = (m[0][2] + m[2][0]) / s;
        y = (m[1][2] + m[2][1]) / s;
        z = 0.25 * s;
    }
    const inv = 1 / Math.max(EPS, Math.sqrt(x * x + y * y + z * z + w * w));
    return [x * inv, y * inv, z * inv, w * inv];
};

const multiplyQuat = (a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] => {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz
    ];
};
