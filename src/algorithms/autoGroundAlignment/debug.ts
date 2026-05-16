import type { AutoGroundAlignmentDebugInfo, DynamicCluster, FootCandidate } from './types';

// #WDD-gpt 2026-05-16 - 汇总前端可视化需要的自动对齐调试信息
export function createDebugInfo(params: {
    staticCount: number;
    dynamicCount: number;
    staticCleanCount: number;
    dynamicCleanCount: number;
    dynamicClusters: DynamicCluster[];
    selectedPersonClusterId?: number;
    bodyAxis?: [number, number, number];
    footCandidates?: FootCandidate[];
    selectedFootSide?: 1 | -1;
    confidenceFactors?: Record<string, number>;
    removedNoiseStats?: Record<string, number>;
}): AutoGroundAlignmentDebugInfo {
    return {
        staticCount: params.staticCount,
        dynamicCount: params.dynamicCount,
        staticCleanCount: params.staticCleanCount,
        dynamicCleanCount: params.dynamicCleanCount,
        dynamicClusters: params.dynamicClusters,
        selectedPersonClusterId: params.selectedPersonClusterId,
        bodyAxis: params.bodyAxis,
        footCandidates: params.footCandidates?.map((c) => ({
            side: c.side,
            endCenter: c.endCenter,
            nearStaticCount: c.nearStatic.length,
            plane: c.plane || undefined,
            score: c.score,
            diagnostics: c.diagnostics
        })),
        selectedFootSide: params.selectedFootSide,
        confidenceFactors: params.confidenceFactors,
        removedNoiseStats: params.removedNoiseStats
    };
}
