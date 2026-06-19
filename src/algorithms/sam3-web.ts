import * as pc from 'playcanvas';

export type Sam3MaskResult = {
    width: number;
    height: number;
    sourceWidth: number;
    sourceHeight: number;
    projectionWidth: number;
    projectionHeight: number;
    mask: Uint8Array;
    prompt: string;
    maskPixels: number;
    debugSummary: string;
};

export type Sam3SelectionResult = {
    indices: number[];
    maskPixels: number;
    projectedPoints: number;
};

type Sam3OnlineConfig = {
    apiKey: string;
    endpoint?: string;
};

type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };
type ParsedMask = { mask: Uint8Array; maskPixels: number; debugSummary: string };
type Sam3CaptureImageData = ImageData & {
    sam3SourceWidth?: number;
    sam3SourceHeight?: number;
    sam3ProjectionWidth?: number;
    sam3ProjectionHeight?: number;
    sam3Scale?: number;
};

export class Sam3WebClient {
    private apiKey = '';
    private endpoint = '/api/sam3/concept_segment';
    private requestTimeoutMs = 75000;

    async init(config: Sam3OnlineConfig) {
        this.apiKey = config.apiKey.trim();
        this.endpoint = config.endpoint || this.endpoint;
        if (!this.apiKey) throw new Error('Missing Roboflow API key.');
        return { message: 'SAM3 online service ready' };
    }

    async segment(image: ImageData, prompt: string): Promise<Sam3MaskResult> {
        if (!this.apiKey) throw new Error('Missing Roboflow API key.');
        const capture = image as Sam3CaptureImageData;
        const sourceWidth = capture.sam3SourceWidth || image.width;
        const sourceHeight = capture.sam3SourceHeight || image.height;
        const projectionWidth = capture.sam3ProjectionWidth || sourceWidth;
        const projectionHeight = capture.sam3ProjectionHeight || sourceHeight;
        const imageBase64 = imageDataToJpegBase64(image);
        const formats = ['json', 'rle'];
        let best: Sam3MaskResult | null = null;
        for (const format of formats) {
            const result = await this.segmentWithFormat(image, imageBase64, prompt, format, sourceWidth, sourceHeight, projectionWidth, projectionHeight);
            if (result.maskPixels > 0) return result;
            best = result;
        }
        return best || { width: image.width, height: image.height, sourceWidth, sourceHeight, projectionWidth, projectionHeight, mask: new Uint8Array(image.width * image.height), maskPixels: 0, debugSummary: 'empty:no-response', prompt };
    }

    private async segmentWithFormat(image: ImageData, imageBase64: string, prompt: string, format: string, sourceWidth: number, sourceHeight: number, projectionWidth: number, projectionHeight: number): Promise<Sam3MaskResult> {
        let response: Response;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            response = await fetch(`${this.endpoint}?api_key=${encodeURIComponent(this.apiKey)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    format,
                    model_id: 'sam3/sam3_final',
                    image: { type: 'base64', value: imageBase64 },
                    prompts: [{ type: 'text', text: prompt }]
                })
            });
        } catch (error) {
            // #WDD-gpt 2026-06-18 - 浏览器把 CORS/proxy/network 问题统一抛成 Failed fetch，转换成用户可执行的诊断信息
            if (error instanceof DOMException && error.name === 'AbortError') {
                throw new Error('SAM3 request timed out after 75s. Roboflow serverless may be cold or overloaded; try again with a simpler prompt.');
            }
            throw new Error(`SAM3 network request failed. Restart the Vite dev server so /api/sam3 proxy is active, then try again. ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            window.clearTimeout(timeout);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(formatRoboflowError(response.status, text));
        }
        const data = text ? JSON.parse(text) : {};
        const parsed = await responseToMask(data, image.width, image.height);
        console.log(`[SAM3 Online] ${format} response summary`, summarizeRoboflowResponse(data), parsed.debugSummary, parsed.maskPixels);
        return { width: image.width, height: image.height, sourceWidth, sourceHeight, projectionWidth, projectionHeight, mask: parsed.mask, maskPixels: parsed.maskPixels, debugSummary: `${format}:${parsed.debugSummary}`, prompt };
    }

    dispose() {
        this.apiKey = '';
    }
}

