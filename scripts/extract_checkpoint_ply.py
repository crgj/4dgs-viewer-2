import torch
import numpy as np
import os
import argparse
from plyfile import PlyData, PlyElement
from tqdm import tqdm

def morton_sort(x, y, z):
    """
    Sorts indices based on Morton code of x, y, z.
    """
    # Calculate extents
    mx, My = np.min(x), np.max(x)
    my, Mx = np.min(y), np.max(y)
    mz, Mz = np.min(z), np.max(z)
    
    min_pt = np.array([mx, my, mz])
    max_pt = np.array([Mx, My, Mz])
    extent = max_pt - min_pt
    
    # Handle zero extent
    extent[extent == 0] = 1.0 
    
    # Normalize to 0-1023 (10 bits)
    norm_x = np.clip((x - mx) * (1024 / extent[0]), 0, 1023).astype(np.uint32)
    norm_y = np.clip((y - my) * (1024 / extent[1]), 0, 1023).astype(np.uint32)
    norm_z = np.clip((z - mz) * (1024 / extent[2]), 0, 1023).astype(np.uint32)
    
    def part1by2(n):
        n &= 0x000003ff
        n = (n ^ (n << 16)) & 0xff0000ff
        n = (n ^ (n <<  8)) & 0x0300f00f
        n = (n ^ (n <<  4)) & 0x030c30c3
        n = (n ^ (n <<  2)) & 0x09249249
        return n
    
    # Interleave bits
    morton_codes = (part1by2(norm_z) << 2) + (part1by2(norm_y) << 1) + part1by2(norm_x)
    
    # Argsort
    indices = np.argsort(morton_codes)
    return indices

