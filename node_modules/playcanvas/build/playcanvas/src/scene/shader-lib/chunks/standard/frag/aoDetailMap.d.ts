declare const _default: "\nfloat addAoDetail(float ao) {\n#ifdef MAPTEXTURE\n    float aoDetail = texture2DBias($SAMPLER, $UV, textureBias).$CH;\n    return detailMode_$DETAILMODE(vec3(ao), vec3(aoDetail)).r;\n#else\n    return ao;\n#endif\n}\n";
export default _default;
