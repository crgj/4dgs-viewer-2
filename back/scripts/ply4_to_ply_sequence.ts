import fs from 'fs';
import path from 'path';
import { PLY4Loader } from '../src/utils/ply4-loader.ts';

type ParsedPLY4 = {
    count: number;
    frames?: number;
    keyframes?: number;
    xyzStride?: number;
    rotKeyframes?: number;
    rotStride?: number;
    dcKeyframes?: number;
    dcStride?: number;
    trajectory?: Float32Array | null;
    rotTrajectory?: Float32Array | null;
    dcTrajectory?: Float32Array | null;
    plyData: {
        elements: Array<{
            properties: Array<{ name: string; storage: Float32Array }>;
        }>;
    };
};

const DEFAULT_INPUT = '/media/crgj/9b112943-ef0f-408c-9192-a94c13debf35/ysw/master500000.ply4';
const DEFAULT_OUTPUT = '/media/crgj/9b112943-ef0f-408c-9192-a94c13debf35/ysw/plys_test/';
const OPACITY_THRESHOLD = 0.01;

const f32 = Math.fround;
const sigmoid = (v: number) => {
    const x = f32(Math.max(-20, Math.min(20, v)));
    const e = f32(Math.exp(-x));
    return f32(1.0 / f32(1.0 + e));
};
const logit = (v: number) => {
    const lo = f32(1e-7);
    const hi = f32(1.0 - lo);
    const p = f32(Math.max(lo, Math.min(hi, v)));
    return f32(Math.log(p / f32(1.0 - p)));
};

function parseArgs() {
    const args = process.argv.slice(2);
    let input = DEFAULT_INPUT;
    let output = DEFAULT_OUTPUT;
    let start = 0;
    let end: number | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--input') input = args[++i];
        else if (arg === '--output') output = args[++i];
        else if (arg === '--start') start = parseInt(args[++i], 10);
        else if (arg === '--end') end = parseInt(args[++i], 10);
    }

    return { input, output, start, end };
}

function getStorageMap(parsed: ParsedPLY4) {
    const props = parsed.plyData.elements[0].properties;
    const map = new Map<string, Float32Array>();
    for (const prop of props) {
        map.set(prop.name, prop.storage);
    }
    return map;
}

function slerpQuat(
    ax: number, ay: number, az: number, aw: number,
    bx: number, by: number, bz: number, bw: number,
    t: number
) {
    const q0Len = f32(Math.hypot(ax, ay, az, aw) || 1.0);
    const q1Len = f32(Math.hypot(bx, by, bz, bw) || 1.0);
    const q0x = f32(ax / q0Len);
    const q0y = f32(ay / q0Len);
    const q0z = f32(az / q0Len);
    const q0w = f32(aw / q0Len);

    let q1x = f32(bx / q1Len);
    let q1y = f32(by / q1Len);
    let q1z = f32(bz / q1Len);
    let q1w = f32(bw / q1Len);

    let dot = f32(f32(q0x * q1x) + f32(q0y * q1y) + f32(q0z * q1z) + f32(q0w * q1w));
    if (dot < 0) {
        q1x = f32(-q1x);
        q1y = f32(-q1y);
        q1z = f32(-q1z);
        q1w = f32(-q1w);
        dot = f32(-dot);
    }
    dot = f32(Math.max(0, Math.min(1, dot)));

    const theta0 = f32(Math.acos(dot));
    const sinTheta0 = f32(Math.sin(theta0));

    let x: number;
    let y: number;
    let z: number;
    let w: number;
    if (sinTheta0 > 1e-4) {
        const invT = f32(1 - t);
        const s0 = f32(Math.sin(f32(invT * theta0)) / f32(sinTheta0 + 1e-10));
        const s1 = f32(Math.sin(f32(t * theta0)) / f32(sinTheta0 + 1e-10));
        x = f32(f32(s0 * q0x) + f32(s1 * q1x));
        y = f32(f32(s0 * q0y) + f32(s1 * q1y));
        z = f32(f32(s0 * q0z) + f32(s1 * q1z));
        w = f32(f32(s0 * q0w) + f32(s1 * q1w));
    } else {
        const invT = f32(1 - t);
        x = f32(f32(invT * q0x) + f32(t * q1x));
        y = f32(f32(invT * q0y) + f32(t * q1y));
        z = f32(f32(invT * q0z) + f32(t * q1z));
        w = f32(f32(invT * q0w) + f32(t * q1w));
    }

    const outLen = f32(Math.hypot(x, y, z, w) || 1.0);
    return [f32(x / outLen), f32(y / outLen), f32(z / outLen), f32(w / outLen)] as const;
}

