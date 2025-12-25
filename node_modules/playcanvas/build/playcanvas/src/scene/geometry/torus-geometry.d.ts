/**
 * A procedural torus-shaped geometry.
 *
 * The size, shape and tesselation properties of the torus can be controlled via constructor
 * parameters. By default, the function will create a torus in the XZ-plane with a tube radius of
 * 0.2, a ring radius of 0.3, 30 segments and 20 sides.
 *
 * Note that the torus is created with UVs in the range of 0 to 1.
 *
 * @category Graphics
 */
export class TorusGeometry extends Geometry {
    /**
     * Create a new TorusGeometry instance.
     *
     * @param {object} [opts] - An object that specifies optional inputs for the function as follows:
     * @param {number} [opts.tubeRadius] - The radius of the tube forming the body of the torus
     * (defaults to 0.2).
     * @param {number} [opts.ringRadius] - The radius from the centre of the torus to the centre of the
     * tube (defaults to 0.3).
     * @param {number} [opts.sectorAngle] - The sector angle in degrees of the ring of the torus
     * (defaults to 2 * Math.PI).
     * @param {number} [opts.segments] - The number of radial divisions forming cross-sections of the
     * torus ring (defaults to 20).
     * @param {number} [opts.sides] - The number of divisions around the tubular body of the torus ring
     * (defaults to 30).
     * @param {boolean} [opts.calculateTangents] - Generate tangent information (defaults to false).
     */
    constructor(opts?: {
        tubeRadius?: number;
        ringRadius?: number;
        sectorAngle?: number;
        segments?: number;
        sides?: number;
        calculateTangents?: boolean;
    });
}
import { Geometry } from './geometry.js';
