const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const INPUT_DIR = '/home/crgj/wdd/output/vis_server/temp_verify';
const DATA_BIN = path.join(INPUT_DIR, 'data.bin');
const OUTPUT_FILE = path.join(INPUT_DIR, 'ts_xyz_0.f32');

async function main() {
    const buffer = fs.readFileSync(DATA_BIN);
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const magic = dv.getUint32(0, true); // 0x5A444C54
    const ver = dv.getUint32(4, true);
    const N = dv.getUint32(8, true);
    const K_xyz = dv.getUint32(12, true);
    const K_rot = dv.getUint32(16, true);
    const scale = dv.getFloat32(20, true);
    const T_total = dv.getUint32(24, true);
    const xyz_stride = dv.getUint32(28, true);
    const rot_stride = dv.getUint32(32, true);

    console.log(`Header: N=${N}, K_xyz=${K_xyz}, T_total=${T_total}, Stride=${xyz_stride}`);

    const compressed = buffer.subarray(36);
    let decompressed;
    try {
        decompressed = zlib.inflateSync(compressed);
    } catch (e) {
        console.error("Decompression failed", e);
        return;
    }

    // Decode XYZ Bank
    // Bank Layout: [Mode(1)] then Payload...
    // Payload for INT8:  [Anchor(C floats)] [Deltas((K-1)*C int8)]
    // Payload for INT16: [Anchor(C floats)] [Deltas((K-1)*C int16)]
    // Payload for FLOAT: [Floats(K*C floats)]

    const MODE_INT8 = 0;
    const MODE_INT16 = 1;
    const MODE_FLOAT = 2;

    const decodeBank = (N, K, C, startOff) => {
        const data = new Float32Array(N * K * C);
        const bankData = decompressed;
        let off = startOff;

        for (let i = 0; i < N; i++) {
            const mode = bankData[off++];
            let baseOff = (i * K) * C;

            if (mode === MODE_INT8) {
                // Anchor
                const anchor = new Float32Array(C);
                for (let j = 0; j < C; j++) {
                    anchor[j] = bankData.readFloatLE(off);
                    off += 4;
                }

                // Copy Anchor
                for (let j = 0; j < C; j++) data[baseOff + j] = anchor[j];

                // Deltas
                const deltaLen = (K - 1) * C;
                // we need to read int8s manually or create view
                for (let k = 1; k < K; k++) {
                    for (let j = 0; j < C; j++) {
                        const delta = bankData.readInt8(off++);
                        const val = anchor[j] + delta / scale;
                        data[baseOff + k * C + j] = val; // Store absolute
                        anchor[j] = val; // Accumulate
                    }
                }

            } else if (mode === MODE_INT16) {
                // Anchor
                const anchor = new Float32Array(C);
                for (let j = 0; j < C; j++) {
                    anchor[j] = bankData.readFloatLE(off);
                    off += 4;
                }

                // Copy Anchor
                for (let j = 0; j < C; j++) data[baseOff + j] = anchor[j];

                // Deltas
                for (let k = 1; k < K; k++) {
                    for (let j = 0; j < C; j++) {
                        const delta = bankData.readInt16LE(off);
                        off += 2;
                        const val = anchor[j] + delta / scale;
                        data[baseOff + k * C + j] = val;
                        anchor[j] = val;
                    }
                }
            } else { // FLOAT
                const count = K * C;
                for (let j = 0; j < count; j++) {
                    data[baseOff + j] = bankData.readFloatLE(off);
                    off += 4;
                }
            }
        }
        return { data, endOff: off };
    };

    // Buffer readFloatLE shim for Buffer (Node.js Buffer has readFloatLE)
    // decompressed is a Buffer in Node.js from inflateSync.

    console.log("Decoding XYZ Bank...");
    const xyzRes = decodeBank(N, K_xyz, 3, 0);
    const trajectoryData = xyzRes.data;

    // We only verify XYZ reconstruction at Frame 0 for now.
    // Frame 0 logic:
    // t = 0
    // progress = 0
    // kFloat = 0
    // k0 = 0, k1 = 1 (clamped to K-1)
    // u = 0.
    // So XYZ = P0.

    // Wait, let's verify logic for t=0.
    // t=0
    // progress = 0 / 49 = 0
    // kFloat = 0 * (17) = 0
    // k0 = 0
    // k1 = min(1, 17) = 1
    // u = 0
    // output = P0 * 1 + P1 * 0 = P0.

    // Let's compute for ALL points.
    const reconstructed = new Float32Array(N * 3);
    const keyframes = K_xyz;
    const t = 2; // Test interpolation (Stride=3, so t=2 is between k0=0 and k1=1)
    const totalFrames = T_total;
    const output_file_2 = path.join(INPUT_DIR, 'ts_xyz_2.f32');

    const stride = xyz_stride;

    // Stride Logic matching post_save.py
    // xyz_times = range(0, T, stride) + [T-1] if needed
    // We don't need to build the array, we can calc on fly.

    // Find segment info
    // Most segments are length 'stride'.
    // The index of the keyframe before t is floor(t / stride).
    let idx = Math.floor(t / stride);

    // Handle edge case: if t is past the last regular keyframe but before T-1 (the very last keyframe)
    // Actually, T_total=50, stride=3.
    // keys: 0, 3, ... 48 (idx 16), 49 (idx 17).
    // if t=48.5: floor(48.5/3) = 16.
    // k0 = 16. k1 = 17.
    // t0 = 48. t1 = 49.
    // u = (48.5 - 48) / (49 - 48) = 0.5.

    // if t=2: floor(2/3) = 0.
    // k0 = 0. k1 = 1.
    // t0 = 0. t1 = 3.
    // u = (2 - 0) / 3 = 0.666.

    // Clamp idx to K-2 max (since we need idx+1 < K)
    // K_xyz = 18. Max idx = 17. We need pair (idx, idx+1). So max idx=16.
    if (idx >= keyframes - 1) idx = keyframes - 2;

    // Determine t0, t1 based on idx
    // Is idx the N-th stride?
    // t0 = idx * stride?
    // Wait, the last keyframe might NOT be at idx*stride if we clamped or if it's the appended T-1.
    // list(range(0, 50, 3)) -> [0, 3, ..., 48]. Length 17. Indices 0..16.
    // Plus T-1=49. Total 18 keys. Indices 0..17.
    // idx 0..16 are regular stride steps.
    // idx 16 is t=48.
    // idx 17 is t=49.

    let t0 = idx * stride;
    let t1 = (idx + 1) * stride;

    // Check if t1 exceeds or equals T-1. 
    // If the constructed range doesn't hit T-1 exactly, the last interval is [last_stride_mult, T-1].
    // index K-2 corresponds to the second to last keyframe.
    // index K-1 is T-1.

    // In our case K=18. idx=16 (t=48).
    // t0 = 48.
    // t1 would be 51. But actual keyframe K-1 is 49.
    // So if (idx == K-2), t1 should be T-1.

    if (idx === keyframes - 2) {
        t1 = totalFrames - 1;
    }

    const k0 = idx;
    const k1 = idx + 1;
    const u = (t - t0) / (t1 - t0);

    console.log(`Reconstructing at t=${t} (u=${u}, k0=${k0}, k1=${k1}, t0=${t0}, t1=${t1})...`);

    for (let i = 0; i < N; i++) {
        const xyzBase = i * keyframes * 3;
        const p0x = trajectoryData[xyzBase + k0 * 3 + 0];
        const p0y = trajectoryData[xyzBase + k0 * 3 + 1];
        const p0z = trajectoryData[xyzBase + k0 * 3 + 2];

        const p1x = trajectoryData[xyzBase + k1 * 3 + 0];
        const p1y = trajectoryData[xyzBase + k1 * 3 + 1];
        const p1z = trajectoryData[xyzBase + k1 * 3 + 2];

        reconstructed[i * 3 + 0] = p0x * (1 - u) + p1x * u;
        reconstructed[i * 3 + 1] = p0y * (1 - u) + p1y * u;
        reconstructed[i * 3 + 2] = p0z * (1 - u) + p1z * u;
    }

    fs.writeFileSync(output_file_2, Buffer.from(reconstructed.buffer));
    console.log(`Written ${reconstructed.byteLength} bytes to ${output_file_2}`);
}

main();
