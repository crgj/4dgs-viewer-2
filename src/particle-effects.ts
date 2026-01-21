import * as pc from 'playcanvas';

/**
 * GaussianEffects #WDD 2026-01-15
 * Manages the "fly-apart and restore" transition effect for Gaussian particles.
 */
export class GaussianEffects {
    private app: pc.Application;
    private factor: number = 0;
    public isEnabled: boolean = false; // #WDD 2026-01-19 Default to disabled

    constructor(app: pc.Application) {
        this.app = app;
    }

    /**
     * Calculates the transition factor (0 -> 1 -> 0) based on camera animation progress (0 -> 1).
     * @param progress Camera animation progress (0.0 to 1.0)
     */
    update(progress: number, material: pc.Material | null) {
        // Use smooth sine wave for symmetric transition if enabled #WDD 2026-01-15
        this.factor = this.isEnabled ? Math.sin(progress * Math.PI) : 0;

        if (material) {
            material.setParameter('uTransitionFactor', this.factor);
            // Pass raw progress (0 -> 1) for synchronized rotation if enabled
            material.setParameter('uRotationFactor', this.isEnabled ? progress : 0);
        }
    }

    /**
     * Resets the effect factor.
     */
    reset(material: pc.Material | null) {
        this.factor = 0;
        if (material) {
            material.setParameter('uTransitionFactor', 0);
        }
    }
}
