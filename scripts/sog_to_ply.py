#!/usr/bin/env python3

import argparse
import json
import math
import os
import zipfile
import numpy as np
from PIL import Image

def sigmoid(x):
    return 1 / (1 + np.exp(-x))

def inverse_sigmoid(y):
    # y = 1 / (1 + exp(-x))
    # 1 + exp(-x) = 1/y
    # exp(-x) = 1/y - 1 = (1-y)/y
    # -x = ln((1-y)/y)
    # x = -ln((1-y)/y) = ln(y/(1-y))
    # Clip y to avoid div by zero or log(0)
    y = np.clip(y, 1e-6, 1 - 1e-6)
    return np.log(y / (1 - y))

def inverse_log_transform(encoded_val):
    # encoded = sign(v) * log(abs(v) + 1)
    # abs(encoded) = log(abs(v) + 1)
    # exp(abs(encoded)) = abs(v) + 1
    # abs(v) = exp(abs(encoded)) - 1
    # v = sign(encoded) * (exp(abs(encoded)) - 1)
    return np.sign(encoded_val) * (np.exp(np.abs(encoded_val)) - 1)

def read_webp_to_array(zf, filename):
    with zf.open(filename) as f:
        img = Image.open(f)
        # Ensure RGBA
        img = img.convert('RGBA')
        return np.array(img)

def reconstruct_means(zf, meta):
    print("Reconstructing Means...")
    means_cfg = meta['means']
    means_l_file = means_cfg['files'][0]
    means_u_file = means_cfg['files'][1]
    
    means_L = read_webp_to_array(zf, means_l_file) # (H, W, 4)
    means_U = read_webp_to_array(zf, means_u_file)
    
    count = meta['count']
    width = means_L.shape[1]
    
    # Flatten
    means_L = means_L.reshape(-1, 4)[:count]
    means_U = means_U.reshape(-1, 4)[:count]
    
    # Reconstruct 16-bit normalized
    # U << 8 | L
    nx = (means_U[:, 0].astype(np.uint16) << 8) | means_L[:, 0].astype(np.uint16)
    ny = (means_U[:, 1].astype(np.uint16) << 8) | means_L[:, 1].astype(np.uint16)
    nz = (means_U[:, 2].astype(np.uint16) << 8) | means_L[:, 2].astype(np.uint16)
    
    mins = means_cfg['mins']
    maxs = means_cfg['maxs']
    
    # Denormalize
    # val = norm * (max - min) / 65535 + min
    range_x = maxs[0] - mins[0]
    range_y = maxs[1] - mins[1]
    range_z = maxs[2] - mins[2]
    
    lx = nx.astype(np.float32) / 65535.0 * range_x + mins[0]
    ly = ny.astype(np.float32) / 65535.0 * range_y + mins[1]
    lz = nz.astype(np.float32) / 65535.0 * range_z + mins[2]
    
    # Inverse Log
    x = inverse_log_transform(lx)
    y = inverse_log_transform(ly)
    z = inverse_log_transform(lz)
    
    return np.stack([x, y, z], axis=1)