def extract_checkpoint_to_ply(model_path, iteration, output_path):
    ckpt_path = os.path.join(model_path, f"chkpnt{iteration}.pth")
    if not os.path.exists(ckpt_path):
        raise FileNotFoundError(f"Checkpoint not found at {ckpt_path}")
        
    print(f"Loading checkpoint: {ckpt_path}")
    ckpt = torch.load(ckpt_path, map_location='cpu', weights_only=False)
    params = list(ckpt[0])
    
    # Helper to get numpy array from params safely
    def get_numpy(idx):
        if idx < len(params) and params[idx] is not None:
             p = params[idx]
             if isinstance(p, torch.Tensor):
                 return p.detach().cpu().numpy()
             return p
        return None

    # Check for static mask (index 24)
    static_mask = get_numpy(24)
    if static_mask is not None:
        static_mask = static_mask.astype(bool)
        
    # Retrieve raw data chunks
    xyz_static = get_numpy(1)        # _xyz
    f_dc_static = get_numpy(2)       # _features_dc
    rot_static = get_numpy(5)        # _rotation 
    
    xyz_dyn_bank = get_numpy(8)      # _xyz_bank
    rot_dyn_bank = get_numpy(20)     # _rot_bank
    f_dc_dyn_bank = get_numpy(22)    # _features_dc_bank
    
    # Unified Attributes (already N)
    f_rest = get_numpy(3)
    scale = get_numpy(4)
    opacity = get_numpy(6)
    mu = get_numpy(16)
    w = get_numpy(17)
    
    # Determine N
    if static_mask is not None:
        N = len(static_mask)
    else:
        # Fallback: assume xyz_bank is everything if present, else xyz
        if xyz_dyn_bank is not None:
            N = xyz_dyn_bank.shape[0]
        elif xyz_static is not None:
            N = xyz_static.shape[0]
        else:
             raise ValueError("Cannot determine N (no xyz or xyz_bank)")

    print(f"Total points: {N}")
    if static_mask is not None:
        print(f"Static: {np.sum(static_mask)}, Dynamic: {np.sum(~static_mask)}")

    # Prepare Unified Banks
    # XYZ Bank
    K_xyz = 1
    if xyz_dyn_bank is not None and xyz_dyn_bank.ndim == 3: K_xyz = xyz_dyn_bank.shape[1]
    
    xyz_bank = np.zeros((N, K_xyz, 3), dtype=np.float32)
    
    if static_mask is not None:
        if np.any(static_mask) and xyz_static is not None:
             # Replicate static xyz for all K
             xyz_bank[static_mask] = xyz_static[:, None, :]
        if np.any(~static_mask) and xyz_dyn_bank is not None:
             xyz_bank[~static_mask] = xyz_dyn_bank
    else:
        if xyz_dyn_bank is not None:
            xyz_bank = xyz_dyn_bank
        elif xyz_static is not None:
            # Assume constant motion if only static
            xyz_bank[:, 0, :] = xyz_static 
            for k_idx in range(1, K_xyz):
                xyz_bank[:, k_idx, :] = xyz_static
             
    # ROT Bank
    K_rot = 0
    if rot_dyn_bank is not None and rot_dyn_bank.ndim == 3: 
        K_rot = rot_dyn_bank.shape[1]
    
    # If dynamic bank exists, we should populate rot_bank
    rot_bank = None
    if K_rot > 0:
        rot_bank = np.zeros((N, K_rot, 4), dtype=np.float32)
        rot_bank[:, :, 0] = 1.0 # Default quaternion (1, 0, 0, 0)
        
        if static_mask is not None:
             if np.any(static_mask) and rot_static is not None:
                 rot_bank[static_mask] = rot_static[:, None, :]
             if np.any(~static_mask) and rot_dyn_bank is not None:
                 rot_bank[~static_mask] = rot_dyn_bank
        else:
            if rot_dyn_bank is not None: rot_bank = rot_dyn_bank
    
    # DC Bank
    K_dc = 0
    if f_dc_dyn_bank is not None and f_dc_dyn_bank.ndim == 4: # (N_d, K, 1, 3)
         K_dc = f_dc_dyn_bank.shape[1]
         
    f_dc_bank = None
    if K_dc > 0:
        f_dc_bank = np.zeros((N, K_dc, 1, 3), dtype=np.float32)
        if static_mask is not None:
            if np.any(static_mask) and f_dc_static is not None:
                # f_dc_static is (N_s, 1, 3) -> broadcast to (N_s, K, 1, 3)
                f_dc_bank[static_mask] = f_dc_static[:, None, :, :]
            if np.any(~static_mask) and f_dc_dyn_bank is not None:
                f_dc_bank[~static_mask] = f_dc_dyn_bank
        else:
             if f_dc_dyn_bank is not None: f_dc_bank = f_dc_dyn_bank
             
    # Construct "f_dc" (N, 1, 3) for base attributes (e.g. at t=0 or frame 0)
    if static_mask is not None:
        f_dc = np.zeros((N, 1, 3), dtype=np.float32)
        if np.any(static_mask) and f_dc_static is not None:
             f_dc[static_mask] = f_dc_static
        if np.any(~static_mask):
             if f_dc_dyn_bank is not None:
                 # Use first frame of dynamic bank as "base" DC
                 f_dc[~static_mask] = f_dc_dyn_bank[:, 0, :, :]
             elif f_dc_static is not None: 
                 # Fallback logic if dynamic bank missing?
                 pass 
    else:
        # If no static mask, maybe it's all static or all dynamic
        if f_dc_static is not None:
             f_dc = f_dc_static
        elif f_dc_dyn_bank is not None:
             f_dc = f_dc_dyn_bank[:, 0, :, :]
        
    # Sort
    anchor = xyz_bank[:, 0, :]
    print("Sorting data via Morton codes...")
    indices = morton_sort(anchor[:, 0], anchor[:, 1], anchor[:, 2])

    def apply_sort(arr):
        if arr is not None:
            return arr[indices]
        return None
        
    xyz_bank = apply_sort(xyz_bank)
    rot_bank = apply_sort(rot_bank)
    f_dc_bank = apply_sort(f_dc_bank)
    f_dc = apply_sort(f_dc)
    f_rest = apply_sort(f_rest)
    scale = apply_sort(scale)
    opacity = apply_sort(opacity)
    mu = apply_sort(mu)
    w = apply_sort(w)
    
    # Retrieve Strides
    total_frames = int(params[18])
    xyz_stride = int(params[19])
    
    rot_stride = xyz_stride
    if len(params) > 21: rot_stride = int(params[21])
    
    f_dc_stride = xyz_stride
    if len(params) > 23: f_dc_stride = int(params[23])

    print(f"Preparing PLY data: N={N}, K_xyz={K_xyz}, K_rot={K_rot}, K_dc={K_dc}")

    # Construct PLY attributes
    # 1. xyz (frame 0)
    xyz = xyz_bank[:, 0, :]
    
    # 2. f_dc (flattened)
    if f_dc is not None:
        # f_dc is (N, 1, 3) -> reshape to (N, 3)
        f_dc = f_dc.transpose(0, 2, 1).reshape(N, -1)
    
    # 3. f_rest (flattened)
    if f_rest is not None:
        # f_rest is (N, feature_dim, 3)
        f_rest = f_rest.transpose(0, 2, 1).reshape(N, -1)
    
    # 4. opacity
    if opacity is not None and opacity.ndim == 2:
        opacity = opacity.flatten()
        
    # 5. mu / w
    if mu is not None: mu = mu.flatten()
    else: mu = np.zeros(N)
    
    if w is not None: w = w.flatten()
    else: w = np.zeros(N)

    # Define Dtype
    dtype_list = [
        ('x', 'f4'), ('y', 'f4'), ('z', 'f4'),
        ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4')
    ]
    
    if f_dc is not None:
        for i in range(f_dc.shape[1]):
            dtype_list.append((f'f_dc_{i}', 'f4'))
    
    if f_rest is not None:
        for i in range(f_rest.shape[1]):
            dtype_list.append((f'f_rest_{i}', 'f4'))
        
    dtype_list.append(('opacity', 'f4'))
    
    if scale is not None:
        for i in range(scale.shape[1]):
            dtype_list.append((f'scale_{i}', 'f4'))
        
    dtype_list.append(('lifetime_mu', 'f4'))
    dtype_list.append(('lifetime_w', 'f4'))
    
    # Banks
    for k in range(K_xyz):
        for coord in ['x', 'y', 'z']:
             dtype_list.append((f'xyz_bank_{k}_{coord}', 'f4'))
             
    if K_rot > 0:
        for k in range(K_rot):
            for coord in ['w', 'x', 'y', 'z']:
                dtype_list.append((f'rot_bank_{k}_{coord}', 'f4'))

    if K_dc > 0:
        for k in range(K_dc):
            for ch in range(3):
                dtype_list.append((f'f_dc_bank_{k}_{ch}', 'f4'))

    
    # Assemble Data
    dtype = np.dtype(dtype_list)
    arr = np.empty(N, dtype=dtype)
    
    arr['x'] = xyz[:, 0]
    arr['y'] = xyz[:, 1]
    arr['z'] = xyz[:, 2]
    arr['nx'] = 0
    arr['ny'] = 0
    arr['nz'] = 0
    
    if f_dc is not None:
        for i in range(f_dc.shape[1]):
            arr[f'f_dc_{i}'] = f_dc[:, i]
            
    if f_rest is not None:
        for i in range(f_rest.shape[1]):
            arr[f'f_rest_{i}'] = f_rest[:, i]
        
    arr['opacity'] = opacity
    
    if scale is not None:
        for i in range(scale.shape[1]):
            arr[f'scale_{i}'] = scale[:, i]
        
    arr['lifetime_mu'] = mu
    arr['lifetime_w'] = w
    
    # XYZ Bank assignment
    for k in range(K_xyz):
        arr[f'xyz_bank_{k}_x'] = xyz_bank[:, k, 0]
        arr[f'xyz_bank_{k}_y'] = xyz_bank[:, k, 1]
        arr[f'xyz_bank_{k}_z'] = xyz_bank[:, k, 2]
        
    # ROT Bank assignment (quaternion order: w, x, y, z)
    if K_rot > 0:
        for k in range(K_rot):
            arr[f'rot_bank_{k}_w'] = rot_bank[:, k, 0]
            arr[f'rot_bank_{k}_x'] = rot_bank[:, k, 1]
            arr[f'rot_bank_{k}_y'] = rot_bank[:, k, 2]
            arr[f'rot_bank_{k}_z'] = rot_bank[:, k, 3]

    if K_dc > 0:
        for k in range(K_dc):
            arr[f'f_dc_bank_{k}_0'] = f_dc_bank[:, k, 0, 0]
            arr[f'f_dc_bank_{k}_1'] = f_dc_bank[:, k, 0, 1]
            arr[f'f_dc_bank_{k}_2'] = f_dc_bank[:, k, 0, 2]


    print(f"Saving PLY to {output_path}...")
    
    # Metadata comments
    comments = [
        f"total_frames {total_frames}",
        f"xyz_bank_keyframe_stride {xyz_stride}",
        f"rot_bank_keyframe_stride {rot_stride}",
        f"features_dc_bank_keyframe_stride {f_dc_stride}"
    ]
    
    el = PlyElement.describe(arr, 'vertex')
    PlyData([el], comments=comments).write(output_path)
    print("Done.")

