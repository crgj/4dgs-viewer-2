declare const _default: "\n\nvec3 getSpecularModulate(in vec3 specularity, in vec3 albedo, in float metalness, in float f0) {\n    vec3 dielectricF0 = f0 * specularity;\n    return mix(dielectricF0, albedo, metalness);\n}\n\nvec3 getAlbedoModulate(in vec3 albedo, in float metalness) {\n    return albedo * (1.0 - metalness);\n}\n";
export default _default;