def reconstruct_quats(zf, meta):
    print("Reconstructing Quaternions...")
    quats_cfg = meta['quats']
    q_file = quats_cfg['files'][0]
    
    q_tex = read_webp_to_array(zf, q_file)
    count = meta['count']
    
    q_flat = q_tex.reshape(-1, 4)[:count]
    
    # [0, 255] -> [-1/sqrt(2), 1/sqrt(2)] mapping?
    # Encoder: 255 * (q * 0.5 + 0.5) with q scaled by sqrt(2) before
    # q_coded = q_scaled * 0.5 + 0.5
    # q_scaled = (q_coded - 0.5) * 2 = 2*q_coded - 1
    # q_orig = q_scaled / sqrt(2)
    
    q0 = (q_flat[:, 0].astype(np.float32) / 255.0 * 2.0 - 1.0) / math.sqrt(2)
    q1 = (q_flat[:, 1].astype(np.float32) / 255.0 * 2.0 - 1.0) / math.sqrt(2)
    q2 = (q_flat[:, 2].astype(np.float32) / 255.0 * 2.0 - 1.0) / math.sqrt(2)
    
    # Component packing into alpha channel: 252 + k
    # k = alpha - 252
    k_vals = q_flat[:, 3].astype(np.int32) - 252
    
    # Reconstruct missing component
    # q0^2 + q1^2 + q2^2 + q3^2 = 1
    # sum_sq = q0^2 + q1^2 + q2^2
    # missing^2 = 1 - sum_sq
    # missing = sqrt(1 - sum_sq)  (always positive because we inverted sign if max was neg)
    
    sum_sq = q0**2 + q1**2 + q2**2
    # Clamp to 1.0 to avoid nan from float error
    sum_sq = np.minimum(sum_sq, 1.0)
    missing = np.sqrt(1.0 - sum_sq)
    
    qs = np.zeros((count, 4), dtype=np.float32)
    
    # Fill based on k
    # k=0: max comp was 0 -> dropped 1,2,3 -> indices stored as q0,q1,q2 are 1,2,3
    # Wait, encoder mapping:
    # k=0: idx=[1,2,3]. stored q0->1, q1->2, q2->3. Missing 0.
    # k=1: idx=[0,2,3]. stored q0->0, q1->2, q2->3. Missing 1.
    # k=2: idx=[0,1,3]. stored q0->0, q1->1, q2->3. Missing 2.
    # k=3: idx=[0,1,2]. stored q0->0, q1->1, q2->2. Missing 3.
    
    # We can do this with masks
    
    # k=0
    m0 = (k_vals == 0)
    qs[m0, 1] = q0[m0]
    qs[m0, 2] = q1[m0]
    qs[m0, 3] = q2[m0]
    qs[m0, 0] = missing[m0]
    
    # k=1
    m1 = (k_vals == 1)
    qs[m1, 0] = q0[m1]
    qs[m1, 2] = q1[m1]
    qs[m1, 3] = q2[m1]
    qs[m1, 1] = missing[m1]
    
    # k=2
    m2 = (k_vals == 2)
    qs[m2, 0] = q0[m2]
    qs[m2, 1] = q1[m2]
    qs[m2, 3] = q2[m2]
    qs[m2, 2] = missing[m2]
    
    # k=3
    m3 = (k_vals == 3)
    qs[m3, 0] = q0[m3]
    qs[m3, 1] = q1[m3]
    qs[m3, 2] = q2[m3]
    qs[m3, 3] = missing[m3]
    
    return qs

def reconstruct_scales(zf, meta):
    print("Reconstructing Scales...")
    scales_cfg = meta['scales']
    codebook = np.array(scales_cfg['codebook'], dtype=np.float32) # (256,)
    
    s_file = scales_cfg['files'][0]
    s_tex = read_webp_to_array(zf, s_file)
    count = meta['count']
    
    s_flat = s_tex.reshape(-1, 4)[:count]
    
    # Indices
    idx0 = s_flat[:, 0]
    idx1 = s_flat[:, 1]
    idx2 = s_flat[:, 2]
    
    s0 = codebook[idx0]
    s1 = codebook[idx1]
    s2 = codebook[idx2]
    
    return np.stack([s0, s1, s2], axis=1)

def reconstruct_colors_opacity(zf, meta):
    print("Reconstructing Colors/Opacity...")
    sh0_cfg = meta['sh0']
    codebook = np.array(sh0_cfg['codebook'], dtype=np.float32) # (256,)
    
    c_file = sh0_cfg['files'][0]
    c_tex = read_webp_to_array(zf, c_file)
    count = meta['count']
    
    c_flat = c_tex.reshape(-1, 4)[:count]
    
    # DC coeffs
    idx0 = c_flat[:, 0]
    idx1 = c_flat[:, 1]
    idx2 = c_flat[:, 2]
    
    f0 = codebook[idx0]
    f1 = codebook[idx1]
    f2 = codebook[idx2]
    
    # Opacity
    # stored as uint8 0-255 representing sigmoid(op) [0-1]
    op_u8 = c_flat[:, 3]
    op_sigmoid = op_u8.astype(np.float32) / 255.0
    op = inverse_sigmoid(op_sigmoid)
    
    return np.stack([f0, f1, f2], axis=1), op

