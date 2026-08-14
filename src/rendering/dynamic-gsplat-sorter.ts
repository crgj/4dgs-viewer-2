type DynamicSorterResult = {
    frame: number;
    requestId: number;
    visibleCount: number;
    sortTimeMs: number;
};

export type DynamicGsplatSorterConfig = {
    trajectory: Float32Array;
    originalIndices: Float32Array | null;
    lifeData: Float32Array | null;
    baseAlpha: Float32Array | null;
    numSplats: number;
    keyframes: number;
    stride: number;
    totalFrames: number;
    alphaDiscard: number;
    onSorted: (result: DynamicSorterResult) => void;
};

type DynamicSorterMessage = {
    order?: ArrayBuffer;
    count?: number;
    dynamicFrame?: number;
    dynamicRequestId?: number;
    sortTimeMs?: number;
};

// #WDD-gpt 2026-08-04 - 将 4D 中心插值、生命周期活动集和深度排序合并到同一个 Worker，避免每帧复制 N×3 中心数组
function DynamicSortWorkerRuntime() {
    let order: Uint32Array | null = null;
    let trajectory: Float32Array | null = null;
    let originalIndices: Float32Array | null = null;
    let lifeData: Float32Array | null = null;
    let baseAlpha: Float32Array | null = null;
    let activeIndices: Uint32Array | null = null;
    let activeDepths: Float32Array | null = null;
    let activeKeys: Uint32Array | null = null;
    let countBuffer: Uint32Array | null = null;
    let numSplats = 0;
    let keyframes = 0;
    let stride = 1;
    let totalFrames = 1;
    let alphaDiscard = 0.01;
    let frame = 0;
    let requestId = 0;
    let cameraPosition: { x: number; y: number; z: number } | null = null;
    let cameraDirection: { x: number; y: number; z: number } | null = null;
    let pendingSort = false;

    const sigmoid = (value: number) => {
        const clamped = Math.max(-20, Math.min(20, value));
        return 1 / (1 + Math.exp(-clamped));
    };

    const lifetimeAlpha = (index: number, time: number) => {
        if (!lifeData) return 1;
        const offset = index * 4;
        if (offset + 2 >= lifeData.length) return 1;
        const mu = lifeData[offset];
        const width = Math.max(0, lifeData[offset + 1]);
        const sharpness = Math.max(1, lifeData[offset + 2]);
        const segmentMax = Math.max(0, totalFrames - 1);
        if (time < 0 || time > segmentMax) return 0;
        const lifeStart = mu - width;
        const lifeEnd = mu + width;
        if (lifeEnd <= 0 || lifeStart >= segmentMax || lifeEnd <= lifeStart) return 0;
        return sigmoid(sharpness * (time - lifeStart)) * sigmoid(-sharpness * (time - lifeEnd));
    };

    const sort = () => {
        if (!pendingSort || !order || !trajectory || !activeIndices || !activeDepths || !activeKeys || !cameraPosition || !cameraDirection) {
            return;
        }
        pendingSort = false;
        const startedAt = performance.now();
        const clampedTime = Math.max(0, Math.min(frame, Math.max(0, totalFrames - 1)));
        const keyframeMax = Math.max(0, (keyframes - 1) * stride);
        const trajectoryTime = Math.min(clampedTime, keyframeMax);
        const left = keyframes <= 1 ? 0 : Math.min(keyframes - 1, Math.max(0, Math.floor(trajectoryTime / stride)));
        const right = keyframes <= 1 ? 0 : Math.min(keyframes - 1, left + 1);
        const leftTime = left * stride;
        const rightTime = right * stride;
        const ratio = left === right || leftTime === rightTime ? 0 : Math.max(0, Math.min(1, (trajectoryTime - leftTime) / (rightTime - leftTime)));
        const px = cameraPosition.x;
        const py = cameraPosition.y;
        const pz = cameraPosition.z;
        const dx = cameraDirection.x;
        const dy = cameraDirection.y;
        const dz = cameraDirection.z;
        let activeCount = 0;
        let minDepth = 0;
        let maxDepth = 0;

        for (let index = 0; index < numSplats; index++) {
            const alpha = (baseAlpha && index < baseAlpha.length ? baseAlpha[index] : 1) * lifetimeAlpha(index, clampedTime);
            if (alpha < alphaDiscard) continue;
            const originalIndex = originalIndices && index < originalIndices.length ? Math.round(originalIndices[index]) : index;
            if (originalIndex < 0) continue;
            const base = originalIndex * keyframes * 3;
            const leftOffset = base + left * 3;
            const rightOffset = base + right * 3;
            if (rightOffset + 2 >= trajectory.length) continue;
            const x0 = trajectory[leftOffset];
            const y0 = trajectory[leftOffset + 1];
            const z0 = trajectory[leftOffset + 2];
            const x = x0 + (trajectory[rightOffset] - x0) * ratio;
            const y = y0 + (trajectory[rightOffset + 1] - y0) * ratio;
            const z = z0 + (trajectory[rightOffset + 2] - z0) * ratio;
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            const depth = (x - px) * dx + (y - py) * dy + (z - pz) * dz;
            // #WDD-gpt 2026-08-04 - PlayCanvas 相机沿本地 -Z 看向前方，排序前剔除相机后方高斯
            if (depth >= 0) continue;
            activeIndices[activeCount] = index;
            activeDepths[activeCount] = depth;
            if (activeCount === 0) {
                minDepth = maxDepth = depth;
            } else {
                minDepth = Math.min(minDepth, depth);
                maxDepth = Math.max(maxDepth, depth);
            }
            activeCount++;
        }

        if (activeCount > 0) {
            const compareBits = Math.max(10, Math.min(20, Math.round(Math.log2(Math.max(1, activeCount) / 4))));
            const bucketCount = 2 ** compareBits + 1;
            if (!countBuffer || countBuffer.length !== bucketCount) {
                countBuffer = new Uint32Array(bucketCount);
            } else {
                countBuffer.fill(0);
            }
            const range = maxDepth - minDepth;
            const divider = range < 1e-6 ? 0 : (2 ** compareBits) / range;
            for (let active = 0; active < activeCount; active++) {
                const key = divider === 0 ? 0 : Math.max(0, Math.min(bucketCount - 1, Math.floor((activeDepths[active] - minDepth) * divider)));
                activeKeys[active] = key;
                countBuffer[key]++;
            }
            for (let bucket = 1; bucket < bucketCount; bucket++) {
                countBuffer[bucket] += countBuffer[bucket - 1];
            }
            for (let active = 0; active < activeCount; active++) {
                const destination = --countBuffer[activeKeys[active]];
                order[destination] = activeIndices[active];
            }
        }

        const resultOrder = order;
        order = null;
        (self as unknown as Worker).postMessage({
            order: resultOrder.buffer,
            count: activeCount,
            dynamicFrame: frame,
            dynamicRequestId: requestId,
            sortTimeMs: performance.now() - startedAt
        }, [resultOrder.buffer]);
    };

    (self as unknown as Worker).onmessage = (event: MessageEvent<any>) => {
        const message = event.data || {};
        if (message.init) {
            order = new Uint32Array(message.order);
            trajectory = new Float32Array(message.trajectory);
            originalIndices = message.originalIndices ? new Float32Array(message.originalIndices) : null;
            lifeData = message.lifeData ? new Float32Array(message.lifeData) : null;
            baseAlpha = message.baseAlpha ? new Float32Array(message.baseAlpha) : null;
            numSplats = message.numSplats;
            keyframes = message.keyframes;
            stride = Math.max(1, message.stride);
            totalFrames = Math.max(1, message.totalFrames);
            alphaDiscard = message.alphaDiscard;
            activeIndices = new Uint32Array(numSplats);
            activeDepths = new Float32Array(numSplats);
            activeKeys = new Uint32Array(numSplats);
            pendingSort = true;
        } else if (message.order) {
            order = new Uint32Array(message.order);
        }
        if (message.cameraPosition) cameraPosition = message.cameraPosition;
        if (message.cameraDirection) cameraDirection = message.cameraDirection;
        if (Number.isFinite(message.dynamicFrame)) {
            frame = message.dynamicFrame;
            requestId = message.dynamicRequestId || 0;
            pendingSort = true;
        }
        if (message.cameraPosition || message.cameraDirection) pendingSort = true;
        sort();
    };
}

