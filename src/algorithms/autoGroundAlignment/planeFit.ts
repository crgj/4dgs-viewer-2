import type { GaussianPoint, Plane, ResolvedAutoGroundAlignmentOptions, Vec3 } from './types';
import { computePCA } from './pca';
import { quantile, sampleDeterministic, seededRandom } from './statistics';
import { centroid, cross, distance, dot, length, normalize, sub } from './vector';

// #WDD-gpt 2026-05-16 - 局部支撑面 RANSAC + 最小二乘重拟合
export function robustLocalPlaneRANSAC(points: GaussianPoint[], options: ResolvedAutoGroundAlignmentOptions): Plane | null {
    if (points.length < 12) return null;
    const sample = sampleDeterministic(points, Math.min(options.maxRansacPoints, points.length));
    const scale = Math.max(1e-6, sceneScaleFromSample(sample));
    const threshold = options.ransacDistanceThreshold > 0
        ? options.ransacDistanceThreshold
        : Math.max(scale * 0.018, quantileKnn(sample) * 1.8);
    const rand = seededRandom(20260516);
    let best: { normal: Vec3; d: number; inliers: GaussianPoint[] } | null = null;

    for (let i = 0; i < options.ransacIterations; i++) {
        const a = sample[Math.floor(rand() * sample.length)];
        const b = sample[Math.floor(rand() * sample.length)];
        const c = sample[Math.floor(rand() * sample.length)];
        if (!a || !b || !c || a === b || a === c || b === c) continue;
        const plane = planeFromThree(a.position, b.position, c.position);
        if (!plane) continue;
        const inliers = sample.filter((p) => Math.abs(pointPlaneDistance(p.position, plane.normal, plane.d)) <= threshold);
        if (!best || inliers.length > best.inliers.length) best = { ...plane, inliers };
    }

    if (!best || best.inliers.length < Math.max(8, sample.length * options.minPlaneInlierRatio)) return null;
    const refined = fitPlaneLeastSquares(best.inliers);
    if (!refined) return null;
    const allInliers = points.filter((p) => Math.abs(pointPlaneDistance(p.position, refined.normal, refined.d)) <= threshold);
    const rms = Math.sqrt(allInliers.reduce((sum, p) => {
        const d = pointPlaneDistance(p.position, refined.normal, refined.d);
        return sum + d * d;
    }, 0) / Math.max(1, allInliers.length));
    return {
        normal: refined.normal,
        d: refined.d,
        inliers: allInliers,
        inlierRatio: allInliers.length / Math.max(1, points.length),
        coverageArea: estimateCoverageArea(allInliers, refined.normal),
        rmsError: rms
    };
}

export function fitPlaneLeastSquares(points: GaussianPoint[]): { normal: Vec3; d: number } | null {
    if (points.length < 3) return null;
    const positions = points.map((p) => p.position);
    const c = centroid(positions);
    const pca = computePCA(positions);
    if (!pca) return null;
    const normal = normalize(pca.eigenVectors[2]);
    return { normal, d: -dot(normal, c) };
}

export function pointPlaneDistance(p: Vec3, normal: Vec3, d: number) {
    return dot(normal, p) + d;
}

export function projectToPlane(p: Vec3, normal: Vec3, d: number): Vec3 {
    const signed = pointPlaneDistance(p, normal, d);
    return [p[0] - normal[0] * signed, p[1] - normal[1] * signed, p[2] - normal[2] * signed];
}

export function orientPlaneTowardPoint(plane: Plane, point: Vec3): Plane {
    if (pointPlaneDistance(point, plane.normal, plane.d) >= 0) return plane;
    return {
        ...plane,
        normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
        d: -plane.d
    };
}

function planeFromThree(a: Vec3, b: Vec3, c: Vec3): { normal: Vec3; d: number } | null {
    if (distance(a, b) < 1e-8 || distance(a, c) < 1e-8 || distance(b, c) < 1e-8) return null;
    const n = cross(sub(b, a), sub(c, a));
    if (length(n) < 1e-8) return null;
    const normal = normalize(n);
    return { normal, d: -dot(normal, a) };
}

function estimateCoverageArea(points: GaussianPoint[], normal: Vec3) {
    if (points.length < 3) return 0;
    const u = normalize(Math.abs(normal[1]) < 0.8 ? cross(normal, [0, 1, 0]) : cross(normal, [1, 0, 0]));
    const v = cross(normal, u);
    const us = points.map((p) => dot(p.position, u)).sort((a, b) => a - b);
    const vs = points.map((p) => dot(p.position, v)).sort((a, b) => a - b);
    return Math.max(0, quantile(us, 0.9) - quantile(us, 0.1)) * Math.max(0, quantile(vs, 0.9) - quantile(vs, 0.1));
}

function sceneScaleFromSample(points: GaussianPoint[]) {
    if (!points.length) return 1;
    const xs = points.map((p) => p.position[0]);
    const ys = points.map((p) => p.position[1]);
    const zs = points.map((p) => p.position[2]);
    return Math.sqrt(
        Math.pow(Math.max(...xs) - Math.min(...xs), 2) +
        Math.pow(Math.max(...ys) - Math.min(...ys), 2) +
        Math.pow(Math.max(...zs) - Math.min(...zs), 2)
    );
}

function quantileKnn(points: GaussianPoint[]) {
    const sample = sampleDeterministic(points, Math.min(1200, points.length));
    const nearest: number[] = [];
    for (const p of sample) {
        let d = Infinity;
        for (const q of sample) {
            if (p === q) continue;
            d = Math.min(d, distance(p.position, q.position));
        }
        if (Number.isFinite(d)) nearest.push(d);
    }
    return quantile(nearest, 0.5);
}
