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

type EncodeRequest = {
    id: number;
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
};

type EncodeResponse =
    | { id: number; buffer: ArrayBuffer }
    | { id: number; error: string };

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
    const { id, width, height, pixels } = event.data;
    try {
        await ensureWebPEncoderReady();
        const imageDataLike = { data: pixels, width, height } as ImageData;
        const encoded = await encodeWebP(imageDataLike, PYTHON_STYLE_WEBP_OPTIONS);
        const response: EncodeResponse = { id, buffer: encoded };
        (self as any).postMessage(response, [encoded]);
    } catch (error) {
        const response: EncodeResponse = {
            id,
            error: error instanceof Error ? error.message : String(error)
        };
        (self as any).postMessage(response);
    }
};