def extract_checkpoint_to_ply_filter(model_path, iteration, output_path):
    """
    Extract checkpoint to PLY with filtering: zero out bank data for inactive time slots.
    Uses conservative strategy to ensure active time slots are absolutely correct.
    """
    ckpt_path = os.path.join(model_path, f"chkpnt{iteration}.pth")
    if not os.path.exists(ckpt_path):
        raise FileNotFoundError(f"Checkpoint not found at {ckpt_path}")

    print(f"Loading checkpoint: {ckpt_path}")
    ckpt = torch.load(ckpt_path, map_location='cpu', weights_only=False)
    params = list(ckpt[0])

    # Helper to get numpy array from params safely
    def get_numpy(idx):
        if idx < len(params) and params[idx] is not None:
             p = params[idx]
             if isinstance(p, torch.Tensor):
                 return p.detach().cpu().numpy()
             return p
        return None

    # Check for static mask (index 24)
    static_mask = get_numpy(24)
    if static_mask is not None:
        static_mask = static_mask.astype(bool)

    # Retrieve raw data chunks
    xyz_static = get_numpy(1)        # _xyz
    f_dc_static = get_numpy(2)       # _features_dc
    rot_static = get_numpy(5)        # _rotation

    xyz_dyn_bank = get_numpy(8)      # _xyz_bank
    rot_dyn_bank = get_numpy(20)     # _rot_bank
    f_dc_dyn_bank = get_numpy(22)    # _features_dc_bank

    # Unified Attributes (already N)
    f_rest = get_numpy(3)
    scale = get_numpy(4)
    opacity = get_numpy(6)
    mu = get_numpy(16)
    w = get_numpy(17)

    # Determine N
    if static_mask is not None:
        N = len(static_mask)
    else:
        # Fallback: assume xyz_bank is everything if present, else xyz
        if xyz_dyn_bank is not None:
            N = xyz_dyn_bank.shape[0]
        elif xyz_static is not None:
            N = xyz_static.shape[0]
        else:
             raise ValueError("Cannot determine N (no xyz or xyz_bank)")

    print(f"Total points: {N}")
    if static_mask is not None:
        print(f"Static: {np.sum(static_mask)}, Dynamic: {np.sum(~static_mask)}")

    # Retrieve Strides and total_frames first (needed for filtering)
    total_frames = int(params[18])
    xyz_stride = int(params[19])

    rot_stride = xyz_stride
    if len(params) > 21: rot_stride = int(params[21])

    f_dc_stride = xyz_stride
    if len(params) > 23: f_dc_stride = int(params[23])

    print(f"Total frames: {total_frames}, xyz_stride: {xyz_stride}, rot_stride: {rot_stride}, f_dc_stride: {f_dc_stride}")

    # Prepare Unified Banks
    # XYZ Bank
    K_xyz = 1
    if xyz_dyn_bank is not None and xyz_dyn_bank.ndim == 3: K_xyz = xyz_dyn_bank.shape[1]

    xyz_bank = np.zeros((N, K_xyz, 3), dtype=np.float32)

    if static_mask is not None:
        if np.any(static_mask) and xyz_static is not None:
             # Replicate static xyz for all K
             xyz_bank[static_mask] = xyz_static[:, None, :]
        if np.any(~static_mask) and xyz_dyn_bank is not None:
             xyz_bank[~static_mask] = xyz_dyn_bank
    else:
        if xyz_dyn_bank is not None:
            xyz_bank = xyz_dyn_bank
        elif xyz_static is not None:
            # Assume constant motion if only static
            xyz_bank[:, 0, :] = xyz_static
            for k_idx in range(1, K_xyz):
                xyz_bank[:, k_idx, :] = xyz_static

    # ROT Bank
    K_rot = 0
    if rot_dyn_bank is not None and rot_dyn_bank.ndim == 3:
        K_rot = rot_dyn_bank.shape[1]

    # If dynamic bank exists, we should populate rot_bank
    rot_bank = None
    if K_rot > 0:
        rot_bank = np.zeros((N, K_rot, 4), dtype=np.float32)
        rot_bank[:, :, 0] = 1.0 # Default quaternion (1, 0, 0, 0)

        if static_mask is not None:
             if np.any(static_mask) and rot_static is not None:
                 rot_bank[static_mask] = rot_static[:, None, :]
             if np.any(~static_mask) and rot_dyn_bank is not None:
                 rot_bank[~static_mask] = rot_dyn_bank
        else:
            if rot_dyn_bank is not None: rot_bank = rot_dyn_bank

    # DC Bank
    K_dc = 0
    if f_dc_dyn_bank is not None and f_dc_dyn_bank.ndim == 4: # (N_d, K, 1, 3)
         K_dc = f_dc_dyn_bank.shape[1]

    f_dc_bank = None
    if K_dc > 0:
        f_dc_bank = np.zeros((N, K_dc, 1, 3), dtype=np.float32)
        if static_mask is not None:
            if np.any(static_mask) and f_dc_static is not None:
                # f_dc_static is (N_s, 1, 3) -> broadcast to (N_s, K, 1, 3)
                f_dc_bank[static_mask] = f_dc_static[:, None, :, :]
            if np.any(~static_mask) and f_dc_dyn_bank is not None:
                f_dc_bank[~static_mask] = f_dc_dyn_bank
        else:
             if f_dc_dyn_bank is not None: f_dc_bank = f_dc_dyn_bank

    # Construct "f_dc" (N, 1, 3) for base attributes (e.g. at t=0 or frame 0)
    if static_mask is not None:
        f_dc = np.zeros((N, 1, 3), dtype=np.float32)
        if np.any(static_mask) and f_dc_static is not None:
             f_dc[static_mask] = f_dc_static
        if np.any(~static_mask):
             if f_dc_dyn_bank is not None:
                 # Use first frame of dynamic bank as "base" DC
                 f_dc[~static_mask] = f_dc_dyn_bank[:, 0, :, :]
             elif f_dc_static is not None:
                 # Fallback logic if dynamic bank missing?
                 pass
    else:
        # If no static mask, maybe it's all static or all dynamic
        if f_dc_static is not None:
             f_dc = f_dc_static
        elif f_dc_dyn_bank is not None:
             f_dc = f_dc_dyn_bank[:, 0, :, :]

    # ============ FILTERING: Zero out inactive bank slots ============
    # Strategy: For each point, find which keyframe slots are needed for interpolation
    # during its active time range [mu-w, mu+w]. Only zero out slots that are
    # completely outside this range and not needed for interpolation.
    #
    # Key insight: Interpolation at time t uses keyframes idx and idx+1 where
    # t is in [key_times[idx], key_times[idx+1]]. So we must keep ALL keyframes
    # that bound ANY active time for this point.
    #
    # IMPORTANT: Static points are ALWAYS active and should NEVER be filtered!

    if mu is not None and w is not None:
        mu_flat = mu.flatten()
        w_flat = w.flatten()

        # Compute active time range for each point
        active_start = mu_flat - w_flat  # (N,)
        active_end = mu_flat + w_flat    # (N,)

        # Static points should never be filtered - mark them as always active
        if static_mask is not None:
            active_start[static_mask] = -np.inf
            active_end[static_mask] = np.inf

        print("Filtering inactive bank slots...")
        if static_mask is not None:
            print(f"  (Static points: {np.sum(static_mask)} will NOT be filtered)")

        # Compute keyframe times
        def get_keyframe_times(stride, K):
            times = list(range(0, total_frames, stride))
            if times[-1] != total_frames - 1:
                times.append(total_frames - 1)
            return times[:K]

        def compute_needed_keyframes(key_times, K, active_start, active_end):
            """
            For each point, compute which keyframe indices are needed.
            A keyframe k is needed if it's used in interpolation for any time t in [active_start, active_end].

            Interpolation at time t uses keyframes idx and idx+1 where key_times[idx] <= t < key_times[idx+1].
            So we need all keyframes from the one BEFORE active_start to the one AFTER active_end.
            """
            key_times = np.array(key_times)
            N = len(active_start)

            # For each point, find the first keyframe index needed (the one at or before active_start)
            # searchsorted returns insertion point, so we need idx-1 for the keyframe before
            first_needed = np.searchsorted(key_times, active_start, side='right') - 1
            first_needed = np.clip(first_needed, 0, K - 1)

            # Find the last keyframe index needed (the one at or after active_end)
            # This is the upper bound of the interpolation interval
            last_needed = np.searchsorted(key_times, active_end, side='left')
            last_needed = np.clip(last_needed, 0, K - 1)

            return first_needed, last_needed  # Both are (N,) arrays

        # Filter XYZ bank
        if K_xyz > 1:
            xyz_key_times = get_keyframe_times(xyz_stride, K_xyz)
            first_needed, last_needed = compute_needed_keyframes(xyz_key_times, K_xyz, active_start, active_end)

            zeros_count = 0
            for k in range(K_xyz):
                # A slot k is inactive for point i if k < first_needed[i] or k > last_needed[i]
                inactive_mask = (k < first_needed) | (k > last_needed)
                xyz_bank[inactive_mask, k, :] = 0.0
                zeros_count += np.sum(inactive_mask)

            print(f"  XYZ bank: zeroed {zeros_count} / {N * K_xyz} slots ({100.0 * zeros_count / (N * K_xyz):.2f}%)")

        # Filter ROT bank
        if rot_bank is not None and K_rot > 1:
            rot_key_times = get_keyframe_times(rot_stride, K_rot)
            first_needed, last_needed = compute_needed_keyframes(rot_key_times, K_rot, active_start, active_end)

            zeros_count = 0
            for k in range(K_rot):
                inactive_mask = (k < first_needed) | (k > last_needed)
                # For rotation, set to identity quaternion (1, 0, 0, 0)
                rot_bank[inactive_mask, k, :] = 0.0
                rot_bank[inactive_mask, k, 0] = 1.0
                zeros_count += np.sum(inactive_mask)

            print(f"  ROT bank: zeroed {zeros_count} / {N * K_rot} slots ({100.0 * zeros_count / (N * K_rot):.2f}%)")

        # Filter DC bank
        if f_dc_bank is not None and K_dc > 1:
            f_dc_key_times = get_keyframe_times(f_dc_stride, K_dc)
            first_needed, last_needed = compute_needed_keyframes(f_dc_key_times, K_dc, active_start, active_end)

            zeros_count = 0
            for k in range(K_dc):
                inactive_mask = (k < first_needed) | (k > last_needed)
                f_dc_bank[inactive_mask, k, :, :] = 0.0
                zeros_count += np.sum(inactive_mask)

            print(f"  DC bank: zeroed {zeros_count} / {N * K_dc} slots ({100.0 * zeros_count / (N * K_dc):.2f}%)")
    else:
        print("Warning: lifetime_mu or lifetime_w not found, skipping filtering")

    # ============ END FILTERING ============

    # Sort
    anchor = xyz_bank[:, 0, :]
    print("Sorting data via Morton codes...")
    indices = morton_sort(anchor[:, 0], anchor[:, 1], anchor[:, 2])

    def apply_sort(arr):
        if arr is not None:
            return arr[indices]
        return None

    xyz_bank = apply_sort(xyz_bank)
    rot_bank = apply_sort(rot_bank)
    f_dc_bank = apply_sort(f_dc_bank)
    f_dc = apply_sort(f_dc)
    f_rest = apply_sort(f_rest)
    scale = apply_sort(scale)
    opacity = apply_sort(opacity)
    mu = apply_sort(mu)
    w = apply_sort(w)

    print(f"Preparing PLY data: N={N}, K_xyz={K_xyz}, K_rot={K_rot}, K_dc={K_dc}")

    # Construct PLY attributes
    # 1. xyz (frame 0)
    xyz = xyz_bank[:, 0, :]

    # 2. f_dc (flattened)
    if f_dc is not None:
        # f_dc is (N, 1, 3) -> reshape to (N, 3)
        f_dc = f_dc.transpose(0, 2, 1).reshape(N, -1)

    # 3. f_rest (flattened)
    if f_rest is not None:
        # f_rest is (N, feature_dim, 3)
        f_rest = f_rest.transpose(0, 2, 1).reshape(N, -1)

    # 4. opacity
    if opacity is not None and opacity.ndim == 2:
        opacity = opacity.flatten()

    # 5. mu / w
    if mu is not None: mu = mu.flatten()
    else: mu = np.zeros(N)

    if w is not None: w = w.flatten()
    else: w = np.zeros(N)

    # Define Dtype
    dtype_list = [
        ('x', 'f4'), ('y', 'f4'), ('z', 'f4'),
        ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4')
    ]

    if f_dc is not None:
        for i in range(f_dc.shape[1]):
            dtype_list.append((f'f_dc_{i}', 'f4'))

    if f_rest is not None:
        for i in range(f_rest.shape[1]):
            dtype_list.append((f'f_rest_{i}', 'f4'))

    dtype_list.append(('opacity', 'f4'))

    if scale is not None:
        for i in range(scale.shape[1]):
            dtype_list.append((f'scale_{i}', 'f4'))

    dtype_list.append(('lifetime_mu', 'f4'))
    dtype_list.append(('lifetime_w', 'f4'))

    # Banks
    for k in range(K_xyz):
        for coord in ['x', 'y', 'z']:
             dtype_list.append((f'xyz_bank_{k}_{coord}', 'f4'))

    if K_rot > 0:
        for k in range(K_rot):
            for coord in ['w', 'x', 'y', 'z']:
                dtype_list.append((f'rot_bank_{k}_{coord}', 'f4'))

    if K_dc > 0:
        for k in range(K_dc):
            for ch in range(3):
                dtype_list.append((f'f_dc_bank_{k}_{ch}', 'f4'))


    # Assemble Data
    dtype = np.dtype(dtype_list)
    arr = np.empty(N, dtype=dtype)

    arr['x'] = xyz[:, 0]
    arr['y'] = xyz[:, 1]
    arr['z'] = xyz[:, 2]
    arr['nx'] = 0
    arr['ny'] = 0
    arr['nz'] = 0

    if f_dc is not None:
        for i in range(f_dc.shape[1]):
            arr[f'f_dc_{i}'] = f_dc[:, i]

    if f_rest is not None:
        for i in range(f_rest.shape[1]):
            arr[f'f_rest_{i}'] = f_rest[:, i]

    arr['opacity'] = opacity

    if scale is not None:
        for i in range(scale.shape[1]):
            arr[f'scale_{i}'] = scale[:, i]

    arr['lifetime_mu'] = mu
    arr['lifetime_w'] = w

    # XYZ Bank assignment
    for k in range(K_xyz):
        arr[f'xyz_bank_{k}_x'] = xyz_bank[:, k, 0]
        arr[f'xyz_bank_{k}_y'] = xyz_bank[:, k, 1]
        arr[f'xyz_bank_{k}_z'] = xyz_bank[:, k, 2]

    # ROT Bank assignment (quaternion order: w, x, y, z)
    if K_rot > 0:
        for k in range(K_rot):
            arr[f'rot_bank_{k}_w'] = rot_bank[:, k, 0]
            arr[f'rot_bank_{k}_x'] = rot_bank[:, k, 1]
            arr[f'rot_bank_{k}_y'] = rot_bank[:, k, 2]
            arr[f'rot_bank_{k}_z'] = rot_bank[:, k, 3]

    if K_dc > 0:
        for k in range(K_dc):
            arr[f'f_dc_bank_{k}_0'] = f_dc_bank[:, k, 0, 0]
            arr[f'f_dc_bank_{k}_1'] = f_dc_bank[:, k, 0, 1]
            arr[f'f_dc_bank_{k}_2'] = f_dc_bank[:, k, 0, 2]


    print(f"Saving PLY to {output_path}...")

    # Metadata comments
    comments = [
        f"total_frames {total_frames}",
        f"xyz_bank_keyframe_stride {xyz_stride}",
        f"rot_bank_keyframe_stride {rot_stride}",
        f"features_dc_bank_keyframe_stride {f_dc_stride}"
    ]

    el = PlyElement.describe(arr, 'vertex')
    PlyData([el], comments=comments).write(output_path)
    print("Done.")


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -20, 20)))