def reconstruct_sh(zf, meta):
    if 'shN' not in meta:
        return None
    
    print("Reconstructing SH Bands...")
    sh_cfg = meta['shN']
    codebook = np.array(sh_cfg['codebook'], dtype=np.float32) # (256,)
    
    cent_file = sh_cfg['files'][0] # indices into codebook
    labels_file = sh_cfg['files'][1] # indices into palette
    
    # 1. Reconstruct SH Centroids (Palette)
    # Texture: each pixel R,G,B is an index into codebook
    cent_tex = read_webp_to_array(zf, cent_file)
    cent_flat = cent_tex.reshape(-1, 3) # Flattened by pixel 
    # Note: Flattening like this might cross palette boundaries if width not aligned?
    # In encoder:
    # c_width = 64 * coeffs_per_color
    # c_height = ceil(palette_size / 64)
    # pixel_idx = (i // 64) * c_width + (i % 64) * coeffs_per_color + j
    
    # Let's read pixels linearly.
    # The palette size is meta['shN']['count']
    palette_size = sh_cfg['count']
    
    bands = sh_cfg.get('bands', 3) # default max?
    # bands=1 -> 9 coeffs. bands=2 -> 24.
    if bands == 1: num_coeffs = 9
    elif bands == 2: num_coeffs = 24
    else: num_coeffs = 45 # bands=3
    
    coeffs_per_color = num_coeffs // 3
    
    # Reconstruct Palette (palette_size, num_coeffs)
    palette = np.zeros((palette_size, num_coeffs), dtype=np.float32)
    
    c_width = cent_tex.shape[1]
    
    cent_flat_img = cent_tex.reshape(-1, 4) # (H*W, 4)
    
    for i in range(palette_size):
        row = i // 64
        col_base = (i % 64) * coeffs_per_color
        
        pixel_start = row * c_width + col_base
        
        for j in range(coeffs_per_color):
            pixel = cent_flat_img[pixel_start + j]
            # pixel R,G,B are indices for R,G,B channels of this coeff group
            # Wait, encoder:
            # c_tex_flat[pixel_idx * 4 + 0] = idx_R
            # c_tex_flat[pixel_idx * 4 + 1] = idx_G
            # c_tex_flat[pixel_idx * 4 + 2] = idx_B
            
            # codebook is 1D shared codebook.
            
            idx_R = pixel[0]
            idx_G = pixel[1]
            idx_B = pixel[2]
            
            # Map to flat index in palette row
            # Palette row layout: [R_0...R_n, G_0...G_n, B_0...B_n] or interleaved?
            # Encoder input sh_data was stack of [f_rest_0, ... f_rest_N]
            # If input was interleaved (R,G,B, R,G,B...), then codebook naturally learns that.
            # But here we explicitly split idx_R/G/B from pixel channels.
            # And encoder did:
            # idx_R = sh_centroids_labels[i, coeffs_per_color * 0 + j]
            # so input columns 0..cpc-1 are R
            
            palette[i, coeffs_per_color * 0 + j] = codebook[idx_R]
            palette[i, coeffs_per_color * 1 + j] = codebook[idx_G]
            palette[i, coeffs_per_color * 2 + j] = codebook[idx_B]
            
    # 2. Use labels map to reconstruct full SH
    labels_tex = read_webp_to_array(zf, labels_file)
    count = meta['count']
    l_flat = labels_tex.reshape(-1, 4)[:count]
    
    # L | U<<8
    labels = l_flat[:, 0].astype(np.uint16) | (l_flat[:, 1].astype(np.uint16) << 8)
    
    # Lookup
    # (N, num_coeffs)
    sh_data = palette[labels]
    
    return sh_data

def reconstruct_lifetime(zf, meta):
    if 'lifetime' not in meta:
        return None
    
    print("Reconstructing Lifetime...")
    l_cfg = meta['lifetime']
    l_file = l_cfg['files'][0]
    l_tex = read_webp_to_array(zf, l_file)
    count = meta['count']
    l_flat = l_tex.reshape(-1, 4)[:count]
    
    # Loader Logic:
    # mu = (tex[0] / 255.0) * (max - min) + min
    
    min_mu = l_cfg['mins'][0] if 'mins' in l_cfg else 0.0
    max_mu = l_cfg['maxs'][0] if 'maxs' in l_cfg else 100.0
    min_w = l_cfg['mins'][1] if 'mins' in l_cfg else 0.0
    max_w = l_cfg['maxs'][1] if 'maxs' in l_cfg else 10.0
    
    mu_norm = l_flat[:, 0].astype(np.float32) / 255.0
    w_norm = l_flat[:, 1].astype(np.float32) / 255.0
    
    mu = mu_norm * (max_mu - min_mu) + min_mu
    w = w_norm * (max_w - min_w) + min_w
    is_param = np.ones_like(mu) # Default to 1? Or 10.0 as K? Loader sets k=10.0
    
    return np.stack([mu, w, is_param], axis=1)

