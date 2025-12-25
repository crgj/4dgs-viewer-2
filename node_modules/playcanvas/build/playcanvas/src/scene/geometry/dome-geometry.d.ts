/**
 * A procedural dome-shaped geometry.
 *
 * The size and tesselation properties of the dome can be controlled via constructor parameters.
 * Radius is fixed to 0.5.
 *
 * Note that the dome is created with UVs in the range of 0 to 1.
 *
 * @category Graphics
 */
export class DomeGeometry extends SphereGeometry {
    /**
     * Create a new CylinderGeometry instance.
     *
     * @param {object} [opts] - An object that specifies optional inputs for the function as follows:
     * @param {number} [opts.latitudeBands] - The number of divisions along the latitudinal axis of the
     * sphere (defaults to 16).
     * @param {number} [opts.longitudeBands] - The number of divisions along the longitudinal axis of
     * the sphere (defaults to 16).
     */
    constructor(opts?: {
        latitudeBands?: number;
        longitudeBands?: number;
    });
}
import { SphereGeometry } from './sphere-geometry.js';
