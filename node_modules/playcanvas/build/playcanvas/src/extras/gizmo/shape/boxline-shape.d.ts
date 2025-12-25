export class BoxLineShape extends Shape {
    constructor(device: any, options?: {});
    _gap: number;
    _lineThickness: number;
    _lineLength: number;
    _boxSize: number;
    _tolerance: number;
    _box: any;
    _line: any;
    _flipped: boolean;
    set gap(value: number);
    get gap(): number;
    set lineThickness(value: number);
    get lineThickness(): number;
    set lineLength(value: number);
    get lineLength(): number;
    set boxSize(value: number);
    get boxSize(): number;
    set tolerance(value: number);
    get tolerance(): number;
    set flipped(value: boolean);
    get flipped(): boolean;
    _createBoxLine(): void;
    _updateBox(): void;
    _updateLine(): void;
}
import { Shape } from './shape.js';
