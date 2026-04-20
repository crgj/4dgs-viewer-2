import JSZip from 'jszip';
import { PLY4Encoder } from './ply4-encoder';

function slerp(
    q0: [number, number, number, number],
    q1: [number, number, number, number],
    t: number
): [number, number, number, number] {
    let dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];

    if (dot < 0) {
        q1 = [-q1[0], -q1[1], -q1[2], -q1[3]];
        dot = -dot;
    }

    if (dot > 0.9995) {
        const result = [
            q0[0] + t * (q1[0] - q0[0]),
            q0[1] + t * (q1[1] - q0[1]),
            q0[2] + t * (q1[2] - q0[2]),
            q0[3] + t * (q1[3] - q0[3])
        ];
        const len = Math.sqrt(result[0] ** 2 + result[1] ** 2 + result[2] ** 2 + result[3] ** 2);
        return [result[0] / len, result[1] / len, result[2] / len, result[3] / len] as [number, number, number, number];
    }

    const theta0 = Math.acos(dot);
    const theta = theta0 * t;
    const sinTheta = Math.sin(theta);
    const sinTheta0 = Math.sin(theta0);

    const s0 = Math.cos(theta) - dot * sinTheta / sinTheta0;
    const s1 = sinTheta / sinTheta0;

    return [
        q0[0] * s0 + q1[0] * s1,
        q0[1] * s0 + q1[1] * s1,
        q0[2] * s0 + q1[2] * s1,
        q0[3] * s0 + q1[3] * s1
    ] as [number, number, number, number];
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export type FrameBuildCtx = {
    count: number;
    keyframes: number;
    xyzStride: number;
    rotKeyframes: number;
    rotStride: number;
    dcKeyframes: number;
    dcStride: number;
    xyzBank: Float32Array;
    rotBank: Float32Array | null;
    dcBank: Float32Array | null;
    origIndices: Float32Array | null;
    rotationSemantic: string | undefined;
};

const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));

/**
 * Build a single-frame data object by interpolating multi-frame PLY4 data at a given frame.
 */
