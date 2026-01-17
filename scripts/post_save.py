import torch
import numpy as np
import os
import argparse
import struct
import matplotlib.pyplot as plt
from tqdm import tqdm
import math
import concurrent.futures
import multiprocessing
import zlib

# ==========================================
# Constants & Configuration
# ==========================================
SCALE = 10000.0
MAGIC = 0x5A444C54 # 'ZDLT' (Zlib Delta)
VERSION = 4 # Incremented for rot_bank support

# Modes
MODE_INT8 = 0
MODE_INT16 = 1
MODE_FLOAT = 2 

CHUNK_SIZE = 10000

# ==========================================
# Helpers
# ==========================================

def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -20, 20)))

def logit(x):
    x = np.clip(x, 1e-7, 1.0 - 1e-7)
    return np.log(x / (1.0 - x))

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
        s0 = np.sin((1.0 - alpha) * theta_0[mask]) / (sin_theta_0[mask] + 1e-10)
        s1 = np.sin(alpha * theta_0[mask]) / (sin_theta_0[mask] + 1e-10)
        res[mask] = s0 * q0[mask] + s1 * q1[mask]

    # Lerp fallback for small angles
    if np.any(~mask):
        if isinstance(alpha, np.ndarray):
            a = alpha if not isinstance(alpha, np.ndarray) or alpha.shape == () else alpha[~mask]
            if isinstance(a, np.ndarray) and a.ndim < q0[~mask].ndim:
                a = a[..., None]
        else:
            a = alpha
        res[~mask] = (1.0 - a) * q0[~mask] + a * q1[~mask]

    # Normalize result
    final_norm = np.linalg.norm(res, axis=-1, keepdims=True)
    return res / (final_norm + 1e-10)

# ==========================================
# Optimized DPCM Compression
# ==========================================

def compress_trajectory_dpcm(idx, traj_in):
    # traj_in: (K, C) 
    K = len(traj_in)
    C = traj_in.shape[-1]
    anchor = traj_in[0]
    
    if K <= 1:
        return (idx, MODE_FLOAT, traj_in.flatten())

    rel = traj_in - anchor
    Q = np.round(rel * SCALE).astype(np.int64)
    D = np.zeros_like(Q)
    D[0] = 0 
    D[1:] = Q[1:] - Q[:-1]
    
    deltas = D[1:] # (K-1, C)
    max_val = np.max(np.abs(deltas))
    
    if max_val < 128:
        return (idx, MODE_INT8, (anchor, deltas.astype(np.int8)))
    elif max_val < 32768:
        return (idx, MODE_INT16, (anchor, deltas.astype(np.int16)))
    else:
        return (idx, MODE_FLOAT, (traj_in.flatten(),))

def process_chunk_dpcm(chunk_data):
    results = []
    for idx, traj in chunk_data:
        results.append(compress_trajectory_dpcm(idx, traj))
    return results

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

# ==========================================
# Phase 1: Separation
# ==========================================

