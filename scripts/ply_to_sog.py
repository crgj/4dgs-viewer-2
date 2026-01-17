#!/usr/bin/env python3

import argparse
import json
import math
import os
import struct
import time
import zipfile
import numpy as np
from PIL import Image

# --- PLY Reading ---

def read_ply(filename):
    """
    Reads a standard PLY file and returns a dictionary of elements.
    Supports binary_little_endian.
    """
    with open(filename, 'rb') as f:
        # Read header
        header_lines = []
        while True:
            line = f.readline().decode('ascii').strip()
            header_lines.append(line)
            if line == 'end_header':
                break
        
        elements = []
        current_element = None
        
        # Parse header
        for line in header_lines:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == 'element':
                current_element = {
                    'name': parts[1],
                    'count': int(parts[2]),
                    'properties': []
                }
                elements.append(current_element)
            elif parts[0] == 'property':
                if current_element is None:
                    continue
                # Handle list properties if necessary (not common in splats but good to known)
                # For splats it's usually: property float x
                current_element['properties'].append({
                    'name': parts[-1],
                    'type': parts[1] # e.g. float
                })
        
        # Read data
        data = {}
        
        # Mapping PLY types to numpy types
        type_map = {
            'char': 'i1', 'uchar': 'u1',
            'short': 'i2', 'ushort': 'u2',
            'int': 'i4', 'uint': 'u4',
            'float': 'f4', 'double': 'f8'
        }

        for elem in elements:
            count = elem['count']
            props = elem['properties']
            
            # Construct dtype
            dtype_list = []
            prop_names = []
            for prop in props:
                dtype_list.append((prop['name'], type_map.get(prop['type'], 'f4')))
                prop_names.append(prop['name'])
            
            # Read whole block
            elem_data = np.fromfile(f, dtype=dtype_list, count=count)
            data[elem['name']] = elem_data

    return data

# --- K-Means (Manual Implementation) ---

def initialize_centroids_1d(data, k):
    """
    Quantile-based initialization for 1D data.
    """
    n = len(data)
    sorted_data = np.sort(data)
    centroids = np.zeros(k, dtype=data.dtype)
    for i in range(k):
        quantile = (2 * i + 1) / (2 * k)
        index = min(int(math.floor(quantile * n)), n - 1)
        centroids[i] = sorted_data[index]
    return centroids

def kmeans_1d(data, k, iterations=10):
    """
    Runs K-Means on 1D data.
    data: 1D numpy array
    k: number of clusters
    """
    # Initialize
    centroids = initialize_centroids_1d(data, k)
    
    # Iterate
    for _ in range(iterations):
        # Assignment: find nearest centroid
        # Reshape for broadcasting: (N, 1) - (1, K)
        dists = np.abs(data[:, None] - centroids[None, :])
        labels = np.argmin(dists, axis=1)
        
        # Update
        for i in range(k):
            mask = (labels == i)
            if np.any(mask):
                centroids[i] = np.mean(data[mask])
            else:
                # Re-init empty cluster to a random point
                centroids[i] = data[np.random.randint(len(data))]
                
    # Sort centroids
    sorted_indices = np.argsort(centroids)
    centroids = centroids[sorted_indices]
    
    # Re-assign labels based on sorted centroids
    dists = np.abs(data[:, None] - centroids[None, :])
    labels = np.argmin(dists, axis=1)
    
    return centroids.astype(np.float32), labels.astype(np.uint32)


