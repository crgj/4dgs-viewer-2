type PlyProperty = {
    name: string;
    type?: string;
    storage: Float32Array;
};

export type PlyVertexElement = {
    name?: string;
    count: number;
    properties: PlyProperty[];
};

export type SHCompressionResult = {
    gaussianCount: number;
    sampleViewCount: number;
    restCoefficientCount: number;
    changedCoefficientCount: number;
};

type Vec3 = [number, number, number];

export type SHCompressionOptions = {
    cameraPositions?: Vec3[];
    regularization?: number;
};

const DEFAULT_SYNTHETIC_CAMERA_COUNT = 64;

const SH_C0 = 0.28209479177387814;
const SH_C1 = 0.4886025119029199;
const SH_C2_0 = 1.0925484305920792;
const SH_C2_1 = -1.0925484305920792;
const SH_C2_2 = 0.31539156525252005;
const SH_C2_3 = -1.0925484305920792;
const SH_C2_4 = 0.5462742152960396;
const SH_C3_0 = -0.5900435899266435;
const SH_C3_1 = 2.890611442640554;
const SH_C3_2 = -0.4570457994644658;
const SH_C3_3 = 0.3731763325901154;
const SH_C3_4 = -0.4570457994644658;
const SH_C3_5 = 1.445305721320277;
const SH_C3_6 = -0.5900435899266435;

// #WDD-gpt 2026-06-18 - 实验性 SH0+SH1 压缩算法说明
// #WDD-gpt 2026-06-18 - 输入数据沿用 3DGS/PlayCanvas 属性布局：f_dc_0..2 是 SH0/DC，f_rest_0..44 是 RGB 各 15 个高阶 SH 系数
// #WDD-gpt 2026-06-18 - 参考蒸馏算法改为两步法：先用采样视角下 full SH 颜色的平均值写入静态 RGB/DC，再用 SH1 拟合残差
// #WDD-gpt 2026-06-18 - high color 使用渲染颜色空间 0.5 + SH(d)，因此写回 DC 时使用 (rgb - 0.5) / SH_C0，避免 DC 亮度偏移
// #WDD-gpt 2026-06-18 - 采样相机由 Viewer 在“当前相机到模型原点半径”的球面上均匀构建，默认 64 个位置并全部看向原点
// #WDD-gpt 2026-06-18 - 每个 Gaussian 使用 normalize(camera_local_pos - gaussian_local_pos) 得到观察方向，避免固定方向忽略点的空间位置
// #WDD-gpt 2026-06-18 - 对残差求解 (D^T W D + lambda I)^-1 D^T W R，其中 D=[-SH_C1*y, SH_C1*z, -SH_C1*x]，和当前 shader 的 SH1 基函数一致
// #WDD-gpt 2026-06-18 - 写回后保留 f_rest_0..2 / 15..17 / 30..32 的一阶系数，清零二阶和三阶系数，从而让后续渲染/导出只依赖 SH0+SH1
export function compressVertexElementSHToLevel1(vertexElement: PlyVertexElement, options: SHCompressionOptions = {}): SHCompressionResult {
    const count = Math.max(0, Math.floor(vertexElement.count || 0));
    const dc = [getRequiredProperty(vertexElement, 'f_dc_0'), getRequiredProperty(vertexElement, 'f_dc_1'), getRequiredProperty(vertexElement, 'f_dc_2')];
    const rest = Array.from({ length: 45 }, (_, index) => getRequiredProperty(vertexElement, `f_rest_${index}`));
    const x = getProperty(vertexElement, 'x');
    const y = getProperty(vertexElement, 'y');
    const z = getProperty(vertexElement, 'z');
    const fallbackDirections = createFallbackViewDirections(DEFAULT_SYNTHETIC_CAMERA_COUNT);
    const cameraPositions = (options.cameraPositions || []).filter(isFiniteVec3);
    const regularization = Math.max(0, options.regularization ?? 1e-4);
    const sampleViewCount = cameraPositions.length || fallbackDirections.length;
    let changedCoefficientCount = 0;

    for (let i = 0; i < count; i++) {
        const directions = cameraPositions.length && x && y && z
            ? createCameraDirectionsForGaussian(cameraPositions, [x[i], y[i], z[i]])
            : fallbackDirections;
        for (let channel = 0; channel < 3; channel++) {
            const offset = channel * 15;
            const fullCoefficients = [
                dc[channel][i],
                rest[offset + 0][i],
                rest[offset + 1][i],
                rest[offset + 2][i],
                rest[offset + 3][i],
                rest[offset + 4][i],
                rest[offset + 5][i],
                rest[offset + 6][i],
                rest[offset + 7][i],
                rest[offset + 8][i],
                rest[offset + 9][i],
                rest[offset + 10][i],
                rest[offset + 11][i],
                rest[offset + 12][i],
                rest[offset + 13][i],
                rest[offset + 14][i]
            ];
            const fitted = fitStaticRGBThenSH1Residual(fullCoefficients, directions, regularization);
            dc[channel][i] = fitted[0];
            rest[offset + 0][i] = fitted[1];
            rest[offset + 1][i] = fitted[2];
            rest[offset + 2][i] = fitted[3];
        }

        for (let coeff = 3; coeff < 15; coeff++) {
            for (let channel = 0; channel < 3; channel++) {
                const target = rest[channel * 15 + coeff];
                if (target[i] !== 0) {
                    target[i] = 0;
                    changedCoefficientCount++;
                }
            }
        }
    }

    return {
        gaussianCount: count,
        sampleViewCount,
        restCoefficientCount: rest.length,
        changedCoefficientCount
    };
}

