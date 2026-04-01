import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { PLY4Loader } from '../src/utils/ply4-loader.ts';
import { SOG4Encoder } from '../src/utils/sog4-encoder.ts';
import { SOG4Loader } from '../src/utils/sog4-loader.ts';

type ParsedTemporal = {
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
    opacitySemantic?: string;
    plyData: {
        elements: Array<{
            properties: Array<{ name: string; storage: Float32Array }>;
        }>;
    };
};

const DEFAULT_INPUT = '/home/crgj/下载/saved_master.ply4';
const DEFAULT_OUT = '/home/crgj/下载/ply4_sog4_roundtrip';
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
    let out = DEFAULT_OUT;
    let start = 0;
    let end: number | null = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--input') input = args[++i];
        else if (arg === '--out') out = args[++i];
        else if (arg === '--start') start = parseInt(args[++i], 10);
        else if (arg === '--end') end = parseInt(args[++i], 10);
    }
    return { input, out, start, end };
}

function getStorageMap(parsed: ParsedTemporal) {
    const map = new Map<string, Float32Array>();
    for (const prop of parsed.plyData.elements[0].properties) {
        map.set(prop.name, prop.storage);
    }
    return map;
}

function getIndexedNames(props: Map<string, Float32Array>, prefix: string) {
    return [...props.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort((a, b) => {
            const ia = parseInt(a.split('_').at(-1) || '0', 10);
            const ib = parseInt(b.split('_').at(-1) || '0', 10);
            return ia - ib;
        });
}

function getInterpIndices(frame: number, keyframes: number, stride: number) {
    if (keyframes <= 1) return { k0: 0, k1: 0, alpha: 0 };
    const f = Math.max(0, frame);
    const k0 = Math.min(Math.floor(f / stride), keyframes - 1);
    const k1 = Math.min(k0 + 1, keyframes - 1);
    const t0 = k0 * stride;
    const t1 = k1 * stride;
    const alpha = t1 > t0 ? f32(Math.max(0, Math.min(1, (f - t0) / (t1 - t0)))) : 0;
    return { k0, k1, alpha };
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
        q1x = f32(-q1x); q1y = f32(-q1y); q1z = f32(-q1z); q1w = f32(-q1w); dot = f32(-dot);
    }
    dot = f32(Math.max(0, Math.min(1, dot)));
    const theta0 = f32(Math.acos(dot));
    const sinTheta0 = f32(Math.sin(theta0));
    let x: number; let y: number; let z: number; let w: number;
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

function interpolatePosition(parsed: ParsedTemporal, i: number, frame: number, props: Map<string, Float32Array>) {
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
    return [props.get('x')?.[i] || 0, props.get('y')?.[i] || 0, props.get('z')?.[i] || 0] as const;
}

function interpolateRotation(parsed: ParsedTemporal, i: number, frame: number, props: Map<string, Float32Array>) {
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

function interpolateDC(parsed: ParsedTemporal, i: number, frame: number, props: Map<string, Float32Array>, fdcNames: string[]) {
    if (parsed.dcTrajectory && (parsed.dcKeyframes || 0) > 0 && fdcNames.length >= 3) {
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
    return fdcNames.map((name) => props.get(name)?.[i] || 0);
}

function buildFrameBuffer(parsed: ParsedTemporal, props: Map<string, Float32Array>, frame: number) {
    const count = parsed.count;
    const baseOpacity = props.get('opacity');
    const lifetimeMu = props.get('lifetime_mu');
    const lifetimeW = props.get('lifetime_w');
    const scaleNames = getIndexedNames(props, 'scale_');
    const fdcNames = getIndexedNames(props, 'f_dc_');
    const frestNames = getIndexedNames(props, 'f_rest_');

    const alive = new Uint8Array(count);
    let validCount = 0;
    for (let i = 0; i < count; i++) {
        const rawOpacity = baseOpacity?.[i] ?? 0;
        const baseAlpha = parsed.opacitySemantic === 'probability' ? rawOpacity : sigmoid(rawOpacity);
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

    const rowFloatCount = 6 + fdcNames.length + frestNames.length + 1 + scaleNames.length + 4;
    const outBuffer = new ArrayBuffer(validCount * rowFloatCount * 4);
    const view = new DataView(outBuffer);
    let row = 0;
    for (let i = 0; i < count; i++) {
        if (!alive[i]) continue;
        let off = row * rowFloatCount * 4;
        row++;
        const [x, y, z] = interpolatePosition(parsed, i, frame, props);
        const dc = interpolateDC(parsed, i, frame, props, fdcNames);
        const [r0, r1, r2, r3] = interpolateRotation(parsed, i, frame, props);
        const rawOpacity = baseOpacity?.[i] ?? 0;
        const baseAlpha = parsed.opacitySemantic === 'probability' ? rawOpacity : sigmoid(rawOpacity);
        let currAlpha = baseAlpha;
        if (lifetimeMu && lifetimeW) {
            const k = 10.0;
            const deltaLeft = f32(frame - f32(lifetimeMu[i] - lifetimeW[i]));
            const deltaRight = f32(f32(lifetimeMu[i] + lifetimeW[i]) - frame);
            const gate = f32(sigmoid(f32(k * deltaLeft)) * sigmoid(f32(k * deltaRight)));
            currAlpha = f32(currAlpha * gate);
        }
        const writeF = (v: number) => {
            view.setFloat32(off, v, true);
            off += 4;
        };
        writeF(x); writeF(y); writeF(z);
        writeF(0); writeF(0); writeF(0);
        for (const value of dc) writeF(value);
        for (const name of frestNames) writeF(props.get(name)?.[i] || 0);
        writeF(logit(currAlpha));
        for (const name of scaleNames) writeF(props.get(name)?.[i] || 0);
        writeF(r0); writeF(r1); writeF(r2); writeF(r3);
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
${fdcNames.map((name) => `property float ${name}`).join('\n')}
${frestNames.map((name) => `property float ${name}`).join('\n')}
property float opacity
${scaleNames.map((name) => `property float ${name}`).join('\n')}
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

async function exportSequence(parsed: ParsedTemporal, outDir: string, label: string, startFrame: number, endFrame: number) {
    fs.mkdirSync(outDir, { recursive: true });
    const props = getStorageMap(parsed);
    for (let frame = startFrame; frame <= endFrame; frame++) {
        const bytes = buildFrameBuffer(parsed, props, frame);
        fs.writeFileSync(path.join(outDir, `frame_${frame.toString().padStart(4, '0')}.ply`), Buffer.from(bytes));
        if ((frame - startFrame) % 10 === 0 || frame === endFrame) {
            console.log(`[${label}] exported ${frame}/${endFrame}`);
        }
    }
}

function summarize(summary: any) {
    const diffs = summary.frames.filter((f: any) => !f.same);
    const issueCounts = new Map<string, number>();
    const countDeltas: number[] = [];
    for (const frame of diffs) {
        for (const issue of frame.issues) {
            const key = issue.type === 'prop_values' ? issue.prop : issue.type;
            issueCounts.set(key, (issueCounts.get(key) || 0) + 1);
            if (issue.type === 'count') {
                countDeltas.push(issue.ref - issue.test);
            }
        }
    }
    return {
        same_frames: summary.same_frames,
        total_frames: summary.total_frames,
        differing_frames: diffs.length,
        count_delta: countDeltas.length ? {
            min: Math.min(...countDeltas),
            max: Math.max(...countDeltas),
            mean: countDeltas.reduce((a, b) => a + b, 0) / countDeltas.length
        } : null,
        issue_counts: Object.fromEntries([...issueCounts.entries()].sort((a, b) => b[1] - a[1]))
    };
}

async function main() {
    const { input, out, start, end } = parseArgs();
    const directDir = path.join(out, 'ply4_direct_frames');
    const roundtripDir = path.join(out, 'sog4_roundtrip_frames');
    const sog4Path = path.join(out, 'roundtrip.sog4');
    fs.mkdirSync(out, { recursive: true });

    const inputBuffer = fs.readFileSync(input);
    const arrayBuffer = inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.byteLength);

    console.log(`[Roundtrip] Load PLY4: ${input}`);
    const ply4Parsed = await new PLY4Loader().load(arrayBuffer, (p, msg) => {
        console.log(`[PLY4 ${p.toFixed(0)}%] ${msg}`);
    }) as ParsedTemporal;

    const totalFrames = ply4Parsed.frames || 1;
    const startFrame = Math.max(0, start);
    const endFrame = Math.min(end ?? (totalFrames - 1), totalFrames - 1);

    console.log('[Roundtrip] Exporting direct PLY4 sequence');
    await exportSequence(ply4Parsed, directDir, 'PLY4', startFrame, endFrame);

    console.log('[Roundtrip] Encode SOG4 from PLY4 data');
    const sog4Bytes = await SOG4Encoder.encode(ply4Parsed, { rawFloatPayload: true }, (p, msg) => {
        console.log(`[SOG4-ENC ${p.toFixed(0)}%] ${msg}`);
    });
    fs.writeFileSync(sog4Path, Buffer.from(sog4Bytes));

    console.log('[Roundtrip] Reload generated SOG4');
    const roundtripParsed = await new SOG4Loader().load(
        sog4Bytes.buffer.slice(sog4Bytes.byteOffset, sog4Bytes.byteOffset + sog4Bytes.byteLength),
        (p, msg) => console.log(`[SOG4-LOAD ${p.toFixed(0)}%] ${msg}`)
    ) as ParsedTemporal;

    console.log('[Roundtrip] Exporting roundtrip SOG4 sequence');
    await exportSequence(roundtripParsed, roundtripDir, 'SOG4-RT', startFrame, endFrame);

    const cmp = spawnSync('python3', [
        'scripts/compare_ply_dirs.py',
        directDir,
        roundtripDir,
        String(startFrame),
        String(endFrame)
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024
    });
    if (cmp.status !== 0) {
        throw new Error(cmp.stderr || cmp.stdout || 'compare_ply_dirs.py failed');
    }

    const full = JSON.parse(cmp.stdout);
    const summary = summarize(full);
    fs.writeFileSync(path.join(out, 'compare_full.json'), JSON.stringify(full, null, 2));
    fs.writeFileSync(path.join(out, 'compare_summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    console.log(`[Roundtrip] Output: ${out}`);
}

main().catch((err) => {
    console.error('[Roundtrip] Failed:', err);
    process.exit(1);
});
