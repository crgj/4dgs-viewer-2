import type { DynamicCluster, GaussianPoint, ResolvedAutoGroundAlignmentOptions } from './types';
import { estimateAdaptiveEps } from './filters';
import { computePCA } from './pca';
import { centroid, bboxOfPoints, distance } from './vector';

// #WDD-gpt 2026-05-16 - 动态点 DBSCAN/连通聚类，使用自适应 eps 识别人形主体候选
export function clusterDynamicPoints(points: GaussianPoint[], options: ResolvedAutoGroundAlignmentOptions): DynamicCluster[] {
    if (!points.length) return [];
    const sample = points.length > options.maxEstimationPoints
        ? points.filter((_, i) => i % Math.ceil(points.length / options.maxEstimationPoints) === 0)
        : points;
    const eps = estimateAdaptiveEps(sample, options);
    const grid = buildGrid(sample, eps);
    const minPts = Math.max(4, Math.min(12, Math.floor(options.knnK)));
    const visited = new Set<GaussianPoint>();
    const assigned = new Set<GaussianPoint>();
    const clusters: DynamicCluster[] = [];
    let id = 1;

    for (const p of sample) {
        if (visited.has(p)) continue;
        visited.add(p);
        const neighbors = regionQuery(grid, p, eps);
        if (neighbors.length < minPts) continue;
        const clusterPoints: GaussianPoint[] = [];
        const queue = neighbors.slice();
        assigned.add(p);
        clusterPoints.push(p);
        for (let qi = 0; qi < queue.length; qi++) {
            const q = queue[qi];
            if (!visited.has(q)) {
                visited.add(q);
                const qn = regionQuery(grid, q, eps);
                if (qn.length >= minPts) queue.push(...qn);
            }
            if (!assigned.has(q)) {
                assigned.add(q);
                clusterPoints.push(q);
            }
        }
        if (clusterPoints.length >= options.dynamicClusterMinPoints) {
            clusters.push(makeCluster(id++, clusterPoints));
        }
    }

    return clusters.sort((a, b) => b.points.length - a.points.length);
}

function buildGrid(points: GaussianPoint[], cellSize: number) {
    const cells = new Map<string, GaussianPoint[]>();
    for (const p of points) {
        const key = cellKey(p, cellSize);
        const bucket = cells.get(key);
        if (bucket) bucket.push(p);
        else cells.set(key, [p]);
    }
    return { cells, cellSize };
}

function regionQuery(grid: { cells: Map<string, GaussianPoint[]>; cellSize: number }, p: GaussianPoint, eps: number) {
    const out: GaussianPoint[] = [];
    const [cx, cy, cz] = cellCoords(p, grid.cellSize);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
                const bucket = grid.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
                if (!bucket) continue;
                for (const q of bucket) {
                    if (distance(p.position, q.position) <= eps) out.push(q);
                }
            }
        }
    }
    return out;
}

function cellCoords(p: GaussianPoint, cellSize: number) {
    return [
        Math.floor(p.position[0] / cellSize),
        Math.floor(p.position[1] / cellSize),
        Math.floor(p.position[2] / cellSize)
    ] as const;
}

function cellKey(p: GaussianPoint, cellSize: number) {
    const c = cellCoords(p, cellSize);
    return `${c[0]},${c[1]},${c[2]}`;
}

export function makeCluster(id: number, points: GaussianPoint[]): DynamicCluster {
    const center = centroid(points.map((p) => p.position));
    const { min, max } = bboxOfPoints(points);
    const pca = computePCA(points.map((p) => p.position));
    return {
        id,
        points,
        center,
        bboxMin: min,
        bboxMax: max,
        eigenValues: pca?.eigenValues,
        eigenVectors: pca?.eigenVectors
    };
}