function formatRoboflowError(status: number, bodyText: string): string {
    let message = bodyText.slice(0, 240);
    try {
        const data = JSON.parse(bodyText);
        if (typeof data?.message === 'string') message = data.message;
        if (typeof data?.detail === 'string') message = data.detail;
    } catch {
        // Keep the raw trimmed body for non-JSON Roboflow responses.
    }

    // #WDD-gpt 2026-06-18 - Roboflow serverless 401 常见于 API Key 没有 SAM3/serverless inference 权限，给出可执行提示
    if (status === 401 && /serverless inference|unauthorized api_key/i.test(message)) {
        return 'Roboflow API Key 没有 Serverless Inference / SAM3 权限。请在 Roboflow 后台启用 serverless inference，或换一个有该权限的 key。';
    }
    if (status === 422) {
        return `Roboflow SAM3 请求格式被拒绝: ${message}`;
    }
    return `Roboflow SAM3 ${status}: ${message}`;
}

function summarizeRoboflowResponse(data: any) {
    const summary: Record<string, unknown> = {};
    if (!data || typeof data !== 'object') return { type: typeof data };
    summary.keys = Object.keys(data).slice(0, 16);
    for (const key of Object.keys(data)) {
        const value = data[key];
        if (Array.isArray(value)) {
            summary[`${key}.length`] = value.length;
            if (value[0] && typeof value[0] === 'object') summary[`${key}[0].keys`] = Object.keys(value[0]).slice(0, 16);
        } else if (value && typeof value === 'object') {
            summary[`${key}.keys`] = Object.keys(value).slice(0, 16);
        } else {
            summary[key] = value;
        }
    }
    return summary;
}

export function captureCanvasImageData(canvas: HTMLCanvasElement, maxSize = 768): ImageData {
    const sourceWidth = canvas.width || canvas.clientWidth;
    const sourceHeight = canvas.height || canvas.clientHeight;
    const rect = canvas.getBoundingClientRect();
    const projectionWidth = rect.width || canvas.clientWidth || sourceWidth;
    const projectionHeight = rect.height || canvas.clientHeight || sourceHeight;
    const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Unable to create SAM3 capture canvas.');
    ctx.drawImage(canvas, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height) as Sam3CaptureImageData;
    // #WDD-gpt 2026-06-18 - 保存截图缩放前的画布尺寸，选择映射必须从 worldToScreen 原始坐标映射到缩放后 mask 坐标
    image.sam3SourceWidth = sourceWidth;
    image.sam3SourceHeight = sourceHeight;
    image.sam3ProjectionWidth = projectionWidth;
    image.sam3ProjectionHeight = projectionHeight;
    image.sam3Scale = scale;
    return image;
}

function imageDataToJpegBase64(image: ImageData): string {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to encode SAM3 image.');
    ctx.putImageData(image, 0, 0);
    // #WDD-gpt 2026-06-18 - 在线 SAM3 上传改用 JPEG，显著降低 base64 体积；质量略提高以匹配半分辨率截图的分割精度
    return canvas.toDataURL('image/jpeg', 0.9).replace(/^data:image\/jpeg;base64,/, '');
}

async function responseToMask(data: any, width: number, height: number): Promise<ParsedMask> {
    const mask = new Uint8Array(width * height);
    const finish = (summary: string): ParsedMask => {
        let maskPixels = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i] > 0) maskPixels++;
        return { mask, maskPixels, debugSummary: summary };
    };

    const rles = collectRleMasks(data);
    if (rles.length) {
        for (const rle of rles) decodeRleIntoMask(mask, width, height, rle);
        return finish(`rle:${rles.length}`);
    }

    const polygons = collectPolygons(data);
    if (polygons.length) {
        rasterizePolygons(mask, width, height, polygons);
        return finish(`polygon:${polygons.length}`);
    }

    const boxes = collectBoxes(data);
    if (boxes.length) {
        rasterizeBoxes(mask, width, height, boxes);
        return finish(`box:${boxes.length}`);
    }

    const encodedMasks = collectEncodedMasks(data);
    for (const encoded of encodedMasks) {
        await mergeEncodedMask(mask, width, height, encoded);
    }
    if (mask.some((value) => value > 0)) return finish(`imageMask:${encodedMasks.length}`);
    const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 12).join(', ') : typeof data;
    console.warn('[SAM3 Online] No usable mask in response', data);
    console.warn(`[SAM3 Online] No usable mask fields. Top-level keys: ${keys || 'none'}`);
    return finish(`empty; keys:${keys || 'none'}`);
}

