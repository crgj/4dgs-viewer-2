
import os
import argparse
import numpy as np
import json
import math
import zipfile
from PIL import Image
from plyfile import PlyData
import io

# ==========================================
# Helpers (K-Means, Math, WebP)
# ==========================================

def log_transform(value):
    return np.sign(value) * np.log(np.abs(value) + 1)

def initialize_centroids_1d(data, k):
    n = len(data)
    sorted_data = np.sort(data)
    centroids = np.zeros(k, dtype=data.dtype)
    for i in range(k):
        quantile = (2 * i + 1) / (2 * k)
        index = min(int(math.floor(quantile * n)), n - 1)
        centroids[i] = sorted_data[index]
    return centroids

def kmeans_1d(data, k, iterations=10):
    k = min(k, len(np.unique(data)))
    if k == 0: return np.array([], dtype=data.dtype), np.array([], dtype=np.uint32)
    
    centroids = initialize_centroids_1d(data, k)
    
    for _ in range(iterations):
        dists = np.abs(data[:, None] - centroids[None, :])
        labels = np.argmin(dists, axis=1)
        
        for i in range(k):
            mask = (labels == i)
            if np.any(mask):
                centroids[i] = np.mean(data[mask])
            else:
                centroids[i] = data[np.random.randint(len(data))]
                
    sorted_indices = np.argsort(centroids)
    centroids = centroids[sorted_indices]
    
    dists = np.abs(data[:, None] - centroids[None, :])
    labels = np.argmin(dists, axis=1)
    return centroids.astype(np.float32), labels.astype(np.uint32)

def kmeans_nd(data, k, iterations=10, batch_size=1024):
    n, d = data.shape
    k = min(k, n) # Safety
    indices = np.random.choice(n, k, replace=False)
    centroids = data[indices].copy()
    labels = np.zeros(n, dtype=np.uint32)
    
    for _ in range(iterations):
        c_norms_sq = np.sum(centroids**2, axis=1)
        for i in range(0, n, batch_size):
            end = min(i + batch_size, n)
            batch = data[i:end]
            dot_prod = np.dot(batch, centroids.T)
            dist_metric = c_norms_sq[None, :] - 2 * dot_prod
            labels[i:end] = np.argmin(dist_metric, axis=1)
            
        new_centroids = np.zeros_like(centroids)
        # Naive update for code clarity relative to speed
        for i in range(k):
            mask = (labels == i)
            if np.any(mask):
                new_centroids[i] = np.mean(data[mask], axis=0)
            else:
                new_centroids[i] = centroids[i] # keep old
        centroids = new_centroids
        
    return centroids.astype(np.float32), labels.astype(np.uint32)

def cluster_shared_codebook(data_columns, k, iterations=10):
    flattened = np.concatenate(data_columns)
    centroids, all_labels = kmeans_1d(flattened, k, iterations)
    
    rows = len(data_columns[0])
    labels_list = []
    for i in range(len(data_columns)):
        labels_list.append(all_labels[i*rows : (i+1)*rows])
    return centroids, labels_list

def save_webp(filename, data, width, height, zip_fs):
    img = Image.fromarray(data, mode='RGBA')
    buf = io.BytesIO()
    img.save(buf, format='WEBP', lossless=True, quality=100, method=6)
    with zip_fs.open(filename, 'w') as f:
        f.write(buf.getvalue())

def normalize_u16(val, min_v, max_v):
    inv_range = 1.0 / (max_v - min_v + 1e-9)
    norm = (val - min_v) * inv_range
    return np.clip(norm * 65535, 0, 65535).astype(np.uint16)

# ==========================================
# Compression Modules
# ==========================================