def kmeans_nd(data, k, iterations=10, batch_size=1024):
    """
    Runs K-Means on ND data using mini-batch assignment to save memory.
    data: (N, D) numpy array
    k: number of clusters
    """
    n, d = data.shape
    
    # Initialize randomly
    # Use a seed for reproducibility if desired, but random is fine
    indices = np.random.choice(n, k, replace=False)
    centroids = data[indices].copy()
    
    labels = np.zeros(n, dtype=np.uint32)
    
    # Pre-allocate arrays for batch processing to avoid re-allocation
    # We need to compute distances. 
    # ||x - c||^2 = ||x||^2 + ||c||^2 - 2 <x, c>
    # calculating this is faster than broadcasting difference
    
    for iter_idx in range(iterations):
        print(f"    Iteration {iter_idx+1}/{iterations}...")
        
        # Precompute centroid norms squared
        c_norms_sq = np.sum(centroids**2, axis=1) # (K,)
        
        # Assign labels in batches
        for i in range(0, n, batch_size):
            end = min(i + batch_size, n)
            batch = data[i:end] # (B, D)
            
            # Compute distances efficiently
            # dists^2 = x^2 + c^2 - 2xc
            # We don't need x^2 for argmin, so just c^2 - 2xc
            
            # (B, K) = (B, D) @ (D, K)
            dot_prod = np.dot(batch, centroids.T)
            
            # exposure to potential precision issues with float32 if values are large
            # but usually fine for normalized/small data.
            # dist_metric = c_norms_sq - 2 * dot_prod
            
            # Broadcasting: (K,) - (B, K) -> (B, K)
            dist_metric = c_norms_sq[None, :] - 2 * dot_prod
            
            labels[i:end] = np.argmin(dist_metric, axis=1)
        
        # Update centroids
        # Recomputing means can also be heavy if we just loop K.
        # We can use np.add.at or similar but standard loop is often okay if K isn't insane.
        # With K=65536, a python loop is slow.
        # Vectorized update:
        
        new_centroids = np.zeros_like(centroids)
        counts = np.zeros(k, dtype=np.int32)
        
        # We can loop over data to accumulate sum
        # But looping over N in python is slow. 
        # Looping over K (65536) in python is also a bit slow (65k iterations).
        # Best way without extra memory is to loop over batches of data and accumulate.
        
        # However, pandas groupby or similar is fast. In pure numpy:
        # We can sort by labels and then use add.reduceat
        
        sorted_indices = np.argsort(labels)
        sorted_labels = labels[sorted_indices]
        sorted_data = data[sorted_indices]
        
        # Find indices where labels change
        # diffs is True where label changes
        # append True at end to capture last group
        uniq_labels, uniq_start_indices = np.unique(sorted_labels, return_index=True)
        
        # add.reduceat requires indices. 
        # We need to make sure we cover all K? 
        # add.reduceat sums slices.
        
        sums = np.add.reduceat(sorted_data, uniq_start_indices, axis=0)
        # sums is (num_unique_labels, D)
        
        # Counts
        # counts can be computed from uniq_start_indices difference
        # append n to calculate last count
        uniq_end_indices = np.append(uniq_start_indices[1:], n)
        group_counts = uniq_end_indices - uniq_start_indices
        
        # Assign to new_centroids
        new_centroids[uniq_labels] = sums / group_counts[:, None]
        
        # Handle empty clusters
        # If a cluster is empty, it won't be in uniq_labels.
        # We should re-init it? Or keep old?
        # Standard k-means often keeps old centroid or re-inits.
        # Let's keep old centroid if no points assigned (simple).
        mask_assigned = np.zeros(k, dtype=bool)
        mask_assigned[uniq_labels] = True
        
        # Copy old centroids for unassigned ones
        if not np.all(mask_assigned):
             new_centroids[~mask_assigned] = centroids[~mask_assigned]
             
             # Optional: re-init empty ones to random points?
             # For simplicity, keeping old is stable.
             # Or better: random point from data. 
             # Let's stick to simple "keep old" to avoid divergence or complexity.
             
        centroids = new_centroids

    return centroids.astype(np.float32), labels.astype(np.uint32)

def cluster_shared_codebook(data_columns, k, iterations=10):
    """
    Replicates the 'cluster1d' logic from TS:
    Takes multiple columns, concatenates them into one long 1D array, 
    clusters them to find shared centroids (codebook), 
    then maps original values to labels.
    """
    # Flatten all columns
    flattened = np.concatenate(data_columns)
    
    # Cluster
    centroids, all_labels = kmeans_1d(flattened, k, iterations)
    
    # Split labels back
    rows = len(data_columns[0])
    labels_list = []
    for i in range(len(data_columns)):
        labels_list.append(all_labels[i*rows : (i+1)*rows])
        
    return centroids, labels_list

# --- Morton Sorting ---

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

# --- Math Utils ---

def log_transform(value):
    return np.sign(value) * np.log(np.abs(value) + 1)

def sigmoid(x):
    return 1 / (1 + np.exp(-x))

