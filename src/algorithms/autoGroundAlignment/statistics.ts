import type { GaussianPoint, Vec3 } from './types';
import { centroid, dot, sub } from './vector';

// #WDD-gpt 2026-05-16 - 统计与采样工具，所有阈值由分位数和场景尺度自适应
export const quantileSorted = (sorted: number[], q: number) => {
    if (!sorted.length) return 0;
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
    return sorted[idx];
};

export const quantile = (values: number[], q: number) => {
    if (!values.length) return 0;
    return quantileSorted([...values].sort((a, b) => a - b), q);
};

export const median = (values: number[]) => quantile(values, 0.5);

export const trimmedMeanVec3 = (points: Vec3[], trim = 0.15): Vec3 => {
    if (!points.length) return [0, 0, 0];
    const c = centroid(points);
    const ranked = points
        .map((p) => ({ p, d: dot(sub(p, c), sub(p, c)) }))
        .sort((a, b) => a.d - b.d);
    const keep = ranked.slice(0, Math.max(1, Math.floor(ranked.length * (1 - trim))));
    return centroid(keep.map((x) => x.p));
};

export const sampleDeterministic = <T>(items: T[], maxCount: number): T[] => {
    if (items.length <= maxCount) return items.slice();
    const out: T[] = [];
    const step = items.length / maxCount;
    for (let i = 0; i < maxCount; i++) out.push(items[Math.floor(i * step)]);
    return out;
};

export const seededRandom = (seed = 1337) => {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
};

export const scaleValue = (point: GaussianPoint) => {
    if (typeof point.scale === 'number') return point.scale;
    if (Array.isArray(point.scale)) return Math.max(point.scale[0], point.scale[1], point.scale[2]);
    return 1;
};

export const distancesToKthNeighbor = (points: GaussianPoint[], k: number, maxPoints = 12000) => {
    const sample = sampleDeterministic(points, maxPoints);
    const result = new Map<string | number, number>();
    for (const p of sample) {
        const distances: number[] = [];
        for (const q of sample) {
            if (p === q) continue;
            const dx = p.position[0] - q.position[0];
            const dy = p.position[1] - q.position[1];
            const dz = p.position[2] - q.position[2];
            distances.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        distances.sort((a, b) => a - b);
        result.set(p.id, distances[Math.min(k - 1, distances.length - 1)] || 0);
    }
    return result;
};

export const medianKnnDistance = (points: GaussianPoint[], k: number, maxPoints = 8000) => {
    const map = distancesToKthNeighbor(points, k, maxPoints);
    return median([...map.values()].filter(Number.isFinite));
};
