export class GSplatSorter extends EventHandler {
    worker: Worker;
    orderTexture: any;
    centers: any;
    destroy(): void;
    init(orderTexture: any, centers: any): void;
    setMapping(mapping: any): void;
    setCamera(pos: any, dir: any): void;
}
import { EventHandler } from '../../core/event-handler.js';
