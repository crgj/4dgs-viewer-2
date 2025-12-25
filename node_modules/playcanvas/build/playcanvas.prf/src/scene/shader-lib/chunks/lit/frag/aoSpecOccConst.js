var aoSpecOccConstPS = `
void occludeSpecular(float gloss, float ao, vec3 worldNormal, vec3 viewDir) {
	float specPow = exp2(gloss * 11.0);
	float specOcc = saturate(pow(dot(worldNormal, viewDir) + ao, 0.01*specPow) - 1.0 + ao);
	dSpecularLight *= specOcc;
	dReflection *= specOcc;
	
#ifdef LIT_SHEEN
	sSpecularLight *= specOcc;
	sReflection *= specOcc;
#endif
}
`;

export { aoSpecOccConstPS as default };
