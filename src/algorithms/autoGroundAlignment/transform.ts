import type { AlignmentTransform, GaussianPoint, Plane, ResolvedAutoGroundAlignmentOptions, Vec3 } from './types';
import { pointPlaneDistance, projectToPlane } from './planeFit';
import { sampleDeterministic, trimmedMeanVec3 } from './statistics';
import { add, applyMatrix, mul, rotationFromTo } from './vector';

// #WDD-gpt 2026-05-16 - 从脚底中心和地面法线构造 p' = R * p + t 的标准化变换
export function computeFootCenter(personPoints: GaussianPoint[], groundPlane: Plane, options: ResolvedAutoGroundAlignmentOptions): Vec3 {
    if (!personPoints.length) return [0, 0, 0];
    const sampled = sampleDeterministic(personPoints, 12000);
    const sorted = sampled
        .map((p) => ({ p, h: pointPlaneDistance(p.position, groundPlane.normal, groundPlane.d) }))
        .sort((a, b) => a.h - b.h);
    const count = Math.max(3, Math.floor(sorted.length * options.footPointPercentile));
    const footPoints = sorted.slice(0, Math.min(sorted.length, count));
    const projected = footPoints.map(({ p }) => projectToPlane(p.position, groundPlane.normal, groundPlane.d));
    return trimmedMeanVec3(projected, 0.25);
}

export function buildAlignmentTransform(groundPlane: Plane, footCenter: Vec3): AlignmentTransform {
    const rotationMatrix = rotationFromTo(groundPlane.normal, [0, 1, 0]);
    const rotatedFoot = applyMatrix(rotationMatrix, footCenter);
    const translation = mul(rotatedFoot, -1);
    const applyToPoint = (p: Vec3) => add(applyMatrix(rotationMatrix, p), translation);
    return {
        rotationMatrix,
        translation,
        footCenter,
        groundNormal: groundPlane.normal,
        groundPlane,
        applyToPoint
    };
}
