declare const _default: "\nvec3 addAlbedoDetail(vec3 albedo) {\n#ifdef MAPTEXTURE\n    vec3 albedoDetail = $DECODE(texture2DBias($SAMPLER, $UV, textureBias)).$CH;\n    return detailMode_$DETAILMODE(albedo, albedoDetail);\n#else\n    return albedo;\n#endif\n}\n";
export default _default;
