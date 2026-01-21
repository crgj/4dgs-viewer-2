
// --- Helper Functions & Core Logic (GLSL 300 ES) ---
// verbatim from PlayCanvas 'splatCoreVS' but upgraded to 'in/out'

export const splatCoreVS = `
    uniform mat4 matrix_model;
    uniform mat4 matrix_view;
    uniform mat4 matrix_projection;
    uniform vec2 viewport;
    uniform vec4 tex_params;
    uniform highp usampler2D splatOrder;
    uniform highp usampler2D transformA;
    uniform highp sampler2D transformB;
    
    in vec3 vertex_position;
    in uint vertex_id_attrib;
    
    #ifndef DITHER_NONE
        out float id;
    #endif

    uint orderId;
    uint splatId;
    ivec2 splatUV;

    bool calcSplatUV() {
        uint numSplats = uint(tex_params.x);
        uint textureWidth = uint(tex_params.y);
        orderId = vertex_id_attrib + uint(vertex_position.z);
        if (orderId >= numSplats) {
            return false;
        }
        ivec2 orderUV = ivec2(
            int(orderId % textureWidth),
            int(orderId / textureWidth)
        );
        splatId = texelFetch(splatOrder, orderUV, 0).r;
        splatUV = ivec2(
            int(splatId % textureWidth),
            int(splatId / textureWidth)
        );
        return true;
    }

    uvec4 tA;
    vec3 getCenter() {
        tA = texelFetch(transformA, splatUV, 0);
        return uintBitsToFloat(tA.xyz);
    }

    void getCovariance(out vec3 covA, out vec3 covB) {
        vec4 tB = texelFetch(transformB, splatUV, 0);
        vec2 tC = unpackHalf2x16(tA.w);
        covA = tB.xyz;
        covB = vec3(tC.x, tC.y, tB.w);
    }

    vec4 calcV1V2(in vec3 splat_cam, in vec3 covA, in vec3 covB, mat3 W) {
        mat3 Vrk = mat3(
            covA.x, covA.y, covA.z, 
            covA.y, covB.x, covB.y,
            covA.z, covB.y, covB.z
        );
        float focal = viewport.x * matrix_projection[0][0];
        float J1 = focal / splat_cam.z;
        vec2 J2 = -J1 / splat_cam.z * splat_cam.xy;
        mat3 J = mat3(
            J1, 0.0, J2.x, 
            0.0, J1, J2.y, 
            0.0, 0.0, 0.0
        );
        mat3 T = W * J;
        mat3 cov = transpose(T) * Vrk * T;
        float diagonal1 = cov[0][0] + 0.3;
        float offDiagonal = cov[0][1];
        float diagonal2 = cov[1][1] + 0.3;
        float mid = 0.5 * (diagonal1 + diagonal2);
        float radius = length(vec2((diagonal1 - diagonal2) / 2.0, offDiagonal));
        float lambda1 = mid + radius;
        float lambda2 = max(mid - radius, 0.1);
        vec2 diagonalVector = normalize(vec2(offDiagonal, lambda1 - diagonal1));
        vec2 v1 = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
        vec2 v2 = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);
        return vec4(v1, v2);
    }

    vec3 unpack111011(uint bits) {
        return vec3(
            float(bits >> 21u) / 2047.0,
            float((bits >> 11u) & 0x3ffu) / 1023.0,
            float(bits & 0x7ffu) / 2047.0
        );
    }

    void fetchScale(in uvec4 t, out float scale, out vec3 a, out vec3 b, out vec3 c) {
        scale = uintBitsToFloat(t.x);
        a = unpack111011(t.y) * 2.0 - 1.0;
        b = unpack111011(t.z) * 2.0 - 1.0;
        c = unpack111011(t.w) * 2.0 - 1.0;
    }

    void fetch(in uvec4 t, out vec3 a, out vec3 b, out vec3 c, out vec3 d) {
        a = unpack111011(t.x) * 2.0 - 1.0;
        b = unpack111011(t.y) * 2.0 - 1.0;
        c = unpack111011(t.z) * 2.0 - 1.0;
        d = unpack111011(t.w) * 2.0 - 1.0;
    }

    #if defined(USE_SH1)
        #define SH_C1 0.4886025119029199f
        uniform highp usampler2D splatSH_1to3;
        #if defined(USE_SH2)
            #define SH_C2_0 1.0925484305920792f
            #define SH_C2_1 -1.0925484305920792f
            #define SH_C2_2 0.31539156525252005f
            #define SH_C2_3 -1.0925484305920792f
            #define SH_C2_4 0.5462742152960396f
            uniform highp usampler2D splatSH_4to7;
            uniform highp usampler2D splatSH_8to11;
            #if defined(USE_SH3)
                #define SH_C3_0 -0.5900435899266435f
                #define SH_C3_1 2.890611442640554f
                #define SH_C3_2 -0.4570457994644658f
                #define SH_C3_3 0.3731763325901154f
                #define SH_C3_4 -0.4570457994644658f
                #define SH_C3_5 1.445305721320277f
                #define SH_C3_6 -0.5900435899266435f
                uniform highp usampler2D splatSH_12to15;
            #endif
        #endif
    #endif

    vec3 evalSH(in vec3 dir) {
        vec3 result = vec3(0.0);
        #if defined(USE_SH1)
            float x = dir.x;
            float y = dir.y;
            float z = dir.z;
            float scale;
            vec3 sh1, sh2, sh3;
            fetchScale(texelFetch(splatSH_1to3, splatUV, 0), scale, sh1, sh2, sh3);
            result += SH_C1 * (-sh1 * y + sh2 * z - sh3 * x);
            #if defined(USE_SH2)
                float xx = x * x;
                float yy = y * y;
                float zz = z * z;
                float xy = x * y;
                float yz = y * z;
                float xz = x * z;
                vec3 sh4, sh5, sh6, sh7;
                vec3 sh8, sh9, sh10, sh11;
                fetch(texelFetch(splatSH_4to7, splatUV, 0), sh4, sh5, sh6, sh7);
                fetch(texelFetch(splatSH_8to11, splatUV, 0), sh8, sh9, sh10, sh11);
                result +=
                    sh4 * (SH_C2_0 * xy) + // Fixed Syntax Error Here
                    sh5 * (SH_C2_1 * yz) +
                    sh6 * (SH_C2_2 * (2.0 * zz - xx - yy)) +
                    sh7 * (SH_C2_3 * xz) +
                    sh8 * (SH_C2_4 * (xx - yy));
                #if defined(USE_SH3)
                    vec3 sh12, sh13, sh14, sh15;
                    fetch(texelFetch(splatSH_12to15, splatUV, 0), sh12, sh13, sh14, sh15);
                    result +=
                        sh9  * (SH_C3_0 * y * (3.0 * xx - yy)) +
                        sh10 * (SH_C3_1 * xy * z) +
                        sh11 * (SH_C3_2 * y * (4.0 * zz - xx - yy)) +
                        sh12 * (SH_C3_3 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy)) +
                        sh13 * (SH_C3_4 * x * (4.0 * zz - xx - yy)) +
                        sh14 * (SH_C3_5 * z * (xx - yy)) +
                        sh15 * (SH_C3_6 * x * (xx - 3.0 * yy));
                #endif
            #endif
            result *= scale;
        #endif
        return result;
    }
`;

