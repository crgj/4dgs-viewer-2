import * as pc from 'playcanvas';

export type PostProcessingSettings = {
    brightness: number;
    contrast: number;
    exposure: number;
};

// #WDD-gpt 2026-08-04 - 在所有透明高斯完成混合后执行颜色调整，并请求 HDR 中间目标保留高光范围
class ColorAdjustmentPostEffect extends pc.PostEffect {
    private readonly shader: pc.Shader;
    brightness = 0;
    contrast = 1;
    exposure = 1;

    constructor(device: pc.GraphicsDevice) {
        super(device);
        (this as any).hdr = true;
        this.shader = pc.createShaderFromCode(
            device,
            pc.PostEffect.quadVertexShader,
            `
                varying vec2 vUv0;
                uniform sampler2D uColorBuffer;
                uniform float uBrightness;
                uniform float uContrast;
                uniform float uExposure;

                void main(void) {
                    vec4 source = texture2D(uColorBuffer, vUv0);
                    vec3 adjusted = (source.rgb - 0.5) * uContrast + 0.5;
                    adjusted = (adjusted + uBrightness) * uExposure;
                    gl_FragColor = vec4(max(adjusted, vec3(0.0)), source.a);
                }
            `,
            'TrueSplatsColorAdjustmentPostEffect',
            { aPosition: pc.SEMANTIC_POSITION }
        );
    }

    render(inputTarget: pc.RenderTarget, outputTarget: pc.RenderTarget | null, rect: pc.Vec4) {
        const scope = this.device.scope;
        scope.resolve('uColorBuffer').setValue(inputTarget.colorBuffer);
        scope.resolve('uBrightness').setValue(this.brightness);
        scope.resolve('uContrast').setValue(this.contrast);
        scope.resolve('uExposure').setValue(this.exposure);
        this.drawQuad(outputTarget, this.shader, rect);
    }
}

export class PostProcessingTool {
    app: pc.Application;
    container: HTMLElement | null = null;
    brightness = 0;
    contrast = 0;
    exposure = 1;
    private readonly effect: ColorAdjustmentPostEffect;

    constructor(
        app: pc.Application,
        camera: pc.CameraComponent,
        private readonly onChanged?: (settings: PostProcessingSettings) => void
    ) {
        this.app = app;
        this.effect = new ColorAdjustmentPostEffect(app.graphicsDevice);
        camera.postEffects.addEffect(this.effect);
        this.setupEventListeners();
        this.applySettings();
    }

    private setupEventListeners() {
        const resetBtn = document.getElementById('reset-pp');
        resetBtn?.addEventListener('click', () => this.reset());

        const expInput = document.getElementById('pp-exposure') as HTMLInputElement;
        const expVal = document.getElementById('val-exposure');
        expInput?.addEventListener('input', () => {
            this.exposure = parseFloat(expInput.value);
            if (expVal) expVal.innerText = this.exposure.toFixed(1);
            this.applySettings();
        });

        const briInput = document.getElementById('pp-brightness') as HTMLInputElement;
        const briVal = document.getElementById('val-brightness');
        briInput?.addEventListener('input', () => {
            this.brightness = parseFloat(briInput.value);
            if (briVal) briVal.innerText = this.brightness > 0 ? '+' + this.brightness.toFixed(2) : this.brightness.toFixed(2);
            this.applySettings();
        });

        const conInput = document.getElementById('pp-contrast') as HTMLInputElement;
        const conVal = document.getElementById('val-contrast');
        conInput?.addEventListener('input', () => {
            this.contrast = parseFloat(conInput.value);
            if (conVal) conVal.innerText = this.contrast > 0 ? '+' + this.contrast.toFixed(2) : this.contrast.toFixed(2);
            this.applySettings();
        });
    }

    reset() {
        this.brightness = 0;
        this.contrast = 0;
        this.exposure = 1;

        (document.getElementById('pp-exposure') as HTMLInputElement).value = '1.0';
        (document.getElementById('pp-brightness') as HTMLInputElement).value = '0.0';
        (document.getElementById('pp-contrast') as HTMLInputElement).value = '0.0';

        if (document.getElementById('val-exposure')) document.getElementById('val-exposure')!.innerText = '1.0';
        if (document.getElementById('val-brightness')) document.getElementById('val-brightness')!.innerText = '0.0';
        if (document.getElementById('val-contrast')) document.getElementById('val-contrast')!.innerText = '0.0';

        this.applySettings();
    }

    applySettings() {
        const settings = {
            brightness: Number.isFinite(this.brightness) ? this.brightness : 0,
            contrast: 1 + (Number.isFinite(this.contrast) ? this.contrast : 0),
            exposure: Number.isFinite(this.exposure) ? this.exposure : 1
        };
        this.effect.brightness = settings.brightness;
        this.effect.contrast = settings.contrast;
        this.effect.exposure = settings.exposure;
        this.onChanged?.(settings);
    }
}
