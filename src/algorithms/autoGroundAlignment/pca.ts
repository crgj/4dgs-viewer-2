import type { Vec3 } from './types';
import { centroid, dot, normalize } from './vector';

// #WDD-gpt 2026-05-16 - 3x3 对称矩阵 Jacobi 特征分解，用于人体主轴和局部平面最小二乘
export function computePCA(points: Vec3[]): { eigenValues: [number, number, number]; eigenVectors: [Vec3, Vec3, Vec3] } | null {
    if (points.length < 3) return null;
    const c = centroid(points);
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of points) {
        const x = p[0] - c[0];
        const y = p[1] - c[1];
        const z = p[2] - c[2];
        cov[0][0] += x * x; cov[0][1] += x * y; cov[0][2] += x * z;
        cov[1][0] += y * x; cov[1][1] += y * y; cov[1][2] += y * z;
        cov[2][0] += z * x; cov[2][1] += z * y; cov[2][2] += z * z;
    }
    const inv = 1 / Math.max(1, points.length - 1);
    for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) cov[r][col] *= inv;
    const eig = jacobiEigenSymmetric3(cov);
    const order = [0, 1, 2].sort((a, b) => eig.values[b] - eig.values[a]);
    return {
        eigenValues: [eig.values[order[0]], eig.values[order[1]], eig.values[order[2]]],
        eigenVectors: [
            normalize([eig.vectors[0][order[0]], eig.vectors[1][order[0]], eig.vectors[2][order[0]]]),
            normalize([eig.vectors[0][order[1]], eig.vectors[1][order[1]], eig.vectors[2][order[1]]]),
            normalize([eig.vectors[0][order[2]], eig.vectors[1][order[2]], eig.vectors[2][order[2]]])
        ]
    };
}

export const orientAxisByReference = (axis: Vec3, reference: Vec3): Vec3 => dot(axis, reference) >= 0 ? axis : [-axis[0], -axis[1], -axis[2]];

function jacobiEigenSymmetric3(input: number[][]) {
    const a = input.map((row) => row.slice());
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let iter = 0; iter < 32; iter++) {
        let p = 0;
        let q = 1;
        let max = Math.abs(a[0][1]);
        const pairs: Array<[number, number]> = [[0, 2], [1, 2]];
        for (const [i, j] of pairs) {
            const val = Math.abs(a[i][j]);
            if (val > max) {
                max = val;
                p = i;
                q = j;
            }
        }
        if (max < 1e-12) break;
        const app = a[p][p];
        const aqq = a[q][q];
        const apq = a[p][q];
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        for (let k = 0; k < 3; k++) {
            const aik = a[p][k];
            const aqk = a[q][k];
            a[p][k] = c * aik - s * aqk;
            a[q][k] = s * aik + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
            const akp = a[k][p];
            const akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
            const vkp = v[k][p];
            const vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
        }
    }
    return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}
