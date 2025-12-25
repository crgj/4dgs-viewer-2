declare const _default: "\n#ifndef VIEWMATRIX\n#define VIEWMATRIX\nuniform mat4 matrix_view;\n#endif\n\nvec3 getViewNormal() {\n    return mat3(matrix_view) * vNormalW;\n}\n";
export default _default;
