import type { CameraPose, DynamicCluster, GaussianPoint, ResolvedAutoGroundAlignmentOptions, SupportPlaneScoreInput } from './types';
import { fitPlaneLeastSquares, orientPlaneTowardPoint, pointPlaneDistance } from './planeFit';
import { quantile } from './statistics';
import { bboxOfPoints, centroid, distance, dot, length, sceneScale, sub } from './vector';

// #WDD-gpt 2026-05-16 - 人物簇选择、背景贴附惩罚和脚底支撑面评分
export function selectPersonCluster(
    clusters: DynamicCluster[],
    staticClean: GaussianPoint[],
    cameras: CameraPose[] | undefined,
    options: ResolvedAutoGroundAlignmentOptions
): DynamicCluster | null {
    if (!clusters.length) return null;
    const allDynamic = clusters.flatMap((c) => c.points);
    const scale = sceneScale([...staticClean, ...allDynamic]);
    const cameraCenter = options.useCameraPrior && cameras?.length ? centroid(cameras.map((c) => c.target || c.position)) : null;
    let best: DynamicCluster | null = null;
    let bestScore = -Infinity;

    for (const cluster of clusters) {
        const pca = cluster.eigenValues && cluster.eigenVectors ? { values: cluster.eigenValues, vectors: cluster.eigenVectors } : null;
        const bbox = bboxOfPoints(cluster.points);
        const spans = sub(bbox.max, bbox.min).map(Math.abs);
        const mainSpan = Math.max(spans[0], spans[1], spans[2]);
        const volume = Math.max(1e-9, spans[0] * spans[1] * spans[2]);
        const totalVar = cluster.eigenValues ? cluster.eigenValues[0] + cluster.eigenValues[1] + cluster.eigenValues[2] : 1;
        const nonPlanarity = cluster.eigenValues ? Math.max(0, Math.min(1, cluster.eigenValues[2] / Math.max(1e-9, totalVar) * 12)) : 0.5;
        const motionConsistency = computeMotionConsistency(cluster.points);
        const volumeScore = Math.max(0, Math.min(1, Math.log(volume / Math.pow(scale * 0.04, 3) + 1) / 4));
        const cameraCenterPrior = cameraCenter ? Math.exp(-distance(cluster.center, cameraCenter) / Math.max(scale * 0.35, 1e-6)) : 0.5;
        const backgroundAttachmentPenalty = computeBackgroundAttachmentPenalty(cluster, staticClean, scale);
        const normalizedMainAxisSpan = Math.max(0, Math.min(1, mainSpan / Math.max(scale * 0.35, 1e-6)));
        const pointCountScore = Math.log(cluster.points.length + 1);
        const score =
            2.0 * pointCountScore +
            1.5 * normalizedMainAxisSpan +
            1.2 * nonPlanarity +
            1.0 * volumeScore +
            1.0 * motionConsistency +
            0.5 * cameraCenterPrior -
            2.5 * backgroundAttachmentPenalty;

        cluster.score = score;
        cluster.diagnostics = {
            pointCountScore,
            normalizedMainAxisSpan,
            nonPlanarity,
            volumeScore,
            motionConsistency,
            cameraCenterPrior,
            backgroundAttachmentPenalty,
            pcaAvailable: pca ? 1 : 0
        };
        if (score > bestScore) {
            bestScore = score;
            best = cluster;
        }
    }

    return best;
}

