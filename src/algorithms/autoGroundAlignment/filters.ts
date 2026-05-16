import type { GaussianPoint, ResolvedAutoGroundAlignmentOptions } from './types';
import { medianKnnDistance, quantile, sampleDeterministic, scaleValue } from './statistics';
import { distance, sceneScale } from './vector';

type NoiseFilterResult = {
    points: GaussianPoint[];
    stats: Record<string, number>;
};

// #WDD-gpt 2026-05-16 - 基于透明度、尺度分位数和局部密度的动静态点去噪
export function splitByMotion(points: GaussianPoint[], options: ResolvedAutoGroundAlignmentOptions) {
    const staticPoints: GaussianPoint[] = [];
    const dynamicPoints: GaussianPoint[] = [];
    const hasLabel = points.some((p) => p.motionLabel === 'static' || p.motionLabel === 'dynamic');
    const hasMagnitude = points.some((p) => typeof p.motionMagnitude === 'number');
    if (!hasLabel && !hasMagnitude) {
        return { staticPoints, dynamicPoints, error: 'No motion label or motion magnitude found.' };
    }
    for (const p of points) {
        if (p.motionLabel === 'static') staticPoints.push(p);
        else if (p.motionLabel === 'dynamic') dynamicPoints.push(p);
        else if (typeof p.motionMagnitude === 'number') {
            (p.motionMagnitude >= options.motionThreshold ? dynamicPoints : staticPoints).push(p);
        }
    }
    return { staticPoints, dynamicPoints, error: null };
}

export function filterStaticNoise(points: GaussianPoint[], options: ResolvedAutoGroundAlignmentOptions) {
    return filterNoise(points, options, 'static');
}

export function filterDynamicNoise(points: GaussianPoint[], options: ResolvedAutoGroundAlignmentOptions) {
    return filterNoise(points, options, 'dynamic');
}

function filterNoise(points: GaussianPoint[], options: ResolvedAutoGroundAlignmentOptions, kind: 'static' | 'dynamic'): NoiseFilterResult {
    if (points.length < 8) {
        return {
            points: points.slice(),
            stats: {
                input: points.length,
                afterOpacityScale: points.length,
                output: points.length,
                removed: 0,
                densityThreshold: 0
            }
        };
    }
    let out = points.slice();
    const input = out.length;
    if (Number.isFinite(options.minOpacity)) {
        out = out.filter((p) => p.opacity === undefined || p.opacity >= options.minOpacity);
    }
    const scales = out.map(scaleValue).filter((x) => Number.isFinite(x) && x > 0);
    if (scales.length > 16) {
        const lo = quantile(scales, options.minScalePercentile);
        const hi = quantile(scales, options.maxScalePercentile);
        out = out.filter((p) => {
            const s = scaleValue(p);
            return s >= lo && s <= hi;
        });
    }
    const density = densityFilter(out, options, kind);
    out = density.points;
    return {
        points: out,
        stats: {
            input,
            afterOpacityScale: density.before,
            output: out.length,
            removed: input - out.length,
            densityThreshold: density.threshold
        }
    };
}

function densityFilter(points: GaussianPoint[], options: ResolvedAutoGroundAlignmentOptions, kind: 'static' | 'dynamic') {
    const before = points.length;
    if (points.length < 40) return { points, before, threshold: 0 };
    const sample = sampleDeterministic(points, Math.min(points.length, 4000));
    const k = Math.max(3, Math.min(options.knnK, sample.length - 1));
    const kth: number[] = [];
    for (const p of sample) {
        const ds: number[] = [];
        for (const q of sample) {
            if (p === q) continue;
            ds.push(distance(p.position, q.position));
        }
        ds.sort((a, b) => a - b);
        kth.push(ds[k - 1] || ds[ds.length - 1] || 0);
    }
    const base = quantile(kth, options.densityPercentile);
    const scale = sceneScale(points);
    const multiplier = kind === 'dynamic' ? 3.2 : 3.8;
    const threshold = Math.max(base * multiplier, scale * 0.012);
    const filtered = points.filter((p) => {
        let nearest = Infinity;
        for (const q of sample) {
            if (p === q) continue;
            nearest = Math.min(nearest, distance(p.position, q.position));
        }
        return nearest <= threshold;
    });
    return { points: filtered.length >= Math.min(20, points.length) ? filtered : points, before, threshold };
}

export const estimateAdaptiveEps = (points: GaussianPoint[], options: ResolvedAutoGroundAlignmentOptions) => {
    const med = medianKnnDistance(points, Math.max(4, Math.min(8, options.knnK)), 3000);
    const scale = sceneScale(points);
    return Math.max(scale * 0.04, med * 4.5);
};
