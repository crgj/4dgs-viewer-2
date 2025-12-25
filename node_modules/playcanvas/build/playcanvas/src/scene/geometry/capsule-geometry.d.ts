/**
 * A procedural capsule-shaped geometry.
 *
 * The size, shape and tesselation properties of the capsule can be controlled via constructor
 * parameters. By default, the function will create a capsule standing vertically centered on the
 * XZ-plane with a radius of 0.3, a height of 1.0, 1 height segment and 20 cap segments.
 *
 * Note that the capsule is created with UVs in the range of 0 to 1.
 *
 * @category Graphics
 */
export class CapsuleGeometry extends ConeBaseGeometry {
    /**
     * Create a new CapsuleGeometry instance.
     *
     * @param {object} [opts] - An object that specifies optional inputs for the function as follows:
     * @param {number} [opts.radius] - The radius of the tube forming the body of the capsule (defaults
     * to 0.3).
     * @param {number} [opts.height] - The length of the body of the capsule from tip to tip (defaults
     * to 1.0).
     * @param {number} [opts.heightSegments] - The number of divisions along the tubular length of the
     * capsule (defaults to 1).
     * @param {number} [opts.sides] - The number of divisions around the tubular body of the capsule
     * (defaults to 20).
     * @param {boolean} [opts.calculateTangents] - Generate tangent information (defaults to false).
     */
    constructor(opts?: {
        radius?: number;
        height?: number;
        heightSegments?: number;
        sides?: number;
        calculateTangents?: boolean;
    });
}
import { ConeBaseGeometry } from './cone-base-geometry.js';