def compress_means(x, y, z, width, height, filename_base, zip_fs):
    # Log transform
    lx, ly, lz = log_transform(x), log_transform(y), log_transform(z)
    
    means_min = [float(np.min(lx)), float(np.min(ly)), float(np.min(lz))]
    means_max = [float(np.max(lx)), float(np.max(ly)), float(np.max(lz))]
    
    nx = normalize_u16(lx, means_min[0], means_max[0])
    ny = normalize_u16(ly, means_min[1], means_max[1])
    nz = normalize_u16(lz, means_min[2], means_max[2])
    
    N = len(x)
    padded_size = width * height
    
    def pad(arr):
        res = np.zeros(padded_size, dtype=arr.dtype)
        res[:N] = arr
        return res
        
    pnx, pny, pnz = pad(nx), pad(ny), pad(nz)
    
    means_L = np.zeros((padded_size, 4), dtype=np.uint8)
    means_U = np.zeros((padded_size, 4), dtype=np.uint8)
    
    means_L[:, 0] = pnx & 0xff
    means_L[:, 1] = pny & 0xff
    means_L[:, 2] = pnz & 0xff
    means_L[:, 3] = 255
    
    means_U[:, 0] = (pnx >> 8) & 0xff
    means_U[:, 1] = (pny >> 8) & 0xff
    means_U[:, 2] = (pnz >> 8) & 0xff
    means_U[:, 3] = 255
    
    fl = f"{filename_base}_l.webp"
    fu = f"{filename_base}_u.webp"
    
    save_webp(fl, means_L.reshape(height, width, 4), width, height, zip_fs)
    save_webp(fu, means_U.reshape(height, width, 4), width, height, zip_fs)
    
    return {
        'mins': means_min,
        'maxs': means_max,
        'files': [fl, fu]
    }

def compress_quats(rot_0, rot_1, rot_2, rot_3, width, height, filename, zip_fs):
    N = len(rot_0)
    # Normalize
    length = np.sqrt(rot_0**2 + rot_1**2 + rot_2**2 + rot_3**2) + 1e-9
    rot_0 /= length; rot_1 /= length; rot_2 /= length; rot_3 /= length
    
    quats = np.stack([rot_0, rot_1, rot_2, rot_3], axis=1) # (N, 4)
    max_indices = np.argmax(np.abs(quats), axis=1)
    
    # Fix sign
    max_vals = quats[np.arange(N), max_indices]
    signs = np.sign(max_vals)
    signs[signs == 0] = 1
    quats *= signs[:, None]
    
    # Scale by sqrt(2)
    quats *= math.sqrt(2)
    
    drop_map = {0: [1,2,3], 1: [0,2,3], 2: [0,1,3], 3: [0,1,2]}
    
    padded_size = width * height
    q_tex = np.zeros((padded_size, 4), dtype=np.uint8)
    
    # Vectorized encoding is messy due to drop map, loop is safer
    for i in range(N):
        k = max_indices[i]
        others = drop_map[k]
        q_tex[i, 0] = int(255 * (quats[i, others[0]] * 0.5 + 0.5))
        q_tex[i, 1] = int(255 * (quats[i, others[1]] * 0.5 + 0.5))
        q_tex[i, 2] = int(255 * (quats[i, others[2]] * 0.5 + 0.5))
        q_tex[i, 3] = 252 + k
        
    save_webp(filename, q_tex.reshape(height, width, 4), width, height, zip_fs)
    
    return { 'files': [filename] }

def compress_scales(s0, s1, s2, width, height, filename, iterations, zip_fs):
    centroids, labels_list = cluster_shared_codebook([s0, s1, s2], 256, iterations)
    
    N = len(s0)
    padded_size = width * height
    tex = np.zeros((padded_size, 4), dtype=np.uint8)
    tex[:N, 0] = labels_list[0]
    tex[:N, 1] = labels_list[1]
    tex[:N, 2] = labels_list[2]
    tex[:, 3] = 255
    
    save_webp(filename, tex.reshape(height, width, 4), width, height, zip_fs)
    return { 'codebook': centroids.tolist(), 'files': [filename] }

