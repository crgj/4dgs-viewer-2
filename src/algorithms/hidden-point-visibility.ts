export const NORMAL_RENDER_ALPHA_DISCARD = 0.01;

export type OpacitySemantic = 'logit' | 'probability' | 'linear' | 'alpha' | string;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const sigmoid = (value: number) => {
    const clamped = Math.max(-20, Math.min(20, value));
    return 1 / (1 + Math.exp(-clamped));
};

export function getRenderedBaseAlpha(rawOpacity: number, semantic?: OpacitySemantic): number {
    if (!Number.isFinite(rawOpacity)) return 1;

    const mode = String(semantic || '').toLowerCase();
    const probability = mode === 'logit'
        ? sigmoid(rawOpacity)
        : (mode === 'probability' || mode === 'linear' || mode === 'alpha')
            ? rawOpacity
            : rawOpacity >= 0 && rawOpacity <= 1
                ? rawOpacity
                : sigmoid(rawOpacity);

    // #WDD-gpt 2026-07-16 - 与 GPU RGBA8 splatColor 和 PLY 帧导出的透明度量化保持一致
    return Math.floor(clamp01(probability) * 255) / 255;
}

export function evaluateLifetimeOpacity(
    mu: number,
    width: number,
    sharpness: number,
    frame: number,
    totalFrames: number
): number {
    const segmentMax = totalFrames > 0 ? Math.max(0, totalFrames - 1) : 1e20;
    if (frame < 0 || frame > segmentMax) return 0;

    const w = Math.max(width, 0);
    const k = Math.max(sharpness, 1);
    const lifeStart = mu - w;
    const lifeEnd = mu + w;
    if (lifeEnd <= 0 || lifeStart >= segmentMax || lifeEnd <= lifeStart) return 0;

    const left = 1 / (1 + Math.exp(-k * (frame - lifeStart)));
    const right = 1 / (1 + Math.exp(k * (frame - lifeEnd)));
    return left * right;
}

export function getPointEffectiveAlphaAtFrame(options: {
    index: number;
    frame: number;
    totalFrames: number;
    opacity: Float32Array | null;
    opacitySemantic?: OpacitySemantic;
    lifeTexData: Float32Array | null;
}): number {
    const { index, frame, totalFrames, opacity, opacitySemantic, lifeTexData } = options;
    const baseAlpha = opacity && index >= 0 && index < opacity.length
        ? getRenderedBaseAlpha(opacity[index], opacitySemantic)
        : 1;

    const lifeIndex = index * 4;
    if (!lifeTexData || lifeIndex + 2 >= lifeTexData.length) return baseAlpha;

    const lifetimeAlpha = evaluateLifetimeOpacity(
        lifeTexData[lifeIndex],
        lifeTexData[lifeIndex + 1],
        lifeTexData[lifeIndex + 2],
        frame,
        totalFrames
    );
    return baseAlpha * lifetimeAlpha;
}

export function getPointMaxEffectiveAlpha(options: {
    index: number;
    totalFrames: number;
    opacity: Float32Array | null;
    opacitySemantic?: OpacitySemantic;
    lifeTexData: Float32Array | null;
}): number {
    const { index, totalFrames, opacity, opacitySemantic, lifeTexData } = options;
    return getPointMaxEffectiveAlphaDirect(index, totalFrames, opacity, opacitySemantic, lifeTexData);
}

function getPointMaxEffectiveAlphaDirect(
    index: number,
    totalFrames: number,
    opacity: Float32Array | null,
    opacitySemantic: OpacitySemantic | undefined,
    lifeTexData: Float32Array | null
): number {
    const baseAlpha = opacity && index >= 0 && index < opacity.length
        ? getRenderedBaseAlpha(opacity[index], opacitySemantic)
        : 1;
    const lifeIndex = index * 4;
    if (!lifeTexData || lifeIndex + 2 >= lifeTexData.length) return baseAlpha;

    const segmentMax = Math.max(0, totalFrames - 1);
    const mu = lifeTexData[lifeIndex];
    const clampedPeak = Math.max(0, Math.min(segmentMax, mu));
    const firstFrame = Math.floor(clampedPeak);
    const secondFrame = Math.ceil(clampedPeak);
    const first = evaluateLifetimeOpacity(
        mu,
        lifeTexData[lifeIndex + 1],
        lifeTexData[lifeIndex + 2],
        firstFrame,
        totalFrames
    );
    const second = secondFrame === firstFrame
        ? first
        : evaluateLifetimeOpacity(
            mu,
            lifeTexData[lifeIndex + 1],
            lifeTexData[lifeIndex + 2],
            secondFrame,
            totalFrames
        );
    return baseAlpha * Math.max(first, second);
}

export function buildNeverVisibleFlags(options: {
    count: number;
    totalFrames: number;
    opacity: Float32Array | null;
    opacitySemantic?: OpacitySemantic;
    lifeTexData: Float32Array | null;
    alphaDiscard?: number;
}): Uint8Array {
    const flags = new Uint8Array(options.count);
    const alphaDiscard = options.alphaDiscard ?? NORMAL_RENDER_ALPHA_DISCARD;

    // #WDD-gpt 2026-07-16 - 隐藏点按渲染器最终 baseAlpha × lifetimeAlpha 判断，修复两个分量单独可见但乘积被裁剪的漏检
    for (let index = 0; index < options.count; index++) {
        const maxAlpha = getPointMaxEffectiveAlphaDirect(
            index,
            options.totalFrames,
            options.opacity,
            options.opacitySemantic,
            options.lifeTexData
        );
        if (maxAlpha < alphaDiscard) flags[index] = 1;
    }
    return flags;
}