export function scoreSupportPlane(input: SupportPlaneScoreInput) {
    let plane = orientPlaneTowardPoint(input.plane, input.person.center);
    input.plane.normal = plane.normal;
    input.plane.d = plane.d;
    const endDistances = input.endPoints.map((p) => Math.abs(pointPlaneDistance(p.position, plane.normal, plane.d)));
    const contactDistance = quantile(endDistances, 0.5);
    const sigma = Math.max(input.sceneScale * 0.018, input.plane.rmsError * 3, 1e-6);
    const contactScore = Math.exp(-contactDistance / sigma);
    const eps = Math.max(input.sceneScale * 0.015, input.plane.rmsError * 2);
    let sameSide = 0;
    for (const p of input.person.points) {
        if (pointPlaneDistance(p.position, plane.normal, plane.d) >= -eps) sameSide++;
    }
    const sameSideRatio = sameSide / Math.max(1, input.person.points.length);
    const axisAlignment = Math.abs(dot(plane.normal, input.bodyAxis));
    const planeQuality = input.plane.inlierRatio * Math.log(input.plane.coverageArea / Math.max(input.sceneScale * input.sceneScale * 0.01, 1e-9) + 1);
    const supportDensity = Math.min(1, input.plane.inliers.length / Math.max(1, input.localNeighborhoodVolume / Math.pow(Math.max(input.sceneScale * 0.04, 1e-6), 3)));
    const rmsErrorPenalty = Math.min(1, input.plane.rmsError / Math.max(input.sceneScale * 0.02, 1e-6));
    const score =
        3.0 * contactScore +
        2.0 * sameSideRatio +
        1.5 * axisAlignment +
        1.0 * planeQuality +
        0.5 * supportDensity -
        1.0 * rmsErrorPenalty;

    return {
        score,
        diagnostics: {
            contactDistance,
            contactScore,
            sameSideRatio,
            axisAlignment,
            planeQuality,
            supportDensity,
            rmsErrorPenalty,
            inlierRatio: input.plane.inlierRatio,
            coverageArea: input.plane.coverageArea,
            rmsError: input.plane.rmsError
        }
    };
}

export function computeAlignmentConfidence(params: {
    bestScore: number;
    secondScore: number;
    candidateDiagnostics: Record<string, number>;
    personScore: number;
    staticSupportCount: number;
}) {
    const scoreGap = Math.max(0, params.bestScore - params.secondScore);
    const gapFactor = Math.max(0, Math.min(1, scoreGap / Math.max(1, Math.abs(params.bestScore) * 0.35)));
    const diag = params.candidateDiagnostics;
    const planeFactor = Math.max(0, Math.min(1, diag.inlierRatio || 0));
    const contactFactor = Math.max(0, Math.min(1, diag.contactScore || 0));
    const sameSideFactor = Math.max(0, Math.min(1, diag.sameSideRatio || 0));
    const axisFactor = Math.max(0, Math.min(1, diag.axisAlignment || 0));
    const personFactor = Math.max(0, Math.min(1, params.personScore / 16));
    const supportFactor = Math.max(0, Math.min(1, params.staticSupportCount / 80));
    const confidence =
        0.18 * gapFactor +
        0.18 * planeFactor +
        0.20 * contactFactor +
        0.16 * sameSideFactor +
        0.12 * axisFactor +
        0.08 * personFactor +
        0.08 * supportFactor;
    return {
        confidence: Math.max(0, Math.min(1, confidence)),
        factors: { gapFactor, planeFactor, contactFactor, sameSideFactor, axisFactor, personFactor, supportFactor }
    };
}

function computeMotionConsistency(points: GaussianPoint[]) {
    const values = points
        .map((p) => p.motionMagnitude)
        .filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (values.length < 4) return 0.6;
    const med = quantile(values, 0.5);
    const spread = quantile(values, 0.85) - quantile(values, 0.15);
    return Math.max(0, Math.min(1, med / (med + spread + 1e-6)));
}

function computeBackgroundAttachmentPenalty(cluster: DynamicCluster, staticClean: GaussianPoint[], scale: number) {
    if (staticClean.length < 20 || cluster.points.length < 8) return 0;
    const radius = Math.max(scale * 0.08, length(sub(cluster.bboxMax, cluster.bboxMin)) * 0.25);
    const nearby = staticClean.filter((s) => distance(s.position, cluster.center) <= radius);
    if (nearby.length < 20) return 0;
    const plane = fitPlaneLeastSquares(nearby);
    if (!plane) return 0;
    const distances = cluster.points.map((p) => Math.abs(pointPlaneDistance(p.position, plane.normal, plane.d)));
    const medianDist = quantile(distances, 0.5);
    const nearRatio = distances.filter((d) => d < scale * 0.025).length / Math.max(1, distances.length);
    return Math.max(0, Math.min(1, nearRatio * Math.exp(-medianDist / Math.max(scale * 0.04, 1e-6))));
}
