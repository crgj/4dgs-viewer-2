export class ArcShape extends Shape {
    constructor(device: any, options?: {});
    _tubeRadius: number;
    _ringRadius: number;
    _sectorAngle: any;
    _lightDir: any;
    _tolerance: number;
    _createTorusGeometry(): TorusGeometry;
    _createTorusMesh(sectorAngle: any): import("../../../index.js").Mesh;
    _createDisk(): void;
    set tubeRadius(value: number);
    get tubeRadius(): number;
    set ringRadius(value: number);
    get ringRadius(): number;
    set tolerance(value: number);
    get tolerance(): number;
    _updateTransform(): void;
    drag(state: any): void;
    hide(state: any): void;
}
import { Shape } from './shape.js';
import { TorusGeometry } from '../../../scene/geometry/torus-geometry.js';