function getInterpIndices(frame: number, keyframes: number, stride: number) {
    if (keyframes <= 1) {
        return { k0: 0, k1: 0, alpha: 0 };
    }
    const f = Math.max(0, frame);
    const k0 = Math.min(Math.floor(f / stride), keyframes - 1);
    const k1 = Math.min(k0 + 1, keyframes - 1);
    const t0 = k0 * stride;
    const t1 = k1 * stride;
    const alpha = t1 > t0 ? f32(Math.max(0, Math.min(1, (f - t0) / (t1 - t0)))) : 0;
    return { k0, k1, alpha };
}

function interpolatePosition(parsed: ParsedPLY4, i: number, frame: number, props: Map<string, Float32Array>) {
    if (parsed.trajectory && (parsed.keyframes || 0) > 0) {
        const keyframes = parsed.keyframes || 0;
        const stride = parsed.xyzStride || 1;
        const { k0, k1, alpha } = getInterpIndices(frame, keyframes, stride);
        const idx0 = (i * keyframes + k0) * 3;
        const idx1 = (i * keyframes + k1) * 3;
        const invAlpha = f32(1 - alpha);
        return [
            f32(f32(parsed.trajectory[idx0 + 0] * invAlpha) + f32(parsed.trajectory[idx1 + 0] * alpha)),
            f32(f32(parsed.trajectory[idx0 + 1] * invAlpha) + f32(parsed.trajectory[idx1 + 1] * alpha)),
            f32(f32(parsed.trajectory[idx0 + 2] * invAlpha) + f32(parsed.trajectory[idx1 + 2] * alpha))
        ] as const;
    }

    return [
        props.get('x')?.[i] || 0,
        props.get('y')?.[i] || 0,
        props.get('z')?.[i] || 0
    ] as const;
}

function interpolateRotation(parsed: ParsedPLY4, i: number, frame: number, props: Map<string, Float32Array>) {
    if (parsed.rotTrajectory && (parsed.rotKeyframes || 0) > 0) {
        const keyframes = parsed.rotKeyframes || 0;
        const stride = parsed.rotStride || 1;
        const { k0, k1, alpha } = getInterpIndices(frame, keyframes, stride);
        const idx0 = (i * keyframes + k0) * 4;
        const idx1 = (i * keyframes + k1) * 4;
        return slerpQuat(
            parsed.rotTrajectory[idx0 + 0], parsed.rotTrajectory[idx0 + 1], parsed.rotTrajectory[idx0 + 2], parsed.rotTrajectory[idx0 + 3],
            parsed.rotTrajectory[idx1 + 0], parsed.rotTrajectory[idx1 + 1], parsed.rotTrajectory[idx1 + 2], parsed.rotTrajectory[idx1 + 3],
            alpha
        );
    }

    return [
        props.get('rot_0')?.[i] ?? 1,
        props.get('rot_1')?.[i] ?? 0,
        props.get('rot_2')?.[i] ?? 0,
        props.get('rot_3')?.[i] ?? 0
    ] as const;
}

function interpolateDC(parsed: ParsedPLY4, i: number, frame: number, props: Map<string, Float32Array>) {
    if (parsed.dcTrajectory && (parsed.dcKeyframes || 0) > 0) {
        const keyframes = parsed.dcKeyframes || 0;
        const stride = parsed.dcStride || 1;
        const { k0, k1, alpha } = getInterpIndices(frame, keyframes, stride);
        const idx0 = (i * keyframes + k0) * 3;
        const idx1 = (i * keyframes + k1) * 3;
        const invAlpha = f32(1 - alpha);
        return [
            f32(f32(parsed.dcTrajectory[idx0 + 0] * invAlpha) + f32(parsed.dcTrajectory[idx1 + 0] * alpha)),
            f32(f32(parsed.dcTrajectory[idx0 + 1] * invAlpha) + f32(parsed.dcTrajectory[idx1 + 1] * alpha)),
            f32(f32(parsed.dcTrajectory[idx0 + 2] * invAlpha) + f32(parsed.dcTrajectory[idx1 + 2] * alpha))
        ] as const;
    }

    return [
        props.get('f_dc_0')?.[i] || 0,
        props.get('f_dc_1')?.[i] || 0,
        props.get('f_dc_2')?.[i] || 0
    ] as const;
}

