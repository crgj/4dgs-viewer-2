import * as pc from 'playcanvas';

// #WDD 2026-04-20: Extracted from main.ts for modularity

export interface CameraPreset {
    name: string;
    pos: pc.Vec3;
    pitch: number;
    yaw: number;
    textObjects?: {
        id: string;
        content: string;
        font: string;
        fontSize: number;
        color: string;
        fontWeight: string;
        fontStyle: string;
        top: number;
        left: number;
    }[];
}

export interface SequenceFrameData {
    count: number;
    propertyNames: string[];
    propertyValues: Record<string, Float32Array>;
}

export interface SplatSequenceElement {
    name: string;
    type: 'ply4' | 'sog4';
    duration: number;
    globalStartFrame: number;
    globalEndFrame: number;
    parsed: any;
    asset: pc.Asset | null;
    entity: pc.Entity | null;
    runtime?: {
        is4DGS: boolean;
        totalFrames: number;
        keyframes: number;
        xyzStride: number;
        rotKeyframes: number;
        rotStride: number;
        dcKeyframes: number;
        dcStride: number;
        lifeTexData: Float32Array | null;
        scalesTexData: Float32Array | null;
        trajectoryData: Float32Array | null;
        rotTrajectoryData: Float32Array | null;
        dcTrajectoryData: Float32Array | null;
        originalIndices: Float32Array | null;
        posArrays: { x: Float32Array, y: Float32Array, z: Float32Array } | null;
        cachedPositions: Float32Array | null;
        lifeTexture: pc.Texture | null;
        trajectoryTexture: pc.Texture | null;
        rotationTexture: pc.Texture | null;
        dcTrajectoryTexture: pc.Texture | null;
        scalesTexture: pc.Texture | null;
        selectionData: Uint8Array | null;
        allTimeSelectionData: Uint8Array | null;
        selectionTexture: pc.Texture | null;
    };
}

export interface SplatSequence {
    name: string;
    elements: SplatSequenceElement[];
    totalFrames: number;
    activeElementIndex: number;
}
