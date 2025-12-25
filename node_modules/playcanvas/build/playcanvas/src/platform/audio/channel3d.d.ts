/**
 * 3D audio channel.
 *
 * @ignore
 */
export class Channel3d extends Channel {
    position: Vec3;
    velocity: Vec3;
    panner: PannerNode;
    maxDistance: number;
    minDistance: number;
    rollOffFactor: number;
    distanceModel: string;
    getPosition(): Vec3;
    setPosition(position: any): void;
    getVelocity(): Vec3;
    setVelocity(velocity: any): void;
    getMaxDistance(): number;
    setMaxDistance(max: any): void;
    getMinDistance(): number;
    setMinDistance(min: any): void;
    getRollOffFactor(): number;
    setRollOffFactor(factor: any): void;
    getDistanceModel(): DistanceModelType;
    setDistanceModel(distanceModel: any): void;
}
import { Channel } from './channel.js';
import { Vec3 } from '../../core/math/vec3.js';