def slerp_np(q0, q1, alpha):
    """
    Spherical Linear Interpolation for quaternions.
    q0, q1: (N, 4)
    alpha: (N,) or float
    """
    # Normalize inputs
    norm0 = np.linalg.norm(q0, axis=-1, keepdims=True)
    norm1 = np.linalg.norm(q1, axis=-1, keepdims=True)
    q0 = q0 / (norm0 + 1e-10)
    q1 = q1 / (norm1 + 1e-10)

    # Shortest path
    dot = np.sum(q0 * q1, axis=-1, keepdims=True)
    q1 = np.where(dot < 0, -q1, q1)
    dot = np.abs(dot)
    dot = np.clip(dot, 0.0, 1.0)

    theta_0 = np.arccos(dot)
    sin_theta_0 = np.sin(theta_0)

    mask = (sin_theta_0 > 1e-4).squeeze(-1)
    res = np.empty_like(q0)

    # Standard Slerp
    if np.any(mask):
        if isinstance(alpha, np.ndarray):
             a = alpha[mask][:, None]
        else:
             a = alpha
             
        s0 = np.sin((1.0 - a) * theta_0[mask]) / (sin_theta_0[mask] + 1e-10)
        s1 = np.sin(a * theta_0[mask]) / (sin_theta_0[mask] + 1e-10)
        res[mask] = s0 * q0[mask] + s1 * q1[mask]

    # Lerp fallback for small angles
    if np.any(~mask):
        if isinstance(alpha, np.ndarray):
             a = alpha[~mask][:, None]
        else:
             a = alpha
        res[~mask] = (1.0 - a) * q0[~mask] + a * q1[~mask]

    # Normalize result
    final_norm = np.linalg.norm(res, axis=-1, keepdims=True)
    return res / (final_norm + 1e-10)