function buildFrameBuffer(parsed: ParsedPLY4, props: Map<string, Float32Array>, frame: number) {
    const count = parsed.count;
    const baseOpacityLogit = props.get('opacity');
    const lifetimeMu = props.get('lifetime_mu');
    const lifetimeW = props.get('lifetime_w');
    const scale0 = props.get('scale_0');
    const scale1 = props.get('scale_1');
    const scale2 = props.get('scale_2');
    const fRest = Array.from({ length: 45 }, (_, idx) => props.get(`f_rest_${idx}`));

    const alive = new Uint8Array(count);
    let validCount = 0;

    for (let i = 0; i < count; i++) {
        const baseAlpha = baseOpacityLogit ? sigmoid(baseOpacityLogit[i]) : 1.0;
        let currAlpha = baseAlpha;
        if (lifetimeMu && lifetimeW) {
            const k = 10.0;
            const deltaLeft = f32(frame - f32(lifetimeMu[i] - lifetimeW[i]));
            const deltaRight = f32(f32(lifetimeMu[i] + lifetimeW[i]) - frame);
            const gate = f32(sigmoid(f32(k * deltaLeft)) * sigmoid(f32(k * deltaRight)));
            currAlpha = f32(currAlpha * gate);
        }
        if (currAlpha >= OPACITY_THRESHOLD) {
            alive[i] = 1;
            validCount++;
        }
    }

    const rowSize = 248;
    const outBuffer = new ArrayBuffer(validCount * rowSize);
    const view = new DataView(outBuffer);
    let row = 0;

    for (let i = 0; i < count; i++) {
        if (!alive[i]) continue;
        const off = row * rowSize;
        row++;

        const [x, y, z] = interpolatePosition(parsed, i, frame, props);
        const [dc0, dc1, dc2] = interpolateDC(parsed, i, frame, props);
        const [r0, r1, r2, r3] = interpolateRotation(parsed, i, frame, props);

        const baseAlpha = baseOpacityLogit ? sigmoid(baseOpacityLogit[i]) : 1.0;
        let currAlpha = baseAlpha;
        if (lifetimeMu && lifetimeW) {
            const k = 10.0;
            const deltaLeft = f32(frame - f32(lifetimeMu[i] - lifetimeW[i]));
            const deltaRight = f32(f32(lifetimeMu[i] + lifetimeW[i]) - frame);
            const gate = f32(sigmoid(f32(k * deltaLeft)) * sigmoid(f32(k * deltaRight)));
            currAlpha = f32(currAlpha * gate);
        }

        view.setFloat32(off + 0, x, true);
        view.setFloat32(off + 4, y, true);
        view.setFloat32(off + 8, z, true);
        view.setFloat32(off + 12, 0, true);
        view.setFloat32(off + 16, 0, true);
        view.setFloat32(off + 20, 0, true);
        view.setFloat32(off + 24, dc0, true);
        view.setFloat32(off + 28, dc1, true);
        view.setFloat32(off + 32, dc2, true);

        for (let j = 0; j < 45; j++) {
            view.setFloat32(off + 36 + j * 4, fRest[j]?.[i] || 0, true);
        }

        view.setFloat32(off + 216, logit(currAlpha), true);
        view.setFloat32(off + 220, scale0?.[i] || 0, true);
        view.setFloat32(off + 224, scale1?.[i] || 0, true);
        view.setFloat32(off + 228, scale2?.[i] || 0, true);
        view.setFloat32(off + 232, r0, true);
        view.setFloat32(off + 236, r1, true);
        view.setFloat32(off + 240, r2, true);
        view.setFloat32(off + 244, r3, true);
    }

    const header = `ply
format binary_little_endian 1.0
element vertex ${validCount}
property float x
property float y
property float z
property float nx
property float ny
property float nz
property float f_dc_0
property float f_dc_1
property float f_dc_2
${Array.from({ length: 45 }, (_, j) => `property float f_rest_${j}`).join('\n')}
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
`;

    const headerBytes = new TextEncoder().encode(header);
    const final = new Uint8Array(headerBytes.length + outBuffer.byteLength);
    final.set(headerBytes, 0);
    final.set(new Uint8Array(outBuffer), headerBytes.length);
    return final;
}

async function main() {
    const { input, output, start, end } = parseArgs();
    fs.mkdirSync(output, { recursive: true });

    console.log(`[PLY4->PLY] Input: ${input}`);
    console.log(`[PLY4->PLY] Output: ${output}`);

    const inputBuffer = fs.readFileSync(input);
    const arrayBuffer = inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.byteLength);

    const loader = new PLY4Loader();
    const parsed = await loader.load(arrayBuffer, (p, msg) => {
        console.log(`[Load ${p.toFixed(0)}%] ${msg}`);
    }) as ParsedPLY4;

    const props = getStorageMap(parsed);
    const totalFrames = parsed.frames || 1;
    const startFrame = Math.max(0, start);
    const endFrame = Math.min(end ?? (totalFrames - 1), totalFrames - 1);

    console.log(`[PLY4->PLY] Splats=${parsed.count}, Frames=${totalFrames}, ExportRange=${startFrame}-${endFrame}`);

    for (let frame = startFrame; frame <= endFrame; frame++) {
        const bytes = buildFrameBuffer(parsed, props, frame);
        const filename = `frame_${frame.toString().padStart(4, '0')}.ply`;
        const filepath = path.join(output, filename);
        fs.writeFileSync(filepath, Buffer.from(bytes));
        console.log(`[PLY4->PLY] Saved ${filepath}`);
    }

    console.log('[PLY4->PLY] Done.');
}

main().catch((err) => {
    console.error('[PLY4->PLY] Failed:', err);
    process.exit(1);
});
