import numpy as np
import struct
import os

def generate_ply():
    num_frames = 10
    points_per_cube = 10000
    total_points = num_frames * points_per_cube
    
    # Init arrays
    xyz = np.zeros((total_points, 3), dtype=np.float32)
    colors = np.zeros((total_points, 3), dtype=np.float32) # f_dc
    opacities = np.ones(total_points, dtype=np.float32) * 10.0 # High opacity (after sigmoid)
    scales = np.ones((total_points, 3), dtype=np.float32) * -4.0 # Small scale
    rots = np.zeros((total_points, 4), dtype=np.float32)
    rots[:, 0] = 1.0 # Identity quaternion
    
    # Custom Lifetime Params
    l_mu = np.zeros(total_points, dtype=np.float32)
    l_w = np.zeros(total_points, dtype=np.float32)
    l_k = np.zeros(total_points, dtype=np.float32)
    
    for f in range(num_frames):
        start_idx = f * points_per_cube
        end_idx = start_idx + points_per_cube
        
        # Position: Cube grid centered at X = f * 2.0
        # Random positions within a 1x1x1 cube at offset
        offsets = np.random.rand(points_per_cube, 3).astype(np.float32) - 0.5
        xyz[start_idx:end_idx] = offsets
        xyz[start_idx:end_idx, 0] += f * 2.0 # Shift X by frame index * 2
        
        # Color: Rainbow
        r = 1.0 if f % 3 == 0 else 0.1
        g = 1.0 if f % 3 == 1 else 0.1
        b = 1.0 if f % 3 == 2 else 0.1
        
        # SH conversion
        sh_c0 = 0.28209479177387814
        colors[start_idx:end_idx, 0] = (r - 0.5) / sh_c0
        colors[start_idx:end_idx, 1] = (g - 0.5) / sh_c0
        colors[start_idx:end_idx, 2] = (b - 0.5) / sh_c0
        
        
        # Lifetime
        # Mu = frame index
        l_mu[start_idx:end_idx] = float(f)
        # W = 0.5 (visible for this frame 0.5 radius -> active range [f-0.5, f+0.5])
        l_w[start_idx:end_idx] = 0.5
        # K = 10.0 (sharp edge)
        l_k[start_idx:end_idx] = 10.0

    # Write PLY
    header = f"""ply
format binary_little_endian 1.0
element vertex {total_points}
property float x
property float y
property float z
property float nx
property float ny
property float nz
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
property float lifetime_mu
property float lifetime_w
property float lifetime_k
end_header
"""
    
    with open("test_lifetime_10frames.ply", "wb") as f:
        f.write(header.encode('ascii'))
        # Using numpy to write efficiently
        data = np.zeros((total_points, 20), dtype=np.float32)
        data[:, 0:3] = xyz
        data[:, 3:6] = 0 # nx ny nz
        data[:, 6:9] = colors
        data[:, 9] = opacities
        data[:, 10:13] = scales
        data[:, 13:17] = rots
        data[:, 17] = l_mu
        data[:, 18] = l_w
        data[:, 19] = l_k
        
        f.write(data.tobytes())
            
    print(f"Generated test_lifetime_10frames.ply with {total_points} points.")

if __name__ == "__main__":
    generate_ply()