# --- Writers ---

def layout_identity(index, width):
    return index

def save_webp(filename, data, width, height, zip_fs):
    """
    Saves buffer to WebP inside zip.
    data: (H, W, 4) numpy array of uint8
    """
    img = Image.fromarray(data, mode='RGBA')
    
    # Write to a buffer
    import io
    buf = io.BytesIO()
    # quality=100 and method=6 (slowest/best) for max compression
    # img.save(buf, format='WEBP', lossless=True, quality=100, method=6)
    img.save(buf, format='WEBP',lossless=True)
    with zip_fs.open(filename, 'w') as f:
        f.write(buf.getvalue())

def process_and_write(input_ply, output_sog, iterations=10):
    print(f"Reading {input_ply}...")
    ply_data = read_ply(input_ply)
    
    if 'vertex' not in ply_data:
        raise ValueError("No vertex element in PLY")
    
    vertices = ply_data['vertex']
    
    # Extract columns
    x = vertices['x']
    y = vertices['y']
    z = vertices['z']
    
    num_rows = len(x)
    print(f"Loaded {num_rows} Gaussians")
    
    # Morton Sort
    # Morton Sort (Skipped - data is pre-sorted in post_save.py)
    print("Sorting skipped (assumed pre-sorted)...")
    
    # Reorder all data (No-op)
    def reorder(arr):
        return arr

    # x = reorder(x)
    # y = reorder(y)
    # z = reorder(z)
    
    # Image dimensions
    width = int(math.ceil(math.sqrt(num_rows) / 4) * 4)
    height = int(math.ceil(num_rows / width / 4) * 4)
    padded_size = width * height
    
    print(f"Texture size: {width}x{height}")
    
    with zipfile.ZipFile(output_sog, 'w', compression=zipfile.ZIP_STORED) as zf:
        
        # --- MEANS ---
        print("Processing Means...")
        # Transform: log -> minmax -> 0-65535
        lx, ly, lz = log_transform(x), log_transform(y), log_transform(z)
        
        means_min = [float(np.min(lx)), float(np.min(ly)), float(np.min(lz))]
        means_max = [float(np.max(lx)), float(np.max(ly)), float(np.max(lz))]
        
        def normalize_u16(val, min_v, max_v):
            norm = (val - min_v) / (max_v - min_v)
            return (norm * 65535).astype(np.uint16)
        
        nx = normalize_u16(lx, means_min[0], means_max[0])
        ny = normalize_u16(ly, means_min[1], means_max[1])
        nz = normalize_u16(lz, means_min[2], means_max[2])
        
        # Split into Low and High bytes
        # Format: R=x, G=y, B=z, A=255
        means_L = np.zeros((padded_size, 4), dtype=np.uint8)
        means_U = np.zeros((padded_size, 4), dtype=np.uint8)
        
        # Pad data to size
        def pad(arr):
            res = np.zeros(padded_size, dtype=arr.dtype)
            res[:num_rows] = arr
            return res
            
        pnx, pny, pnz = pad(nx), pad(ny), pad(nz)
        
        means_L[:, 0] = pnx & 0xff
        means_L[:, 1] = pny & 0xff
        means_L[:, 2] = pnz & 0xff
        means_L[:, 3] = 255
        
        means_U[:, 0] = (pnx >> 8) & 0xff
        means_U[:, 1] = (pny >> 8) & 0xff
        means_U[:, 2] = (pnz >> 8) & 0xff
        means_U[:, 3] = 255
        
        save_webp('means_l.webp', means_L.reshape(height, width, 4), width, height, zf)
        save_webp('means_u.webp', means_U.reshape(height, width, 4), width, height, zf)
        
        # --- QUATERNIONS ---
        print("Processing Quaternions...")
        # Reorder quats
        rot_0 = reorder(vertices['rot_0'])
        rot_1 = reorder(vertices['rot_1'])
        rot_2 = reorder(vertices['rot_2'])
        rot_3 = reorder(vertices['rot_3'])
        
        # Normalize
        length = np.sqrt(rot_0**2 + rot_1**2 + rot_2**2 + rot_3**2)
        rot_0 /= length
        rot_1 /= length
        rot_2 /= length
        rot_3 /= length
        
        # Find max component
        quats = np.stack([rot_0, rot_1, rot_2, rot_3], axis=1) # (N, 4)
        max_indices = np.argmax(np.abs(quats), axis=1) # (N,)
        
        # Invert if max component is negative
        # Select max values: quats[np.arange(N), max_indices]
        max_vals = quats[np.arange(num_rows), max_indices]
        signs = np.sign(max_vals)
        # Fix sign=0 case if any (unlikely for normalized quats)
        signs[signs == 0] = 1
        quats *= signs[:, None]
        
        # Scale by sqrt(2)
        quats *= np.sqrt(2)
        
        # Encode
        # Indices for the 3 dropped components
        # 0 -> 1,2,3
        # 1 -> 0,2,3
        # 2 -> 0,1,3
        # 3 -> 0,1,2
        drop_map = {
            0: [1, 2, 3],
            1: [0, 2, 3],
            2: [0, 1, 3],
            3: [0, 1, 2]
        }
        
        q_tex = np.zeros((padded_size, 4), dtype=np.uint8)
        
        for i in range(num_rows):
            k = max_indices[i]
            others = drop_map[k]
            
            # Map [-1, 1] -> [0, 255]
            # 255 * (val * 0.5 + 0.5)
            q_tex[i, 0] = int(255 * (quats[i, others[0]] * 0.5 + 0.5))
            q_tex[i, 1] = int(255 * (quats[i, others[1]] * 0.5 + 0.5))
            q_tex[i, 2] = int(255 * (quats[i, others[2]] * 0.5 + 0.5))
            q_tex[i, 3] = 252 + k
            
        save_webp('quats.webp', q_tex.reshape(height, width, 4), width, height, zf)
        
        # --- SCALES ---
        print("Processing Scales...")
        s0 = reorder(vertices['scale_0'])
        s1 = reorder(vertices['scale_1'])
        s2 = reorder(vertices['scale_2'])
        
        centroids, labels_list = cluster_shared_codebook([s0, s1, s2], 256, iterations)
        
        scales_tex = np.zeros((padded_size, 4), dtype=np.uint8)
        scales_tex[:num_rows, 0] = labels_list[0]
        scales_tex[:num_rows, 1] = labels_list[1]
        scales_tex[:num_rows, 2] = labels_list[2]
        scales_tex[:, 3] = 255
        
        save_webp('scales.webp', scales_tex.reshape(height, width, 4), width, height, zf)
        scales_codebook = centroids.tolist()
        
        # --- COLORS (SH0) & OPACITY ---
        print("Processing Colors...")
        f0 = reorder(vertices['f_dc_0'])
        f1 = reorder(vertices['f_dc_1'])
        f2 = reorder(vertices['f_dc_2'])
        op = reorder(vertices['opacity'])
        
        centroids_c, labels_list_c = cluster_shared_codebook([f0, f1, f2], 256, iterations)
        
        colors_tex = np.zeros((padded_size, 4), dtype=np.uint8)
        colors_tex[:num_rows, 0] = labels_list_c[0]
        colors_tex[:num_rows, 1] = labels_list_c[1]
        colors_tex[:num_rows, 2] = labels_list_c[2]
        
        # Sigmoid opacity -> 0-255
        op_sigmoid = 1 / (1 + np.exp(-op))
        op_u8 = (op_sigmoid * 255).astype(np.uint8)
        colors_tex[:num_rows, 3] = op_u8
        
        save_webp('sh0.webp', colors_tex.reshape(height, width, 4), width, height, zf)
        colors_codebook = centroids_c.tolist()
        
        # --- SPHERICAL HARMONICS (SH N) ---
        sh_keys = [k for k in vertices.dtype.names if k.startswith('f_rest_')]
        shN_meta = None
        
        if sh_keys:
            print(f"Processing SH ({len(sh_keys)} coeffs)...")
            sh_data_list = [reorder(vertices[k]) for k in sh_keys]
            sh_data = np.stack(sh_data_list, axis=1) # (N, num_coeffs)
            
            # 1. Quantize vectors (rows) using K-Means to find paletteSize clusters
            # Palette size rule from TS: min(64, 2**floor(log2(N/1024))) * 1024
            palette_size = min(64, 2 ** int(math.floor(math.log2(num_rows / 1024)))) * 1024
            palette_size = max(palette_size, 16) # Safety
            print(f"  Clustering SH vectors into {palette_size} clusters...")
            
            # K-Means ND on the vectors
            sh_centroids, sh_labels = kmeans_nd(sh_data, palette_size, iterations)
            
            # 2. Quantize the centroids themselves (codebook) using cluster1d
            # Flatten centroids (palette_size, num_coeffs)
            print("  Quantizing SH codebook...")
            flat_centroids = sh_centroids.flatten()
            codebook_centroids, codebook_labels = kmeans_1d(flat_centroids, 256, iterations)
            
            # Pack centroids texture
            # sh_centroids is (PaletteSize, Coeffs). 
            # We map each scalar in sh_centroids to a label (index into codebook_centroids)
            sh_centroids_labels = codebook_labels.reshape(sh_centroids.shape)
            
            # Texture format: 
            # 3 coeffs per pixel (RGB). Alpha typically unused (0xff) or used for packing?
            # TS says: 
            # centroidsBuf[i * shCoeffs * 4 + j * 4 + 0] = x;
            # x is the codebook index.
            
            num_coeffs = len(sh_keys)
            # Layout for centroids texture:
            # Width = 64 * Coeffs
            # Height = Ceil(PaletteSize / 64)
            
            c_width = 64 * num_coeffs
            c_height = int(math.ceil(palette_size / 64))
            
            c_tex = np.zeros((c_height, c_width, 4), dtype=np.uint8)
            
            for i in range(palette_size):
                row_idx = i // 64
                col_base = (i % 64) * num_coeffs
                
                for j in range(num_coeffs):
                    c_tex[row_idx, col_base + j, 0] = sh_centroids_labels[i, j]
                    c_tex[row_idx, col_base + j, 1] = sh_centroids_labels[i, j] # Why repeat?
                    c_tex[row_idx, col_base + j, 2] = sh_centroids_labels[i, j] # Just reusing logic?
                    # Wait, looking at TS:
                    # x = centroidsRow[shColumnNames[shCoeffs * 0 + j]];
                    # y = centroidsRow[shColumnNames[shCoeffs * 1 + j]];
                    # z = centroidsRow[shColumnNames[shCoeffs * 2 + j]];
                    # Ah, TS handles 3 bands (9 coeffs) or more. 
                    # If bands=1 (3 coeffs), shCoeffs=1. 3 coeffs total.
                    # shColumnNames has 3 entries. j goes 0..1.
                    # shCoeffs variable in TS is actually (num_coeffs / 3).
                    
            coeffs_per_color = num_coeffs // 3
            # Layout for centroids texture:
            # Width = 64 * Coeffs
            # Height = Ceil(PaletteSize / 64)
            
            c_width = 64 * coeffs_per_color
            c_height = int(math.ceil(palette_size / 64))
            
            c_tex = np.zeros((c_height, c_width, 4), dtype=np.uint8)
            
            # This loop is now obsolete or needs update?
            # actually we reconstruct it fully below using flat array
            # The manual loop `for i in range(palette_size)` logic below is what I am relying on.
            # I can remove this init loop if I construct `c_tex_flat` correctly.
            
            # Re-read my previous code:
            # I had a loop `for i in range(palette_size): ...` initializing c_tex
            # Then I had another loop writing `c_tex_flat`.
            # I should clean this up.
            
            c_tex_flat = np.zeros((c_height * c_width * 4), dtype=np.uint8)
            
            # We iterate i (0..palette_size)
            # We iterate j (0..coeffs_per_color)
            for i in range(palette_size):
                for j in range(coeffs_per_color):
                     idx_R = sh_centroids_labels[i, coeffs_per_color * 0 + j]
                     idx_G = sh_centroids_labels[i, coeffs_per_color * 1 + j]
                     idx_B = sh_centroids_labels[i, coeffs_per_color * 2 + j]
                     
                     # Calculate pixel index in texture
                     # Row is i // 64.
                     # Block col is i % 64.
                     # Within block, offset is j.
                     # Pixel index = (row * c_width) + (block_col * coeffs_per_color) + j
                     
                     pixel_idx = (i // 64) * c_width + (i % 64) * coeffs_per_color + j
                     
                     c_tex_flat[pixel_idx * 4 + 0] = idx_R
                     c_tex_flat[pixel_idx * 4 + 1] = idx_G
                     c_tex_flat[pixel_idx * 4 + 2] = idx_B
                     c_tex_flat[pixel_idx * 4 + 3] = 0xff
            
            save_webp('shN_centroids.webp', c_tex_flat.reshape(c_height, c_width, 4), c_width, c_height, zf)
            
            # Labels texture (indices into palette)
            l_tex = np.zeros((padded_size, 4), dtype=np.uint8)
            l_label = pad(sh_labels) # Use padded labels
            
            l_tex[:, 0] = l_label & 0xff
            l_tex[:, 1] = (l_label >> 8) & 0xff
            l_tex[:, 3] = 0xff
            
            save_webp('shN_labels.webp', l_tex.reshape(height, width, 4), width, height, zf)
            
            sh_bands_map = {9: 1, 24: 2, 45: 3}
            shN_meta = {
                'count': palette_size,
                'bands': sh_bands_map.get(num_coeffs, 0),
                'codebook': codebook_centroids.tolist(),
                'files': ['shN_centroids.webp', 'shN_labels.webp']
            }

        # --- PARAMS (mu, w, is_param) ---
        params_keys = ['mu', 'w', 'is_param']
        params_codebook = None
        
        # Check if all keys exist in vertices
        if all(k in vertices.dtype.names for k in params_keys):
            print("Processing Params (mu, w, is_param) with separate codebooks...")
            mu = reorder(vertices['mu'])
            w = reorder(vertices['w'])
            is_param = reorder(vertices['is_param'])
            
            # Cluster independently
            # mu usually has large range (0-300+), w smaller, is_param (0 or 1)
            # 256 clusters for each is plenty, maybe overkill for is_param but safe.
            centroids_mu, labels_mu = kmeans_1d(mu, 256, iterations)
            centroids_w, labels_w = kmeans_1d(w, 256, iterations)
            centroids_p, labels_p = kmeans_1d(is_param, 256, iterations)
            
            params_tex = np.zeros((padded_size, 4), dtype=np.uint8)
            params_tex[:num_rows, 0] = labels_mu.astype(np.uint8)
            params_tex[:num_rows, 1] = labels_w.astype(np.uint8)
            params_tex[:num_rows, 2] = labels_p.astype(np.uint8)
            params_tex[:, 3] = 255
            
            save_webp('params.webp', params_tex.reshape(height, width, 4), width, height, zf)
            
            params_codebook_mu = centroids_mu.tolist()
            params_codebook_w = centroids_w.tolist()
            params_codebook_p = centroids_p.tolist()

        # --- METADATA ---
        print("Writing meta.json...")
        meta = {
            'version': 2,
            'asset': {
                'generator': 'ply_to_sog.py v1.0'
            },
            'count': num_rows,
            'means': {
                'mins': means_min,
                'maxs': means_max,
                'files': ['means_l.webp', 'means_u.webp']
            },
            'scales': {
                'codebook': scales_codebook,
                'files': ['scales.webp']
            },
            'quats': {
                'files': ['quats.webp']
            },
            'sh0': {
                'codebook': colors_codebook,
                'files': ['sh0.webp']
            }
        }
        
        if shN_meta:
            meta['shN'] = shN_meta
            
        if params_codebook_mu:
            meta['params'] = {
                'codebook_mu': params_codebook_mu,
                'codebook_w': params_codebook_w,
                'codebook_is_param': params_codebook_p,
                'files': ['params.webp']
            }
            
        zf.writestr('meta.json', json.dumps(meta))
        
    print(f"Done! Saved to {output_sog}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Convert PLY to SOG')
    parser.add_argument('input', help='Input PLY file')
    parser.add_argument('output', help='Output SOG file')
    parser.add_argument('-w', '--overwrite', action='store_true', help='Overwrite output')
    parser.add_argument('-i', '--iterations', type=int, default=10, help='Number of K-Means iterations')
    
    args = parser.parse_args()
    
    if os.path.exists(args.output) and not args.overwrite:
        print(f"Error: {args.output} exists. Use -w to overwrite.")
        exit(1)
        
    process_and_write(args.input, args.output, iterations=args.iterations)
