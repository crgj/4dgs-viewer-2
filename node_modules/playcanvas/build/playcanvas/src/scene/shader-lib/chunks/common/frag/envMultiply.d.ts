declare const _default: "\nuniform float skyboxIntensity;\n\nvec3 processEnvironment(vec3 color) {\n    return color * skyboxIntensity;\n}\n";
export default _default;
