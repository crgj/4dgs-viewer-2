// #WDD-gpt 2026-05-16 - 定义 4DGS 自动地面对齐算法的公共类型
export type Vec3 = [number, number, number];

export interface GaussianPoint {
    id: string | number;
    position: Vec3;
    rotation?: unknown;
    scale?: Vec3 | number;
    opacity?: number;
    motionMagnitude?: number;
    motionLabel?: 'static' | 'dynamic' | 'unknown';
    positionsOverTime?: Vec3[];
}

export interface CameraPose {
    id?: string | number;
    position: Vec3;
    forward?: Vec3;
    target?: Vec3;
}

export interface Plane {
    normal: Vec3;
    d: number;
    inliers: GaussianPoint[];
    inlierRatio: number;
    coverageArea: number;
    rmsError: number;
}

export interface AlignmentTransform {
    rotationMatrix: number[][];
    translation: Vec3;
    footCenter: Vec3;
    groundNormal: Vec3;
    groundPlane: Plane;
    applyToPoint: (p: Vec3) => Vec3;
}

export interface DynamicCluster {
    id: number;
    points: GaussianPoint[];
    center: Vec3;
    bboxMin: Vec3;
    bboxMax: Vec3;
    eigenValues?: [number, number, number];
    eigenVectors?: [Vec3, Vec3, Vec3];
    score?: number;
    diagnostics?: Record<string, number>;
}

export interface AutoGroundAlignmentDebugInfo {
    staticCount: number;
    dynamicCount: number;
    staticCleanCount: number;
    dynamicCleanCount: number;
    dynamicClusters: DynamicCluster[];
    selectedPersonClusterId?: number;
    bodyAxis?: Vec3;
    footCandidates?: Array<{
        side: 1 | -1;
        endCenter: Vec3;
        nearStaticCount: number;
        plane?: Plane;
        score: number;
        diagnostics: Record<string, number>;
    }>;
    selectedFootSide?: 1 | -1;
    confidenceFactors?: Record<string, number>;
    removedNoiseStats?: Record<string, number>;
}

export interface AutoGroundAlignmentResult {
    success: boolean;
    confidence: number;
    transform?: AlignmentTransform;
    personCluster?: DynamicCluster;
    groundPlane?: Plane;
    footCenter?: Vec3;
    debug?: AutoGroundAlignmentDebugInfo;
    warnings: string[];
    errors: string[];
}

export interface AutoGroundAlignmentOptions {
    motionThreshold?: number;
    minOpacity?: number;
    maxScalePercentile?: number;
    minScalePercentile?: number;
    knnK?: number;
    densityPercentile?: number;
    dynamicClusterMinPoints?: number;
    staticClusterMinPoints?: number;
    ransacIterations?: number;
    ransacDistanceThreshold?: number;
    minPlaneInlierRatio?: number;
    footEndPercentile?: number;
    footPointPercentile?: number;
    useCameraPrior?: boolean;
    debug?: boolean;
    maxEstimationPoints?: number;
    maxRansacPoints?: number;
    confidenceThreshold?: number;
}

export interface ResolvedAutoGroundAlignmentOptions extends Required<AutoGroundAlignmentOptions> {}

export interface FootCandidate {
    side: 1 | -1;
    endCenter: Vec3;
    endPoints: GaussianPoint[];
    nearStatic: GaussianPoint[];
    plane: Plane | null;
    score: number;
    diagnostics: Record<string, number>;
}

export interface SupportPlaneScoreInput {
    person: DynamicCluster;
    bodyAxis: Vec3;
    endPoints: GaussianPoint[];
    plane: Plane;
    sceneScale: number;
    localNeighborhoodVolume: number;
}