def logit(x):
    """Safe logit function."""
    x = np.clip(x, 1e-7, 1.0 - 1e-7)
    return np.log(x / (1.0 - x))

def save_per_frame_ply(master_ply_path, output_dir):
    print(f"Loading master PLY: {master_ply_path}")
    plydata = PlyData.read(master_ply_path)
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    # 1. Parse Metadata from comments
    total_frames = 0
    xyz_stride = 1
    rot_stride = 1
    f_dc_stride = 1
    
    for comment in plydata.comments:

        if "total_frames" in comment:
            total_frames = int(comment.split()[-1])
        elif "xyz_bank_keyframe_stride" in comment:
            xyz_stride = int(comment.split()[-1])
        elif "rot_bank_keyframe_stride" in comment:
            rot_stride = int(comment.split()[-1])
        elif "features_dc_bank_keyframe_stride" in comment:
            f_dc_stride = int(comment.split()[-1])
            
    print(f"Metadata: Total Frames={total_frames}, XYZ Stride={xyz_stride}, ROT Stride={rot_stride}, DC Stride={f_dc_stride}")

    if total_frames == 0:
        print("Warning: total_frames not found in comments, assuming single frame or failing.")
        
    # 2. Load Data
    v = plydata['vertex']
    N = v.count
    
    # helper to get property as array
    def get_prop(name):
        return np.asarray(v[name])
        
    # Load attributes
    print("Loading attributes...")
    # Static attributes
    # NOTE: strictly match "<prefix><index>" to avoid pulling in bank fields
    # like "f_dc_bank_0_0" when loading base static channels.
    def get_indexed_prop_names(prefix):
        names = []
        for p in v.properties:
            name = p.name
            if not name.startswith(prefix):
                continue
            suffix = name[len(prefix):]
            if suffix.isdigit():
                names.append((int(suffix), name))
        names.sort(key=lambda x: x[0])
        return [name for _, name in names]

    f_dc_names = get_indexed_prop_names("f_dc_")
    f_rest_names = get_indexed_prop_names("f_rest_")
    scale_names = get_indexed_prop_names("scale_")
    
    f_dc = np.stack([get_prop(n) for n in f_dc_names], axis=1)
    f_rest = np.stack([get_prop(n) for n in f_rest_names], axis=1)
    scale = np.stack([get_prop(n) for n in scale_names], axis=1)
    
    # opacity in Master PLY is Logit (from checkpoint)
    opacity_logit_master = get_prop("opacity")
    
    lifetime_mu = get_prop("lifetime_mu") if "lifetime_mu" in v else None
    lifetime_w = get_prop("lifetime_w") if "lifetime_w" in v else None
    
    # Load Banks
    xyz_bank_props = [p.name for p in v.properties if p.name.startswith("xyz_bank_")]
    rot_bank_props = [p.name for p in v.properties if p.name.startswith("rot_bank_")]
    
    # xyz_bank_{k}_{coord}
    # Find max K
    if not xyz_bank_props:
        raise ValueError("No xyz_bank found in PLY")
        
    k_xyz_max = 0
    for n in xyz_bank_props:
        parts = n.split('_')
        # xyz, bank, k, coord
        k = int(parts[2])
        if k > k_xyz_max: k_xyz_max = k
    K_xyz = k_xyz_max + 1
    
    xyz_bank = np.zeros((N, K_xyz, 3), dtype=np.float32)
    for k in range(K_xyz):
        xyz_bank[:, k, 0] = get_prop(f"xyz_bank_{k}_x")
        xyz_bank[:, k, 1] = get_prop(f"xyz_bank_{k}_y")
        xyz_bank[:, k, 2] = get_prop(f"xyz_bank_{k}_z")
        
    rot_bank = None
    K_rot = 0
    if rot_bank_props:
        k_rot_max = 0
        for n in rot_bank_props:
            parts = n.split('_')
            # rot, bank, k, coord
            k = int(parts[2])
            if k > k_rot_max: k_rot_max = k
        K_rot = k_rot_max + 1
        
        rot_bank = np.zeros((N, K_rot, 4), dtype=np.float32)
        for k in range(K_rot):
            rot_bank[:, k, 0] = get_prop(f"rot_bank_{k}_w")
            rot_bank[:, k, 1] = get_prop(f"rot_bank_{k}_x")
            rot_bank[:, k, 2] = get_prop(f"rot_bank_{k}_y")
            rot_bank[:, k, 3] = get_prop(f"rot_bank_{k}_z")
    
    f_dc_bank = None
    K_dc = 0
    f_dc_bank_props = [p.name for p in v.properties if p.name.startswith("f_dc_bank_")]
    if f_dc_bank_props:
        k_dc_max = 0
        for n in f_dc_bank_props:
             parts = n.split('_')
             # f, dc, bank, k, ch
             k = int(parts[3])
             if k > k_dc_max: k_dc_max = k
        K_dc = k_dc_max + 1
        
        f_dc_bank = np.zeros((N, K_dc, 3), dtype=np.float32)
        for k in range(K_dc):
            f_dc_bank[:, k, 0] = get_prop(f"f_dc_bank_{k}_0")
            f_dc_bank[:, k, 1] = get_prop(f"f_dc_bank_{k}_1")
            f_dc_bank[:, k, 2] = get_prop(f"f_dc_bank_{k}_2")

    # 3. Generate Frames
    print(f"Generating {total_frames} frames...")
    
    # Compute Keyframe Times
    xyz_key_times = list(range(0, total_frames, xyz_stride))

    if xyz_key_times[-1] != total_frames - 1:
        xyz_key_times.append(total_frames - 1)
    xyz_key_times = np.array(xyz_key_times)
    
    rot_key_times = list(range(0, total_frames, rot_stride))
    if rot_key_times[-1] != total_frames - 1:
        rot_key_times.append(total_frames - 1)
    rot_key_times = np.array(rot_key_times)

    f_dc_key_times = list(range(0, total_frames, f_dc_stride))
    if f_dc_key_times[-1] != total_frames - 1:
        f_dc_key_times.append(total_frames - 1)
    f_dc_key_times = np.array(f_dc_key_times)

    
    # Prepare Dtype for output
    dtype_list = [('x', 'f4'), ('y', 'f4'), ('z', 'f4'), ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4')]
    for i in range(f_dc.shape[1]): dtype_list.append((f'f_dc_{i}', 'f4'))
    for i in range(f_rest.shape[1]): dtype_list.append((f'f_rest_{i}', 'f4'))
    dtype_list.append(('opacity', 'f4'))
    for i in range(scale.shape[1]): dtype_list.append((f'scale_{i}', 'f4'))
    for i in range(4): dtype_list.append((f'rot_{i}', 'f4')) # Standard Rot
    
    dtype = np.dtype(dtype_list)
    
    base_alpha = sigmoid(opacity_logit_master)
    
    for t in tqdm(range(total_frames), desc="Frames"):
        # Interpolate XYZ
        if K_xyz == 1:
            curr_xyz = xyz_bank[:, 0]
        else:
            idx = np.searchsorted(xyz_key_times, t, side='right') - 1
            if idx >= K_xyz - 1: idx = K_xyz - 2
            
            t0 = xyz_key_times[idx]
            t1 = xyz_key_times[idx+1]
            
            numer = float(t - t0)
            denom = float(t1 - t0)
            alpha = numer / denom if denom > 0 else 0.0
            
            p0 = xyz_bank[:, idx]
            p1 = xyz_bank[:, idx+1]
            curr_xyz = p0 * (1.0 - alpha) + p1 * alpha
            
        # Interpolate ROT
        if rot_bank is None:
            curr_rot = np.zeros((N, 4), dtype=np.float32)
            curr_rot[:, 0] = 1.0
        elif K_rot == 1:
            curr_rot = rot_bank[:, 0]
        else:
            ridx = np.searchsorted(rot_key_times, t, side='right') - 1
            if ridx >= K_rot - 1: ridx = K_rot - 2
            
            rt0 = rot_key_times[ridx]
            rt1 = rot_key_times[ridx+1]
            
            rnumer = float(t - rt0)
            rdenom = float(rt1 - rt0)
            ralpha = rnumer / rdenom if rdenom > 0 else 0.0
            
            q0 = rot_bank[:, ridx]
            q1 = rot_bank[:, ridx+1]
            curr_rot = slerp_np(q0, q1, ralpha)

        # Interpolate DC
        if f_dc_bank is not None:
            if K_dc == 1:
                curr_f_dc = f_dc_bank[:, 0]
            else:
                didx = np.searchsorted(f_dc_key_times, t, side='right') - 1
                if didx >= K_dc - 1: didx = K_dc - 2
                
                dt0 = f_dc_key_times[didx]
                dt1 = f_dc_key_times[didx+1]
                
                dnumer = float(t - dt0)
                ddenom = float(dt1 - dt0)
                dalpha = dnumer / ddenom if ddenom > 0 else 0.0
                
                c0 = f_dc_bank[:, didx]
                c1 = f_dc_bank[:, didx+1]
                curr_f_dc = c0 * (1.0 - dalpha) + c1 * dalpha
        else:
             curr_f_dc = f_dc # Fallback to static

            
        # Opacity Gating (Correct Processing: Logit -> Prob -> Gate -> Logit)
        if lifetime_mu is not None and lifetime_w is not None:
            k = 10.0
            delta_left = t - (lifetime_mu - lifetime_w)
            delta_right = (lifetime_mu + lifetime_w) - t
            
            gate = sigmoid(k * delta_left) * sigmoid(k * delta_right)
            curr_alpha = base_alpha * gate
        else:
            curr_alpha = base_alpha
            
        # Filter dead points (optional, but good for size)
        # 0.01 threshold on PROBABILITY
        alive_mask = curr_alpha >= 0.01 
        if not np.any(alive_mask):
            continue
            
        n_alive = np.sum(alive_mask)
        
        # Convert Prob -> Logit for saving
        # Standard 3DGS PLY format expects Logits for opacity
        curr_opac_logit = logit(curr_alpha[alive_mask])
        
        # Assemble Frame Data
        arr = np.empty(n_alive, dtype=dtype)
        arr['x'] = curr_xyz[alive_mask, 0]
        arr['y'] = curr_xyz[alive_mask, 1]
        arr['z'] = curr_xyz[alive_mask, 2]
        arr['nx'] = 0; arr['ny'] = 0; arr['nz'] = 0
        
        # Use interpolated DC if available
        if f_dc_bank is not None:
             # f_dc is 3 channels
             for i in range(3): arr[f'f_dc_{i}'] = curr_f_dc[alive_mask, i]
        else:
             for i in range(f_dc.shape[1]): arr[f'f_dc_{i}'] = f_dc[alive_mask, i]

        for i in range(f_rest.shape[1]): arr[f'f_rest_{i}'] = f_rest[alive_mask, i]

        
        arr['opacity'] = curr_opac_logit
        
        for i in range(scale.shape[1]): arr[f'scale_{i}'] = scale[alive_mask, i]
        for i in range(4): arr[f'rot_{i}'] = curr_rot[alive_mask, i]
        
        filename = f"frame_{t:04d}.ply"
        filepath = os.path.join(output_dir, filename)
        
        el = PlyElement.describe(arr, 'vertex')
        PlyData([el], text=False).write(filepath)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract Gaussian Splatting checkpoint to PLY with active attributes")

    subparsers = parser.add_subparsers(dest='mode', required=True, help="Mode of operation")

    # Extract Mode
    parser_extract = subparsers.add_parser('extract', help="Extract checkpoint to Master PLY")
    parser_extract.add_argument("--model_path", required=True, help="Path to model directory containing checkpoints")
    parser_extract.add_argument("--iteration", type=int, default=30000, help="Iteration number of checkpoint")
    parser_extract.add_argument("--output_path", required=True, help="Output Master PLY file path")

    # Extract Filter Mode (zero out inactive bank slots for better compression)
    parser_extract_filter = subparsers.add_parser('extract_filter', help="Extract checkpoint to Master PLY with inactive bank slots zeroed out")
    parser_extract_filter.add_argument("--model_path", required=True, help="Path to model directory containing checkpoints")
    parser_extract_filter.add_argument("--iteration", type=int, default=30000, help="Iteration number of checkpoint")
    parser_extract_filter.add_argument("--output_path", required=True, help="Output Master PLY file path")

    # Reconstruct Mode
    parser_recon = subparsers.add_parser('reconstruct', help="Reconstruct per-frame PLYs from Master PLY")
    parser_recon.add_argument("--master_ply", required=True, help="Path to Master PLY file")
    parser_recon.add_argument("--output_dir", required=True, help="Directory to save per-frame PLYs")

    args = parser.parse_args()

    if args.mode == 'extract':
        extract_checkpoint_to_ply(args.model_path, args.iteration, args.output_path)
    elif args.mode == 'extract_filter':
        extract_checkpoint_to_ply_filter(args.model_path, args.iteration, args.output_path)
    elif args.mode == 'reconstruct':
        save_per_frame_ply(args.master_ply, args.output_dir)