function collectRleMasks(data: any): any[] {
    const rles: any[] = [];
    const looksLikeRle = (value: any) => {
        if (!value || typeof value !== 'object') return false;
        return Array.isArray(value.counts) || typeof value.counts === 'string' || Array.isArray(value.rle) || Array.isArray(value.run_lengths);
    };
    const visit = (value: any) => {
        if (!value) return;
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (typeof value !== 'object') return;
        if (looksLikeRle(value)) rles.push(value);
        if (looksLikeRle(value.mask)) rles.push(value.mask);
        if (looksLikeRle(value.rle)) rles.push(value.rle);
        if (Array.isArray(value.detections)) visit(value.detections);
        if (Array.isArray(value.predictions)) visit(value.predictions);
        if (Array.isArray(value.results)) visit(value.results);
        if (Array.isArray(value.prompt_results)) visit(value.prompt_results);
        if (Array.isArray(value.masks)) visit(value.masks);
    };
    visit(data);
    return rles;
}

function decodeRleIntoMask(mask: Uint8Array, width: number, height: number, rle: any) {
    const counts = Array.isArray(rle) ? rle : (Array.isArray(rle.counts) ? rle.counts : (Array.isArray(rle.rle) ? rle.rle : rle.run_lengths));
    if (!Array.isArray(counts)) return;
    const size = Array.isArray(rle.size) && rle.size.length >= 2 ? rle.size : [height, width];
    const rleHeight = Math.max(1, Number(size[0]) || height);
    const rleWidth = Math.max(1, Number(size[1]) || width);
    let index = 0;
    let value = 0;
    for (const rawCount of counts) {
        const run = Math.max(0, Math.floor(Number(rawCount) || 0));
        if (value) {
            for (let i = 0; i < run; i++) {
                const flat = index + i;
                const y = flat % rleHeight;
                const x = Math.floor(flat / rleHeight);
                const mx = Math.floor((x / rleWidth) * width);
                const my = Math.floor((y / rleHeight) * height);
                if (mx >= 0 && mx < width && my >= 0 && my < height) mask[my * width + mx] = 255;
            }
        }
        index += run;
        value = value ? 0 : 1;
    }
}

function collectPolygons(data: any): Point[][] {
    const polygons: Point[][] = [];
    const visit = (value: any) => {
        if (!value) return;
        if (Array.isArray(value)) {
            const points = normalizePolygon(value);
            if (points.length >= 3) {
                polygons.push(points);
                return;
            }
            value.forEach(visit);
            return;
        }
        if (typeof value === 'object') {
            if (Array.isArray(value.points)) visit(value.points);
            if (Array.isArray(value.polygon)) visit(value.polygon);
            if (Array.isArray(value.polygons)) visit(value.polygons);
            if (Array.isArray(value.contour)) visit(value.contour);
            if (Array.isArray(value.contours)) visit(value.contours);
            if (Array.isArray(value.segmentation)) visit(value.segmentation);
            if (Array.isArray(value.segmentations)) visit(value.segmentations);
            if (Array.isArray(value.detections)) visit(value.detections);
            if (Array.isArray(value.masks)) visit(value.masks);
            if (Array.isArray(value.mask)) visit(value.mask);
            if (Array.isArray(value.predictions)) visit(value.predictions);
            if (Array.isArray(value.prompt_results)) visit(value.prompt_results);
            if (Array.isArray(value.results)) visit(value.results);
        }
    };
    visit(data);
    return polygons;
}

function collectBoxes(data: any): Box[] {
    const boxes: Box[] = [];
    const visit = (value: any) => {
        if (!value) return;
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (typeof value !== 'object') return;
        if (
            Number.isFinite(value.x) &&
            Number.isFinite(value.y) &&
            Number.isFinite(value.width) &&
            Number.isFinite(value.height)
        ) {
            boxes.push({
                x: Number(value.x),
                y: Number(value.y),
                width: Number(value.width),
                height: Number(value.height)
            });
        }
        if (Array.isArray(value.detections)) visit(value.detections);
        if (Array.isArray(value.predictions)) visit(value.predictions);
        if (Array.isArray(value.results)) visit(value.results);
        if (Array.isArray(value.prompt_results)) visit(value.prompt_results);
    };
    visit(data);
    return boxes;
}

function normalizePolygon(value: any[]): Point[] {
    const points: Point[] = [];
    for (const point of value) {
        if (Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
            points.push({ x: Number(point[0]), y: Number(point[1]) });
        } else if (point && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y)) {
            points.push({ x: Number(point.x), y: Number(point.y) });
        } else {
            return [];
        }
    }
    return points;
}

function rasterizePolygons(mask: Uint8Array, width: number, height: number, polygons: Point[][]) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Unable to rasterize SAM3 polygons.');
    ctx.fillStyle = '#fff';
    for (const polygon of polygons) {
        ctx.beginPath();
        ctx.moveTo(polygon[0].x, polygon[0].y);
        for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
        ctx.closePath();
        ctx.fill();
    }
    const pixels = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < mask.length; i++) {
        if (pixels[i * 4 + 3] > 0 || pixels[i * 4] > 0) mask[i] = 255;
    }
}