export async function buildFrameData(data: any, frame: number, ctx: FrameBuildCtx): Promise<any> {
    const {
        count, keyframes, xyzStride, rotKeyframes, rotStride,
        dcKeyframes, dcStride, xyzBank, rotBank, dcBank,
        origIndices, rotationSemantic
    } = ctx;

    const lifetime_mu = data.lifetime_mu;
    const lifetime_w = data.lifetime_w;

    const duration = data.duration || data.frames || 1;
    const maxTime = Math.max(0, Math.min(duration - 1, (keyframes - 1) * xyzStride));
    const tClamped = Math.max(0, Math.min(frame, maxTime));
    const idx = xyzStride > 0 ? Math.floor(tClamped / xyzStride) : 0;
    const k0 = keyframes <= 1 ? 0 : Math.min(Math.max(0, idx), keyframes - 1);
    const k1 = keyframes <= 1 ? 0 : Math.min(k0 + 1, keyframes - 1);
    const t0 = k0 * xyzStride;
    const t1 = k1 * xyzStride;
    const ratioXYZ = (k0 === k1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));

    const rotIdx = rotStride > 0 ? Math.floor(tClamped / rotStride) : 0;
    const rk0 = rotKeyframes <= 1 ? 0 : Math.min(Math.max(0, rotIdx), rotKeyframes - 1);
    const rk1 = rotKeyframes <= 1 ? 0 : Math.min(rk0 + 1, rotKeyframes - 1);
    const rt0 = rk0 * rotStride;
    const rt1 = rk1 * rotStride;
    const ratioRot = (rk0 === rk1 || rt1 === rt0) ? 0 : Math.max(0, Math.min(1, (tClamped - rt0) / (rt1 - rt0)));

    const dcIdx = dcStride > 0 ? Math.floor(tClamped / dcStride) : 0;
    const dk0 = dcKeyframes <= 1 ? 0 : Math.min(Math.max(0, dcIdx), dcKeyframes - 1);
    const dk1 = dcKeyframes <= 1 ? 0 : Math.min(dk0 + 1, dcKeyframes - 1);
    const dt0 = dk0 * dcStride;
    const dt1 = dk1 * dcStride;
    const ratioDC = (dk0 === dk1 || dt1 === dt0) ? 0 : Math.max(0, Math.min(1, (tClamped - dt0) / (dt1 - dt0)));

    // Visible Indices Selection (Filter by Lifetime)
    const visibleIndices: number[] = [];
    for (let i = 0; i < count; i++) {
        const oidx = origIndices ? Math.round(origIndices[i]) : i;
        const mu = lifetime_mu ? lifetime_mu[oidx] : 25;
        const w = lifetime_w ? lifetime_w[oidx] : 100;
        // #WDD 2026-04-19 增加可见性过滤 避免导出当前时刻不可见的点
        const gate = sigmoid(10.0 * (frame - (mu - w))) * sigmoid(10.0 * ((mu + w) - frame));
        
        let opac = data.opacity ? data.opacity[oidx] : 1.0;
        if (data.opacitySemantic === 'logit') {
            opac = sigmoid(opac);
        }
        
        if (gate * opac >= 0.005) {
            visibleIndices.push(i);
        }
    }

    const visibleCount = visibleIndices.length;
    const newX = new Float32Array(visibleCount);
    const newY = new Float32Array(visibleCount);
    const newZ = new Float32Array(visibleCount);
    const newRot0 = rotBank && rotKeyframes > 0 ? new Float32Array(visibleCount) : null;
    const newRot1 = rotBank && rotKeyframes > 0 ? new Float32Array(visibleCount) : null;
    const newRot2 = rotBank && rotKeyframes > 0 ? new Float32Array(visibleCount) : null;
    const newRot3 = rotBank && rotKeyframes > 0 ? new Float32Array(visibleCount) : null;
    const newDc0 = dcBank && dcKeyframes > 0 ? new Float32Array(visibleCount) : null;
    const newDc1 = dcBank && dcKeyframes > 0 ? new Float32Array(visibleCount) : null;
    const newDc2 = dcBank && dcKeyframes > 0 ? new Float32Array(visibleCount) : null;
    const newOpacity = new Float32Array(visibleCount);
    const newScale0 = new Float32Array(visibleCount);
    const newScale1 = new Float32Array(visibleCount);
    const newScale2 = new Float32Array(visibleCount);

    for (let j = 0; j < visibleCount; j++) {
        const i = visibleIndices[j];
        const oidx = origIndices ? Math.round(origIndices[i]) : i;

        // Static Props
        newOpacity[j] = data.opacity ? data.opacity[oidx] : 0;
        newScale0[j] = data.scale_0 ? data.scale_0[oidx] : 1.0;
        newScale1[j] = data.scale_1 ? data.scale_1[oidx] : 1.0;
        newScale2[j] = data.scale_2 ? data.scale_2[oidx] : 1.0;

        // XYZ
        const xBase = oidx * keyframes * 3;
        const xb0 = xBase + k0 * 3;
        const xb1 = xBase + k1 * 3;
        newX[j] = lerp(xyzBank[xb0 + 0], xyzBank[xb1 + 0], ratioXYZ);
        newY[j] = lerp(xyzBank[xb0 + 1], xyzBank[xb1 + 1], ratioXYZ);
        newZ[j] = lerp(xyzBank[xb0 + 2], xyzBank[xb1 + 2], ratioXYZ);

        // Rotation
        if (rotBank && rotKeyframes > 0 && newRot0 && newRot1 && newRot2 && newRot3) {
            const rBase = oidx * rotKeyframes * 4;
            const rb0 = rBase + rk0 * 4;
            const rb1 = rBase + rk1 * 4;
            const q0: [number, number, number, number] = [rotBank[rb0 + 0], rotBank[rb0 + 1], rotBank[rb0 + 2], rotBank[rb0 + 3]];
            const q1: [number, number, number, number] = [rotBank[rb1 + 0], rotBank[rb1 + 1], rotBank[rb1 + 2], rotBank[rb1 + 3]];
            const qr = slerp(q0, q1, ratioRot);
            if (rotationSemantic === 'xyzw') {
                newRot0[j] = qr[1]; newRot1[j] = qr[2]; newRot2[j] = qr[3]; newRot3[j] = qr[0];
            } else {
                newRot0[j] = qr[0]; newRot1[j] = qr[1]; newRot2[j] = qr[2]; newRot3[j] = qr[3];
            }
        }

        // DC
        if (dcBank && dcKeyframes > 0 && newDc0 && newDc1 && newDc2) {
            const dBase = oidx * dcKeyframes * 3;
            const db0 = dBase + dk0 * 3;
            const db1 = dBase + dk1 * 3;
            newDc0[j] = lerp(dcBank[db0 + 0], dcBank[db1 + 0], ratioDC);
            newDc1[j] = lerp(dcBank[db0 + 1], dcBank[db1 + 1], ratioDC);
            newDc2[j] = lerp(dcBank[db0 + 2], dcBank[db1 + 2], ratioDC);
        }

        if (j % 20000 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    const finalFrameData: any = {
        count: visibleCount,
        frames: 1,
        duration: 1,
        x: newX,
        y: newY,
        z: newZ,
        opacity: newOpacity,
        scale_0: newScale0,
        scale_1: newScale1,
        scale_2: newScale2,
        lifetime_mu: new Float32Array(visibleCount),
        lifetime_w: new Float32Array(visibleCount),
        lifetime_k: new Float32Array(visibleCount),
        keyframes: 0,
        xyzStride: 1,
        rotKeyframes: 0,
        rotStride: 1,
        dcKeyframes: 0,
        dcStride: 1,
        opacitySemantic: data.opacitySemantic,
        rotationSemantic: data.rotationSemantic,
        originalIndices: null
    };

    if (newRot0) {
        finalFrameData.rot_0 = newRot0;
        finalFrameData.rot_1 = newRot1;
        finalFrameData.rot_2 = newRot2;
        finalFrameData.rot_3 = newRot3;
    }
    if (newDc0) {
        finalFrameData.f_dc_0 = newDc0;
        finalFrameData.f_dc_1 = newDc1;
        finalFrameData.f_dc_2 = newDc2;
    }

    // Copy SH rest
    for (const key of Object.keys(data)) {
        if ((/^f_rest_\d+$/).test(key)) {
            const restOrig = data[key];
            const newRest = new Float32Array(visibleCount);
            for (let j = 0; j < visibleCount; j++) {
                const i = visibleIndices[j];
                const oidx = origIndices ? Math.round(origIndices[i]) : i;
                newRest[j] = restOrig[oidx];
            }
            finalFrameData[key] = newRest;
        }
    }

    if (data.plyData) finalFrameData.plyData = data.plyData;
    if (data.meta) finalFrameData.meta = data.meta;

    return finalFrameData;
}

/**
 * Export a multi-frame PLY4 into a sequence of single-frame PLY4 files.
 */
export async function exportPLY4Sequence(
    data: any,
    baseName: string,
    progress?: (pct: number, msg: string) => void
): Promise<{ zipBuffer: ArrayBuffer; frameCount: number }> {
    const totalFrames = data.frames || 1;
    
    // Create ctx
    const ctx: FrameBuildCtx = {
        count: data.count || 0,
        keyframes: data.keyframes || 1,
        xyzStride: data.xyzStride || 1,
        rotKeyframes: data.rotKeyframes || 0,
        rotStride: data.rotStride || 1,
        dcKeyframes: data.dcKeyframes || 0,
        dcStride: data.dcStride || 1,
        xyzBank: data.trajectory || data.xyzBank,
        rotBank: data.rotTrajectory || data.rotBank,
        dcBank: data.dcTrajectory || data.dcBank,
        origIndices: data.originalIndices as Float32Array | null,
        rotationSemantic: data.rotationSemantic
    };

    const zip = new JSZip();
    const folder = zip.folder(baseName) || zip;

    for (let frame = 0; frame < totalFrames; frame++) {
        progress?.((frame / totalFrames) * 100, `Exporting frame ${frame + 1}/${totalFrames}`);

        const frameData = await buildFrameData(data, frame, ctx);

        const buffer = await PLY4Encoder.encode(frameData, {}, (p, m) => {});

        const frameIndexStr = String(frame).padStart(3, '0');
        folder.file(`${baseName}_${frameIndexStr}.ply4`, new Uint8Array(buffer));
    }

    progress?.(95, 'Packing zip archive...');
    const zipBuffer = await zip.generateAsync(
        { type: 'arraybuffer', compression: 'STORE' },
        (meta) => {
            if (meta.percent % 10 === 0) progress?.(95 + (meta.percent / 100) * 5, `Packing zip... ${meta.percent.toFixed(0)}%`);
        }
    ) as ArrayBuffer;
    progress?.(100, 'Sequence export complete');

    return { zipBuffer, frameCount: totalFrames };
}
