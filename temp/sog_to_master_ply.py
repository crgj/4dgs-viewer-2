
import os
import argparse
import numpy as np
import json
import math
import zipfile
from PIL import Image
from plyfile import PlyData, PlyElement
from tqdm import tqdm

# ==========================================
# Helpers
# ==========================================

def read_webp_to_array(zf, filename):
    with zf.open(filename) as f:
        img = Image.open(f)
        img = img.convert('RGBA')
        return np.array(img)

def inverse_log_transform(encoded_val):
    return np.sign(encoded_val) * (np.exp(np.abs(encoded_val)) - 1)

def inverse_sigmoid(y):
    y = np.clip(y, 1e-6, 1 - 1e-6)
    return np.log(y / (1 - y))

def reconstruct_means(zf, meta_obj, count):
    # Works for 'means' or 'xyz_bank_k' entries if they follow same structure
    means_cfg = meta_obj
    means_l_file = means_cfg['files'][0]
    means_u_file = means_cfg['files'][1]
    
    means_L = read_webp_to_array(zf, means_l_file).reshape(-1, 4)[:count]
    means_U = read_webp_to_array(zf, means_u_file).reshape(-1, 4)[:count]
    
    nx = (means_U[:, 0].astype(np.uint16) << 8) | means_L[:, 0].astype(np.uint16)
    ny = (means_U[:, 1].astype(np.uint16) << 8) | means_L[:, 1].astype(np.uint16)
    nz = (means_U[:, 2].astype(np.uint16) << 8) | means_L[:, 2].astype(np.uint16)
    
    mins = means_cfg['mins']
    maxs = means_cfg['maxs']
    
    range_x = maxs[0] - mins[0]
    range_y = maxs[1] - mins[1]
    range_z = maxs[2] - mins[2]
    
    lx = nx.astype(np.float32) / 65535.0 * range_x + mins[0]
    ly = ny.astype(np.float32) / 65535.0 * range_y + mins[1]
    lz = nz.astype(np.float32) / 65535.0 * range_z + mins[2]
    
    x = inverse_log_transform(lx)
    y = inverse_log_transform(ly)
    z = inverse_log_transform(lz)
    
    return np.stack([x, y, z], axis=1)

def reconstruct_quats(zf, meta_obj, count):
    quats_cfg = meta_obj
    q_file = quats_cfg['files'][0]
    
    q_tex = read_webp_to_array(zf, q_file)
    q_flat = q_tex.reshape(-1, 4)[:count]
    
    q0 = (q_flat[:, 0].astype(np.float32) / 255.0 * 2.0 - 1.0) / math.sqrt(2)
    q1 = (q_flat[:, 1].astype(np.float32) / 255.0 * 2.0 - 1.0) / math.sqrt(2)
    q2 = (q_flat[:, 2].astype(np.float32) / 255.0 * 2.0 - 1.0) / math.sqrt(2)
    
    k_vals = q_flat[:, 3].astype(np.int32) - 252
    
    sum_sq = np.minimum(q0**2 + q1**2 + q2**2, 1.0)
    missing = np.sqrt(1.0 - sum_sq)
    
    qs = np.zeros((count, 4), dtype=np.float32)
    
    # k=0: drop 0. stored 1,2,3
    m0 = (k_vals == 0); qs[m0, 1] = q0[m0]; qs[m0, 2] = q1[m0]; qs[m0, 3] = q2[m0]; qs[m0, 0] = missing[m0]
    # k=1: drop 1. stored 0,2,3
    m1 = (k_vals == 1); qs[m1, 0] = q0[m1]; qs[m1, 2] = q1[m1]; qs[m1, 3] = q2[m1]; qs[m1, 1] = missing[m1]
    # k=2: drop 2. stored 0,1,3
    m2 = (k_vals == 2); qs[m2, 0] = q0[m2]; qs[m2, 1] = q1[m2]; qs[m2, 3] = q2[m2]; qs[m2, 2] = missing[m2]
    # k=3: drop 3. stored 0,1,2
    m3 = (k_vals == 3); qs[m3, 0] = q0[m3]; qs[m3, 1] = q1[m3]; qs[m3, 2] = q2[m3]; qs[m3, 3] = missing[m3]
    
    return qs