function rasterizeBoxes(mask: Uint8Array, width: number, height: number, boxes: Box[]) {
    // #WDD-gpt 2026-06-18 - Roboflow SAM3 若只返回检测框，先用 bbox 兜底生成粗选区，后续仍优先使用 polygon/mask
    for (const box of boxes) {
        const minX = Math.max(0, Math.floor(box.x - box.width * 0.5));
        const maxX = Math.min(width - 1, Math.ceil(box.x + box.width * 0.5));
        const minY = Math.max(0, Math.floor(box.y - box.height * 0.5));
        const maxY = Math.min(height - 1, Math.ceil(box.y + box.height * 0.5));
        for (let y = minY; y <= maxY; y++) {
            const row = y * width;
            for (let x = minX; x <= maxX; x++) mask[row + x] = 255;
        }
    }
}

function collectEncodedMasks(data: any): string[] {
    const masks: string[] = [];
    const visit = (value: any) => {
        if (!value) return;
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (typeof value === 'object') {
            if (typeof value.mask === 'string') masks.push(value.mask);
            if (Array.isArray(value.predictions)) visit(value.predictions);
            if (Array.isArray(value.prompt_results)) visit(value.prompt_results);
            if (Array.isArray(value.results)) visit(value.results);
        }
    };
    visit(data);
    return masks;
}

async function mergeEncodedMask(mask: Uint8Array, width: number, height: number, encoded: string) {
    const image = new Image();
    image.decoding = 'async';
    image.src = encoded.startsWith('data:image/') ? encoded : `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Unable to decode SAM3 mask.');
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < mask.length; i++) {
        if (pixels[i * 4 + 3] > 0 && (pixels[i * 4] > 0 || pixels[i * 4 + 1] > 0 || pixels[i * 4 + 2] > 0)) mask[i] = 255;
    }
}

export function selectGaussianIndicesFromMask(options: {
    positions: Float32Array;
    entity: pc.Entity;
    camera: pc.CameraComponent;
    mask: Uint8Array;
    maskWidth: number;
    maskHeight: number;
    screenWidth: number;
    screenHeight: number;
    maskOffsetX?: number;
    maskOffsetY?: number;
    maskScale?: number;
    flipX?: boolean;
    flipY?: boolean;
}): Sam3SelectionResult {
    const {
        positions,
        entity,
        camera,
        mask,
        maskWidth,
        maskHeight,
        screenWidth,
        screenHeight,
        maskOffsetX = 0,
        maskOffsetY = 0,
        maskScale = 1,
        flipX = false,
        flipY = false
    } = options;
    const modelMat = entity.getWorldTransform();
    const local = new pc.Vec3();
    const world = new pc.Vec3();
    const screen = new pc.Vec3();
    const selected: number[] = [];
    const count = Math.floor(positions.length / 3);
    let maskPixels = 0;
    let projectedPoints = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] > 0) maskPixels++;
    }

    // #WDD-gpt 2026-06-18 - SAM3 mask 到 Gaussian 选区：投影中心点到当前视角，使用双 y 采样兼容 PlayCanvas 屏幕坐标与 canvas 像素坐标差异
    for (let i = 0; i < count; i++) {
        local.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        modelMat.transformPoint(local, world);
        camera.worldToScreen(world, screen);
        if (screen.z <= 0) continue;
        const cx = screenWidth * 0.5;
        const cy = screenHeight * 0.5;
        let relativeX = screen.x;
        let relativeY = screen.y;
        if (flipX) relativeX = screenWidth - relativeX;
        if (flipY) relativeY = screenHeight - relativeY;
        relativeX = (relativeX - cx - maskOffsetX) / Math.max(0.001, maskScale) + cx;
        relativeY = (relativeY - cy - maskOffsetY) / Math.max(0.001, maskScale) + cy;
        if (relativeX < 0 || relativeX >= screenWidth || relativeY < 0 || relativeY >= screenHeight) continue;
        projectedPoints++;
        // #WDD-gpt 2026-06-18 - SAM3 mask 是按上传截图缩放后的尺寸返回，选择时必须把当前画布投影按比例映射到 mask 坐标
        const mx = Math.max(0, Math.min(maskWidth - 1, Math.floor((relativeX / screenWidth) * maskWidth)));
        const my = Math.max(0, Math.min(maskHeight - 1, Math.floor((relativeY / screenHeight) * maskHeight)));
        if (mask[my * maskWidth + mx] > 0) selected.push(i);
    }
    return { indices: selected, maskPixels, projectedPoints };
}
