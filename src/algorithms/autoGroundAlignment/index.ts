import type {
    AutoGroundAlignmentOptions,
    AutoGroundAlignmentResult,
    CameraPose,
    DynamicCluster,
    FootCandidate,
    GaussianPoint,
    ResolvedAutoGroundAlignmentOptions,
    Vec3
} from './types';
import { clusterDynamicPoints } from './clustering';
import { createDebugInfo } from './debug';
import { filterDynamicNoise, filterStaticNoise, splitByMotion } from './filters';
import { robustLocalPlaneRANSAC } from './planeFit';
import { computePCA } from './pca';
import { computeAlignmentConfidence, scoreSupportPlane, selectPersonCluster } from './scoring';
import { quantile, trimmedMeanVec3 } from './statistics';
import { buildAlignmentTransform, computeFootCenter } from './transform';
import { bboxOfPoints, centroid, distance, dot, length, sceneScale, sub } from './vector';

export * from './types';
export * from './vector';
export * from './transform';

// #WDD-gpt 2026-05-16 - 4DGS 自动地面对齐主流程：人物主体识别 -> 脚底局部支撑面 -> 标准化变换
export function autoAlign4DGSScene(
    points: GaussianPoint[],
    cameras: CameraPose[] = [],
    options: AutoGroundAlignmentOptions = {}
): AutoGroundAlignmentResult {
    const opts = resolveOptions(options);
    const warnings: string[] = [];
    const errors: string[] = [];
    try {
        if (points.length < 30) {
            return failure('Not enough points for auto ground alignment.', warnings, errors);
        }
        const split = splitByMotion(points, opts);
        if (split.error) return failure(split.error, warnings, errors);
        if (split.dynamicPoints.length < opts.dynamicClusterMinPoints) warnings.push('Dynamic point count is low.');
        if (split.staticPoints.length < opts.staticClusterMinPoints) warnings.push('Static support point count is low.');

        const staticFiltered = filterStaticNoise(split.staticPoints, opts);
        const dynamicFiltered = filterDynamicNoise(split.dynamicPoints, opts);
        const staticClean = staticFiltered.points;
        const dynamicClean = dynamicFiltered.points;
        if (staticClean.length < 12) return failure('No usable static support points after filtering.', warnings, errors);
        if (dynamicClean.length < opts.dynamicClusterMinPoints) return failure('No usable dynamic person points after filtering.', warnings, errors);

        const clusters = clusterDynamicPoints(dynamicClean, opts);
        if (!clusters.length) return failure('No dynamic clusters found.', warnings, errors, makeDebug(split, staticFiltered, dynamicFiltered, [], undefined, undefined, [], undefined, undefined));
        const person = selectPersonCluster(clusters, staticClean, cameras, opts);
        if (!person) return failure('Could not select a person-like dynamic cluster.', warnings, errors, makeDebug(split, staticFiltered, dynamicFiltered, clusters, undefined, undefined, [], undefined, undefined));

        const pca = computePCA(person.points.map((p) => p.position));
        if (!pca) return failure('Person cluster PCA failed.', warnings, errors);
        person.eigenValues = pca.eigenValues;
        person.eigenVectors = pca.eigenVectors;
        const bodyAxis = pca.eigenVectors[0];
        const scale = sceneScale(points);
        const candidates = [
            evaluateFootEndCandidate(person, staticClean, bodyAxis, 1, opts, scale),
            evaluateFootEndCandidate(person, staticClean, bodyAxis, -1, opts, scale)
        ];
        const ranked = candidates.slice().sort((a, b) => b.score - a.score);
        const best = ranked[0];
        const second = ranked[1];
        if (!best?.plane) return failure('No local support plane found near either person end.', warnings, errors, makeDebug(split, staticFiltered, dynamicFiltered, clusters, person, bodyAxis, candidates, undefined, undefined));

        const confidenceEval = computeAlignmentConfidence({
            bestScore: best.score,
            secondScore: second?.score ?? 0,
            candidateDiagnostics: best.diagnostics,
            personScore: person.score || 0,
            staticSupportCount: best.nearStatic.length
        });
        const footCenter = computeFootCenter(person.points, best.plane, opts);
        const transform = buildAlignmentTransform(best.plane, footCenter);
        const confidence = confidenceEval.confidence;
        if (confidence < opts.confidenceThreshold) {
            warnings.push(`Low auto ground alignment confidence: ${confidence.toFixed(2)}.`);
        }

        const debug = opts.debug
            ? makeDebug(split, staticFiltered, dynamicFiltered, clusters, person, bodyAxis, candidates, best.side, confidenceEval.factors)
            : undefined;

        return {
            success: confidence >= opts.confidenceThreshold,
            confidence,
            transform,
            personCluster: person,
            groundPlane: best.plane,
            footCenter,
            debug,
            warnings,
            errors
        };
    } catch (err) {
        return failure(err instanceof Error ? err.message : String(err), warnings, errors);
    }
}

