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
    
    # Extract parameters based on known indices from post_save.py/gaussian_model.py
    # 0: ? (active_sh_degree)
    # 1: _xyz (Don't save)
    # 2: _features_dc
    # 3: _features_rest
    # 4: _scaling
    # 5: _rotation (Don't save)
    # 6: _opacity
    # 7: lifetime_bank (Don't save)
    # 8: _xyz_bank
    # 9: max_radii2D (Don't save)
    # ...
    # 16: _lifetime_mu
    # 17: _lifetime_w
    # 18: total_frames (int)
    # 19: xyz_bank_keyframe_stride (int)
    # 20: _rot_bank
    # 21: rot_bank_keyframe_stride (int)

    # Note: Indices might vary if implementation changes, but these match previous research.
    
    xyz_bank_param = params[8]
    if xyz_bank_param is None or len(xyz_bank_param) == 0:
        raise ValueError("xyz_bank is missing or empty in checkpoint.")
        
    # Get frame 0 for sorting anchors
    anchor = xyz_bank_param[:, 0, :].detach().cpu().numpy()
    
    print("Sorting data via Morton codes...")
    indices = morton_sort(anchor[:, 0], anchor[:, 1], anchor[:, 2])
    
    # Apply sort to arrays we need
    def sort_param(idx):
        if idx < len(params) and params[idx] is not None:
             # Check if it's a tensor
             if isinstance(params[idx], torch.Tensor):
                 return params[idx][indices].detach().cpu().numpy()
             else:
                 # Scalar values or other types likely don't need sorting, 
                 # but we are only sorting per-point arrays here.
                 return params[idx]
        return None

    # Retrieve and sort required data
    f_dc = sort_param(2)
    f_rest = sort_param(3)
    scale = sort_param(4)
    opacity = sort_param(6)
    xyz_bank = sort_param(8)
    mu = sort_param(16)
    w = sort_param(17)
    rot_bank = sort_param(20)
    
    # Constants
    total_frames = int(params[18])
    xyz_stride = int(params[19])
    if len(params) > 21:
        rot_stride = int(params[21])
    else:
        rot_stride = xyz_stride # Fallback
        
    N = xyz_bank.shape[0]
    
    # Construct PLY attributes
    # 1. xyz (use frame 0 of xyz_bank as anchor/display position)
    xyz = xyz_bank[:, 0, :]
    
    # 2. f_dc (flattened)
    # f_dc shape: (N, 1, 3) -> (N, 3) -> f_dc_0, f_dc_1, f_dc_2
    f_dc = f_dc.transpose(0, 2, 1).reshape(N, -1)
    
    # 3. f_rest (flattened)
    # f_rest shape: (N, 15, 3) -> (N, 45) -> f_rest_0...
    f_rest = f_rest.transpose(0, 2, 1).reshape(N, -1)
    
    # 4. opacity (N, 1) -> opacity
    if opacity.ndim == 2:
        opacity = opacity.flatten()
        
    # 5. scale (N, 3) -> scale_0, scale_1, scale_2
    # 6. mu (N, 1) -> lifetime_mu
    if mu is not None:
        mu = mu.flatten()
    else:
        mu = np.zeros(N) # Or handle as missing
        
    # 7. w (N, 1) -> lifetime_w
    if w is not None:
        w = w.flatten()
    else:
        w = np.zeros(N)

    # 8. xyz_bank (N, K, 3) -> xyz_bank_{k}_{x,y,z}
    K_xyz = xyz_bank.shape[1]
    
    # 9. rot_bank (N, K_rot, 4) -> rot_bank_{k}_{x,y,z,w}
    if rot_bank is not None:
        K_rot = rot_bank.shape[1]
    else:
        K_rot = 0
        
    print(f"Preparing PLY data: N={N}, K_xyz={K_xyz}, K_rot={K_rot}")
    
    # Define Dtype
    dtype_list = [
        ('x', 'f4'), ('y', 'f4'), ('z', 'f4'),
        ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4')
    ]
    
    for i in range(f_dc.shape[1]):
        dtype_list.append((f'f_dc_{i}', 'f4'))
    for i in range(f_rest.shape[1]):
        dtype_list.append((f'f_rest_{i}', 'f4'))
        
    dtype_list.append(('opacity', 'f4'))
    
    for i in range(scale.shape[1]):
        dtype_list.append((f'scale_{i}', 'f4'))
        
    # User requested lifetime mu and w
    dtype_list.append(('lifetime_mu', 'f4'))
    dtype_list.append(('lifetime_w', 'f4'))
    
    # Banks
    for k in range(K_xyz):
        for coord in ['x', 'y', 'z']:
             dtype_list.append((f'xyz_bank_{k}_{coord}', 'f4'))
             
    if K_rot > 0:
        for k in range(K_rot):
            for coord in ['x', 'y', 'z', 'w']:
                dtype_list.append((f'rot_bank_{k}_{coord}', 'f4'))
    
    # Assemble Data
    # Pre-allocate structured array
    dtype = np.dtype(dtype_list)
    arr = np.empty(N, dtype=dtype)
    
    # Fill Data
    arr['x'] = xyz[:, 0]
    arr['y'] = xyz[:, 1]
    arr['z'] = xyz[:, 2]
    arr['nx'] = 0
    arr['ny'] = 0
    arr['nz'] = 0
    
    for i in range(f_dc.shape[1]):
        arr[f'f_dc_{i}'] = f_dc[:, i]
    for i in range(f_rest.shape[1]):
        arr[f'f_rest_{i}'] = f_rest[:, i]
        
    arr['opacity'] = opacity
    
    for i in range(scale.shape[1]):
        arr[f'scale_{i}'] = scale[:, i]
        
    arr['lifetime_mu'] = mu
    arr['lifetime_w'] = w
    
    # XYZ Bank
    # Flattening xyz_bank to (N, K*3)
    xyz_bank_flat = xyz_bank.reshape(N, -1)
    # Fill by name
    # The order of columns in flattened array matches the nested loop order [k, coord]
    # provided we constructed the flatten correctly (C-order).
    # xyz_bank is (N, K, 3). Flatten -> (N, K*3): sorted as k=0(x,y,z), k=1(x,y,z)...
    
    idx = 0
    for k in range(K_xyz):
        for coord in ['x', 'y', 'z']:
            # xyz_bank_{k}_{coord}
            arr[dtype_list[6 + f_dc.shape[1] + f_rest.shape[1] + 1 + scale.shape[1] + 2 + idx][0]] = xyz_bank_flat[:, idx]
            idx += 1
            
    # ROT Bank
    if K_rot > 0:
        rot_bank_flat = rot_bank.reshape(N, -1)
        rot_idx = 0
        start_rot_idx = 6 + f_dc.shape[1] + f_rest.shape[1] + 1 + scale.shape[1] + 2 + idx
        for k in range(K_rot):
            for coord in ['x', 'y', 'z', 'w']:
                 arr[dtype_list[start_rot_idx + rot_idx][0]] = rot_bank_flat[:, rot_idx]
                 rot_idx += 1
                 
    # Better way to fill safely by name to avoid index arithmetic errors
    # (Though slower, but safer. Optimizing with bulk assignment above is fine if indices match)
    # Let's double check bulk assignment logic or just loop keys.
    # To be extremely safe and given N is ~millions, loop over columns.
    
    # Redo bank assignment safely
    print("Populating data structure...")
    col_idx = 0
    # xyz, n
    col_idx += 6
    # f_dc
    col_idx += f_dc.shape[1]
    # f_rest
    col_idx += f_rest.shape[1]
    # opac
    col_idx += 1
    # scale
    col_idx += scale.shape[1]
    # life
    col_idx += 2
    
    # XYZ Bank assignment
    for k in range(K_xyz):
        arr[f'xyz_bank_{k}_x'] = xyz_bank[:, k, 0]
        arr[f'xyz_bank_{k}_y'] = xyz_bank[:, k, 1]
        arr[f'xyz_bank_{k}_z'] = xyz_bank[:, k, 2]
        
    # ROT Bank assignment
    if K_rot > 0:
        for k in range(K_rot):
            arr[f'rot_bank_{k}_x'] = rot_bank[:, k, 0]
            arr[f'rot_bank_{k}_y'] = rot_bank[:, k, 1]
            arr[f'rot_bank_{k}_z'] = rot_bank[:, k, 2]
            arr[f'rot_bank_{k}_w'] = rot_bank[:, k, 3]

    print(f"Saving PLY to {output_path}...")
    
    # Metadata comments
    comments = [
        f"total_frames {total_frames}",
        f"xyz_bank_keyframe_stride {xyz_stride}",
        f"rot_bank_keyframe_stride {rot_stride}"
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
    
    for comment in plydata.comments:
        if "total_frames" in comment:
            total_frames = int(comment.split()[-1])
        elif "xyz_bank_keyframe_stride" in comment:
            xyz_stride = int(comment.split()[-1])
        elif "rot_bank_keyframe_stride" in comment:
            rot_stride = int(comment.split()[-1])
            
    print(f"Metadata: Total Frames={total_frames}, XYZ Stride={xyz_stride}, ROT Stride={rot_stride}")
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
    f_dc_names = sorted([p.name for p in v.properties if p.name.startswith("f_dc_")], key=lambda x: int(x.split('_')[-1]))
    f_rest_names = sorted([p.name for p in v.properties if p.name.startswith("f_rest_")], key=lambda x: int(x.split('_')[-1]))
    scale_names = sorted([p.name for p in v.properties if p.name.startswith("scale_")], key=lambda x: int(x.split('_')[-1]))
    
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
            rot_bank[:, k, 0] = get_prop(f"rot_bank_{k}_x")
            rot_bank[:, k, 1] = get_prop(f"rot_bank_{k}_y")
            rot_bank[:, k, 2] = get_prop(f"rot_bank_{k}_z")
            rot_bank[:, k, 3] = get_prop(f"rot_bank_{k}_w")
            
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
    
    # Reconstruct Mode
    parser_recon = subparsers.add_parser('reconstruct', help="Reconstruct per-frame PLYs from Master PLY")
    parser_recon.add_argument("--master_ply", required=True, help="Path to Master PLY file")
    parser_recon.add_argument("--output_dir", required=True, help="Directory to save per-frame PLYs")
    
    args = parser.parse_args()
    
    if args.mode == 'extract':
        extract_checkpoint_to_ply(args.model_path, args.iteration, args.output_path)
    elif args.mode == 'reconstruct':
        save_per_frame_ply(args.master_ply, args.output_dir)
