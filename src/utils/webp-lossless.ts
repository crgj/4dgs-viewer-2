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

    await ensureWebPEncoderReady();
    return await encodeWebP(tex.img, PYTHON_STYLE_WEBP_OPTIONS);
};
