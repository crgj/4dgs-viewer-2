var clusteredLightPS = `
uniform highp sampler2D clusterWorldTexture;
uniform highp sampler2D lightsTexture8;
uniform highp sampler2D lightsTextureFloat;
#if defined(CLUSTER_COOKIES)
	#define CLUSTER_COOKIES_OR_SHADOWS
#endif
#if defined(CLUSTER_SHADOWS)
	#define CLUSTER_COOKIES_OR_SHADOWS
#endif
#ifdef CLUSTER_SHADOWS
	#ifdef GL2
		uniform sampler2DShadow shadowAtlasTexture;
	#else
		uniform sampler2D shadowAtlasTexture;
	#endif
#endif
#ifdef CLUSTER_COOKIES
	uniform sampler2D cookieAtlasTexture;
#endif
#ifdef GL2
	uniform int clusterMaxCells;
#else
	uniform float clusterMaxCells;
	uniform vec4 lightsTextureInvSize;
#endif
uniform float clusterSkip;
uniform vec3 clusterCellsCountByBoundsSize;
uniform vec3 clusterTextureSize;
uniform vec3 clusterBoundsMin;
uniform vec3 clusterBoundsDelta;
uniform vec3 clusterCellsDot;
uniform vec3 clusterCellsMax;
uniform vec2 clusterCompressionLimit0;
uniform vec2 shadowAtlasParams;
struct ClusterLightData {
	vec3 halfWidth;
	float lightType;
	vec3 halfHeight;
	#ifdef GL2
		int lightIndex;
	#else
		float lightV;
	#endif
	vec3 position;
	float shape;
	vec3 direction;
	float falloffMode;
	vec3 color;
	float shadowIntensity;
	vec3 omniAtlasViewport;
	float range;
	vec4 cookieChannelMask;
	float shadowBias;
	float shadowNormalBias;
	float innerConeAngleCos;
	float outerConeAngleCos;
	float cookie;
	float cookieRgb;
	float cookieIntensity;
	float mask;
};
mat4 lightProjectionMatrix;
#define isClusteredLightCastShadow(light) ( light.shadowIntensity > 0.0 )
#define isClusteredLightCookie(light) (light.cookie > 0.5 )
#define isClusteredLightCookieRgb(light) (light.cookieRgb > 0.5 )
#define isClusteredLightSpot(light) ( light.lightType > 0.5 )
#define isClusteredLightFalloffLinear(light) ( light.falloffMode < 0.5 )
#define isClusteredLightArea(light) ( light.shape > 0.1 )
#define isClusteredLightRect(light) ( light.shape < 0.3 )
#define isClusteredLightDisk(light) ( light.shape < 0.6 )
#ifdef CLUSTER_MESH_DYNAMIC_LIGHTS
	#define acceptLightMask(light) ( light.mask < 0.75)
#else
	#define acceptLightMask(light) ( light.mask > 0.25)
#endif
vec4 decodeClusterLowRange4Vec4(vec4 d0, vec4 d1, vec4 d2, vec4 d3) {
	return vec4(
		bytes2floatRange4(d0, -2.0, 2.0),
		bytes2floatRange4(d1, -2.0, 2.0),
		bytes2floatRange4(d2, -2.0, 2.0),
		bytes2floatRange4(d3, -2.0, 2.0)
	);
}
#ifdef GL2
	vec4 sampleLightsTexture8(const ClusterLightData clusterLightData, int index) {
		return texelFetch(lightsTexture8, ivec2(index, clusterLightData.lightIndex), 0);
	}
	vec4 sampleLightTextureF(const ClusterLightData clusterLightData, int index) {
		return texelFetch(lightsTextureFloat, ivec2(index, clusterLightData.lightIndex), 0);
	}
#else
	vec4 sampleLightsTexture8(const ClusterLightData clusterLightData, float index) {
		return texture2DLodEXT(lightsTexture8, vec2(index * lightsTextureInvSize.z, clusterLightData.lightV), 0.0);
	}
	vec4 sampleLightTextureF(const ClusterLightData clusterLightData, float index) {
		return texture2DLodEXT(lightsTextureFloat, vec2(index * lightsTextureInvSize.x, clusterLightData.lightV), 0.0);
	}
#endif
void decodeClusterLightCore(inout ClusterLightData clusterLightData, float lightIndex) {
	#ifdef GL2
		clusterLightData.lightIndex = int(lightIndex);
	#else
		clusterLightData.lightV = (lightIndex + 0.5) * lightsTextureInvSize.w;
	#endif
	vec4 lightInfo = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_FLAGS);
	clusterLightData.lightType = lightInfo.x;
	clusterLightData.shape = lightInfo.y;
	clusterLightData.falloffMode = lightInfo.z;
	clusterLightData.shadowIntensity = lightInfo.w;
	vec4 colorA = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_COLOR_A);
	vec4 colorB = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_COLOR_B);
	clusterLightData.color = vec3(bytes2float2(colorA.xy), bytes2float2(colorA.zw), bytes2float2(colorB.xy)) * clusterCompressionLimit0.y;
	clusterLightData.cookie = colorB.z;
	clusterLightData.mask = colorB.w;
	#ifdef CLUSTER_TEXTURE_FLOAT
		vec4 lightPosRange = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_POSITION_RANGE);
		clusterLightData.position = lightPosRange.xyz;
		clusterLightData.range = lightPosRange.w;
		vec4 lightDir_Unused = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_SPOT_DIRECTION);
		clusterLightData.direction = lightDir_Unused.xyz;
	#else
		vec4 encPosX = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_POSITION_X);
		vec4 encPosY = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_POSITION_Y);
		vec4 encPosZ = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_POSITION_Z);
		clusterLightData.position = vec3(bytes2float4(encPosX), bytes2float4(encPosY), bytes2float4(encPosZ)) * clusterBoundsDelta + clusterBoundsMin;
		vec4 encRange = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_RANGE);
		clusterLightData.range = bytes2float4(encRange) * clusterCompressionLimit0.x;
		vec4 encDirX = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_SPOT_DIRECTION_X);
		vec4 encDirY = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_SPOT_DIRECTION_Y);
		vec4 encDirZ = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_SPOT_DIRECTION_Z);
		clusterLightData.direction = vec3(bytes2float4(encDirX), bytes2float4(encDirY), bytes2float4(encDirZ)) * 2.0 - 1.0;
	#endif
}
void decodeClusterLightSpot(inout ClusterLightData clusterLightData) {
	vec4 coneAngle = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_SPOT_ANGLES);
	clusterLightData.innerConeAngleCos = bytes2float2(coneAngle.xy) * 2.0 - 1.0;
	clusterLightData.outerConeAngleCos = bytes2float2(coneAngle.zw) * 2.0 - 1.0;
}
void decodeClusterLightOmniAtlasViewport(inout ClusterLightData clusterLightData) {
	#ifdef CLUSTER_TEXTURE_FLOAT
		clusterLightData.omniAtlasViewport = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_PROJ_MAT_0).xyz;
	#else
		vec4 viewportA = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_ATLAS_VIEWPORT_A);
		vec4 viewportB = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_ATLAS_VIEWPORT_B);
		clusterLightData.omniAtlasViewport = vec3(bytes2float2(viewportA.xy), bytes2float2(viewportA.zw), bytes2float2(viewportB.xy));
	#endif
}
void decodeClusterLightAreaData(inout ClusterLightData clusterLightData) {
	#ifdef CLUSTER_TEXTURE_FLOAT
		clusterLightData.halfWidth = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_AREA_DATA_WIDTH).xyz;
		clusterLightData.halfHeight = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_AREA_DATA_HEIGHT).xyz;
	#else
		vec4 areaWidthX = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_AREA_DATA_WIDTH_X);
		vec4 areaWidthY = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_AREA_DATA_WIDTH_Y);
		vec4 areaWidthZ = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_AREA_DATA_WIDTH_Z);
		clusterLightData.halfWidth = vec3(mantissaExponent2Float(areaWidthX), mantissaExponent2Float(areaWidthY), mantissaExponent2Float(areaWidthZ));
		vec4 areaHeightX = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_AREA_DATA_HEIGHT_X);
		vec4 areaHeightY = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_AREA_DATA_HEIGHT_Y);
		vec4 areaHeightZ = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_AREA_DATA_HEIGHT_Z);
		clusterLightData.halfHeight = vec3(mantissaExponent2Float(areaHeightX), mantissaExponent2Float(areaHeightY), mantissaExponent2Float(areaHeightZ));
	#endif
}
void decodeClusterLightProjectionMatrixData(inout ClusterLightData clusterLightData) {
	
	#ifdef CLUSTER_TEXTURE_FLOAT
		vec4 m0 = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_PROJ_MAT_0);
		vec4 m1 = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_PROJ_MAT_1);
		vec4 m2 = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_PROJ_MAT_2);
		vec4 m3 = sampleLightTextureF(clusterLightData, CLUSTER_TEXTURE_F_PROJ_MAT_3);
	#else
		vec4 m00 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_00);
		vec4 m01 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_01);
		vec4 m02 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_02);
		vec4 m03 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_03);
		vec4 m0 = decodeClusterLowRange4Vec4(m00, m01, m02, m03);
		vec4 m10 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_10);
		vec4 m11 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_11);
		vec4 m12 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_12);
		vec4 m13 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_13);
		vec4 m1 = decodeClusterLowRange4Vec4(m10, m11, m12, m13);
		vec4 m20 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_20);
		vec4 m21 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_21);
		vec4 m22 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_22);
		vec4 m23 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_23);
		vec4 m2 = decodeClusterLowRange4Vec4(m20, m21, m22, m23);
		vec4 m30 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_30);
		vec4 m31 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_31);
		vec4 m32 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_32);
		vec4 m33 = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_PROJ_MAT_33);
		vec4 m3 = vec4(mantissaExponent2Float(m30), mantissaExponent2Float(m31), mantissaExponent2Float(m32), mantissaExponent2Float(m33));
	#endif
	
	lightProjectionMatrix = mat4(m0, m1, m2, m3);
}
void decodeClusterLightShadowData(inout ClusterLightData clusterLightData) {
	
	vec4 biases = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_SHADOW_BIAS);
	clusterLightData.shadowBias = bytes2floatRange2(biases.xy, -1.0, 20.0),
	clusterLightData.shadowNormalBias = bytes2float2(biases.zw);
}
void decodeClusterLightCookieData(inout ClusterLightData clusterLightData) {
	vec4 cookieA = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_COOKIE_A);
	clusterLightData.cookieIntensity = cookieA.x;
	clusterLightData.cookieRgb = cookieA.y;
	clusterLightData.cookieChannelMask = sampleLightsTexture8(clusterLightData, CLUSTER_TEXTURE_8_COOKIE_B);
}
void evaluateLight(
	ClusterLightData light, 
	vec3 worldNormal, 
	vec3 viewDir, 
	vec3 reflectionDir,
#if defined(LIT_CLEARCOAT)
	vec3 clearcoatReflectionDir,
#endif
	float gloss, 
	vec3 specularity, 
	vec3 geometricNormal, 
	mat3 tbn, 
#if defined(LIT_IRIDESCENCE)
	vec3 iridescenceFresnel,
#endif
	vec3 clearcoat_worldNormal,
	float clearcoat_gloss,
	float sheen_gloss,
	float iridescence_intensity
) {
	vec3 cookieAttenuation = vec3(1.0);
	float diffuseAttenuation = 1.0;
	float falloffAttenuation = 1.0;
	getLightDirPoint(light.position);
	#ifdef CLUSTER_AREALIGHTS
	if (isClusteredLightArea(light)) {
		decodeClusterLightAreaData(light);
		if (isClusteredLightRect(light)) {
			calcRectLightValues(light.position, light.halfWidth, light.halfHeight);
		} else if (isClusteredLightDisk(light)) {
			calcDiskLightValues(light.position, light.halfWidth, light.halfHeight);
		} else {
			calcSphereLightValues(light.position, light.halfWidth, light.halfHeight);
		}
		falloffAttenuation = getFalloffWindow(light.range, dLightDirW);
	} else
	#endif
	{
		if (isClusteredLightFalloffLinear(light))
			falloffAttenuation = getFalloffLinear(light.range, dLightDirW);
		else
			falloffAttenuation = getFalloffInvSquared(light.range, dLightDirW);
	}
	if (falloffAttenuation > 0.00001) {
		#ifdef CLUSTER_AREALIGHTS
		if (isClusteredLightArea(light)) {
			if (isClusteredLightRect(light)) {
				diffuseAttenuation = getRectLightDiffuse(worldNormal, viewDir, dLightDirW, dLightDirNormW) * 16.0;
			} else if (isClusteredLightDisk(light)) {
				diffuseAttenuation = getDiskLightDiffuse(worldNormal, viewDir, dLightDirW, dLightDirNormW) * 16.0;
			} else {
				diffuseAttenuation = getSphereLightDiffuse(worldNormal, viewDir, dLightDirW, dLightDirNormW) * 16.0;
			}
		} else
		#endif
		{
			falloffAttenuation *= getLightDiffuse(worldNormal, viewDir, dLightDirW, dLightDirNormW); 
		}
		if (isClusteredLightSpot(light)) {
			decodeClusterLightSpot(light);
			falloffAttenuation *= getSpotEffect(light.direction, light.innerConeAngleCos, light.outerConeAngleCos, dLightDirNormW);
		}
		#if defined(CLUSTER_COOKIES_OR_SHADOWS)
		if (falloffAttenuation > 0.00001) {
			if (isClusteredLightCastShadow(light) || isClusteredLightCookie(light)) {
				if (isClusteredLightSpot(light)) {
					decodeClusterLightProjectionMatrixData(light);
				} else {
					decodeClusterLightOmniAtlasViewport(light);
				}
				float shadowTextureResolution = shadowAtlasParams.x;
				float shadowEdgePixels = shadowAtlasParams.y;
				#ifdef CLUSTER_COOKIES
				if (isClusteredLightCookie(light)) {
					decodeClusterLightCookieData(light);
					if (isClusteredLightSpot(light)) {
						cookieAttenuation = getCookie2DClustered(TEXTURE_PASS(cookieAtlasTexture), lightProjectionMatrix, vPositionW, light.cookieIntensity, isClusteredLightCookieRgb(light), light.cookieChannelMask);
					} else {
						cookieAttenuation = getCookieCubeClustered(TEXTURE_PASS(cookieAtlasTexture), dLightDirW, light.cookieIntensity, isClusteredLightCookieRgb(light), light.cookieChannelMask, shadowTextureResolution, shadowEdgePixels, light.omniAtlasViewport);
					}
				}
				#endif
				#ifdef CLUSTER_SHADOWS
				if (isClusteredLightCastShadow(light)) {
					decodeClusterLightShadowData(light);
					vec4 shadowParams = vec4(shadowTextureResolution, light.shadowNormalBias, light.shadowBias, 1.0 / light.range);
					if (isClusteredLightSpot(light)) {
						getShadowCoordPerspZbufferNormalOffset(lightProjectionMatrix, shadowParams, geometricNormal);
						
						#if defined(CLUSTER_SHADOW_TYPE_PCF1)
							float shadow = getShadowSpotClusteredPCF1(SHADOWMAP_PASS(shadowAtlasTexture), dShadowCoord, shadowParams);
						#elif defined(CLUSTER_SHADOW_TYPE_PCF3)
							float shadow = getShadowSpotClusteredPCF3(SHADOWMAP_PASS(shadowAtlasTexture), dShadowCoord, shadowParams);
						#elif defined(CLUSTER_SHADOW_TYPE_PCF5)
							float shadow = getShadowSpotClusteredPCF5(SHADOWMAP_PASS(shadowAtlasTexture), dShadowCoord, shadowParams);
						#elif defined(CLUSTER_SHADOW_TYPE_PCSS)
							float shadow = getShadowSpotClusteredPCSS(SHADOWMAP_PASS(shadowAtlasTexture), dShadowCoord, shadowParams);
						#endif
						falloffAttenuation *= mix(1.0, shadow, light.shadowIntensity);
					} else {
						vec3 dir = normalOffsetPointShadow(shadowParams, dLightPosW, dLightDirW, dLightDirNormW, geometricNormal);
						#if defined(CLUSTER_SHADOW_TYPE_PCF1)
							float shadow = getShadowOmniClusteredPCF1(SHADOWMAP_PASS(shadowAtlasTexture), shadowParams, light.omniAtlasViewport, shadowEdgePixels, dir);
						#elif defined(CLUSTER_SHADOW_TYPE_PCF3)
							float shadow = getShadowOmniClusteredPCF3(SHADOWMAP_PASS(shadowAtlasTexture), shadowParams, light.omniAtlasViewport, shadowEdgePixels, dir);
						#elif defined(CLUSTER_SHADOW_TYPE_PCF5)
							float shadow = getShadowOmniClusteredPCF5(SHADOWMAP_PASS(shadowAtlasTexture), shadowParams, light.omniAtlasViewport, shadowEdgePixels, dir);
						#endif
						falloffAttenuation *= mix(1.0, shadow, light.shadowIntensity);
					}
				}
				#endif
			}
		}
		#endif
		#ifdef CLUSTER_AREALIGHTS
		if (isClusteredLightArea(light)) {
			{
				vec3 areaDiffuse = (diffuseAttenuation * falloffAttenuation) * light.color * cookieAttenuation;
				#if defined(LIT_SPECULAR)
					#if defined(LIT_CONSERVE_ENERGY)
						areaDiffuse = mix(areaDiffuse, vec3(0), dLTCSpecFres);
					#endif
				#endif
				dDiffuseLight += areaDiffuse;
			}
			#ifdef LIT_SPECULAR
				float areaLightSpecular;
				if (isClusteredLightRect(light)) {
					areaLightSpecular = getRectLightSpecular(worldNormal, viewDir);
				} else if (isClusteredLightDisk(light)) {
					areaLightSpecular = getDiskLightSpecular(worldNormal, viewDir);
				} else {
					areaLightSpecular = getSphereLightSpecular(worldNormal, viewDir);
				}
				dSpecularLight += dLTCSpecFres * areaLightSpecular * falloffAttenuation * light.color * cookieAttenuation;
				#ifdef LIT_CLEARCOAT
					float areaLightSpecularCC;
					if (isClusteredLightRect(light)) {
						areaLightSpecularCC = getRectLightSpecular(clearcoat_worldNormal, viewDir);
					} else if (isClusteredLightDisk(light)) {
						areaLightSpecularCC = getDiskLightSpecular(clearcoat_worldNormal, viewDir);
					} else {
						areaLightSpecularCC = getSphereLightSpecular(clearcoat_worldNormal, viewDir);
					}
					ccSpecularLight += ccLTCSpecFres * areaLightSpecularCC * falloffAttenuation * light.color  * cookieAttenuation;
				#endif
			#endif
		} else
		#endif
		{
			{
				vec3 punctualDiffuse = falloffAttenuation * light.color * cookieAttenuation;
				#if defined(CLUSTER_AREALIGHTS)
				#if defined(LIT_SPECULAR)
				#if defined(LIT_CONSERVE_ENERGY)
					punctualDiffuse = mix(punctualDiffuse, vec3(0), specularity);
				#endif
				#endif
				#endif
				dDiffuseLight += punctualDiffuse;
			}
	 
			#ifdef LIT_SPECULAR
				vec3 halfDir = normalize(-dLightDirNormW + viewDir);
				
				#ifdef LIT_SPECULAR_FRESNEL
					dSpecularLight += 
						getLightSpecular(halfDir, reflectionDir, worldNormal, viewDir, dLightDirNormW, gloss, tbn) * falloffAttenuation * light.color * cookieAttenuation * 
						getFresnel(
							dot(viewDir, halfDir), 
							gloss, 
							specularity
						#if defined(LIT_IRIDESCENCE)
							, iridescenceFresnel,
							iridescence_intensity
						#endif
							);
				#else
					dSpecularLight += getLightSpecular(halfDir, reflectionDir, worldNormal, viewDir, dLightDirNormW, gloss, tbn) * falloffAttenuation * light.color * cookieAttenuation * specularity;
				#endif
				#ifdef LIT_CLEARCOAT
					#ifdef LIT_SPECULAR_FRESNEL
						ccSpecularLight += getLightSpecular(halfDir, clearcoatReflectionDir, clearcoat_worldNormal, viewDir, dLightDirNormW, clearcoat_gloss, tbn) * falloffAttenuation * light.color * cookieAttenuation * getFresnelCC(dot(viewDir, halfDir));
					#else
						ccSpecularLight += getLightSpecular(halfDir, clearcoatReflectionDir, clearcoat_worldNormal, viewDir, dLightDirNormW, clearcoat_gloss, tbn) * falloffAttenuation * light.color * cookieAttenuation; 
					#endif
				#endif
				#ifdef LIT_SHEEN
					sSpecularLight += getLightSpecularSheen(halfDir, worldNormal, viewDir, dLightDirNormW, sheen_gloss) * falloffAttenuation * light.color * cookieAttenuation;
				#endif
			#endif
		}
	}
	dAtten = falloffAttenuation;
	dAttenD = diffuseAttenuation;
	dAtten3 = cookieAttenuation;
}
void evaluateClusterLight(
	float lightIndex, 
	vec3 worldNormal, 
	vec3 viewDir, 
	vec3 reflectionDir, 
#if defined(LIT_CLEARCOAT)
	vec3 clearcoatReflectionDir,
#endif
	float gloss, 
	vec3 specularity, 
	vec3 geometricNormal, 
	mat3 tbn, 
#if defined(LIT_IRIDESCENCE)
	vec3 iridescenceFresnel,
#endif
	vec3 clearcoat_worldNormal,
	float clearcoat_gloss,
	float sheen_gloss,
	float iridescence_intensity
) {
	ClusterLightData clusterLightData;
	decodeClusterLightCore(clusterLightData, lightIndex);
	if (acceptLightMask(clusterLightData))
		evaluateLight(
			clusterLightData, 
			worldNormal, 
			viewDir, 
			reflectionDir, 
#if defined(LIT_CLEARCOAT)
			clearcoatReflectionDir, 
#endif
			gloss, 
			specularity, 
			geometricNormal, 
			tbn, 
#if defined(LIT_IRIDESCENCE)
			iridescenceFresnel,
#endif
			clearcoat_worldNormal,
			clearcoat_gloss,
			sheen_gloss,
			iridescence_intensity
		);
}
void addClusteredLights(
	vec3 worldNormal, 
	vec3 viewDir, 
	vec3 reflectionDir, 
#if defined(LIT_CLEARCOAT)
	vec3 clearcoatReflectionDir,
#endif
	float gloss, 
	vec3 specularity, 
	vec3 geometricNormal, 
	mat3 tbn, 
#if defined(LIT_IRIDESCENCE)
	vec3 iridescenceFresnel,
#endif
	vec3 clearcoat_worldNormal,
	float clearcoat_gloss,
	float sheen_gloss,
	float iridescence_intensity
) {
	if (clusterSkip > 0.5)
		return;
	vec3 cellCoords = floor((vPositionW - clusterBoundsMin) * clusterCellsCountByBoundsSize);
	if (!(any(lessThan(cellCoords, vec3(0.0))) || any(greaterThanEqual(cellCoords, clusterCellsMax)))) {
		float cellIndex = dot(clusterCellsDot, cellCoords);
		float clusterV = floor(cellIndex * clusterTextureSize.y);
		float clusterU = cellIndex - (clusterV * clusterTextureSize.x);
		#ifdef GL2
			for (int lightCellIndex = 0; lightCellIndex < clusterMaxCells; lightCellIndex++) {
				float lightIndex = texelFetch(clusterWorldTexture, ivec2(int(clusterU) + lightCellIndex, clusterV), 0).x;
				if (lightIndex <= 0.0)
						return;
				evaluateClusterLight(
					lightIndex * 255.0, 
					worldNormal, 
					viewDir, 
					reflectionDir,
#if defined(LIT_CLEARCOAT)
					clearcoatReflectionDir,
#endif
					gloss, 
					specularity, 
					geometricNormal, 
					tbn, 
#if defined(LIT_IRIDESCENCE)
					iridescenceFresnel,
#endif
					clearcoat_worldNormal,
					clearcoat_gloss,
					sheen_gloss,
					iridescence_intensity
				); 
			}
		#else
			clusterV = (clusterV + 0.5) * clusterTextureSize.z;
			const float maxLightCells = 256.0;
			for (float lightCellIndex = 0.5; lightCellIndex < maxLightCells; lightCellIndex++) {
				float lightIndex = texture2DLodEXT(clusterWorldTexture, vec2(clusterTextureSize.y * (clusterU + lightCellIndex), clusterV), 0.0).x;
				if (lightIndex <= 0.0)
					return;
				
				evaluateClusterLight(
					lightIndex * 255.0, 
					worldNormal, 
					viewDir, 
					reflectionDir,
#if defined(LIT_CLEARCOAT)
					clearcoatReflectionDir,
#endif
					gloss, 
					specularity, 
					geometricNormal, 
					tbn, 
#if defined(LIT_IRIDESCENCE)
					iridescenceFresnel,
#endif
					clearcoat_worldNormal,
					clearcoat_gloss,
					sheen_gloss,
					iridescence_intensity
				); 
				if (lightCellIndex >= clusterMaxCells) {
					break;
				}
			}
		#endif
	}
}
`;

export { clusteredLightPS as default };