def reconstruct_params(zf, meta):
    # Try lifetime first
    if 'lifetime' in meta:
        return reconstruct_lifetime(zf, meta)
        
    if 'params' in meta:
        try:
            print("Reconstructing Params...")
            p_cfg = meta['params']
            
            # Check for combined codebook vs split
            if 'codebook_mu' in p_cfg:
                codebook_mu = np.array(p_cfg['codebook_mu'], dtype=np.float32)
                codebook_w = np.array(p_cfg['codebook_w'], dtype=np.float32)
                codebook_p = np.array(p_cfg['codebook_is_param'], dtype=np.float32)
                
                p_file = p_cfg['files'][0]
                p_tex = read_webp_to_array(zf, p_file)
                count = meta['count']
                p_flat = p_tex.reshape(-1, 4)[:count]
                
                idx_mu = p_flat[:, 0]
                idx_w = p_flat[:, 1]
                idx_is_param = p_flat[:, 2]
                
                mu = codebook_mu[idx_mu]
                w = codebook_w[idx_w]
                is_param = codebook_p[idx_is_param]
                return np.stack([mu, w, is_param], axis=1)
            else:
                 print("Warning: Unknown params format (codebook singular?). Skipping.")
        except Exception as e:
            print(f"Error reconstructing params: {e}. Using defaults.")

    # Defaults
    count = meta['count']
    mu = np.zeros(count, dtype=np.float32)
    w = np.full(count, 100.0, dtype=np.float32) # Wide enough to be visible
    is_param = np.zeros(count, dtype=np.float32)
    return np.stack([mu, w, is_param], axis=1)

def write_ply(filename, positions, rotation, scale, color, opacity, sh_rest, params):
    print(f"Writing {filename}...")
    
    count = len(positions)
    
    # Prepare data for writing
    # Construct dtype list
    dtype_list = [
        ('x', 'f4'), ('y', 'f4'), ('z', 'f4'),
        ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4'), # nx,ny,nz are usually normal, often 0 for splats
        ('f_dc_0', 'f4'), ('f_dc_1', 'f4'), ('f_dc_2', 'f4')
    ]
    
    # SH
    if sh_rest is not None:
        num_sh = sh_rest.shape[1]
        for i in range(num_sh):
            dtype_list.append((f'f_rest_{i}', 'f4'))
            
    dtype_list.extend([
        ('opacity', 'f4'),
        ('scale_0', 'f4'), ('scale_1', 'f4'), ('scale_2', 'f4'),
        ('rot_0', 'f4'), ('rot_1', 'f4'), ('rot_2', 'f4'), ('rot_3', 'f4')
    ])
    
    if params is not None:
         dtype_list.extend([
            ('mu', 'f4'), ('w', 'f4'), ('is_param', 'f4')
         ])
         
    # Dummy normals 
    normals = np.zeros_like(positions)
    
    # Structure array
    data = np.zeros(count, dtype=dtype_list)
    
    data['x'] = positions[:, 0]
    data['y'] = positions[:, 1]
    data['z'] = positions[:, 2]
    
    data['nx'] = normals[:, 0]
    data['ny'] = normals[:, 1]
    data['nz'] = normals[:, 2]
    
    data['f_dc_0'] = color[:, 0]
    data['f_dc_1'] = color[:, 1]
    data['f_dc_2'] = color[:, 2]
    
    if sh_rest is not None:
        for i in range(sh_rest.shape[1]):
             data[f'f_rest_{i}'] = sh_rest[:, i]
             
    data['opacity'] = opacity
    
    data['scale_0'] = scale[:, 0]
    data['scale_1'] = scale[:, 1]
    data['scale_2'] = scale[:, 2]
    
    data['rot_0'] = rotation[:, 0]
    data['rot_1'] = rotation[:, 1]
    data['rot_2'] = rotation[:, 2]
    data['rot_3'] = rotation[:, 3]
    
    if params is not None:
        data['mu'] = params[:, 0]
        data['w'] = params[:, 1]
        data['is_param'] = params[:, 2]
        
    # Header
    header = "ply\n"
    header += "format binary_little_endian 1.0\n"
    header += f"element vertex {count}\n"
    
    for name, typ in dtype_list:
        header += f"property float {name}\n"
        
    header += "end_header\n"
    
    with open(filename, 'wb') as f:
        f.write(header.encode('ascii'))
        data.tofile(f)

def process_sog_to_ply(input_sog, output_ply):
    print(f"Reading {input_sog}...")
    with zipfile.ZipFile(input_sog, 'r') as zf:
        with zf.open('meta.json') as f:
            meta = json.load(f)
            
        print(f"Count: {meta['count']}")
        
        positions = reconstruct_means(zf, meta)
        rotation = reconstruct_quats(zf, meta)
        scale = reconstruct_scales(zf, meta)
        color, opacity = reconstruct_colors_opacity(zf, meta)
        sh_rest = reconstruct_sh(zf, meta)
        params = reconstruct_params(zf, meta)
        
        write_ply(output_ply, positions, rotation, scale, color, opacity, sh_rest, params)
        
    print(f"Converted {input_sog} -> {output_ply}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Convert SOG to PLY')
    parser.add_argument('input', help='Input SOG file')
    parser.add_argument('output', help='Output PLY file')
    
    args = parser.parse_args()
    
    process_sog_to_ply(args.input, args.output)
