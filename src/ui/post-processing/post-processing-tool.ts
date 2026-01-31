
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
        this.injectUI();
        this.setupEventListeners();
        this.applySettings();
    }

    private injectUI() {
        // Inject Floating Panel
        // Updated position to be near settings button but not overlapping
        const html = `
            <div id="post-process-panel" class="glass-blue rounded-xl p-3 flex flex-col gap-3 shadow-2xl transition-all duration-300 w-48 border border-white/10 hidden" style="position: fixed !important; top: 6rem !important; right: 1.5rem !important; z-index: 9999 !important;">
                <div class="flex items-center justify-between">
                    <span class="text-[9px] font-bold uppercase tracking-widest ui-text-primary">Post Process</span>
                    <button id="reset-pp" class="text-[8px] ui-text-highlight hover:text-white transition-colors uppercase font-bold">Res</button>
                    <button id="close-pp" class="p-1 hover:ui-text-highlight transition-colors">
                        <svg viewBox="0 0 24 24" class="w-3 h-3 fill-current"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
                
                <div class="h-px ui-border"></div>

                <!-- Exposure -->
                <div class="flex flex-col gap-1">
                    <div class="flex justify-between">
                        <span class="text-[8px] uppercase opacity-50 font-bold">Exposure</span>
                        <span id="val-exposure" class="text-[8px] font-mono">1.0</span>
                    </div>
                    <input type="range" id="pp-exposure" min="0" max="5" step="0.1" value="1.0" class="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer">
                </div>

                <!-- Brightness -->
                <div class="flex flex-col gap-1">
                    <div class="flex justify-between">
                         <span class="text-[8px] uppercase opacity-50 font-bold">Brightness</span>
                         <span id="val-brightness" class="text-[8px] font-mono">0.0</span>
                    </div>
                    <input type="range" id="pp-brightness" min="-1" max="1" step="0.05" value="0.0" class="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer">
                </div>
                
                <!-- Contrast -->
                <div class="flex flex-col gap-1">
                    <div class="flex justify-between">
                        <span class="text-[8px] uppercase opacity-50 font-bold">Contrast</span>
                        <span id="val-contrast" class="text-[8px] font-mono">0.0</span>
                    </div>
                    <input type="range" id="pp-contrast" min="-1" max="1" step="0.05" value="0.0" class="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer">
                </div>
            </div>
            
            <!-- Toggle Button in Control Panel (we'll append it via JS to existing panel) -->
        `;

        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.appendChild(div.firstElementChild!);
        this.container = document.getElementById('post-process-panel');

        // Add Toggle Button to Main Toolbar
        const toolbar = document.querySelector('#control-panel .grid');
        if (toolbar) {
            const btn = document.createElement('button');
            btn.id = "toggle-pp";
            btn.className = "ui-btn p-1.5 rounded-lg flex justify-center has-tooltip";
            btn.setAttribute('aria-label', "Post Processing");
            btn.innerHTML = `<svg viewBox="0 0 24 24" class="w-4 h-4 fill-current"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>`;

            btn.onclick = () => {
                this.container?.classList.toggle('hidden');
            };

            // Insert before the last item (input file) or just append
            toolbar.insertBefore(btn, toolbar.lastElementChild); // Insert before file input
        }
    }

    private setupEventListeners() {
        // Prevent camera interaction when hovering panel
        this.container?.addEventListener('mousedown', (e) => e.stopPropagation());
        this.container?.addEventListener('mousemove', (e) => e.stopPropagation());
        this.container?.addEventListener('wheel', (e) => e.stopPropagation());
        this.container?.addEventListener('touchmove', (e) => e.stopPropagation());

        const closeBtn = document.getElementById('close-pp');
        closeBtn?.addEventListener('click', () => this.container?.classList.add('hidden'));

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

