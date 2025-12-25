declare const _default: "\n    localPos *= particle_vertexData2.y * emitterScale;\n    localPos += particlePos;\n\n    gl_Position = matrix_viewProjection * vec4(localPos, 1.0);\n";
export default _default;
