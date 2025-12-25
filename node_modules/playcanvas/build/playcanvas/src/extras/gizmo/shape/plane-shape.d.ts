export class PlaneShape extends Shape {
    constructor(device: any, options?: {});
    _size: number;
    _gap: number;
    _flipped: Vec3;
    set size(value: number);
    get size(): number;
    set gap(value: number);
    get gap(): number;
    set flipped(value: Vec3);
    get flipped(): Vec3;
    _getPosition(): Vec3;
    _createPlane(): void;
    _updateTransform(): void;
}
import { Shape } from './shape.js';
import { Vec3 } from '../../../core/math/vec3.js';
