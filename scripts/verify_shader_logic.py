
import numpy as np

def verify_logic(T, stride):
    # Python Logic
    xyz_times = list(range(0, T, stride))
    if xyz_times[-1] != T - 1:
        xyz_times.append(T - 1)
    
    K = len(xyz_times)
    print(f"T={T}, Stride={stride}, K={K}")
    print(f"Times: {xyz_times}")
    
    # Simulate for all t
    # Using 0.1 steps
    ts = np.arange(0, T, 0.5)
    
    for t in ts:
        # Python Search
        idx = 0
        while idx < K-1 and xyz_times[idx+1] <= t:
            idx += 1
        
        # Last frame check
        if t >= xyz_times[-1]:
            py_idx0 = K-1
            py_idx1 = K-1
            py_u = 0.0
        else:
            py_idx0 = idx
            py_idx1 = idx + 1
            t0 = xyz_times[idx]
            t1 = xyz_times[idx+1]
            py_u = (t - t0) / (t1 - t0) if t1 != t0 else 0

        # Shader O(1) Logic
        # float K = uKeyframes; (K)
        # float T = uGlobalTotalFrames; (T)
        # float stride = uXYZStride; (stride)
        
        if K <= 1:
            sh_idx0 = 0
            sh_idx1 = 0
            sh_u = 0
        else:
            s_idx = int(t / stride)
            maxStartIdx = K - 2
            
            if s_idx >= maxStartIdx:
                s_idx = maxStartIdx
                sh_idx0 = s_idx
                sh_idx1 = s_idx + 1
                sh_t0 = float(s_idx) * stride
                sh_t1 = float(T - 1)
            else:
                sh_idx0 = s_idx
                sh_idx1 = s_idx + 1
                sh_t0 = float(sh_idx0) * stride
                sh_t1 = float(sh_idx1) * stride
                
            sh_u = (sh_t1 - sh_t0)
            if sh_u != 0:
                sh_u = max(0.0, min(1.0, (t - sh_t0) / sh_u))
            else:
                sh_u = 0.0

        # Compare
        # Round u to 4 decimals
        py_u = round(py_u, 4)
        sh_u = round(sh_u, 4)
        
        match = (py_idx0 == sh_idx0) and (py_idx1 == sh_idx1) and (abs(py_u - sh_u) < 0.001)
        
        # Exception: if t >= T-1. Python logic uses idx K-1 directly.
        # Shader logic uses idx K-2, idx1 K-1, u=1.0.
        # Functionally equivalent: p0*(1-u) + p1*u -> p1 if u=1.
        # So check effective interpolation.
        
        # Shader: mix(p[sh_idx0], p[sh_idx1], sh_u)
        # Python: mix(p[py_idx0], p[py_idx1], py_u)
        
        # If Shader u=1.0, it selects sh_idx1.
        # If Shader u=0.0, it selects sh_idx0.
        
        eff_sh_idx = sh_idx1 if sh_u == 1.0 else (sh_idx0 if sh_u == 0.0 else -1)
        eff_py_idx = py_idx1 if py_u == 1.0 else (py_idx0 if py_u == 0.0 else -1)
        
        # Specialized check for boundary
        if not match:
            # Check if effective result is same
            # e.g. Py: idx 17, u=0. Shader: idx 16, idx1 17, u=1.
            # Both mean Keyframe 17.
            
            val_py = py_idx0 * (1-py_u) + py_idx1 * py_u
            val_sh = sh_idx0 * (1-sh_u) + sh_idx1 * sh_u
            
            if abs(val_py - val_sh) < 0.001:
                match = True
        
        if not match:
            print(f"FAIL at t={t}")
            print(f"  Py: idx {py_idx0}->{py_idx1} u={py_u}")
            print(f"  Sh: idx {sh_idx0}->{sh_idx1} u={sh_u}")
            return False

    print("PASS")
    return True

print("--- Test 1: T=50, s=3 ---")
verify_logic(50, 3)

print("--- Test 2: T=49, s=3 (End matches exactly) ---")
verify_logic(49, 3)

print("--- Test 3: T=4, s=1 ---")
verify_logic(4, 1)

print("--- Test 4: T=21, s=10 ---")
verify_logic(21, 10)
