
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
// Matches PlayCanvas 'splatMainVS' EXACTLY (plus GLSL300ES port and Lifetime Option)

export const splatMainVS = `
    uniform vec3 view_position;
    uniform sampler2D splatColor;
    
    out mediump vec2 texCoord;
    out mediump vec4 color;
    
    mediump vec4 discardVec = vec4(0.0, 0.0, 2.0, 1.0);
    
    // Custom Lifetime Uniforms
    uniform sampler2D lifetimeTexture;
    uniform float uTime;
    
    float getLifetimeOpacityTexture(ivec2 uv, float t) {
        // Safe check for lifetime 
        // If not defined, we could macro it out, but user wants 'correctness' first.
        // We will enable this mostly only if macro defined.
        #ifdef USE_LIFETIME_TEXTURE
            vec4 val = texelFetch(lifetimeTexture, uv, 0);
            float mu = val.r;
            float w = val.g;
            float k = val.b;
            if (k < 0.1) k = 50.0; 
            float left = 1.0 / (1.0 + exp( -k * (t - (mu - w)) ));
            float right = 1.0 / (1.0 + exp( k * (t - (mu + w)) ));
            return left * right;
        #else
            return 1.0;
        #endif
    }

    void main(void)
    {
        if (!calcSplatUV()) {
            gl_Position = discardVec;
            return;
        }
        
        vec3 center = getCenter();
        mat4 model_view = matrix_view * matrix_model;
        vec4 splat_cam = model_view * vec4(center, 1.0);
        
        if (splat_cam.z > 0.0) {
            gl_Position = discardVec;
            return;
        }
        
        vec4 splat_proj = matrix_projection * splat_cam;
        splat_proj.z = clamp(splat_proj.z, -abs(splat_proj.w), abs(splat_proj.w));
        
        vec3 covA, covB;
        getCovariance(covA, covB);
        vec4 v1v2 = calcV1V2(splat_cam.xyz, covA, covB, transpose(mat3(model_view)));
        
        color = texelFetch(splatColor, splatUV, 0);

        // --- Custom Lifetime (Optional) ---
        float alphaMult = getLifetimeOpacityTexture(splatUV, uTime);
        if (alphaMult < 0.01) {
             gl_Position = discardVec;
             return;
        }
        //color.a *= alphaMult;
        // ---------------------------------

        float scale = min(1.0, sqrt(-log(1.0 / 255.0 / color.a)) / 2.0);
        v1v2 *= scale;

        // FIXED: PlayCanvas Check for small splats
        if (dot(v1v2.xy, v1v2.xy) < 4.0 && dot(v1v2.zw, v1v2.zw) < 4.0) {
            gl_Position = discardVec;
            return;
        }

        gl_Position = splat_proj + vec4((vertex_position.x * v1v2.xy + vertex_position.y * v1v2.zw) / viewport * splat_proj.w, 0, 0);
        
        // FIXED Scale: PlayCanvas uses '/ 2.0', not '* 2.0'
        texCoord = vertex_position.xy * scale / 2.0; 

        #ifdef USE_SH1
            vec4 worldCenter = matrix_model * vec4(center, 1.0);
            vec3 viewDir = normalize((worldCenter.xyz / worldCenter.w - view_position) * mat3(matrix_model));
            color.xyz = max(color.xyz + evalSH(viewDir), 0.0);
        #endif

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
