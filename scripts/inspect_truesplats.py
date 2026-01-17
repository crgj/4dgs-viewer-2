import zipfile
import struct
import sys
import os

def inspect_truesplats(filepath):
    print(f"Inspecting {filepath}...")
    if not os.path.exists(filepath):
        print("File not found!")
        return

    try:
        with zipfile.ZipFile(filepath, 'r') as zf:
            if 'data.bin' in zf.namelist():
                print("Found data.bin")
                with zf.open('data.bin') as f:
                    header_raw = f.read(36)
                    # Header: Magic(4), Ver(4), N(4), K_xyz(4), K_rot(4), Scale(4), T_total(4), Stride_xyz(4), Stride_rot(4)
                    head = struct.unpack("I I I I I f I I I", header_raw)
                    magic, ver, N, K_xyz, K_rot, scale, T_total, xyz_stride, rot_stride = head
                    
                    print("-" * 30)
                    print(f"Magic:      0x{magic:X}")
                    print(f"Version:    {ver}")
                    print(f"N (Points): {N}")
                    print(f"K_xyz:      {K_xyz}")
                    print(f"K_rot:      {K_rot}")
                    print(f"Scale:      {scale}")
                    print(f"T_total:    {T_total}")
                    print(f"XYZ Stride: {xyz_stride}")
                    print(f"ROT Stride: {rot_stride}")
                    print("-" * 30)
            else:
                print("data.bin not found in zip!")
            
            if 'meta.json' in zf.namelist():
                print("Found meta.json")
                with zf.open('meta.json') as f:
                    print(f.read().decode('utf-8')[:500] + "...") # Print first 500 chars

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python inspect_truesplats.py <path>")
    else:
        inspect_truesplats(sys.argv[1])
