/**
 * A procedural cylinder-shaped geometry.
 *
 * The size, shape and tesselation properties of the cylinder can be controlled via constructor
 * parameters. By default, the function will create a cylinder standing vertically centered on the
 * XZ-plane with a radius of 0.5, a height of 1.0, 1 height segment and 20 cap segments.
 *
 * Note that the cylinder is created with UVs in the range of 0 to 1.
 *
 * @category Graphics
 */
export class CylinderGeometry extends ConeBaseGeometry {
    /**
     * Create a new CylinderGeometry instance.
     *
     * @param {object} [opts] - An object that specifies optional inputs for the function as follows:
     * @param {number} [opts.radius] - The radius of the tube forming the body of the cylinder
     * (defaults to 0.5).
     * @param {number} [opts.height] - The length of the body of the cylinder (defaults to 1.0).
     * @param {number} [opts.heightSegments] - The number of divisions along the length of the cylinder
     * (defaults to 5).
     * @param {number} [opts.capSegments] - The number of divisions around the tubular body of the
     * cylinder (defaults to 20).
     * @param {boolean} [opts.calculateTangents] - Generate tangent information (defaults to false).
     */
    constructor(opts?: {
        radius?: number;
        height?: number;
        heightSegments?: number;
        capSegments?: number;
        calculateTangents?: boolean;
    });
}
import { ConeBaseGeometry } from './cone-base-geometry.js';
