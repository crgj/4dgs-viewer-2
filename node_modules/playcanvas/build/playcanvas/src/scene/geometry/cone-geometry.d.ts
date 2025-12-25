/**
 * A procedural cone-shaped geometry.
 *
 * The size, shape and tesselation properties of the cone can be controlled via constructor
 * parameters. By default, the function will create a cone standing vertically centered on the
 * XZ-plane with a base radius of 0.5, a height of 1.0, 5 height segments and 18 cap segments.
 *
 * Note that the cone is created with UVs in the range of 0 to 1.
 *
 * @category Graphics
 */
export class ConeGeometry extends ConeBaseGeometry {
    /**
     * Create a new ConeGeometry instance.
     *
     * @param {object} [opts] - An object that specifies optional inputs for the function as follows:
     * @param {number} [opts.baseRadius] - The base radius of the cone (defaults to 0.5).
     * @param {number} [opts.peakRadius] - The peak radius of the cone (defaults to 0.0).
     * @param {number} [opts.height] - The length of the body of the cone (defaults to 1.0).
     * @param {number} [opts.heightSegments] - The number of divisions along the length of the cone
     * (defaults to 5).
     * @param {number} [opts.capSegments] - The number of divisions around the tubular body of the cone
     * (defaults to 18).
     * @param {boolean} [opts.calculateTangents] - Generate tangent information (defaults to false).
     */
    constructor(opts?: {
        baseRadius?: number;
        peakRadius?: number;
        height?: number;
        heightSegments?: number;
        capSegments?: number;
        calculateTangents?: boolean;
    });
}
import { ConeBaseGeometry } from './cone-base-geometry.js';
