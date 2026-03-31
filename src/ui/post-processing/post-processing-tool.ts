
import * as pc from 'playcanvas';

export class PostProcessingTool {
    app: pc.Application;

    // UI Elements
    container: HTMLElement | null = null;

    // State
    brightness: number = 0.0; // -1 to 1
    contrast: number = 0.0;   // -1 to 1
    exposure: number = 1.0;   // multiplier

    constructor(app: pc.Application) {
        this.app = app;
        this.setupEventListeners();
        this.applySettings();
    }

    private setupEventListeners() {
        const resetBtn = document.getElementById('reset-pp');
        resetBtn?.addEventListener('click', () => this.reset());

        // Exposure
        const expInput = document.getElementById('pp-exposure') as HTMLInputElement;
        const expVal = document.getElementById('val-exposure');
        expInput?.addEventListener('input', () => {
            this.exposure = parseFloat(expInput.value);
            if (expVal) expVal.innerText = this.exposure.toFixed(1);
            this.applySettings();
        });

        // Brightness
        const briInput = document.getElementById('pp-brightness') as HTMLInputElement;
        const briVal = document.getElementById('val-brightness');
        briInput?.addEventListener('input', () => {
            this.brightness = parseFloat(briInput.value);
            if (briVal) briVal.innerText = this.brightness > 0 ? '+' + this.brightness.toFixed(2) : this.brightness.toFixed(2);
            this.applySettings();
        });

        // Contrast
        const conInput = document.getElementById('pp-contrast') as HTMLInputElement;
        const conVal = document.getElementById('val-contrast');
        conInput?.addEventListener('input', () => {
            this.contrast = parseFloat(conInput.value);
            if (conVal) conVal.innerText = this.contrast > 0 ? '+' + this.contrast.toFixed(2) : this.contrast.toFixed(2);
            this.applySettings();
        });
    }

    reset() {
        this.brightness = 0.0;
        this.contrast = 0.0;
        this.exposure = 1.0;

        // Update UI
        (document.getElementById('pp-exposure') as HTMLInputElement).value = "1.0";
        (document.getElementById('pp-brightness') as HTMLInputElement).value = "0.0";
        (document.getElementById('pp-contrast') as HTMLInputElement).value = "0.0";

        if (document.getElementById('val-exposure')) document.getElementById('val-exposure')!.innerText = "1.0";
        if (document.getElementById('val-brightness')) document.getElementById('val-brightness')!.innerText = "0.0";
        if (document.getElementById('val-contrast')) document.getElementById('val-contrast')!.innerText = "0.0";

        this.applySettings();
    }


    applySettings() {
        // Apply via shader uniforms instead of scene settings
        this.updateMaterialUniforms();
    }

    private updateMaterialUniforms() {
        // Find all entities with gsplat component and update their material uniforms
        const entities = this.app.root.findComponents('gsplat');
        entities.forEach((gsplat: any) => {
            const instance = gsplat.instance;
            if (instance && instance.material) {
                const mat = instance.material;
                mat.setParameter('uBrightness', this.brightness);
                mat.setParameter('uContrast', 1.0 + this.contrast); // Map [-1,1] to [0,2]
                mat.setParameter('uExposure', this.exposure);
            }
        });
    }
}
