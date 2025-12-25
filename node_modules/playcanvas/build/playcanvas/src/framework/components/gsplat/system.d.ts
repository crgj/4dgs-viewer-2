/**
 * Allows an Entity to render a gsplat.
 *
 * @category Graphics
 */
export class GSplatComponentSystem extends ComponentSystem {
    id: string;
    ComponentType: typeof GSplatComponent;
    DataType: typeof GSplatComponentData;
    schema: string[];
    initializeComponentData(component: any, _data: any, properties: any): void;
    cloneComponent(entity: any, clone: any): Component;
    onRemove(entity: any, component: any): void;
}
import { ComponentSystem } from '../system.js';
import { GSplatComponent } from './component.js';
import { GSplatComponentData } from './data.js';
import { Component } from '../component.js';
