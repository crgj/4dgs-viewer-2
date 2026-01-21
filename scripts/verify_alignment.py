import numpy as np
import struct
import zlib
import zipfile
import json
import os
import argparse

def read_ply_from_zip(zf, filename):
    # Dummy read for verification (simplified)
    # We might not be able to read encoded webp easily without PIL/cv2 quirks
    # But we can read 'meta.json' to confirm it exists
    pass

def verify(truesplats_path):
    print(f"Opening {truesplats_path}...")
    with zipfile.ZipFile(truesplats_path, 'r') as zf:
        if 'data.bin' not in zf.namelist():
            print("Error: data.bin not found in zip")
            return
            
        print("Reading data.bin from zip...")
        data = zf.read('data.bin')
        
    print("Parsing Header...")
    header_raw = data[:36]
    head = struct.unpack("I I I I I f I I I", header_raw)
    magic, ver, N, K_xyz, K_rot, scale, T_total, xyz_stride, rot_stride = head
    
    print(f"Header: N={N}, K_xyz={K_xyz}, K_rot={K_rot}, Scale={scale}, TotalFrames={T_total}, XYZ_Stride={xyz_stride}, ROT_Stride={rot_stride}")
            
    if magic != 0x5A444C54:
        raise ValueError("Invalid Magic")
        
    print("Decompressing payload...")
    decompressed = zlib.decompress(data[36:])
    
    # Minimal decompressor for XYZ Bank
    off = 0
    
    MODE_INT8 = 0
    MODE_INT16 = 1
    MODE_FLOAT = 2
    
    # We will sample a few points to check trajectory continuity
    # Sample indices: 0, N//2, N-1
    indices_to_check = [0, N//2, N-1]
    
    print("Scanning XYZ Bank...")
    
    for i in range(N):
        m = decompressed[off]
        off += 1
        
        trajectory = []
        
        if m == MODE_INT8:
            anch = list(struct.unpack_from("fff", decompressed, off))
            off += 12
            trajectory.append(anch[:])
            
            # Read deltas
            deltas_raw = decompressed[off : off + (K_xyz - 1) * 3]
            off += (K_xyz - 1) * 3
            
            if i in indices_to_check:
                # Decode
                d_off = 0
                curr = anch[:]
                for k in range(K_xyz - 1):
                    dx = struct.unpack_from("b", deltas_raw, d_off)[0] / scale
                    dy = struct.unpack_from("b", deltas_raw, d_off + 1)[0] / scale
                    dz = struct.unpack_from("b", deltas_raw, d_off + 2)[0] / scale
                    d_off += 3
                    curr[0] += dx
                    curr[1] += dy
                    curr[2] += dz
                    trajectory.append(curr[:])
                    
        elif m == MODE_INT16:
            anch = list(struct.unpack_from("fff", decompressed, off))
            off += 12
            trajectory.append(anch[:])
            
            deltas_raw = decompressed[off : off + (K_xyz - 1) * 3 * 2]
            off += (K_xyz - 1) * 3 * 2
            
            if i in indices_to_check:
                 d_off = 0
                 curr = anch[:]
                 for k in range(K_xyz - 1):
                    dx = struct.unpack_from("h", deltas_raw, d_off)[0] / scale
                    dy = struct.unpack_from("h", deltas_raw, d_off + 2)[0] / scale # little endian
                    dz = struct.unpack_from("h", deltas_raw, d_off + 4)[0] / scale
                    d_off += 6
                    curr[0] += dx
                    curr[1] += dy
                    curr[2] += dz
                    trajectory.append(curr[:])

        else:
            # Float32 full
            floats = struct.unpack_from("f" * (K_xyz * 3), decompressed, off)
            off += K_xyz * 3 * 4
            if i in indices_to_check:
                for k in range(K_xyz):
                    trajectory.append(floats[k*3 : (k+1)*3])
                    
        if i in indices_to_check:
            print(f"--- Point {i} Trajectory (Mode {m}) ---")
            for k, p in enumerate(trajectory):
                print(f"  K{k}: {p}")

    # ROTATION CHECK
    if K_rot > 0:
        print("Scanning ROT Bank...")
        off = N * K_xyz * 3 * 4 # Approximation of offset? No, variable size.
        # We need to compute proper offset or just continue scan
        # But wait, we didn't track offset properly in previous loop because of conditional reads
        # Re-creating loop properly?
        # Actually, let's just make the script parse fully.
        
        # Reset off to after XYZ bank
        # We must calculate where XYZ bank ends.
        # OR just run a loop to skip XYZ.
        pass # Too complex to rewrite fully right now.
        
        # Alternative: Just look at the extracted data if we kept it?
        # Creating a more robust parser quickly:
        
    # Re-parse for ROT
    off = 0
    # Skip XYZ
    for i in range(N):
        m = decompressed[off]
        off += 1
        if m == MODE_INT8:
            off += 12 + (K_xyz - 1) * 3
        elif m == MODE_INT16:
            off += 12 + (K_xyz - 1) * 6
        else:
            off += K_xyz * 12
            
    print(f"Offset after XYZ: {off}")
    # Now read ROT [0]
    if N > 0:
        m = decompressed[off]
        off += 1
        rot_val = [0,0,0,0]
        if m == MODE_INT8:
            rot_val = list(struct.unpack_from("ffff", decompressed, off))
        elif m == MODE_INT16:
            rot_val = list(struct.unpack_from("ffff", decompressed, off))
        else:
             rot_val = list(struct.unpack_from("ffff", decompressed, off))
        print(f"ROT [0] Frame 0: {rot_val}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("truesplats_path")
    args = parser.parse_args()
    verify(args.truesplats_path)