def compress_sh0_op(f0, f1, f2, op, width, height, filename, iterations, zip_fs):
    centroids, labels_list = cluster_shared_codebook([f0, f1, f2], 256, iterations)
    
    op_sigmoid = 1.0 / (1.0 + np.exp(-op))
    op_u8 = (op_sigmoid * 255).astype(np.uint8)
    
    N = len(f0)
    padded_size = width * height
    tex = np.zeros((padded_size, 4), dtype=np.uint8)
    tex[:N, 0] = labels_list[0]
    tex[:N, 1] = labels_list[1]
    tex[:N, 2] = labels_list[2]
    tex[:N, 3] = op_u8
    
    save_webp(filename, tex.reshape(height, width, 4), width, height, zip_fs)
    return { 'codebook': centroids.tolist(), 'files': [filename] }

def compress_shN(sh_data, width, height, iterations, zip_fs):
    N, num_coeffs = sh_data.shape
    palette_size = min(64, 2 ** int(math.floor(math.log2(N / 1024)))) * 1024
    palette_size = max(palette_size, 16)
    
    print(f"  Clustering SH into {palette_size} clusters...")
    sh_centroids, sh_labels = kmeans_nd(sh_data, palette_size, iterations)
    
    flat_centroids = sh_centroids.flatten()
    codebook_centroids, codebook_labels = kmeans_1d(flat_centroids, 256, iterations)
    sh_centroids_labels = codebook_labels.reshape(sh_centroids.shape)
    
    coeffs_per_color = num_coeffs // 3
    c_width = 64 * coeffs_per_color
    c_height = int(math.ceil(palette_size / 64))
    
    c_tex_flat = np.zeros((c_height * c_width * 4), dtype=np.uint8)
    
    for i in range(palette_size):
        for j in range(coeffs_per_color):
            idx_R = sh_centroids_labels[i, coeffs_per_color * 0 + j]
            idx_G = sh_centroids_labels[i, coeffs_per_color * 1 + j]
            idx_B = sh_centroids_labels[i, coeffs_per_color * 2 + j]
            
            pixel_idx = (i // 64) * c_width + (i % 64) * coeffs_per_color + j
            c_tex_flat[pixel_idx * 4 + 0] = idx_R
            c_tex_flat[pixel_idx * 4 + 1] = idx_G
            c_tex_flat[pixel_idx * 4 + 2] = idx_B
            c_tex_flat[pixel_idx * 4 + 3] = 0xff
            
    save_webp('shN_centroids.webp', c_tex_flat.reshape(c_height, c_width, 4), c_width, c_height, zip_fs)
    
    padded_size = width * height
    l_tex = np.zeros((padded_size, 4), dtype=np.uint8)
    
    def pad_u32(arr):
        res = np.zeros(padded_size, dtype=np.uint32)
        res[:N] = arr
        return res
        
    l_label = pad_u32(sh_labels)
    l_tex[:, 0] = l_label & 0xff
    l_tex[:, 1] = (l_label >> 8) & 0xff
    l_tex[:, 3] = 0xff
    
    save_webp('shN_labels.webp', l_tex.reshape(height, width, 4), width, height, zip_fs)
    
    bands_map = {9: 1, 24: 2, 45: 3}
    return {
        'count': palette_size,
        'bands': bands_map.get(num_coeffs, 0),
        'codebook': codebook_centroids.tolist(),
        'files': ['shN_centroids.webp', 'shN_labels.webp']
    }

def compress_params(mu, w, is_param, width, height, iterations, zip_fs):
    c_mu, l_mu = kmeans_1d(mu, 256, iterations)
    c_w, l_w = kmeans_1d(w, 256, iterations)
    c_p, l_p = kmeans_1d(is_param, 256, iterations)
    
    padded_size = width * height
    tex = np.zeros((padded_size, 4), dtype=np.uint8)
    tex[:len(mu), 0] = l_mu.astype(np.uint8)
    tex[:len(mu), 1] = l_w.astype(np.uint8)
    tex[:len(mu), 2] = l_p.astype(np.uint8)
    tex[:, 3] = 255
    
    save_webp('params.webp', tex.reshape(height, width, 4), width, height, zip_fs)
    
    return {
        'codebook_mu': c_mu.tolist(),
        'codebook_w': c_w.tolist(),
        'codebook_is_param': c_p.tolist(),
        'files': ['params.webp']
    }

# ==========================================
# Main Conversion
# ==========================================

def convert_master_to_sog(master_ply, output_sog, iterations=10):
    print(f"Reading Master PLY: {master_ply}")
    plydata = PlyData.read(master_ply)
    v = plydata['vertex']
    N = v.count
    
    # Calculate Texture Dims
    width = int(math.ceil(math.sqrt(N) / 4) * 4)
    height = int(math.ceil(N / width / 4) * 4)
    print(f"Count: {N}, Texture: {width}x{height}")
    
    meta = {
        'version': 2,
        'asset': {'generator': 'master_ply_to_sog_native'},
        'count': N,
    }
    
    with zipfile.ZipFile(output_sog, 'w', compression=zipfile.ZIP_STORED) as zf:
        
        # 1. Standard Attributes
        print("Compressing Standard Attributes...")
        
        # Means
        meta['means'] = compress_means(
            np.asarray(v['x']), np.asarray(v['y']), np.asarray(v['z']),
            width, height, 'means', zf
        )
        
        # Rotations
        # Use rot_0/1/2/3 if exist, else look for rot_bank_0 if rot missing?
        # Assuming Master PLY has synthesized or original 'rot_0'.. or we use rot_bank_0 as base?
        # If original rot not there, we should use rot_bank_0.
        has_rot = 'rot_0' in v
        if has_rot:
            r0, r1, r2, r3 = v['rot_0'], v['rot_1'], v['rot_2'], v['rot_3']
        elif 'rot_bank_0_x' in v:
            print("Using rot_bank_0 as static rotation...")
            r0, r1, r2, r3 = v['rot_bank_0_x'], v['rot_bank_0_y'], v['rot_bank_0_z'], v['rot_bank_0_w']
        else:
            print("No rotation found, using identity.")
            r0 = np.ones(N); r1 = np.zeros(N); r2 = np.zeros(N); r3 = np.zeros(N)
            
        meta['quats'] = compress_quats(
            np.asarray(r0), np.asarray(r1), np.asarray(r2), np.asarray(r3),
            width, height, 'quats', zf
        )
        
        # Scales
        meta['scales'] = compress_scales(
            np.asarray(v['scale_0']), np.asarray(v['scale_1']), np.asarray(v['scale_2']),
            width, height, 'scales', iterations, zf
        )
        
        # Colors & Opacity
        meta['sh0'] = compress_sh0_op(
            np.asarray(v['f_dc_0']), np.asarray(v['f_dc_1']), np.asarray(v['f_dc_2']),
            np.asarray(v['opacity']),
            width, height, 'sh0', iterations, zf
        )
        
        # SH Rest
        sh_keys = [p.name for p in v.properties if p.name.startswith('f_rest_')]
        if sh_keys:
            print(f"Compressing {len(sh_keys)} SH coefficients...")
            sh_data_list = [np.asarray(v[k]) for k in sh_keys]
            sh_data = np.stack(sh_data_list, axis=1)
            meta['shN'] = compress_shN(sh_data, width, height, iterations, zf)
            
        # Params (if fit)
        if 'lifetime_mu' in v:
            print("Compressing Params...")
            meta['params'] = compress_params(
                np.asarray(v['lifetime_mu']), np.asarray(v['lifetime_w']),
                np.zeros(N) if 'is_param' not in v else np.asarray(v['is_param']), # Default is_param?
                width, height, iterations, zf
            )
            
        # 2. Extract and Compress Banks
        
        # XYZ Bank
        xyz_bank_keys = [p.name for p in v.properties if p.name.startswith('xyz_bank_')]
        if xyz_bank_keys:
            print("Compressing XYZ Bank...")
            max_k = 0
            for k in xyz_bank_keys:
                max_k = max(max_k, int(k.split('_')[2]))
            K_xyz = max_k + 1
            
            meta['xyz_bank'] = []
            for k in range(K_xyz):
                # Check if this bank exists (might be implicit K?)
                # We inferred K from max index, so 0..K-1 should exist.
                # But careful if some k are missing (unlikely in bank format).
                try:
                    xb_meta = compress_means(
                        np.asarray(v[f'xyz_bank_{k}_x']),
                        np.asarray(v[f'xyz_bank_{k}_y']),
                        np.asarray(v[f'xyz_bank_{k}_z']),
                        width, height, f'xyz_bank_{k}', zf
                    )
                    meta['xyz_bank'].append(xb_meta)
                    print(f"  XYZ Bank {k} done.")
                except KeyError:
                    print(f"  Warning: xyz_bank_{k} missing columns.")
                    
        # F_DC Bank (New)
        f_dc_bank_keys = [p.name for p in v.properties if p.name.startswith('f_dc_bank_')]
        if f_dc_bank_keys:
            print("Compressing F_DC Bank...")
            max_k = 0
            for k in f_dc_bank_keys:
                max_k = max(max_k, int(k.split('_')[3]))
            K_dc = max_k + 1
            
            meta['f_dc_bank'] = []
            for k in range(K_dc):
                try:
                    # Compress as means (Log-Normalized 3-channel image)
                    # Note: DC features are not spatial coords, but compress_means
                    # works generic for any 3-channel float data.
                    # It applies log transform, which might flatten color dynamic range?
                    # DC is usually [-SH_C0*0.282, +...] ~ RGB.
                    # RGB is roughly 0-1 (unbounded for HDR).
                    # Log transform helps if dynamic range is large.
                    
                    dc_meta = compress_means(
                        np.asarray(v[f'f_dc_bank_{k}_0']),
                        np.asarray(v[f'f_dc_bank_{k}_1']),
                        np.asarray(v[f'f_dc_bank_{k}_2']),
                        width, height, f'f_dc_bank_{k}', zf
                    )
                    meta['f_dc_bank'].append(dc_meta)
                    print(f"  F_DC Bank {k} done.")
                except KeyError:
                    print(f"  Warning: f_dc_bank_{k} missing columns.")
                
        # ROT Bank
        rot_bank_keys = [p.name for p in v.properties if p.name.startswith('rot_bank_')]
        if rot_bank_keys:
            print("Compressing ROT Bank...")
            max_k = 0
            for k in rot_bank_keys:
                max_k = max(max_k, int(k.split('_')[2]))
            K_rot = max_k + 1
            
            meta['rot_bank'] = []
            for k in range(K_rot):
                try:
                    rb_meta = compress_quats(
                        np.asarray(v[f'rot_bank_{k}_x']),
                        np.asarray(v[f'rot_bank_{k}_y']),
                        np.asarray(v[f'rot_bank_{k}_z']),
                        np.asarray(v[f'rot_bank_{k}_w']),
                        width, height, f'rot_bank_{k}', zf
                    )
                    meta['rot_bank'].append(rb_meta)
                    print(f"  ROT Bank {k} done.")
                except KeyError:
                     print(f"  Warning: rot_bank_{k} missing columns.")
                
        # Metadata
        # Copy original comments (strides, etc) to meta?
        # Standard SOG viewers won't read comments, but we can store them in meta.json
        # 'custom' field is often safe.
        custom_data = {}
        for c in plydata.comments:
            parts = c.split()
            if len(parts) >= 2:
                 custom_data[parts[0]] = parts[1]
        if custom_data:
            meta['custom'] = custom_data
            
        zf.writestr('meta.json', json.dumps(meta, indent=2))
        
    print(f"Done. Saved to {output_sog}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert Master PLY to SOG (Native)")
    parser.add_argument("input_ply", help="Master PLY file")
    parser.add_argument("output_sog", help="Output SOG file")
    parser.add_argument("--iterations", type=int, default=10, help="K-Means iterations")
    
    args = parser.parse_args()
    
    convert_master_to_sog(args.input_ply, args.output_sog, args.iterations)
