import zipfile
import json
import numpy as np
import cv2
import sys
import os
import subprocess
import shutil

def dequantize(q, bd, min_val, max_val):
    if bd == 0: return q # Safety
    denom = (1 << bd) - 1
    if denom == 0: denom = 1
    scale = (max_val - min_val) / denom
    return q * scale + min_val

def rgb2sh(x):
    return (x - 0.5) / 0.28209479177387814

def process_archive(zip_path):
    temp_dir = "temp_debug_unzip"
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)
    os.makedirs(temp_dir)

    print(f"Opening {zip_path}...")
    with zipfile.ZipFile(zip_path, 'r') as z:
        z.extractall(temp_dir)
    
    # Load Metadata
    with open(os.path.join(temp_dir, "metadata.json"), 'r') as f:
        meta = json.load(f)
    
    print("Metadata loaded.")
    
    # Decoding Helpers
    def decode_bin(name, is_gray=False):
        bin_path = os.path.join(temp_dir, name)
        if not os.path.exists(bin_path):
            return None
        png_path = bin_path + ".png"
        # Use simple ffmpeg command. Assumes ffmpeg installed.
        # -y overwrite
        cmd = ["ffmpeg", "-y", "-v", "quiet", "-i", bin_path, png_path]
        subprocess.run(cmd, check=True)
        
        if is_gray:
            img = cv2.imread(png_path, cv2.IMREAD_GRAYSCALE)
        else:
            img = cv2.imread(png_path)
            if img is not None:
                img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB) # Ensure RGB
        return img

    # Decode Images
    img_x1 = decode_bin("xyz_1.bin")
    img_x2 = decode_bin("xyz_2.bin")
    img_op = decode_bin("opacity.bin", is_gray=True)
    img_sc = decode_bin("scale.bin")
    
    results = {}
    
    points_to_check = [0, 1000]
    
    total_points = img_x1.shape[0] * img_x1.shape[1] if img_x1 is not None else 0
    width = img_x1.shape[1] if img_x1 is not None else 0
    
    lsb = int(meta['xyz_bd']) - int(meta['xyz_MSB'])
    
    for i in points_to_check:
        if i >= total_points: continue
        
        r, c = divmod(i, width) # Row-major? Or Column-major? usually row major
        # TS unzip uses r = i // w ? No, i goes 0..total. pxIdx = i*4.
        # TS: const yVal = y[r * strideY + c]; where loop is r=0..h, c=0..w.
        # i = r*w + c.
        # So yes, row major.
        
        res = {}
        
        # XYZ
        if img_x1 is not None and img_x2 is not None:
            rgb1 = img_x1[r, c] # RGB array
            rgb2 = img_x2[r, c]
            
            # Merge
            # Assuming R=X, G=Y, B=Z channel mapping (matches TS)
            # Python image tuple (R, G, B)
            xi = (int(rgb1[0]) << lsb) | int(rgb2[0])
            yi = (int(rgb1[1]) << lsb) | int(rgb2[1])
            zi = (int(rgb1[2]) << lsb) | int(rgb2[2])
            
            xf = dequantize(xi, meta['xyz_bd'], meta['xyz_min'][0], meta['xyz_max'][0])
            yf = dequantize(yi, meta['xyz_bd'], meta['xyz_min'][1], meta['xyz_max'][1])
            zf = dequantize(zi, meta['xyz_bd'], meta['xyz_min'][2], meta['xyz_max'][2])
            
            res['xyz'] = {
                'raw_h': rgb1.tolist(),
                'raw_l': rgb2.tolist(),
                'int': [xi, yi, zi],
                'final': [float(xf), float(yf), float(zf)]
            }
            
        # Opacity
        if img_op is not None:
            # Gray image, scalar value
            val = img_op[r, c]
            opf = dequantize(val, meta['opacity_bd'], meta['opacity_min'], meta['opacity_max'])
            res['opacity'] = {
                'raw_y': int(val),
                'final': float(opf),
                'range': [meta['opacity_min'], meta['opacity_max']]
            }

        # Scale
        if img_sc is not None:
            rgb = img_sc[r, c] # RGB
            s0 = dequantize(rgb[0], meta['scale_bd'], meta['scale_min'][0], meta['scale_max'][0])
            s1 = dequantize(rgb[1], meta['scale_bd'], meta['scale_min'][1], meta['scale_max'][1])
            s2 = dequantize(rgb[2], meta['scale_bd'], meta['scale_min'][2], meta['scale_max'][2])
            
            res['scale'] = {
                'raw': rgb.tolist(),
                'final': [float(s0), float(s1), float(s2)],
                'min': meta['scale_min'],
                'max': meta['scale_max']
            }
            
        results[i] = res

    out_file = "debug_py.json"
    with open(out_file, "w") as f:
        json.dump({"metadata": meta, "points": results}, f, indent=2)
        
    print(f"Done. Results saved to {out_file}")
    # Cleanup
    # shutil.rmtree(temp_dir) 

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python debug_compare.py <path_to_zip>")
        sys.exit(1)
    process_archive(sys.argv[1])
