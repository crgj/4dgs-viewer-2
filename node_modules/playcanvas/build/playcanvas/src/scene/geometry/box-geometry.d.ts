/**
 * A procedural box-shaped geometry.
 *
 * The size, shape and tesselation properties of the box can be controlled via constructor options.
 * By default, a box centered on the object space origin with a width, length and height of 1.0 unit
 * and 1 segment in either axis (2 triangles per face).
 *
 * Note that the box is created with UVs in the range of 0 to 1 on each face.
 *
 * @category Graphics
 */
export class BoxGeometry extends Geometry {
    /**
     * Create a new BoxGeometry instance.
     *
     * @param {object} [opts] - An object that specifies optional inputs for the function as follows:
     * @param {Vec3} [opts.halfExtents] - The half dimensions of the box in each axis (defaults to
     * [0.5, 0.5, 0.5]).
     * @param {number} [opts.widthSegments] - The number of divisions along the X axis of the box
     * (defaults to 1).
     * @param {number} [opts.lengthSegments] - The number of divisions along the Z axis of the box
     * (defaults to 1).
     * @param {number} [opts.heightSegments] - The number of divisions along the Y axis of the box
     * (defaults to 1).
     * @param {boolean} [opts.calculateTangents] - Generate tangent information (defaults to false).
     * @param {number} [opts.yOffset] - Move the box vertically by given offset in local space. Pass
     * 0.5 to generate the box with pivot point at the bottom face. Defaults to 0.
     */
    constructor(opts?: {
        halfExtents?: Vec3;
        widthSegments?: number;
        lengthSegments?: number;
        heightSegments?: number;
        calculateTangents?: boolean;
        yOffset?: number;
    });
    positions: any[];
    normals: any[];
    uvs: any[];
    uvs1: any[];
    indices: any[];
}
import { Geometry } from './geometry.js';
import { Vec3 } from '../../core/math/vec3.js';
