/**
 * A procedural plane-shaped geometry.
 *
 * The size and tesselation properties of the plane can be controlled via constructor parameters. By
 * default, the function will create a plane centered on the object space origin with a width and
 * length of 1.0 and 5 segments in either axis (50 triangles). The normal vector of the plane is
 * aligned along the positive Y axis.
 *
 * Note that the plane is created with UVs in the range of 0 to 1.
 *
 * @category Graphics
 */
export class PlaneGeometry extends Geometry {
    /**
     * Create a new PlaneGeometry instance.
     *
     * @param {object} [opts] - An object that specifies optional inputs for the function as follows:
     * @param {Vec2} [opts.halfExtents] - The half dimensions of the plane in the X and Z axes
     * (defaults to [0.5, 0.5]).
     * @param {number} [opts.widthSegments] - The number of divisions along the X axis of the plane
     * (defaults to 5).
     * @param {number} [opts.lengthSegments] - The number of divisions along the Z axis of the plane
     * (defaults to 5).
     * @param {boolean} [opts.calculateTangents] - Generate tangent information (defaults to false).
     */
    constructor(opts?: {
        halfExtents?: Vec2;
        widthSegments?: number;
        lengthSegments?: number;
        calculateTangents?: boolean;
    });
}
import { Geometry } from './geometry.js';
import { Vec2 } from '../../core/math/vec2.js';
