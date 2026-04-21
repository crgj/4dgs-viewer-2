import encodeWebP, { init as initWebPEncoder } from '@jsquash/webp/encode';
import webpEncoderWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url';
import webpEncoderSimdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url';

const PYTHON_STYLE_WEBP_OPTIONS = {
    lossless: 1,
    quality: 100,
    method: 6,
    near_lossless: 100,
    alpha_quality: 100,
    exact: 1
} as const;

let webpEncoderInitPromise: Promise<unknown> | null = null;
let webpWorker: Worker | null = null;
let webpWorkerRequestId = 0;
const webpWorkerPending = new Map<number, {
    resolve: (buffer: ArrayBuffer) => void;
    reject: (error: Error) => void;
}>();

const ensureWebPEncoderReady = () => {
    if (!webpEncoderInitPromise) {
        webpEncoderInitPromise = initWebPEncoder({
            locateFile: (path: string) => {
                if (path === 'webp_enc_simd.wasm') return webpEncoderSimdWasmUrl;
                if (path === 'webp_enc.wasm') return webpEncoderWasmUrl;
                return path;
            }
        });
    }
    return webpEncoderInitPromise;
};

const chooseImageType = (fileName: string) =>
    fileName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/webp';

const getWebPWorker = () => {
    if (typeof Worker === 'undefined') return null;
    if (!webpWorker) {
        webpWorker = new Worker(new URL('./webp-lossless-worker.ts', import.meta.url), { type: 'module' });
        webpWorker.onmessage = (event: MessageEvent<{ id: number; buffer?: ArrayBuffer; error?: string }>) => {
            const { id, buffer, error } = event.data;
            const pending = webpWorkerPending.get(id);
            if (!pending) return;
            webpWorkerPending.delete(id);
            if (error) {
                pending.reject(new Error(error));
                return;
            }
            if (!buffer) {
                pending.reject(new Error('Worker returned empty WebP buffer.'));
                return;
            }
            pending.resolve(buffer);
        };
        webpWorker.onerror = (event) => {
            const error = new Error(event.message || 'WebP worker failed.');
            for (const pending of webpWorkerPending.values()) {
                pending.reject(error);
            }
            webpWorkerPending.clear();
            webpWorker?.terminate();
            webpWorker = null;
        };
    }
    return webpWorker;
};

const encodeWebPInWorker = async (image: ImageData): Promise<ArrayBuffer> => {
    const worker = getWebPWorker();
    if (!worker) {
        await ensureWebPEncoderReady();
        return await encodeWebP(image, PYTHON_STYLE_WEBP_OPTIONS);
    }

    const id = ++webpWorkerRequestId;
    const pixels = new Uint8ClampedArray(image.data);
    return await new Promise<ArrayBuffer>((resolve, reject) => {
        webpWorkerPending.set(id, { resolve, reject });
        worker.postMessage({
            id,
            width: image.width,
            height: image.height,
            pixels
        }, [pixels.buffer]);
    });
};

const canvasToBlob = async (canvas: any, type: string): Promise<Blob> => {
    if (typeof canvas.convertToBlob === 'function') {
        const blob = await canvas.convertToBlob({ type });
        if (blob && blob.size > 0) return blob;
        throw new Error(`Canvas convertToBlob failed for ${type}`);
    }

    return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob: Blob | null) => {
            if (!blob || blob.size === 0) {
                reject(new Error(`Canvas toBlob failed for ${type}`));
                return;
            }
            resolve(blob);
        }, type);
    });
};

export const encodeTextureImage = async (tex: any, fileName: string): Promise<ArrayBuffer> => {
    tex.ctx.putImageData(tex.img, 0, 0);

    if (chooseImageType(fileName) === 'image/png') {
        return await (await canvasToBlob(tex.canvas, 'image/png')).arrayBuffer();
    }

    // #WDD-gpt 2026-04-20 - 将 WebP 编码移到 Worker，避免批量导出时主线程假死
    return await encodeWebPInWorker(tex.img as ImageData);
};
