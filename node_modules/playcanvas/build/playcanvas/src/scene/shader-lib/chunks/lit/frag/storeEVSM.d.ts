declare const _default: "\nfloat exponent = VSM_EXPONENT;\n\ndepth = 2.0 * depth - 1.0;\ndepth =  exp(exponent * depth);\ngl_FragColor = vec4(depth, depth*depth, 1.0, 1.0);\n";
export default _default;
