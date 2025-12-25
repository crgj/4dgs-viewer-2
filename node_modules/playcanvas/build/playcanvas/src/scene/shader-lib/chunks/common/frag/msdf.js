var msdfPS = `
uniform sampler2D texture_msdfMap;
#ifdef GL_OES_standard_derivatives
#define USE_FWIDTH
#endif
#ifdef GL2
#define USE_FWIDTH
#endif
float median(float r, float g, float b) {
	return max(min(r, g), min(max(r, g), b));
}
float map (float min, float max, float v) {
	return (v - min) / (max - min);
}
uniform float font_sdfIntensity;
uniform float font_pxrange;
uniform float font_textureWidth;
#ifdef UNIFORM_TEXT_PARAMETERS
uniform vec4 outline_color;
uniform float outline_thickness;
uniform vec4 shadow_color;
uniform vec2 shadow_offset;
#else
varying vec4 outline_color;
varying float outline_thickness;
varying vec4 shadow_color;
varying vec2 shadow_offset;
#endif
vec4 applyMsdf(vec4 color) {
	vec3 tsample = texture2D(texture_msdfMap, vUv0).rgb;
	vec2 uvShdw = vUv0 - shadow_offset;
	vec3 ssample = texture2D(texture_msdfMap, uvShdw).rgb;
	float sigDist = median(tsample.r, tsample.g, tsample.b);
	float sigDistShdw = median(ssample.r, ssample.g, ssample.b);
	float smoothingMax = 0.2;
	#ifdef USE_FWIDTH
	vec2 w = fwidth(vUv0);
	float smoothing = clamp(w.x * font_textureWidth / font_pxrange, 0.0, smoothingMax);
	#else
	float font_size = 16.0;
	float smoothing = clamp(font_pxrange / font_size, 0.0, smoothingMax);
	#endif
	float mapMin = 0.05;
	float mapMax = clamp(1.0 - font_sdfIntensity, mapMin, 1.0);
	float sigDistInner = map(mapMin, mapMax, sigDist);
	float sigDistOutline = map(mapMin, mapMax, sigDist + outline_thickness);
	sigDistShdw = map(mapMin, mapMax, sigDistShdw + outline_thickness);
	float center = 0.5;
	float inside = smoothstep(center-smoothing, center+smoothing, sigDistInner);
	float outline = smoothstep(center-smoothing, center+smoothing, sigDistOutline);
	float shadow = smoothstep(center-smoothing, center+smoothing, sigDistShdw);
	vec4 tcolor = (outline > inside) ? outline * vec4(outline_color.a * outline_color.rgb, outline_color.a) : vec4(0.0);
	tcolor = mix(tcolor, color, inside);
	vec4 scolor = (shadow > outline) ? shadow * vec4(shadow_color.a * shadow_color.rgb, shadow_color.a) : tcolor;
	tcolor = mix(scolor, tcolor, outline);
	
	return tcolor;
}
`;

export { msdfPS as default };
