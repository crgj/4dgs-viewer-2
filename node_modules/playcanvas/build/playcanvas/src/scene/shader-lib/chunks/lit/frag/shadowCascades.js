var shadowCascadesPS = `
const float maxCascades = 4.0;
mat4 cascadeShadowMat;
void getShadowCascadeMatrix(mat4 shadowMatrixPalette[4], float shadowCascadeDistances[4], float shadowCascadeCount) {
	float depth = 1.0 / gl_FragCoord.w;
	float cascadeIndex = 0.0;
	for (float i = 0.0; i < maxCascades; i++) {
		if (depth < shadowCascadeDistances[int(i)]) {
			cascadeIndex = i;
			break;
		}
	}
	cascadeIndex = min(cascadeIndex, shadowCascadeCount - 1.0);
	#ifdef GL2
		cascadeShadowMat = shadowMatrixPalette[int(cascadeIndex)];
	#else
		if (cascadeIndex == 0.0) {
			cascadeShadowMat = shadowMatrixPalette[0];
		}
		else if (cascadeIndex == 1.0) {
			cascadeShadowMat = shadowMatrixPalette[1];
		}
		else if (cascadeIndex == 2.0) {
			cascadeShadowMat = shadowMatrixPalette[2];
		}
		else {
			cascadeShadowMat = shadowMatrixPalette[3];
		}
	#endif
}
void fadeShadow(float shadowCascadeDistances[4]) {				  
	float depth = 1.0 / gl_FragCoord.w;
	if (depth > shadowCascadeDistances[int(maxCascades - 1.0)]) {
		dShadowCoord.z = -9999999.0;
	}
}
`;

export { shadowCascadesPS as default };
