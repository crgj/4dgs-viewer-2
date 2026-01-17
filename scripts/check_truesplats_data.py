
import os
import zipfile
import json
import numpy as np
from PIL import Image
import io

def read_webp_to_array(zf, filename):
    with zf.open(filename) as f:
        img_data = f.read()
        image = Image.open(io.BytesIO(img_data))
        image = image.convert('RGBA')
        return np.array(image)

def check_truesplats():
    # truesplats_path = 'public/data.truesplats'
    truesplats_path = '/home/crgj/wdd/output/ok.truesplats'
    print(f"Checking {truesplats_path}...")
    if not os.path.exists(truesplats_path):
        print("File not found.")
        return

    with zipfile.ZipFile(truesplats_path, 'r') as outer_zf:
        if 'static.sog' not in outer_zf.namelist():
            print("static.sog not found in outer zip!")
            return
        
        # Read static.sog into memory
        sog_data = outer_zf.read('static.sog')
        sog_io = io.BytesIO(sog_data)
        
        with zipfile.ZipFile(sog_io, 'r') as zf:
            print(f"SOG Zip files: {zf.namelist()}")
            if 'meta.json' not in zf.namelist():
                print("meta.json not found in static.sog!")
                return

            with zf.open('meta.json') as f:
                meta = json.load(f)
        
            print(f"Count: {meta['count']}")
            
            if 'params' in meta:
                p_cfg = meta['params']
                print(f"Params keys: {p_cfg.keys()}")
                
                # Helper to get codebook
                def get_cb(name):
                    # Try various keys used in different versions
                    return p_cfg.get(name) or p_cfg.get(name + '_list') or p_cfg.get('codebook')

                cb_mu = np.array(get_cb('codebook_mu'), dtype=np.float32)
                # cb_w might be same if combined
                cb_w = np.array(get_cb('codebook_w'), dtype=np.float32)

                print(f"Codebook Mu Shape: {cb_mu.shape}")
                if cb_mu.ndim > 1:
                    print(f"Codebook Mu Sample (first 5): {cb_mu[:5]}")
                
                # Read texture
                p_file = p_cfg['files'][0]
                print(f"Reading params texture: {p_file}")
                # zf is open here
                tex = read_webp_to_array(zf, p_file)
                print(f"Texture Shape: {tex.shape}")
                
                # Flatten
                tex_flat = tex.reshape(-1, 4)[:meta['count']]
                
                # Sort by Duration (w) - ascending
                # Structure: (index, mu, w)
                points_data = []
                
                # Statistics
                count_negative_w = 0 # Completely invisible
                count_full_lifetime = 0 # w > 24.0 (Visible > 48 frames)
                count_partial = 0
                
                print("Analyzing lifetimes for all points...")
                for i in range(meta['count']):
                    mu_idx = tex_flat[i, 0]
                    w_idx = tex_flat[i, 1]
                    
                    mu_val = 0
                    w_val = 0
                    
                    if cb_mu.ndim > 1: # VQ
                        entry = cb_mu[mu_idx]
                        mu_val = entry[0]
                        w_val = entry[1]
                    else:
                        mu_val = cb_mu[mu_idx]
                        w_val = cb_w[w_idx]
                        
                    points_data.append((i, mu_val, w_val))
                    
                    if w_val < 0:
                        count_negative_w += 1
                    elif w_val > 24.0:
                        count_full_lifetime += 1
                    else:
                        count_partial += 1
                
                print("\n[Python Debug] Lifetime Statistics:")
                print(f"Total Points: {meta['count']}")
                print(f"Always Invisible (w < 0): {count_negative_w} ({count_negative_w/meta['count']*100:.1f}%)")
                print(f"Always Visible (w > 24.0): {count_full_lifetime} ({count_full_lifetime/meta['count']*100:.1f}%)")
                print(f"Partially Visible: {count_partial} ({count_partial/meta['count']*100:.1f}%)")

                # Sort by w (smallest first)
                points_data.sort(key=lambda x: x[2])
                
                print("\n[Python Debug] Top 10 Shortest Lifetimes (Candidates for Red Points):")
                for k in range(10):
                    idx, m, w = points_data[k]
                    print(f"Pt {idx}: mu={m:.2f}, w={w:.2f} (Duration={2*w:.2f})")
                
            # --- Check SH0 (Color) ---
            if 'sh0' in meta and 'codebook' in meta['sh0']:
                print("\n[Python Debug] SH0 (Color) Analysis:")
                sh0_cb = np.array(meta['sh0']['codebook'], dtype=np.float32)
                sh0_file = meta['sh0']['files'][0]
                
                # Check min/max of codebook
                print(f"SH0 Codebook Range: [{sh0_cb.min():.4f}, {sh0_cb.max():.4f}]")
                
                # Read texture
                try:
                    with zf.open(sh0_file) as f:
                        sh0_img_data = f.read()
                        sh0_img = Image.open(io.BytesIO(sh0_img_data)).convert('RGBA')
                        sh0_tex = np.array(sh0_img)
                        
                        sh0_flat = sh0_tex.reshape(-1, 4)[:meta['count']]
                        
                        print("First 10 f_dc values:")
                        for k in range(10):
                            idx_r = sh0_flat[k, 0]
                            idx_g = sh0_flat[k, 1]
                            idx_b = sh0_flat[k, 2]
                            
                            val_r = sh0_cb[idx_r]
                            val_g = sh0_cb[idx_g]
                            val_b = sh0_cb[idx_b]
                            print(f"Pt {k} f_dc: ({val_r:.3f}, {val_g:.3f}, {val_b:.3f})")
                except Exception as e:
                    print(f"Failed to read SH0 texture: {e}")

            else:
                print("No params block in meta.json")

if __name__ == "__main__":
    check_truesplats()
