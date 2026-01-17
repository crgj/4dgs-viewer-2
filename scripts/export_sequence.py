import os
import io
import zipfile
import numpy as np
from PIL import Image
from plyfile import PlyData, PlyElement
import argparse

# --- Helpers ---
def read_webp_to_array(img_data):
    img = Image.open(io.BytesIO(img_data)).convert('RGBA')
    return np.array(img)

def inverse_log_transform(v):
    return np.sign(v) * (np.exp(np.abs(v)) - 1)

def inverse_sigmoid(y):
    y = np.clip(y, 1e-6, 1 - 1e-6)
    return np.log(y / (1 - y))

def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))

def get_lifetime_visibility(t, mu, w):
    # Hard Cutoff Logic
    if t < (mu - w) or t > (mu + w):
        return False
    return True

def export_sequence(truesplats_path, output_dir, num_frames=50):
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    print(f"Loading {truesplats_path}...")
    zf = zipfile.ZipFile(truesplats_path, 'r')
    
    # Handle nested static.sog if present
    sog_zf = zf
    if 'static.sog' in zf.namelist():
        sog_data = zf.read('static.sog')
        sog_zf = zipfile.ZipFile(io.BytesIO(sog_data), 'r')

    # Read Metadata
    import json
    meta = json.loads(sog_zf.read('meta.json'))
    count = meta['count']
    print(f"Total Points: {count}")

    # --- 1. Load All Property Data ---
    
    # Means (Static Base)
    # Note: If trajectory exists, this is usually just the base or t=0, 
    # but we will rely on trajectory for position if available.
    
    # Lifetime (Params)
    print("Loading Lifetime...")
    params_tex = read_webp_to_array(sog_zf.read(meta['params']['files'][0]))
    params_flat = params_tex.reshape(-1, 4)[:count]
    
    # Inspect params structure
    p_meta = meta['params']
    cb_mu = None
    cb_w = None
    is_vq = False
    
    if 'codebook' in p_meta:
        # Case A or B
        cb_data = p_meta['codebook']
        if isinstance(cb_data, dict):
            # Case B: Dict
            print("Lifetime format: Independent (Dict)")
            cb_mu = np.array(cb_data['mu'], dtype=np.float32)
            cb_w = np.array(cb_data['w'], dtype=np.float32)
        else:
            # Case A: VQ List
            print("Lifetime format: VQ (List)")
            is_vq = True
            cb_mu = np.array(cb_data, dtype=np.float32)
            
    elif 'codebook_mu' in p_meta:
        # Case C: Direct Keys (ok.truesplats)
        print("Lifetime format: Independent (Direct Keys)")
        cb_mu = np.array(p_meta['codebook_mu'], dtype=np.float32)
        cb_w = np.array(p_meta['codebook_w'], dtype=np.float32)
    else:
        raise ValueError("Unknown params codebook format")
    
    # Decode Lifetime
    mus = np.zeros(count, dtype=np.float32)
    ws = np.zeros(count, dtype=np.float32)
    
    if is_vq:
        for i in range(count):
            idx = params_flat[i, 0]
            mus[i] = cb_mu[idx][0]
            ws[i] = cb_mu[idx][1]
    else:
        for i in range(count):
            mus[i] = cb_mu[params_flat[i, 0]]
            ws[i] = cb_w[params_flat[i, 1]]

    # Trajectory
    has_traj = 'data.bin' in zf.namelist()
    traj_data = None
    keyframes = 0
    xyz_stride = 1
    
    if has_traj:
        print("Loading Trajectory (data.bin)...")
        dt_bin = zf.read('data.bin')
        
        # Parse Header (32 bytes)
        import struct
        header_size = 32
        magic, ver, N_traj, K_xyz, K_rot, scale_factor, T_total, xyz_stride = struct.unpack('<IIIIIfII', dt_bin[:header_size])
        
        print(f"Header: Magic={hex(magic)}, N={N_traj}, K_xyz={K_xyz}, K_rot={K_rot}")
        print(f"Scale={scale_factor}, TotalFrames={T_total}, Stride={xyz_stride}")

        if N_traj != count:
             print(f"Warning: Trajectory count {N_traj} != SOG count {count}")

        # Calculate Payload
        payload = dt_bin[header_size:]
        
        import zlib
        try:
            decompressed = zlib.decompress(payload)
        except Exception as e:
            # Maybe raw?
            decompressed = payload # Fallback? Unlikely given magic.
            
        # Decode Banks
        offset = 0
        d_len = len(decompressed)
        
        def decode_bank(N, K, C, label):
            nonlocal offset
            data = np.zeros((N, K, C), dtype=np.float32)
            
            # Using memoryview for faster access
            buf = decompressed
            
            for i in range(N):
                if offset >= d_len: break
                mode = buf[offset]
                offset += 1
                
                base_vals = struct.unpack(f'<{C}f', buf[offset:offset+C*4])
                offset += C*4
                
                # Copy Base (k=0)
                data[i, 0] = base_vals
                
                if mode == 0: # INT8
                    count_deltas = (K - 1) * C
                    deltas = struct.unpack(f'<{count_deltas}b', buf[offset:offset+count_deltas])
                    offset += count_deltas
                    
                    cur = list(base_vals)
                    for k in range(1, K):
                        for j in range(C):
                            cur[j] += deltas[(k-1)*C + j] / scale_factor
                            data[i, k, j] = cur[j]
                            
                elif mode == 1: # INT16
                    count_deltas = (K - 1) * C
                    # Struct unpack needs exact bytes
                    # deltas = struct.unpack(f'<{count_deltas}h', buf[offset:offset+count_deltas*2])
                    # offset += count_deltas * 2
                    
                    # Safer chunk read
                    chunk = buf[offset : offset + count_deltas*2]
                    offset += count_deltas * 2
                    deltas = np.frombuffer(chunk, dtype=np.int16)
                    
                    cur = list(base_vals)
                    for k in range(1, K):
                        for j in range(C):
                            cur[j] += deltas[(k-1)*C + j] / scale_factor
                            data[i, k, j] = cur[j]
                            
                elif mode == 2: # FLOAT
                    # Read full floats for ALL K? No, check TS.
                    # TS: slice ... K*C*4. And direct copy.
                    # It seems Mode 2 replaces EVERYTHING including base?
                    # TS: `const floats = new Float32Array(... K*C*4)`
                    # TS: loops k=0 to K.
                    # So Mode 2 overwrites the base_vals we just read?
                    # Actually TS reads mode -> if float, read K*C floats.
                    # Wait, look at my TS dump (Step 568):
                    # `off` is incremented by C*4 BEFORE checking mode?
                    # No.
                    # TS: `const mode = decompressed[off++];`
                    # THEN `if (mode === MODE_INT8) { read base... }`
                    # `else if (mode === MODE_FLOAT) { read floats... }`
                    
                    # My Python logic above read base_vals UNCONDITIONALLY. This is WRONG if mode is FLOAT.
                    pass
                else:
                    raise ValueError(f"Unknown mode {mode}")
            
            return data

        # Correct logic with conditional base read
        def decode_bank_fixed(N, K, C, label):
            nonlocal offset
            data = np.zeros((N, K, C), dtype=np.float32)
            
            for i in range(N):
                mode = decompressed[offset]
                offset += 1
                
                if mode == 2: # FLOAT
                    # Read all K frames as Raw Floats
                    count_floats = K * C
                    chunk = decompressed[offset : offset + count_floats*4]
                    offset += count_floats * 4
                    floats = np.frombuffer(chunk, dtype=np.float32)
                    data[i] = floats.reshape(K, C)
                else:
                    # INT8 or INT16 -> Read Base first
                    base_vals = struct.unpack(f'<{C}f', decompressed[offset:offset+C*4])
                    offset += C*4
                    data[i, 0] = base_vals
                    
                    cur = list(base_vals)
                    
                    if mode == 0: # INT8
                        count_deltas = (K - 1) * C
                        chunk = decompressed[offset : offset + count_deltas]
                        offset += count_deltas
                        deltas = np.frombuffer(chunk, dtype=np.int8) # numpy used int8 matching struct 'b'
                        
                        idx = 0
                        for k in range(1, K):
                            for j in range(C):
                                cur[j] += deltas[idx] / scale_factor
                                idx += 1
                                data[i, k, j] = cur[j]
                                
                    elif mode == 1: # INT16
                        count_deltas = (K - 1) * C
                        chunk = decompressed[offset : offset + count_deltas*2]
                        offset += count_deltas * 2
                        deltas = np.frombuffer(chunk, dtype=np.int16)
                        
                        idx = 0
                        for k in range(1, K):
                            for j in range(C):
                                cur[j] += deltas[idx] / scale_factor
                                idx += 1
                                data[i, k, j] = cur[j]
            return data

        traj_data = decode_bank_fixed(N_traj, K_xyz, 3, "XYZ")
        
        # Check if we need to skip rotation bytes or read them?
        # Header has `K_rot`. If > 0, we read ROT bank.
        # TS: `const xyzData = decodeBank...` then `if (K_rot > 0) rotData = decodeBank...`
        # One stream sequence.
        
        rot_traj_data = None if K_rot == 0 else decode_bank_fixed(N_traj, K_rot, 4, "ROT")
        # We can extract quats from `rot_traj_data` later for interpolation.
        
        # Override keyframes/stride variables with header info
        keyframes = K_xyz
        # xyz_stride was read from header

    # Scales
    print("Loading Scales...")
    scales_tex = read_webp_to_array(sog_zf.read(meta['scales']['files'][0]))
    scales_flat = scales_tex.reshape(-1, 4)[:count]
    scales_cb = np.array(meta['scales']['codebook'], dtype=np.float32)
    scales = np.zeros((count, 3), dtype=np.float32)
    for i in range(count):
        scales[i, 0] = scales_cb[scales_flat[i, 0]]
        scales[i, 1] = scales_cb[scales_flat[i, 1]]
        scales[i, 2] = scales_cb[scales_flat[i, 2]]
    scales = np.exp(scales)

    # Rotations (Static or Trajectory base)
    print("Loading Rotations...")
    # Check key name
    rot_key = 'rotation'
    if 'quats' in meta:
        rot_key = 'quats'
    elif 'rotation' not in meta:
         print("Warning: No rotation/quats found in meta. Using identity.")
         # Handle missing?
    
    quats_tex = read_webp_to_array(sog_zf.read(meta[rot_key]['files'][0]))
    quats_flat = quats_tex.reshape(-1, 4)[:count]
    quats = np.zeros((count, 4), dtype=np.float32)
    sqrt2 = np.sqrt(2)
    for i in range(count):
        r, g, b, a = quats_flat[i]
        k = a - 252
        qvals = np.array([r, g, b], dtype=np.float32) / 255.0 * 2.0 - 1.0
        qvals /= sqrt2
        
        q = np.zeros(4, dtype=np.float32)
        q_idx = 0
        sum_sq = 0
        for j in range(4):
            if j == k: continue
            q[j] = qvals[q_idx]
            q_idx += 1
            sum_sq += q[j]*q[j]
        
        q[k] = np.sqrt(max(0, 1.0 - sum_sq))
        quats[i] = q
        
    # TODO: If K_rot > 0, we should use rot_traj_data for interpolation logic later.
    # Currently loop uses `quats` (static).
    # I will support `rot_traj_data` in the loop.
    
    # ... (Rest of logic)

    # Scales
    print("Loading Scales...")
    scales_tex = read_webp_to_array(sog_zf.read(meta['scales']['files'][0]))
    scales_flat = scales_tex.reshape(-1, 4)[:count]
    scales_cb = np.array(meta['scales']['codebook'], dtype=np.float32)
    scales = np.zeros((count, 3), dtype=np.float32)
    for i in range(count):
        scales[i, 0] = scales_cb[scales_flat[i, 0]]
        scales[i, 1] = scales_cb[scales_flat[i, 1]]
        scales[i, 2] = scales_cb[scales_flat[i, 2]]
    # Apply exp() as per shader/loader? 
    # Shader: `vec3 scales = exp(texelFetch(...))`
    scales = np.exp(scales)

    # Rotations (Static for now)
    print("Loading Rotations...")
    # Loader logic:
    # const r = texData[i*4], g..., k = a - 252
    # qvals = [r, g, b] mapped -1..1
    # reconstruct omitted component.
    quats_tex = read_webp_to_array(sog_zf.read(meta['rotation']['files'][0]))
    quats_flat = quats_tex.reshape(-1, 4)[:count]
    quats = np.zeros((count, 4), dtype=np.float32)
    sqrt2 = np.sqrt(2)
    for i in range(count):
        r, g, b, a = quats_flat[i]
        k = a - 252
        qvals = np.array([r, g, b], dtype=np.float32) / 255.0 * 2.0 - 1.0
        qvals /= sqrt2
        
        q = np.zeros(4, dtype=np.float32)
        q_idx = 0
        sum_sq = 0
        for j in range(4):
            if j == k: continue
            q[j] = qvals[q_idx]
            q_idx += 1
            sum_sq += q[j]*q[j]
        
        q[k] = np.sqrt(max(0, 1.0 - sum_sq))
        # Shader: default order input? nlerp?
        # We save as xyzw (scalar last? or w first?)
        # 3DGS PLY standard is [rot_0, rot_1, rot_2, rot_3] = [w, x, y, z] usually.
        # Loader: data.rot_0 = q[0] ...
        # q[0] is from k=0 handling.
        # Let's just save as is.
        quats[i] = q

    # Colors (SH0)
    print("Loading Colors (SH0)...")
    sh0_tex = read_webp_to_array(sog_zf.read(meta['sh0']['files'][0]))
    sh0_flat = sh0_tex.reshape(-1, 4)[:count]
    sh0_cb = np.array(meta['sh0']['codebook'], dtype=np.float32)
    f_dcs = np.zeros((count, 3), dtype=np.float32)
    
    # Opacity
    opacities = np.zeros(count, dtype=np.float32)
    
    for i in range(count):
        # Color
        f_dcs[i, 0] = sh0_cb[sh0_flat[i, 0]]
        f_dcs[i, 1] = sh0_cb[sh0_flat[i, 1]]
        f_dcs[i, 2] = sh0_cb[sh0_flat[i, 2]]
        
        # Opacity
        # Loader: data.opacity[i] = texData[...3] / 255.0
        # This is PROBABILITY 0-1.
        # Standard PLY expects LOGIT.
        # We should convert back to logit for generic PLY, OR just save opacity property 0-1 if not using standard renders.
        # Standard 3DGS PLY is 'opacity' (Logit).
        # Let's save as Logit: inverse_sigmoid(prob).
        prob = sh0_flat[i, 3] / 255.0
        opacities[i] = inverse_sigmoid(prob)

    # --- 2. Generate Sequence ---
    print(f"Generating {num_frames} frames...")
    
    for t in range(num_frames):
        valid_indices = []
        
        # Interpolate Trajectory
        # Stride logic from shader:
        # idx = floor(t / stride)
        # t_local = (t - idx*stride) / stride
        # p = mix(p0, p1, t_local)
        
        idx0 = int(t / xyz_stride)
        idx1 = idx0 + 1
        t_local = (t - idx0 * xyz_stride) / float(xyz_stride)
        
        # Clamp
        if idx0 >= keyframes - 1:
            idx0 = keyframes - 2
            idx1 = keyframes - 1
            t_local = 1.0 # End of animation? Or clamp logic?
            # Shader: maxTime check.
            # Let's assume clamp.
        
        if idx1 >= keyframes:
            idx1 = keyframes - 1
            idx0 = keyframes - 2 # Handle edge

        positions_t = []
        
        for i in range(count):
            # Check Lifetime
            mu = mus[i]
            w = ws[i]
            if not get_lifetime_visibility(float(t), mu, w):
                continue
                
            # Valid point
            valid_indices.append(i)
            
            # Position
            if traj_data is not None:
                p0 = traj_data[i, idx0]
                p1 = traj_data[i, idx1]
                p = (1.0 - t_local) * p0 + t_local * p1
                positions_t.append(p)
            else:
                # Fallback to means if no trajectory (shouldn't happen for 4DGS)
                # But we didn't load means fully (skipped).
                positions_t.append([0,0,0]) # Error placeholder
        
        if not valid_indices:
            print(f"Frame {t}: 0 points. Skipping save.")
            continue
            
        # Construct PLY Data
        num_valid = len(valid_indices)
        
        # Arrays for PLY
        ply_x = np.zeros(num_valid, dtype=np.float32)
        ply_y = np.zeros(num_valid, dtype=np.float32)
        ply_z = np.zeros(num_valid, dtype=np.float32)
        
        ply_nx = np.zeros(num_valid, dtype=np.float32) # Normal placeholder
        ply_ny = np.zeros(num_valid, dtype=np.float32)
        ply_nz = np.zeros(num_valid, dtype=np.float32)
        
        ply_f_dc_0 = np.zeros(num_valid, dtype=np.float32)
        ply_f_dc_1 = np.zeros(num_valid, dtype=np.float32)
        ply_f_dc_2 = np.zeros(num_valid, dtype=np.float32)
        
        ply_opacity = np.zeros(num_valid, dtype=np.float32)
        
        ply_scale_0 = np.zeros(num_valid, dtype=np.float32)
        ply_scale_1 = np.zeros(num_valid, dtype=np.float32)
        ply_scale_2 = np.zeros(num_valid, dtype=np.float32)
        
        ply_rot_0 = np.zeros(num_valid, dtype=np.float32)
        ply_rot_1 = np.zeros(num_valid, dtype=np.float32)
        ply_rot_2 = np.zeros(num_valid, dtype=np.float32)
        ply_rot_3 = np.zeros(num_valid, dtype=np.float32)
        
        for k, idx in enumerate(valid_indices):
            p = positions_t[k]
            ply_x[k] = p[0]
            ply_y[k] = p[1]
            ply_z[k] = p[2]
            
            # Others
            ply_f_dc_0[k] = f_dcs[idx, 0]
            ply_f_dc_1[k] = f_dcs[idx, 1]
            ply_f_dc_2[k] = f_dcs[idx, 2]
            ply_opacity[k] = opacities[idx]
            ply_scale_0[k] = np.log(scales[idx, 0]) # PLY expects log scale? Standard 3DGS is log scale.
            ply_scale_1[k] = np.log(scales[idx, 1])
            ply_scale_2[k] = np.log(scales[idx, 2])
            ply_rot_0[k] = quats[idx, 0]
            ply_rot_1[k] = quats[idx, 1]
            ply_rot_2[k] = quats[idx, 2]
            ply_rot_3[k] = quats[idx, 3]

        # Define Elements
        el = PlyElement.describe(
            np.array(
                list(zip(ply_x, ply_y, ply_z, ply_nx, ply_ny, ply_nz, 
                         ply_f_dc_0, ply_f_dc_1, ply_f_dc_2, 
                         ply_opacity, 
                         ply_scale_0, ply_scale_1, ply_scale_2, 
                         ply_rot_0, ply_rot_1, ply_rot_2, ply_rot_3)),
                dtype=[('x', 'f4'), ('y', 'f4'), ('z', 'f4'), 
                       ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4'),
                       ('f_dc_0', 'f4'), ('f_dc_1', 'f4'), ('f_dc_2', 'f4'),
                       ('opacity', 'f4'),
                       ('scale_0', 'f4'), ('scale_1', 'f4'), ('scale_2', 'f4'),
                       ('rot_0', 'f4'), ('rot_1', 'f4'), ('rot_2', 'f4'), ('rot_3', 'f4')]
            ),
            'vertex'
        )
        
        out_path = os.path.join(output_dir, f"frame_{t:03d}.ply")
        PlyData([el], text=False).write(out_path)
        print(f"Saved {out_path} ({num_valid} points)")

if __name__ == "__main__":
    export_sequence(
        truesplats_path='/home/crgj/wdd/output/ok.truesplats',
        output_dir='/home/crgj/wdd/output/sequence',
        num_frames=50
    )
