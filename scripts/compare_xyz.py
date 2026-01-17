
import numpy as np
import sys
from plyfile import PlyData

BASE_DIR = "/home/crgj/wdd/output/vis_server/temp_verify"
PLY_FILE = f"{BASE_DIR}/reconstructed_ply/frame_0002.ply"
STATIC_PLY = f"{BASE_DIR}/static.ply"
TS_BIN = f"{BASE_DIR}/ts_xyz_2.f32"

def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -20, 20)))

def main():
    # Read Python Reconstructed PLY
    ply = PlyData.read(PLY_FILE)
    el = ply.elements[0]
    python_xyz = np.stack([np.asarray(el['x']), np.asarray(el['y']), np.asarray(el['z'])], axis=1)
    
    # Read TS Binary (Full)
    ts_xyz_full = np.fromfile(TS_BIN, dtype=np.float32).reshape(-1, 3)
    
    # Read Static PLY for Opacity to verify filtering
    static = PlyData.read(STATIC_PLY)
    el_s = static.elements[0]
    opac_logit = np.asarray(el_s['opacity'])
    
    # Simulate Filter
    # We assume defaults: mu=0, w=100 -> Gate ~ 1.0
    # So mask is sigmoid(logit) >= 0.01
    base_opac = sigmoid(opac_logit)
    mask = base_opac >= 0.01
    
    ts_xyz_filtered = ts_xyz_full[mask]
    
    print(f"Python Count: {python_xyz.shape[0]}")
    print(f"TS Full:      {ts_xyz_full.shape[0]}")
    print(f"TS Filtered:  {ts_xyz_filtered.shape[0]}")
    
    if python_xyz.shape[0] != ts_xyz_filtered.shape[0]:
        print("ERROR: Still mismatch after filtering!")
        # Debugging: maybe gate calculation isn't exactly 1.0?
        # mu=0, w=100. t=0. 
        # gate = sigmoid(10*(0 - (0-100))) * sigmoid(10*((0+100) - 0))
        #      = sigmoid(1000) * sigmoid(1000) = 1.0 * 1.0 = 1.0
        return

    # Compare
    diff = np.abs(python_xyz - ts_xyz_filtered)
    max_diff = np.max(diff)
    mean_diff = np.mean(diff)
    
    print(f"Max Diff: {max_diff:.8f}")
    print(f"Mean Diff: {mean_diff:.8f}")
    
    if max_diff < 1e-4:
        print("SUCCESS: VERIFIED MATCH!")
    else:
        print("FAILURE: Value mismatch.")

if __name__ == "__main__":
    main()