def save_static_attributes_ply(path, params, anchor_xyz):
    from plyfile import PlyData, PlyElement
    N = anchor_xyz.shape[0]
    f_dc = params[2].detach().cpu().numpy().transpose(0, 2, 1).reshape(N, -1)
    f_rest = params[3].detach().cpu().numpy().transpose(0, 2, 1).reshape(N, -1)
    scale = params[4].detach().cpu().numpy()
    rot = params[5].detach().cpu().numpy()
    opac = params[6].detach().cpu().numpy()
    use_param = bool(params[15])
    mu = params[16].detach().cpu().numpy() if params[16] is not None else np.zeros((N, 1), dtype=np.float32)
    w = params[17].detach().cpu().numpy() if params[17] is not None else np.zeros((N, 1), dtype=np.float32)
    
    l = [('x', 'f4'), ('y', 'f4'), ('z', 'f4'), ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4')]
    for i in range(f_dc.shape[1]): l.append((f'f_dc_{i}', 'f4'))
    for i in range(f_rest.shape[1]): l.append((f'f_rest_{i}', 'f4'))
    l.append(('opacity', 'f4'))
    for i in range(scale.shape[1]): l.append((f'scale_{i}', 'f4'))
    for i in range(rot.shape[1]): l.append((f'rot_{i}', 'f4'))
    l.append(('mu', 'f4'))
    l.append(('w', 'f4'))
    l.append(('is_param', 'f4'))
    
    dtype = np.dtype(l)
    normals = np.zeros((N, 3), dtype=np.float32)
    is_param_arr = np.full((N, 1), 1.0 if use_param else 0.0, dtype=np.float32)
    data = np.hstack([anchor_xyz, normals, f_dc, f_rest, opac, scale, rot, mu, w, is_param_arr])
    arr = np.empty(N, dtype=dtype)
    for i, name in enumerate(dtype.names): arr[name] = data[:, i]
    PlyData([PlyElement.describe(arr, 'vertex')], text=False).write(path)

def run_extraction(model_path, iteration, save_dir):
    ckpt_path = os.path.join(model_path, f"chkpnt{iteration}.pth")
    print(f"Loading {ckpt_path}...")
    ckpt = torch.load(ckpt_path, weights_only=False)
    params = list(ckpt[0]) # Convert to list to allow modification
    
    xyz_bank_pre = params[8]
    
    # Morton Sort (New Step)
    print("Sorting data via Morton codes...")
    anchor = xyz_bank_pre[:, 0, :].detach().cpu().numpy()
    indices = morton_sort(anchor[:, 0], anchor[:, 1], anchor[:, 2])
    
    # Apply sort to all per-point parameters
    # Indices to sort: 2(f_dc), 3(f_rest), 4(scale), 5(rot), 6(opac), 8(xyz_bank), 16(mu), 17(w), 20(rot_bank)
    target_indices = [2, 3, 4, 5, 6, 8, 16, 17, 20]
    for idx in target_indices:
        if idx < len(params) and params[idx] is not None:
            params[idx] = params[idx][indices]
            
    # Refresh references
    xyz_bank = params[8]
    rot_bank = params[20] if len(params) > 20 else None
    
    total_frames = int(params[18])
    xyz_stride = int(params[19])
    rot_stride = int(params[21]) if len(params) > 21 else xyz_stride
    
    N, K_xyz, _ = xyz_bank.shape
    K_rot = rot_bank.shape[1] if rot_bank is not None else 0
    
    out_path = os.path.join(model_path, save_dir)
    os.makedirs(out_path, exist_ok=True)
    
    def compress_bank(bank, label):
        all_traj = bank.detach().cpu().numpy()
        C = all_traj.shape[-1]
        chunks = [[(k, all_traj[k]) for k in range(i, min(i+CHUNK_SIZE, N))] for i in range(0, N, CHUNK_SIZE)]
        results_map = {}
        with concurrent.futures.ProcessPoolExecutor() as exe:
            futures = [exe.submit(process_chunk_dpcm, c) for c in chunks]
            for f in tqdm(concurrent.futures.as_completed(futures), total=len(chunks), desc=f"Compressing {label}"):
                for idx, mode, payload in f.result(): results_map[idx] = (mode, payload)
        
        buf = bytearray()
        for i in range(N):
            m, p = results_map[i]
            buf.append(m)
            if m == MODE_INT8:
                buf.extend(struct.pack("f" * C, *p[0]))
                buf.extend(p[1].tobytes())
            elif m == MODE_INT16:
                buf.extend(struct.pack("f" * C, *p[0]))
                buf.extend(p[1].tobytes())
            else:
                buf.extend(p[0].tobytes())
        return buf

    print(f"XYZ Bank: {N} points, {K_xyz} keyframes")
    buf_xyz = compress_bank(xyz_bank, "XYZ Bank")
    
    if rot_bank is not None:
        print(f"ROT Bank: {N} points, {K_rot} keyframes")
        buf_rot = compress_bank(rot_bank, "ROT Bank")
    else:
        print("ROT Bank: Not found, using static rotations.")
        buf_rot = bytearray()

    uncompressed_buf = buf_xyz + buf_rot
    print(f"Raw Combined Size: {len(uncompressed_buf)/1024/1024:.2f} MB")
    
    compressed_payload = zlib.compress(uncompressed_buf, level=9)
    print(f"Zlib Compressed Size: {len(compressed_payload)/1024/1024:.2f} MB")
    
    with open(os.path.join(out_path, "data.bin"), "wb") as f:
        # Header: Magic(4), Ver(4), N(4), K_xyz(4), K_rot(4), Scale(4), T_total(4), Stride_xyz(4), Stride_rot(4)
        # 9 fields * 4 bytes = 36 bytes
        f.write(struct.pack("I I I I I f I I I", MAGIC, VERSION, N, K_xyz, K_rot, SCALE, total_frames, xyz_stride, rot_stride))
        f.write(compressed_payload)
    
    save_static_attributes_ply(os.path.join(out_path, "static.ply"), params, xyz_bank[:, 0, :].detach().cpu().numpy())
    print(f"Done. Destination: {out_path}")

# ==========================================
# Phase 2: Reconstruction
# ==========================================

def run_reconstruction_optimized(input_dir):
    from plyfile import PlyData, PlyElement
    bin_path = os.path.join(input_dir, "data.bin")
    ply_path = os.path.join(input_dir, "static.ply")
    
    with open(bin_path, "rb") as f:
        header_raw = f.read(36)
        head = struct.unpack("I I I I I f I I I", header_raw)
        magic, ver, N, K_xyz, K_rot, scale, T_total, xyz_stride, rot_stride = head
        data = f.read()
        
    if magic == MAGIC:
        data = zlib.decompress(data)
    else:
        print("Warning: Unknown Magic or Uncompressed BIN.")

    def decompress_bank(data_ptr, K, C, label):
        rec = []
        off = 0
        for _ in tqdm(range(N), desc=f"Decompressing {label}"):
            m = data_ptr[off]; off += 1
            if m == MODE_INT8:
                anch = np.array(struct.unpack_from("f" * C, data_ptr, off)); off += 4 * C
                d = np.frombuffer(data_ptr[off:off+(K-1)*C], dtype=np.int8).reshape(K-1, C).astype(np.float32); off += (K-1)*C
                rec.append(np.concatenate([anch[None,:], anch[None,:]+np.cumsum(d,0)/scale], 0))
            elif m == MODE_INT16:
                anch = np.array(struct.unpack_from("f" * C, data_ptr, off)); off += 4 * C
                d = np.frombuffer(data_ptr[off:off+(K-1)*C*2], dtype=np.int16).reshape(K-1, C).astype(np.float32); off += (K-1)*C*2
                rec.append(np.concatenate([anch[None,:], anch[None,:]+np.cumsum(d,0)/scale], 0))
            else:
                rec.append(np.frombuffer(data_ptr[off:off+K*C*4], dtype=np.float32).reshape(K, C)); off += K*C*4
        return np.array(rec), off

    rec_xyz, offset_xyz = decompress_bank(data, K_xyz, 3, "XYZ Bank")
    if K_rot > 0:
        rec_rot, _ = decompress_bank(data[offset_xyz:], K_rot, 4, "ROT Bank")
    else:
        rec_rot = None

    ply = PlyData.read(ply_path)
    el = ply.elements[0]
    def get_attr(prefix):
        props = sorted([p.name for p in el.properties if p.name.startswith(prefix)], 
                       key=lambda x: int(x.split('_')[-1]) if '_' in x else 0)
        return np.stack([np.asarray(el[p]) for p in props], axis=1)

    f_dc, f_rest, scale_attr, rot_static = get_attr("f_dc"), get_attr("f_rest"), get_attr("scale"), get_attr("rot")
    opac_logit, mu, w = np.asarray(el["opacity"])[:, None], np.asarray(el["mu"])[:, None], np.asarray(el["w"])[:, None]
    
    xyz_times = list(range(0, T_total, xyz_stride))
    if len(xyz_times) == 0 or xyz_times[-1] != T_total - 1: xyz_times.append(T_total - 1)
    
    rot_times = list(range(0, T_total, rot_stride))
    if len(rot_times) == 0 or rot_times[-1] != T_total - 1: rot_times.append(T_total - 1)

    out_seq = os.path.join(input_dir, "reconstructed_ply")
    os.makedirs(out_seq, exist_ok=True)
    base_opac_active = sigmoid(opac_logit).flatten()
    
    dtype_list = [('x','f4'),('y','f4'),('z', 'f4'),('nx','f4'),('ny','f4'),('nz','f4')]
    for i in range(f_dc.shape[1]): dtype_list.append((f'f_dc_{i}', 'f4'))
    for i in range(f_rest.shape[1]): dtype_list.append((f'f_rest_{i}', 'f4'))
    dtype_list.append(('opacity', 'f4'))
    for i in range(scale_attr.shape[1]): dtype_list.append((f'scale_{i}', 'f4'))
    for i in range(rot_static.shape[1]): dtype_list.append((f'rot_{i}', 'f4'))
    dtype = np.dtype(dtype_list)
    
    for t in tqdm(range(T_total), desc="Generating Frames"):
        # Interpolate XYZ
        idx = 0
        while idx < K_xyz-1 and xyz_times[idx+1] <= t: idx += 1
        if t >= xyz_times[-1]: xyz = rec_xyz[:, -1, :]
        else:
            t0, t1 = xyz_times[idx], xyz_times[idx+1]
            u = (t - t0) / (t1 - t0)
            xyz = rec_xyz[:, idx] * (1-u) + rec_xyz[:, idx+1] * u
            
        # Interpolate ROT
        if rec_rot is not None:
            ridx = 0
            while ridx < K_rot-1 and rot_times[ridx+1] <= t: ridx += 1
            if t >= rot_times[-1]: rot = rec_rot[:, -1, :]
            else:
                rt0, rt1 = rot_times[ridx], rot_times[ridx+1]
                ru = (t - rt0) / (rt1 - rt0)
                rot = slerp_np(rec_rot[:, ridx], rec_rot[:, ridx+1], ru)
        else:
            rot = rot_static

        gate = (sigmoid(10.0 * (t - (mu - w))) * sigmoid(10.0 * ((mu + w) - t))).flatten()
        opac_active = base_opac_active * gate
        mask = opac_active >= 0.01
        if not mask.any(): continue
        
        nv = mask.sum()
        v_opac = logit(opac_active[mask])[:, None]
        data_frame = np.hstack([xyz[mask], np.zeros((nv, 3), dtype=np.float32), f_dc[mask], f_rest[mask], v_opac, scale_attr[mask], rot[mask]])
        arr = np.empty(nv, dtype=dtype)
        for i, name in enumerate(dtype.names): arr[name] = data_frame[:, i]
        PlyData([PlyElement.describe(arr, 'vertex')], text=False).write(os.path.join(out_seq, f"frame_{t:04d}.ply"))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["extract", "reconstruct"], required=True)
    parser.add_argument("--model_path")
    parser.add_argument("--iteration", type=int, default=50000)
    parser.add_argument("--input_dir")
    parser.add_argument("--save_dir", default="optimized_package")
    args = parser.parse_args()

    if args.mode == "extract":
        run_extraction(args.model_path, args.iteration, args.save_dir)
    elif args.mode == "reconstruct":
        run_reconstruction_optimized(args.input_dir)
