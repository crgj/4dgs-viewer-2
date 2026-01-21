import * as pc from 'playcanvas';

export class SkyboxManager {
    private app: pc.Application;
    private currentSkyboxTexture: pc.Texture | null = null;
    private currentEnvAtlas: pc.Texture | null = null;

    constructor(app: pc.Application) {
        this.app = app;
    }

    /**
     * Loads a skybox from a URL (Texture or Cubemap)
     * Currently supports single equirectangular texture loading which is common for skyboxes.
     */
    public loadSkybox(url: string, filename: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const asset = new pc.Asset(filename, 'texture', { url: url });

            asset.ready((a) => {
                const texture = a.resource as pc.Texture;
                this.processSkybox(texture);
                resolve();
            });

            asset.on('error', (err: string) => reject(err));

            this.app.assets.add(asset);
            this.app.assets.load(asset);
        });
    }

    /**
     * Set skybox from an existing asset (e.g. preloaded texture)
     */
    public setSkyboxAsset(asset: pc.Asset) {
        if (asset.resource) {
            this.processSkybox(asset.resource as pc.Texture);
        } else {
            asset.ready((a) => {
                this.processSkybox(a.resource as pc.Texture);
            });
            this.app.assets.load(asset);
        }
    }

    public clearSkybox() {
        if (this.currentSkyboxTexture) {
            this.currentSkyboxTexture.destroy();
            this.currentSkyboxTexture = null;
        }
        if (this.currentEnvAtlas) {
            this.currentEnvAtlas.destroy();
            this.currentEnvAtlas = null;
        }

        this.app.scene.skybox = null as any;
        this.app.scene.envAtlas = null as any;

        const layer = this.app.scene.layers.getLayerById(pc.LAYERID_SKYBOX);
        if (layer) layer.enabled = false;
    }

    /**
     * Main processing logic using EnvLighting to generate high-quality cubemap and lighting
     */
    private processSkybox(source: pc.Texture) {
        // Cleanup previous
        if (this.currentSkyboxTexture && this.currentSkyboxTexture !== source) {
            this.currentSkyboxTexture.destroy();
        }
        if (this.currentEnvAtlas) {
            this.currentEnvAtlas.destroy();
        }

        // 1. Generate Skybox Cubemap (Fixes seams & projection, creates mipmaps)
        const skybox = pc.EnvLighting.generateSkyboxCubemap(source);
        this.currentSkyboxTexture = skybox;

        // 2. Generate Lighting (EnvAtlas) for PBR
        const lighting = pc.EnvLighting.generateLightingSource(source);
        const envAtlas = pc.EnvLighting.generateAtlas(lighting, {});
        lighting.destroy();
        this.currentEnvAtlas = envAtlas;

        // 3. Apply to Scene
        this.app.scene.envAtlas = envAtlas;
        this.app.scene.skybox = skybox;

        // Enable Skybox Layer
        const layer = this.app.scene.layers.getLayerById(pc.LAYERID_SKYBOX);
        if (layer) layer.enabled = true;

        // Default settings
        this.setType(pc.SKYTYPE_INFINITE);
        this.setExposure(0);
        this.setBlur(0); // Default sharp
    }

    // --- Control API ---

    public setBlur(level: number) {
        // Blur only works in Infinite Sphere mode with mipmaps
        if (this.app.scene.sky.type === pc.SKYTYPE_INFINITE) {
            this.app.scene.skyboxMip = Math.max(0, Math.min(5, level));
        } else {
            this.app.scene.skyboxMip = 0;
        }
    }

    public setExposure(ev: number) {
        this.app.scene.skyboxIntensity = Math.pow(2, ev);
    }

    public setRotation(degrees: number) {
        const rot = new pc.Quat();
        rot.setFromEulerAngles(0, degrees, 0);
        this.app.scene.skyboxRotation = rot;
    }

    public setType(type: string) {
        // Map string types to constants if needed
        switch (type) {
            case 'Infinite Sphere': this.app.scene.sky.type = pc.SKYTYPE_INFINITE; break;
            case 'Projective Dome': this.app.scene.sky.type = pc.SKYTYPE_DOME; break;
            case 'Projective Box': this.app.scene.sky.type = pc.SKYTYPE_BOX; break;
            default: this.app.scene.sky.type = type; break;
        }
    }

    public setBackgroundColor(color: pc.Color) {
        // This usually affects the clear color if skybox is disabled or transparent
        // For Viewer, it modifies CSS or clear color
        // Here we just helper to disable skybox if "Solid Color" mode implied
    }
}
