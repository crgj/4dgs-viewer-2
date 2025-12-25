export class Graph {
    constructor(name: any, app: any, watermark: any, textRefreshRate: any, timer: any);
    app: any;
    name: any;
    device: any;
    timer: any;
    watermark: any;
    enabled: boolean;
    textRefreshRate: any;
    avgTotal: number;
    avgTimer: number;
    avgCount: number;
    timingText: string;
    texture: any;
    yOffset: number;
    cursor: number;
    sample: Uint8ClampedArray<ArrayBuffer>;
    counter: number;
    destroy(): void;
    loseContext(): void;
    update(ms: any): void;
    render(render2d: any, x: any, y: any, w: any, h: any): void;
}