export function canCompressVertexElementSH(vertexElement: PlyVertexElement | null | undefined) {
    if (!vertexElement) return false;
    return ['f_dc_0', 'f_dc_1', 'f_dc_2'].every((name) => !!getProperty(vertexElement, name))
        && Array.from({ length: 45 }, (_, index) => `f_rest_${index}`).every((name) => !!getProperty(vertexElement, name));
}

function getProperty(vertexElement: PlyVertexElement, name: string) {
    return vertexElement.properties.find((property) => property.name === name)?.storage || null;
}

function getRequiredProperty(vertexElement: PlyVertexElement, name: string) {
    const storage = getProperty(vertexElement, name);
    if (!storage) throw new Error(`Missing SH property: ${name}`);
    return storage;
}

function createFallbackViewDirections(count: number): Vec3[] {
    const directions: Vec3[] = [];
    const n = Math.max(4, Math.floor(count));
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n;
        const radius = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = i * goldenAngle;
        directions.push([Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
    }
    return directions;
}

function normalize(direction: Vec3): Vec3 {
    const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function isFiniteVec3(value: Vec3) {
    return Number.isFinite(value?.[0]) && Number.isFinite(value?.[1]) && Number.isFinite(value?.[2]);
}

function createCameraDirectionsForGaussian(cameraPositions: Vec3[], point: Vec3): Vec3[] {
    const directions: Vec3[] = [];
    for (const camera of cameraPositions) {
        const base = normalize([camera[0] - point[0], camera[1] - point[1], camera[2] - point[2]]);
        if (!isFiniteVec3(base)) continue;
        directions.push(base);
    }
    return directions.length ? directions : createFallbackViewDirections(DEFAULT_SYNTHETIC_CAMERA_COUNT);
}

function firstOrderResidualBasis(direction: Vec3) {
    const [x, y, z] = direction;
    return [SH_C1 * -y, SH_C1 * z, SH_C1 * -x];
}

function fitStaticRGBThenSH1Residual(coefficients: number[], directions: Vec3[], regularization: number): [number, number, number, number] {
    const colors = directions.map((direction) => 0.5 + evalFullSHContribution(coefficients, direction));
    const rgb = colors.reduce((sum, color) => sum + color, 0) / Math.max(colors.length, 1);
    const ata = new Float64Array(9);
    const atr = new Float64Array(3);

    for (let i = 0; i < directions.length; i++) {
        const row = firstOrderResidualBasis(directions[i]);
        const residual = colors[i] - rgb;
        for (let r = 0; r < 3; r++) {
            atr[r] += row[r] * residual;
            for (let c = 0; c < 3; c++) ata[r * 3 + c] += row[r] * row[c];
        }
    }

    ata[0] += regularization;
    ata[4] += regularization;
    ata[8] += regularization;

    const sh1 = solve3x3(ata, atr);
    return [(rgb - 0.5) / SH_C0, sh1[0], sh1[1], sh1[2]];
}

function evalFullSHContribution(c: number[], direction: Vec3) {
    const [x, y, z] = direction;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const yz = y * z;
    const xz = x * z;

    return c[0] * SH_C0
        + SH_C1 * (-c[1] * y + c[2] * z - c[3] * x)
        + c[4] * (SH_C2_0 * xy)
        + c[5] * (SH_C2_1 * yz)
        + c[6] * (SH_C2_2 * (2 * zz - xx - yy))
        + c[7] * (SH_C2_3 * xz)
        + c[8] * (SH_C2_4 * (xx - yy))
        + c[9] * (SH_C3_0 * y * (3 * xx - yy))
        + c[10] * (SH_C3_1 * xy * z)
        + c[11] * (SH_C3_2 * y * (4 * zz - xx - yy))
        + c[12] * (SH_C3_3 * z * (2 * zz - 3 * xx - 3 * yy))
        + c[13] * (SH_C3_4 * x * (4 * zz - xx - yy))
        + c[14] * (SH_C3_5 * z * (xx - yy))
        + c[15] * (SH_C3_6 * x * (xx - 3 * yy));
}

function solve3x3(input: Float64Array, rhs: Float64Array) {
    const size = 3;
    const matrix = new Float64Array(size * (size + 1));
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) matrix[r * 4 + c] = input[r * 3 + c];
        matrix[r * 4 + size] = rhs[r];
    }

    for (let pivot = 0; pivot < size; pivot++) {
        let bestRow = pivot;
        let bestValue = Math.abs(matrix[pivot * 4 + pivot]);
        for (let r = pivot + 1; r < size; r++) {
            const value = Math.abs(matrix[r * 4 + pivot]);
            if (value > bestValue) {
                bestValue = value;
                bestRow = r;
            }
        }
        if (bestValue < 1e-12) return [0, 0, 0] as [number, number, number];
        if (bestRow !== pivot) {
            for (let c = 0; c < 4; c++) {
                const tmp = matrix[pivot * 4 + c];
                matrix[pivot * 4 + c] = matrix[bestRow * 4 + c];
                matrix[bestRow * 4 + c] = tmp;
            }
        }

        const scale = matrix[pivot * 4 + pivot];
        for (let c = 0; c < 4; c++) matrix[pivot * 4 + c] /= scale;

        for (let r = 0; r < size; r++) {
            if (r === pivot) continue;
            const factor = matrix[r * 4 + pivot];
            if (factor === 0) continue;
            for (let c = 0; c < 4; c++) matrix[r * 4 + c] -= factor * matrix[pivot * 4 + c];
        }
    }

    return [matrix[3], matrix[7], matrix[11]] as [number, number, number];
}
