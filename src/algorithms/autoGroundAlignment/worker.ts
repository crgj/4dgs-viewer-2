import { autoAlign4DGSScene } from './index';
import type { AutoGroundAlignmentOptions, GaussianPoint } from './types';

type WorkerRequest = {
    id: number;
    points: GaussianPoint[];
    options?: AutoGroundAlignmentOptions;
};

type WorkerProgress = {
    id: number;
    type: 'progress';
    percent: number;
    stage: string;
    detail?: string;
};

type WorkerDone = {
    id: number;
    type: 'done';
    result: ReturnType<typeof autoAlign4DGSScene>;
};

type WorkerError = {
    id: number;
    type: 'error';
    error: string;
};

const postProgress = (id: number, percent: number, stage: string, detail?: string) => {
    self.postMessage({ id, type: 'progress', percent, stage, detail } satisfies WorkerProgress);
};

// #WDD-gpt 2026-05-16 - 后台执行自动地面对齐，避免主线程被大点云估计阻塞
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const { id, points, options } = event.data;
    try {
        postProgress(id, 10, 'PREPARING', `${points.length} sampled points`);
        postProgress(id, 28, 'FILTERING', 'Cleaning static and dynamic points');
        setTimeout(() => {
            try {
                postProgress(id, 48, 'CLUSTERING', 'Finding person-like dynamic cluster');
                const result = autoAlign4DGSScene(points, [], options || {});
                postProgress(id, 90, 'SOLVING', 'Building alignment transform');
                self.postMessage({ id, type: 'done', result: serializeResult(result) } satisfies WorkerDone);
            } catch (err) {
                self.postMessage({ id, type: 'error', error: err instanceof Error ? err.message : String(err) } satisfies WorkerError);
            }
        }, 0);
    } catch (err) {
        self.postMessage({ id, type: 'error', error: err instanceof Error ? err.message : String(err) } satisfies WorkerError);
    }
};

function serializeResult(result: ReturnType<typeof autoAlign4DGSScene>): ReturnType<typeof autoAlign4DGSScene> {
    if (!result.transform) return result;
    return {
        ...result,
        transform: {
            ...result.transform,
            applyToPoint: undefined as never
        }
    };
}
