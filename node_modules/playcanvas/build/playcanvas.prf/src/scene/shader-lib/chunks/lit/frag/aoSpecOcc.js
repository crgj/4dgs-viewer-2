var aoSpecOccPS = `
uniform float material_occludeSpecularIntensity;
void occludeSpecular(float gloss, float ao, vec3 worldNormal, vec3 viewDir) {
	float specPow = exp2(gloss * 11.0);
	float specOcc = saturate(pow(dot(worldNormal, viewDir) + ao, 0.01*specPow) - 1.0 + ao);
	specOcc = mix(1.0, specOcc, material_occludeSpecularIntensity);
	dSpecularLight *= specOcc;
	dReflection *= specOcc;
	
#ifdef LIT_SHEEN
	sSpecularLight *= specOcc;
	sReflection *= specOcc;
#endif
}
`;

export { aoSpecOccPS as default };