def reconstruct_scales(zf, meta, count):
    scales_cfg = meta['scales']
    codebook = np.array(scales_cfg['codebook'], dtype=np.float32)
    s_tex = read_webp_to_array(zf, scales_cfg['files'][0])
    s_flat = s_tex.reshape(-1, 4)[:count]
    return np.stack([codebook[s_flat[:,0]], codebook[s_flat[:,1]], codebook[s_flat[:,2]]], axis=1)

def reconstruct_colors_opacity(zf, meta, count):
    sh0_cfg = meta['sh0']
    codebook = np.array(sh0_cfg['codebook'], dtype=np.float32)
    c_tex = read_webp_to_array(zf, sh0_cfg['files'][0])
    c_flat = c_tex.reshape(-1, 4)[:count]
    
    f0 = codebook[c_flat[:,0]]
    f1 = codebook[c_flat[:,1]]
    f2 = codebook[c_flat[:,2]]
    
    op_u8 = c_flat[:,3]
    # PLY usually wants Logit Opacity
    # SOG stores Sigmoid(Op). We inverse sigmoid to get Logit.
    op_sigmoid = op_u8.astype(np.float32) / 255.0
    op = inverse_sigmoid(op_sigmoid)
    
    return np.stack([f0, f1, f2], axis=1), op