export class DynamicGsplatSorter {
    private readonly worker: Worker;

    constructor(private readonly instance: any, private readonly config: DynamicGsplatSorterConfig) {
        const sorter = instance?.sorter;
        const nativeWorker = sorter?.worker as Worker | undefined;
        const orderLevel = sorter?.orderTexture?._levels?.[0];
        if (!sorter || !nativeWorker || !orderLevel?.buffer) {
            throw new Error('Dynamic GSplat sorter requires an initialized PlayCanvas sorter.');
        }

        // #WDD-gpt  2026-08-13 - 保留 PlayCanvas 原生排序回调，分段第二次激活时不能从已终止的自定义 Worker 上读取空回调
        const nativeHandlerKey = '__dynamicGsplatNativeOnMessage';
        if (!(nativeHandlerKey in sorter)) {
            sorter[nativeHandlerKey] = nativeWorker.onmessage;
        }
        const nativeOnMessage = sorter[nativeHandlerKey] as Worker['onmessage'];
        const orderBuffer = orderLevel.buffer.slice(0);
        nativeWorker.terminate();

        const workerUrl = URL.createObjectURL(new Blob([
            `(${DynamicSortWorkerRuntime.toString()})()`
        ], { type: 'application/javascript' }));
        this.worker = new Worker(workerUrl);
        URL.revokeObjectURL(workerUrl);
        sorter.worker = this.worker;
        this.worker.onmessage = (event: MessageEvent<DynamicSorterMessage>) => {
            nativeOnMessage?.call(this.worker, event);
            const data = event.data;
            if (Number.isFinite(data.dynamicFrame) && Number.isFinite(data.dynamicRequestId)) {
                this.config.onSorted({
                    frame: data.dynamicFrame!,
                    requestId: data.dynamicRequestId!,
                    visibleCount: data.count || 0,
                    sortTimeMs: data.sortTimeMs || 0
                });
            }
        };

        this.worker.postMessage({
            init: true,
            order: orderBuffer,
            trajectory: config.trajectory.buffer,
            originalIndices: config.originalIndices?.buffer || null,
            lifeData: config.lifeData?.buffer || null,
            baseAlpha: config.baseAlpha?.buffer || null,
            numSplats: config.numSplats,
            keyframes: config.keyframes,
            stride: config.stride,
            totalFrames: config.totalFrames,
            alphaDiscard: config.alphaDiscard
        }, [orderBuffer]);

        // #WDD-gpt 2026-08-04 - 强制下一次 instance.sort() 把当前相机重新发送给新 Worker
        instance.lastCameraPosition?.set(Number.NaN, Number.NaN, Number.NaN);
        instance.lastCameraDirection?.set(Number.NaN, Number.NaN, Number.NaN);
    }

    requestFrame(frame: number, requestId: number) {
        this.worker.postMessage({ dynamicFrame: frame, dynamicRequestId: requestId });
    }

    destroy() {
        // #WDD-gpt 2026-08-04 - 先解除回调再终止 Worker，避免模型替换边界上的迟到消息更新新状态
        this.worker.onmessage = null;
        this.worker.terminate();
    }
}
