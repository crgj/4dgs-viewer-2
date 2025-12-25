/**
 * A procedural sphere-shaped geometry.
 *
 * The size and tesselation properties of the sphere can be controlled via constructor parameters. By
 * default, the function will create a sphere centered on the object space origin with a radius of
 * 0.5 and 16 segments in both longitude and latitude.
 *
 * Note that the sphere is created with UVs in the range of 0 to 1.
 *
 * @category Graphics
 */
export class SphereGeometry extends Geometry {
    /**
     * Create a new SphereGeometry instance.
     *
     * @param {object} [opts] - An object that specifies optional inputs for the function as follows:
     * @param {number} [opts.radius] - The radius of the sphere (defaults to 0.5).
     * @param {number} [opts.latitudeBands] - The number of divisions along the latitudinal axis of the
     * sphere (defaults to 16).
     * @param {number} [opts.longitudeBands] - The number of divisions along the longitudinal axis of
     * the sphere (defaults to 16).
     * @param {boolean} [opts.calculateTangents] - Generate tangent information (defaults to false).
     */
    constructor(opts?: {
        radius?: number;
        latitudeBands?: number;
        longitudeBands?: number;
        calculateTangents?: boolean;
    });
}
import { Geometry } from './geometry.js';