export function evaluateFootEndCandidate(
    person: DynamicCluster,
    staticClean: GaussianPoint[],
    bodyAxis: Vec3,
    side: 1 | -1,
    options: ResolvedAutoGroundAlignmentOptions,
    scale = sceneScale([...person.points, ...staticClean])
): FootCandidate {
    const projections = person.points.map((p) => dot(p.position, bodyAxis));
    const cut = side > 0 ? quantile(projections, 1 - options.footEndPercentile) : quantile(projections, options.footEndPercentile);
    const endPoints = person.points.filter((p) => side > 0 ? dot(p.position, bodyAxis) >= cut : dot(p.position, bodyAxis) <= cut);
    const endCenter = trimmedMeanVec3(endPoints.map((p) => p.position), 0.2);
    const bodyLength = Math.max(1e-6, quantile(projections, 0.95) - quantile(projections, 0.05));
    const radius = Math.max(scale * 0.035, bodyLength * 0.22);
    const nearStatic = staticClean.filter((p) => distance(p.position, endCenter) <= radius);
    let plane = nearStatic.length >= 12 ? robustLocalPlaneRANSAC(nearStatic, options) : null;
    if (!plane) {
        return { side, endCenter, endPoints, nearStatic, plane, score: -Infinity, diagnostics: { nearStaticCount: nearStatic.length } };
    }
    const bbox = bboxOfPoints(nearStatic);
    const volume = Math.max(1e-9, Math.abs((bbox.max[0] - bbox.min[0]) * (bbox.max[1] - bbox.min[1]) * (bbox.max[2] - bbox.min[2])));
    const scored = scoreSupportPlane({ person, bodyAxis, endPoints, plane, sceneScale: scale, localNeighborhoodVolume: volume });
    plane = plane;
    return {
        side,
        endCenter,
        endPoints,
        nearStatic,
        plane,
        score: scored.score,
        diagnostics: { ...scored.diagnostics, nearStaticCount: nearStatic.length, radius }
    };
}

function resolveOptions(options: AutoGroundAlignmentOptions): ResolvedAutoGroundAlignmentOptions {
    return {
        motionThreshold: options.motionThreshold ?? 0.02,
        minOpacity: options.minOpacity ?? -Infinity,
        maxScalePercentile: options.maxScalePercentile ?? 0.995,
        minScalePercentile: options.minScalePercentile ?? 0.005,
        knnK: options.knnK ?? 8,
        densityPercentile: options.densityPercentile ?? 0.7,
        dynamicClusterMinPoints: options.dynamicClusterMinPoints ?? 40,
        staticClusterMinPoints: options.staticClusterMinPoints ?? 80,
        ransacIterations: options.ransacIterations ?? 360,
        ransacDistanceThreshold: options.ransacDistanceThreshold ?? 0,
        minPlaneInlierRatio: options.minPlaneInlierRatio ?? 0.25,
        footEndPercentile: options.footEndPercentile ?? 0.08,
        footPointPercentile: options.footPointPercentile ?? 0.08,
        useCameraPrior: options.useCameraPrior ?? false,
        debug: options.debug ?? false,
        maxEstimationPoints: options.maxEstimationPoints ?? 30000,
        maxRansacPoints: options.maxRansacPoints ?? 10000,
        confidenceThreshold: options.confidenceThreshold ?? 0.45
    };
}

function makeDebug(
    split: { staticPoints: GaussianPoint[]; dynamicPoints: GaussianPoint[] },
    staticFiltered: { points: GaussianPoint[]; stats: Record<string, number> },
    dynamicFiltered: { points: GaussianPoint[]; stats: Record<string, number> },
    clusters: DynamicCluster[],
    person?: DynamicCluster,
    bodyAxis?: Vec3,
    candidates?: FootCandidate[],
    selectedFootSide?: 1 | -1,
    confidenceFactors?: Record<string, number>
) {
    return createDebugInfo({
        staticCount: split.staticPoints.length,
        dynamicCount: split.dynamicPoints.length,
        staticCleanCount: staticFiltered.points.length,
        dynamicCleanCount: dynamicFiltered.points.length,
        dynamicClusters: clusters,
        selectedPersonClusterId: person?.id,
        bodyAxis,
        footCandidates: candidates || [],
        selectedFootSide,
        confidenceFactors,
        removedNoiseStats: {
            staticRemoved: staticFiltered.stats.removed || 0,
            dynamicRemoved: dynamicFiltered.stats.removed || 0,
            staticDensityThreshold: staticFiltered.stats.densityThreshold || 0,
            dynamicDensityThreshold: dynamicFiltered.stats.densityThreshold || 0
        }
    });
}

function failure(message: string, warnings: string[], errors: string[], debug?: ReturnType<typeof createDebugInfo>): AutoGroundAlignmentResult {
    return {
        success: false,
        confidence: 0,
        warnings,
        errors: [...errors, message],
        debug
    };
}
