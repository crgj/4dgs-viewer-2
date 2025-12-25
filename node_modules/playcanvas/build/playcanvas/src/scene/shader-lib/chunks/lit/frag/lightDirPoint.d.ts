declare const _default: "\nvoid getLightDirPoint(vec3 lightPosW) {\n    dLightDirW = vPositionW - lightPosW;\n    dLightDirNormW = normalize(dLightDirW);\n    dLightPosW = lightPosW;\n}\n";
export default _default;
