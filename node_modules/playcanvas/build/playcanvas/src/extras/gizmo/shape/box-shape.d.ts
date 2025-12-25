export class BoxShape extends Shape {
    constructor(device: any, options?: {});
    _size: number;
    _tolerance: number;
    _createCenter(): void;
    set size(value: number);
    get size(): number;
    set tolerance(value: number);
    get tolerance(): number;
    _updateTransform(): void;
}
import { Shape } from './shape.js';