// --- Reference Core FS logic integrated into Main PS ---

// --- Main Vertex Shader ---
// Matches PlayCanvas 'splatMainVS' EXACTLY (plus GLSL300ES port)

export const splatMainVS = `
    uniform vec3 view_position;
    uniform sampler2D splatColor;
    
    out mediump vec2 texCoord;
    out mediump vec4 color;
    
    mediump vec4 discardVec = vec4(0.0, 0.0, 2.0, 1.0);

    // Custom Lifetime Uniforms
    uniform sampler2D lifetimeTexture;
    uniform sampler2D selectionTexture;
    uniform float isSelectionMode; // 1.0 if selecting, 0.0 otherwise

    uniform float uTime;
    uniform float uGlobalTotalFrames; // #WDD 2026-01-16

    // Trajectory Data
    #ifdef USE_TRAJECTORY
        uniform sampler2D uTrajectoryTexture;
        uniform float uKeyframes;
        uniform float uXYZStride; // #WDD 2026-01-15
    #endif

    // Rotation & Scale Logic Declarations
    #ifdef USE_ROTATION
        uniform sampler2D uRotationTexture;
        uniform sampler2D uScalesTexture;
        uniform float uRotKeyframes;
        uniform float uRotStride; // #WDD 2026-01-15

        // Simple NLERP for quaternions
        vec4 nlerp(vec4 a, vec4 b, float t) {
            if (dot(a, b) < 0.0) b = -b; // Shortest path
            return normalize(mix(a, b, t));
        }

        mat3 quatToMat3(vec4 q) {
            float x = q.x, y = q.y, z = q.z, w = q.w;
            float x2 = x + x, y2 = y + y, z2 = z + z;
            float xx = x * x2, xy = x * y2, xz = x * z2;
            float yy = y * y2, yz = y * z2, zz = z * z2;
            float wx = w * x2, wy = w * y2, wz = w * z2;
            return mat3(
                1.0 - (yy + zz), xy + wz, xz - wy,
                xy - wz, 1.0 - (xx + zz), yz + wx,
                xz + wy, yz - wx, 1.0 - (xx + yy)
            );
        }
    #endif

    // Transition Effect #WDD 2026-01-15
    uniform float uTransitionFactor;
    uniform float uRotationFactor; // Raw progress 0->1 #WDD 2026-01-15
    uniform float uSwizzleMode; // #WDD 2026-01-15 0=yzwx (def), 1=xyzw, 2=wyzx

    // Pseudo-random helper
    float fract_sin(float val) {
        return fract(sin(val) * 43758.5453123);
    }

    // Calculate 4D Opacity Scaling (Sigmoid-based window)
    float getLifetimeOpacityTexture(uint id, float t) {
        #ifdef USE_LIFETIME_TEXTURE
            // Robust Indexing #WDD 2026-01-16
            int lWidth = textureSize(lifetimeTexture, 0).x;
            ivec2 lUV = ivec2(int(id % uint(lWidth)), int(id / uint(lWidth)));
            vec4 val = texelFetch(lifetimeTexture, lUV, 0);
            
            // Mu and W are now RAW frame values (no scaling needed) #WDD 2026-01-16
            float mu = val.r;
            float w = val.g;     
            float k = val.b;

            float argLeft = k * (t - (mu - w));
            float left = 1.0 / (1.0 + exp(-argLeft));

            float argRight = -k * (t - (mu + w));
            float right = 1.0 / (1.0 + exp(-argRight));
            
            float visibility = left * right;

            // #WDD 2026-01-16: HARD CUTOFF
            if (t < (mu - w) || t > (mu + w)) {
                visibility = 0.0;
            }

            return visibility;
             
        #else
            return 1.0;
        #endif
    }
    
    void main(void)
    {
        bool debugLifetime = false; 
        if (!calcSplatUV()) {
            gl_Position = discardVec;
            return;
        }
        
        vec3 center = getCenter();

        // --- Trajectory Logic ---
        #ifdef USE_TRAJECTORY
            // #WDD 2026-01-15 Stride-based logic matching post_save.py / main.ts verification
            // 逻辑检查: 
            // - uTime 是当前帧索引 (float)
            // - uXYZStride 是关键帧采样间隔 (例如 5)
            // - idx 是当前时间对应的左侧关键帧索引 (0, 1, 2...)
            int idx = int(floor(uTime / uXYZStride));
            
            // 边界检查: 确保不会读取超过纹理范围的关键帧
            if (idx >= int(uKeyframes) - 1) idx = int(uKeyframes) - 2;

            float t0 = float(idx) * uXYZStride;
            float t1 = float(idx + 1) * uXYZStride;

            int k0 = idx;
            int k1 = idx + 1;
            
            // 插值系数 t: 在两个关键帧之间的时间比例 (0.0 -> 1.0)
            float t = clamp((uTime - t0) / (t1 - t0), 0.0, 1.0);

            int width = textureSize(uTrajectoryTexture, 0).x;
            uint baseIdx = splatId * uint(uKeyframes);
            
            uint idx0 = baseIdx + uint(k0);
            ivec2 uv0 = ivec2(idx0 % uint(width), idx0 / uint(width));
            vec3 p0 = texelFetch(uTrajectoryTexture, uv0, 0).rgb;

            uint idx1 = baseIdx + uint(k1);
            ivec2 uv1 = ivec2(idx1 % uint(width), idx1 / uint(width));
            vec3 p1 = texelFetch(uTrajectoryTexture, uv1, 0).rgb;

            center = mix(p0, p1, t);
        #endif

        // --- Rotation & Scale Logic (Dynamic Covariance) ---

        // Covariance Variables
        vec3 covA, covB;

        #ifdef USE_ROTATION
            // 1. Interpolate Rotation (Stride-based)
            int rIdx = int(floor(uTime / uRotStride));
            if (rIdx >= int(uRotKeyframes) - 1) rIdx = int(uRotKeyframes) - 2;

            float rt0 = float(rIdx) * uRotStride;
            float rt1 = float(rIdx + 1) * uRotStride;

            int rk0 = rIdx;
            int rk1 = rIdx + 1;
            float rt = clamp((uTime - rt0) / (rt1 - rt0), 0.0, 1.0);

            int rWidth = textureSize(uRotationTexture, 0).x;
            uint rBaseIdx = splatId * uint(uRotKeyframes);
            
            ivec2 ruv0 = ivec2((rBaseIdx + uint(rk0)) % uint(rWidth), (rBaseIdx + uint(rk0)) / uint(rWidth));
            vec4 rq0 = texelFetch(uRotationTexture, ruv0, 0);

            ivec2 ruv1 = ivec2((rBaseIdx + uint(rk1)) % uint(rWidth), (rBaseIdx + uint(rk1)) / uint(rWidth));
            vec4 rq1 = texelFetch(uRotationTexture, ruv1, 0);

            vec4 finalRot = nlerp(rq0, rq1, rt);

            // 2. Fetch Scale (Static)
            // SplatID -> UV for Static textures
            int sWidth = textureSize(uScalesTexture, 0).x;
            ivec2 sUV = ivec2(splatId % uint(sWidth), splatId / uint(sWidth));
            vec3 scales = exp(texelFetch(uScalesTexture, sUV, 0).rgb); // Apply exp() for log-scale

            // 3. Compute Covariance Matrix M = R * S
            // Texture is likely WXYZ, but comp is XYZW. Swizzle if needed.
            // Standard 3DGS is WXYZ. 
            // Our nlerp returns a mfinalScaleix.
            // quatToMat3 expects x,y,z,w in that variable naming.
            
            vec4 q;
            if (uSwizzleMode > 1.5) {
                // Mode 2: Inverted order or testing ZYXW? 
                // Let's try identity for now as Mode 1, Mode 2 as .xyzw (dup).
                // Actually let's assume Mode 1 is NO SWIZZLE (XYZW input)
                // Mode 0 is current default (WXYZ input -> swizzle to XYZW)
                
                // Let's add Mode 2 as .wxyz (if data is YZWX?) random guess
                q = finalRot.wxyz;
            } else if (uSwizzleMode > 0.5) {
                // Mode 1: No Swizzle (Data is already XYZW)
                q = finalRot; 
            } else {
                // Mode 0: Also Identity (Data is already XYZW from loader)
                // Previously assumed WXYZ input -> .yzwx, but loader now reorders to XYZW.
                q = finalRot; 
            }
            
            mat3 R = quatToMat3(q);
            mat3 M = R * mat3(
                scales.x, 0.0, 0.0,
                0.0, scales.y, 0.0,
                0.0, 0.0, scales.z
            );
            mat3 Sigma = M * transpose(M); // M * Mt

            // 4. Extract covA, covB for calcV1V2
            // Sigma is symmetric: 
            // [0][0] [0][1] [0][2]
            // [1][0] [1][1] [1][2]
            // [2][0] [2][1] [2][2]
            // covA = (00, 01, 02)
            // covB = (11, 12, 22)  <-- wait, calcV1V2 expects specific packing
            
            // Re-checking calcV1V2:
            // mat3 Vrk = mat3(covA.x, covA.y, covA.z,  covA.y, covB.x, covB.y,  covA.z, covB.y, covB.z)
            // So:
            // covA.x = Sigma[0][0]
            // covA.y = Sigma[0][1]
            // covA.z = Sigma[0][2]
            // covB.x = Sigma[1][1]
            // covB.y = Sigma[1][2]
            // covB.z = Sigma[2][2]
            
            covA = vec3(Sigma[0][0], Sigma[0][1], Sigma[0][2]);
            covB = vec3(Sigma[1][1], Sigma[1][2], Sigma[2][2]);
        #else
            // Fallback to static covariance
            getCovariance(covA, covB);
        #endif

        // --- Transition Snowflake Effect #WDD 2026-01-15 ---
        float visualFactor = pow(uTransitionFactor, 0.3); 
        float effectScale = 1.0;
        bool isSnowflake = false;
        
        if (uTransitionFactor > 0.0) {
            isSnowflake = true;
            float seed = float(splatId);
            
            // --- EXTREME RANDOMNESS PHYSICS #WDD 2026-01-15 ---
            
            // 1. Randomized Timing & Progress Curve per Splat
            // Power curve for initial pop, no pMultiplier to avoid "staying at max distance" #WDD 2026-01-15 
            float individualFactor = pow(uTransitionFactor, 0.6); 

            // 2. Randomized 3D Burst Directions
            vec3 burstDir = normalize(vec3(
                fract_sin(seed * 1.618) * 2.0 - 1.0,
                fract_sin(seed * 9.123) * 2.0 - 1.0,
                fract_sin(seed * 3.141) * 2.0 - 1.0
            ));

            // 3. 3D Explosive Scatter Distance - HALVED AGAIN #WDD 2026-01-15 
            float randomDist = (0.5 + fract_sin(seed * 6.78) * 1.25) * individualFactor;
            
            // Initial position is now a combination of burst and jitter
            vec3 scatteredPos = center + burstDir * randomDist;

            // 4. Tornado Rotation around Y-axis
            // Speed variance for chaotic interaction - HALVED TURNS #WDD 2026-01-15 
            float speedMult = 1.0 + fract_sin(seed * 7.89) * 2.5; 
            float randomOffset = fract_sin(seed * 4.56) * 6.28;
            float angle = 3.14159265 * uRotationFactor * speedMult + randomOffset;
            
            float cosA = cos(angle);
            float sinA = sin(angle);
            
            // Orbiting with an additional chaotic wobble
            vec2 offset = scatteredPos.xz - center.xz;
            vec2 rotatedOffset = vec2(
                offset.x * cosA - offset.y * sinA,
                offset.x * sinA + offset.y * cosA
            );
            
            // Final position with chaotic Y-axis drift
            vec3 rotatedPos = vec3(center.x + rotatedOffset.x, scatteredPos.y, center.z + rotatedOffset.y);

            // 5. Wind turbulence (Horizontal only)
            float jitterFreq = 22.0; 
            vec2 jitter = vec2(
                sin(uTime * jitterFreq + seed * 1.3),
                cos(uTime * jitterFreq * 0.8 + seed * 2.1)
            ) * 0.12; 

            center = rotatedPos + vec3(jitter.x, 0.0, jitter.y) * individualFactor; 

            // Aesthetic: Volume stays high
            effectScale = max(0.7, 1.0 - visualFactor * 0.3); 
        }

        mat4 model_view = matrix_view * matrix_model;
        vec4 splat_cam = model_view * vec4(center, 1.0);
        
        if (splat_cam.z > 0.0) {
            gl_Position = discardVec;
            return;
        }
        
        vec4 splat_proj = matrix_projection * splat_cam;
        splat_proj.z = clamp(splat_proj.z, -abs(splat_proj.w), abs(splat_proj.w));
        
        // Base Color Fetch moved early for scale calc #WDD 2026-01-15
        vec4 baseColor = texelFetch(splatColor, splatUV, 0);

        // --- Lifetime Calculation & Early Discard ---
        float alphaMult = getLifetimeOpacityTexture(splatId, uTime); // Passing splatId instead of UV
        float activeAlpha = baseColor.a * alphaMult;

        // #WDD 2026-01-17 Debug: Combined Highlights
        bool forcedVisible = false;



        // #WDD 2026-01-15 Early Discard (Modified)
        float uAlphaDiscard = 0.01; 
        if (!debugLifetime && !forcedVisible && activeAlpha < uAlphaDiscard) {
             gl_Position = discardVec;
             return;
        }

        vec4 v1v2 = calcV1V2(splat_cam.xyz, covA, covB, transpose(mat3(model_view)));

        // --- Forced 'Small Dot' logic #WDD 2026-01-15 ---
        float finalScale;
        if (isSnowflake) {
            // Increased base dot radius to 12.0 pixels for better visibility #WDD 2026-01-15
            float dotRadius = 12.0 * effectScale; 
            v1v2 = vec4(dotRadius, 0.0, 0.0, dotRadius);
            finalScale = 1.0; 
        } else {
            // Use activeAlpha for scale: smaller = fainter. Prevents "black fog".
            float alphaForScale = max(activeAlpha, 1e-8);
            finalScale = min(1.0, sqrt(-log(1.0 / 255.0 / alphaForScale)) / 2.0);
            v1v2 *= finalScale;
        }

        // Check for small splats
        if (dot(v1v2.xy, v1v2.xy) < 4.0 && dot(v1v2.zw, v1v2.zw) < 4.0) {
            gl_Position = discardVec;
            return;
        }

        gl_Position = splat_proj + vec4((vertex_position.x * v1v2.xy + vertex_position.y * v1v2.zw) / viewport * splat_proj.w, 0, 0);
        
        texCoord = vertex_position.xy * finalScale / 2.0; 

        color = baseColor;
        color.a *= alphaMult; 
        
        // --- Rapid Visual Transition #WDD 2026-01-15 ---
        if (isSnowflake) {
            // Preserving more original color - reduced whiteness mix
            color.rgb = mix(color.rgb, vec3(1.0), visualFactor * 0.4); 
            // Keep high opacity for better volume feel
            color.a = mix(color.a, 0.6 * color.a, visualFactor);
        }
        
        // --- Selection Highlight ---
        float selectionVal = texelFetch(selectionTexture, splatUV, 0).r;
        
        if (isSelectionMode > 0.5) {
             color.a = max(color.a, 0.2); 
        }

        if (selectionVal > 0.0) {
            color.rgb = vec3(1.0, 1.0, 0.0); // Yellow
            color.a = 1.0; 
        }

        // // 1. Priority: Yellow if W < 1.0 (Short duration)
        // #ifdef USE_LIFETIME_TEXTURE
        //     {
        //         int lWidth_chk = textureSize(lifetimeTexture, 0).x;
        //         ivec2 lUV_chk = ivec2(int(splatId % uint(lWidth_chk)), int(splatId / uint(lWidth_chk)));
        //         vec4 valChk = texelFetch(lifetimeTexture, lUV_chk, 0);
        //         float wVal = valChk.g; // Raw W
        //         if (wVal <1.0) {
        //             color.rgb = vec3(1.0, 1.0, 0.0); // Yellow
        //             color.a = 1.0; 
        //             forcedVisible = true;
        //         }
        //     }
        // #endif

        // // 2. Red if effective opacity is practically zero (and not already Yellow)
        // if (baseColor.a < 0.1) {
        //     color.rgb = vec3(1.0, 0.0, 0.0); // Red
        //     color.a = 1.0; // Semi-transparent to avoid occlusion
        //     forcedVisible = true;
        // }

        // --- Deletion check ---
        float deletedVal = texelFetch(selectionTexture, splatUV, 0).g;
        if (deletedVal > 0.0) {
             gl_Position = discardVec;
             return;
        }
        
 

        // #WDD 2026-01-16: LIFETIME DEBUG VISUALIZATION
        // Set to true or create a uniform to debug culling



 



        if (debugLifetime) {
            #ifdef USE_LIFETIME_TEXTURE
                int lWidth_dbg = textureSize(lifetimeTexture, 0).x;
                ivec2 lUV_dbg = ivec2(int(splatId % uint(lWidth_dbg)), int(splatId / uint(lWidth_dbg)));
                vec4 val = texelFetch(lifetimeTexture, lUV_dbg, 0);
                
                float safe_total_dbg = max(uGlobalTotalFrames, 50.0);
                // Texture stores RAW floats now (RGBA32F), so val.r IS mu
                float mu = val.r; 
                float w = val.g;
                float t = uTime;
                
                // --- DIAGNOSTIC COLORS ---
                // R: (mu/duration) - Should vary across the character
                // G: (t/duration)  - Should change uniformly when playing
                // B: (w/duration)  - Should vary across the character
                color.rgb = vec3(mu / safe_total_dbg, t / safe_total_dbg, w / safe_total_dbg);
                
                // Index check: If you see a gradient from left to right, then indices are working
                // color.rgb = vec3(float(splatId % 1000u) / 1000.0, float(splatId / 1000u) / 100.0, 0.0);

                // Cyan if mu=0 and w=0 (likely failed to read)
                if (mu < 0.001 && w < 0.001) color.rgb = vec3(0.0, 1.0, 1.0);
                
                color.a = 1.0; 
            #endif

           

        } else {

        #ifdef USE_SH1
            vec4 worldCenter = matrix_model * vec4(center, 1.0);
            vec3 viewDir = normalize((worldCenter.xyz / worldCenter.w - view_position) * mat3(matrix_model));
            color.xyz = max(color.xyz + evalSH(viewDir), 0.0);
        #endif
        
        } // End Debug Block

        #ifndef DITHER_NONE
            id = float(splatId);
        #endif
    }
`;

// --- Main Pixel Shader ---
// Matches PlayCanvas 'splatMainFS' logic (GLSL 300 ES)

export const splatMainPS = `
    in mediump vec2 texCoord;
    in mediump vec4 color;
    
    layout(location=0) out highp vec4 pc_fragColor;

    void main(void)
    {
        // evalSplat logic from PlayCanvas splatCoreFS
        mediump float A = dot(texCoord, texCoord);
        if (A > 1.0) {
            discard;
        }
        mediump float B = exp(-A * 4.0) * color.a;
        if (B < (1.0/255.0)) {
            discard;
        }

        // Output
        pc_fragColor = vec4(color.rgb, B);
    }
`;
