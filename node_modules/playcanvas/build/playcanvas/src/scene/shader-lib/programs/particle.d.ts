export const particle: ShaderGeneratorParticle;
declare class ShaderGeneratorParticle extends ShaderGenerator {
    generateKey(options: any): string;
    _animTex(options: any): string;
    createShaderDefinition(device: any, options: any): any;
}
import { ShaderGenerator } from './shader-generator.js';
export {};