def reconstruct_sh(zf, meta, count):
    if 'shN' not in meta: return None
    sh_cfg = meta['shN']
    codebook = np.array(sh_cfg['codebook'], dtype=np.float32)
    
    cent_tex = read_webp_to_array(zf, sh_cfg['files'][0])
    labels_tex = read_webp_to_array(zf, sh_cfg['files'][1])
    
    # 1. Reconstruct Palette
    palette_size = sh_cfg['count']
    bands = sh_cfg.get('bands', 3)
    num_coeffs = {1: 9, 2: 24, 3: 45}.get(bands, 45)
    coeffs_per_color = num_coeffs // 3
    
    palette = np.zeros((palette_size, num_coeffs), dtype=np.float32)
    c_width = cent_tex.shape[1]
    cent_flat = cent_tex.reshape(-1, 4)
    
    for i in range(palette_size):
        for j in range(coeffs_per_color):
            pixel_idx = (i // 64) * c_width + (i % 64) * coeffs_per_color + j
            pixel = cent_flat[pixel_idx]
            palette[i, coeffs_per_color*0+j] = codebook[pixel[0]]
            palette[i, coeffs_per_color*1+j] = codebook[pixel[1]]
            palette[i, coeffs_per_color*2+j] = codebook[pixel[2]]
            
    # 2. Labels -> SH
    l_flat = labels_tex.reshape(-1, 4)[:count]
    labels = l_flat[:,0].astype(np.uint16) | (l_flat[:,1].astype(np.uint16) << 8)
    return palette[labels]

def reconstruct_params(zf, meta, count):
    if 'params' not in meta: return None
    p_cfg = meta['params']
    mu_cb = np.array(p_cfg['codebook_mu'], dtype=np.float32)
    w_cb = np.array(p_cfg['codebook_w'], dtype=np.float32)
    is_p_cb = np.array(p_cfg['codebook_is_param'], dtype=np.float32)
    
    p_tex = read_webp_to_array(zf, p_cfg['files'][0])
    p_flat = p_tex.reshape(-1, 4)[:count]
    
    return np.stack([mu_cb[p_flat[:,0]], w_cb[p_flat[:,1]], is_p_cb[p_flat[:,2]]], axis=1)

# ==========================================
# Main Conversion
# ==========================================

def convert_sog_to_master(input_sog, output_ply):
    print(f"Reading SOG: {input_sog}")
    with zipfile.ZipFile(input_sog, 'r') as zf:
        with zf.open('meta.json') as f:
            meta = json.load(f)
            
        count = meta['count']
        print(f"Count: {count}")
        
        # 1. Standard Attributes
        print("Reconstructing Standard Attributes...")
        pos = reconstruct_means(zf, meta['means'], count)
        quat = reconstruct_quats(zf, meta['quats'], count)
        scale = reconstruct_scales(zf, meta, count)
        color, opacity = reconstruct_colors_opacity(zf, meta, count)
        sh_rest = reconstruct_sh(zf, meta, count)
        params = reconstruct_params(zf, meta, count)
        
        # 2. Bank Attributes
        xyz_banks = []
        if 'xyz_bank' in meta:
            print("Reconstructing XYZ Banks...")
            for i, xb_meta in enumerate(meta['xyz_bank']):
                xyz_banks.append(reconstruct_means(zf, xb_meta, count))
                
        rot_banks = []
        if 'rot_bank' in meta:
            print("Reconstructing ROT Banks...")
            for i, rb_meta in enumerate(meta['rot_bank']):
                rot_banks.append(reconstruct_quats(zf, rb_meta, count))

        f_dc_banks = []
        if 'f_dc_bank' in meta:
            print("Reconstructing F_DC Banks...")
            for i, dc_meta in enumerate(meta['f_dc_bank']):
                # Compressed with compress_means (log transformed)
                f_dc_banks.append(reconstruct_means(zf, dc_meta, count))
                
        # 3. Assemble PLY
        print("Assembling Data...")
        
        # Dtype construction
        dtype_list = [
            ('x', 'f4'), ('y', 'f4'), ('z', 'f4'),
            ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4'),
        ]
        num_sh0 = 3
        for i in range(num_sh0): dtype_list.append((f'f_dc_{i}', 'f4'))
        
        if sh_rest is not None:
             for i in range(sh_rest.shape[1]): dtype_list.append((f'f_rest_{i}', 'f4'))
             
        dtype_list.append(('opacity', 'f4'))
        for i in range(3): dtype_list.append((f'scale_{i}', 'f4'))
        for i in range(4): dtype_list.append((f'rot_{i}', 'f4')) # Replaces rot_bank proxy if present in static
        
        if params is not None:
            dtype_list.append(('lifetime_mu', 'f4'))
            dtype_list.append(('lifetime_w', 'f4'))
            # dtype_list.append(('is_param', 'f4')) # if needed
            
        for k in range(len(xyz_banks)):
            for c in ['x','y','z']: dtype_list.append((f'xyz_bank_{k}_{c}', 'f4'))
            
        for k in range(len(rot_banks)):
            for c in ['x','y','z','w']: dtype_list.append((f'rot_bank_{k}_{c}', 'f4'))
            
        for k in range(len(f_dc_banks)):
            for c in range(3): dtype_list.append((f'f_dc_bank_{k}_{c}', 'f4'))

        data = np.zeros(count, dtype=dtype_list)
        
        data['x'] = pos[:,0]; data['y'] = pos[:,1]; data['z'] = pos[:,2]
        data['nx'] = 0; data['ny'] = 0; data['nz'] = 0
        
        data['f_dc_0'] = color[:,0]; data['f_dc_1'] = color[:,1]; data['f_dc_2'] = color[:,2]
        
        if sh_rest is not None:
            for i in range(sh_rest.shape[1]): data[f'f_rest_{i}'] = sh_rest[:,i]
            
        data['opacity'] = opacity
        data['scale_0'] = scale[:,0]; data['scale_1'] = scale[:,1]; data['scale_2'] = scale[:,2]
        data['rot_0'] = quat[:,0]; data['rot_1'] = quat[:,1]; data['rot_2'] = quat[:,2]; data['rot_3'] = quat[:,3]
        
        if params is not None:
            data['lifetime_mu'] = params[:,0]
            data['lifetime_w'] = params[:,1]
            
        for k, bank in enumerate(xyz_banks):
            data[f'xyz_bank_{k}_x'] = bank[:,0]
            data[f'xyz_bank_{k}_y'] = bank[:,1]
            data[f'xyz_bank_{k}_z'] = bank[:,2]
            
        for k, bank in enumerate(rot_banks):
            data[f'rot_bank_{k}_x'] = bank[:,0]
            data[f'rot_bank_{k}_y'] = bank[:,1]
            data[f'rot_bank_{k}_z'] = bank[:,2]
            data[f'rot_bank_{k}_w'] = bank[:,3]
            
        for k, bank in enumerate(f_dc_banks):
            data[f'f_dc_bank_{k}_0'] = bank[:,0]
            data[f'f_dc_bank_{k}_1'] = bank[:,1]
            data[f'f_dc_bank_{k}_2'] = bank[:,2]

        # Metadata from custom
        comments = []
        if 'custom' in meta:
            for k, v in meta['custom'].items():
                comments.append(f"{k} {v}")
                
        print(f"Saving to {output_ply}...")
        el = PlyElement.describe(data, 'vertex')
        PlyData([el], comments=comments).write(output_ply)
        
    print("Done.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert SOG to Master PLY (Native)")
    parser.add_argument("input_sog", help="Input SOG file")
    parser.add_argument("output_ply", help="Output Master PLY file")
    
    args = parser.parse_args()
    
    convert_sog_to_master(args.input_sog, args.output_ply)
