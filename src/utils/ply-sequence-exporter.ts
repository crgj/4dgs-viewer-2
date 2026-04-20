import { PLYEncoder } from './ply-encoder';

// #WDD 2026-04-19 重写TS版本的PLY序列导出代码，完全对齐 extract_checkpoint_ply.py 里的逻辑，
// 包括不透明度概率截顶和筛选、关键帧查表、及四元数SLERP插值计算。
// 用于支持将带有动画的PLY4打包批量导出为标准的、按帧拆分的3DGS PLY文件。

type FrameBuildContext = {
    count: number;
    totalFrames: number;

    xyzKeyTimes: number[];
    xyzBank: Float32Array | null;
    K_xyz: number;

    rotKeyTimes: number[];
    rotBank: Float32Array | null;
    K_rot: number;

    dcKeyTimes: number[];
    dcBank: Float32Array | null;
    K_dc: number;

    x: Float32Array | undefined;
    y: Float32Array | undefined;
    z: Float32Array | undefined;

    rot_w: Float32Array | undefined;
    rot_x: Float32Array | undefined;
    rot_y: Float32Array | undefined;
    rot_z: Float32Array | undefined;

    s0: Float32Array | undefined;
    s1: Float32Array | undefined;
    s2: Float32Array | undefined;

    fdc0: Float32Array | undefined;
    fdc1: Float32Array | undefined;
    fdc2: Float32Array | undefined;

    baseAlpha: Float32Array | null;
    lifetimeMu: Float32Array | null;
    lifetimeW: Float32Array | null;

    fRestNames: string[];
    fRest: Float32Array[];

    rotationSemantic: 'wxyz' | 'xyzw';
    originalIndices: Float32Array | null;
};

// 辅助函数，兼容从 plyData 数据集内部或者外部第一层寻找属性
function getProp(data: any, name: string): Float32Array | null {
    if (data[name] instanceof Float32Array) return data[name];
    if (data.plyData?.elements?.[0]?.properties) {
        const prop = data.plyData.elements[0].properties.find((p: any) => p.name === name);
        if (prop && prop.storage instanceof Float32Array) {
            return prop.storage;
        }
    }
    return null;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const sigmoid = (v: number) => 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, v))));

const logit = (v: number) => {
    const x = clamp(v, 1e-7, 1.0 - 1e-7);
    return Math.log(x / (1.0 - x));
};

function slerp_np(q0: [number, number, number, number], q1In: [number, number, number, number], alpha: number): [number, number, number, number] {
    let len0 = Math.hypot(q0[0], q0[1], q0[2], q0[3]) || 1e-10;
    let nq0 = [q0[0] / len0, q0[1] / len0, q0[2] / len0, q0[3] / len0];

    let len1 = Math.hypot(q1In[0], q1In[1], q1In[2], q1In[3]) || 1e-10;
    let nq1 = [q1In[0] / len1, q1In[1] / len1, q1In[2] / len1, q1In[3] / len1];

    let dot = nq0[0] * nq1[0] + nq0[1] * nq1[1] + nq0[2] * nq1[2] + nq0[3] * nq1[3];
    if (dot < 0) {
        nq1 = [-nq1[0], -nq1[1], -nq1[2], -nq1[3]];
        dot = -dot;
    }
    dot = clamp(dot, 0.0, 1.0);

    const theta_0 = Math.acos(dot);
    const sin_theta_0 = Math.sin(theta_0);

    let res: [number, number, number, number];
    if (sin_theta_0 > 1e-4) {
        const s0 = Math.sin((1.0 - alpha) * theta_0) / (sin_theta_0 + 1e-10);
        const s1 = Math.sin(alpha * theta_0) / (sin_theta_0 + 1e-10);
        res = [
            s0 * nq0[0] + s1 * nq1[0],
            s0 * nq0[1] + s1 * nq1[1],
            s0 * nq0[2] + s1 * nq1[2],
            s0 * nq0[3] + s1 * nq1[3]
        ];
    } else {
        res = [
            (1.0 - alpha) * nq0[0] + alpha * nq1[0],
            (1.0 - alpha) * nq0[1] + alpha * nq1[1],
            (1.0 - alpha) * nq0[2] + alpha * nq1[2],
            (1.0 - alpha) * nq0[3] + alpha * nq1[3]
        ];
    }

    const final_norm = Math.hypot(res[0], res[1], res[2], res[3]) || 1e-10;
    return [res[0] / final_norm, res[1] / final_norm, res[2] / final_norm, res[3] / final_norm];
}

function getKeyTimes(totalFrames: number, stride: number): number[] {
    const times: number[] = [];
    for (let i = 0; i < totalFrames; i += stride) {
        times.push(i);
    }
    if (times.length > 0 && times[times.length - 1] !== totalFrames - 1) {
        times.push(totalFrames - 1);
    }
    return times;
}

function computeInterpArray(t: number, keyTimes: number[]): { k0: number, k1: number, u: number } {
    const K = keyTimes.length;
    if (K <= 1) return { k0: 0, k1: 0, u: 0.0 };

    let idx = -1;
    for (let i = 0; i < K; i++) {
        if (keyTimes[i] <= t) {
            idx = i;
        } else {
            break;
        }
    }
    if (idx < 0) idx = 0;
    if (idx >= K - 1) idx = K - 2;

    const t0 = keyTimes[idx];
    const t1 = keyTimes[idx + 1];

    const numer = t - t0;
    const denom = t1 - t0;
    const alpha = denom > 0 ? numer / denom : 0.0;

    return { k0: idx, k1: idx + 1, u: alpha };
}

function createContext(data: any): FrameBuildContext {
    const count = Number(data?.count || 0);
    const totalFrames = Number(data?.frames || data?.duration || 1);

    const fRestNames: string[] = [];
    const fRest: Float32Array[] = [];
    
    // 收集 f_rest
    for (let i = 0; i < 45; i++) {
        const key = `f_rest_${i}`;
        const arr = getProp(data, key);
        if (arr) {
            fRestNames.push(key);
            fRest.push(arr);
        }
    }

    const lifetimeMu = getProp(data, 'lifetime_mu');
    const lifetimeW = getProp(data, 'lifetime_w');
    const originalIndices = getProp(data, 'originalIndices') || getProp(data, 'original_index');

    const xyzStride = Number(data?.xyzStride || 1);
    const rotStride = Number(data?.rotStride || 1);
    const dcStride = Number(data?.dcStride || 1);

    const xyzKeyTimes = getKeyTimes(totalFrames, xyzStride);
    const rotKeyTimes = getKeyTimes(totalFrames, rotStride);
    const dcKeyTimes = getKeyTimes(totalFrames, dcStride);

    const xyzBank = (data?.trajectory || data?.xyzBank || null) as Float32Array | null;
    const rotBank = (data?.rotTrajectory || data?.rotBank || null) as Float32Array | null;
    const dcBank = (data?.dcTrajectory || data?.dcBank || null) as Float32Array | null;

    const K_xyz = xyzBank ? Math.floor(xyzBank.length / (count * 3)) : 0;
    const K_rot = rotBank ? Math.floor(rotBank.length / (count * 4)) : 0;
    const K_dc = dcBank ? Math.floor(dcBank.length / (count * 3)) : 0;

    const opacityArray = data?.opacity as Float32Array | undefined;
    let baseAlpha: Float32Array | null = null;
    if (opacityArray) {
        baseAlpha = new Float32Array(count);
        const semantic = String(data?.opacitySemantic || 'logit');
        for (let i = 0; i < count; i++) {
            let v = opacityArray[i];
            if (semantic !== 'probability') {
                if (semantic === 'logit' || v < 0.0 || v > 1.0) {
                    v = sigmoid(v);
                }
            }
            baseAlpha[i] = v;
        }
    }

    return {
        count,
        totalFrames,

        xyzKeyTimes,
        xyzBank,
        K_xyz,

        rotKeyTimes,
        rotBank,
        K_rot,

        dcKeyTimes,
        dcBank,
        K_dc,

        rotationSemantic: data?.rotationSemantic === 'xyzw' ? 'xyzw' : 'wxyz',
        x: getProp(data, 'x') || undefined,
        y: getProp(data, 'y') || undefined,
        z: getProp(data, 'z') || undefined,
        rot_w: getProp(data, 'rot_0') || undefined,
        rot_x: getProp(data, 'rot_1') || undefined,
        rot_y: getProp(data, 'rot_2') || undefined,
        rot_z: getProp(data, 'rot_3') || undefined,
        s0: getProp(data, 'scale_0') || undefined,
        s1: getProp(data, 'scale_1') || undefined,
        s2: getProp(data, 'scale_2') || undefined,
        fdc0: getProp(data, 'f_dc_0') || undefined,
        fdc1: getProp(data, 'f_dc_1') || undefined,
        fdc2: getProp(data, 'f_dc_2') || undefined,

        baseAlpha,
        lifetimeMu,
        lifetimeW,
        fRestNames,
        fRest,
        originalIndices
    };
}

function buildFrameData(ctx: FrameBuildContext, t: number): any {
    const { count } = ctx;
    if (count <= 0) return { count: 0 };

    const xyzInterp = computeInterpArray(t, ctx.xyzKeyTimes);
    const rotInterp = computeInterpArray(t, ctx.rotKeyTimes);
    const dcInterp = computeInterpArray(t, ctx.dcKeyTimes);

    const visible: number[] = [];
    const finalOpacityLogit: number[] = [];

    for (let i = 0; i < count; i++) {
        const oidx = ctx.originalIndices ? Math.round(ctx.originalIndices[i]) : i;
        const bAlpha = ctx.baseAlpha ? ctx.baseAlpha[oidx] : 1.0;
        let currAlpha = bAlpha;

        if (ctx.lifetimeMu && ctx.lifetimeW) {
            const mu = ctx.lifetimeMu[oidx];
            const w = ctx.lifetimeW[oidx];
            const k = 10.0;
            const deltaLeft = t - (mu - w);
            const deltaRight = (mu + w) - t;
            const gate = sigmoid(k * deltaLeft) * sigmoid(k * deltaRight);
            currAlpha = bAlpha * gate;
        }

        if (currAlpha >= 0.01) {
            visible.push(i);
            finalOpacityLogit.push(logit(currAlpha));
        }
    }

    const n_alive = visible.length;
    if (n_alive === 0) {
        return { count: 0 };
    }

    const outCount = n_alive;
    const x = new Float32Array(outCount);
    const y = new Float32Array(outCount);
    const z = new Float32Array(outCount);
    const rot0 = new Float32Array(outCount);
    const rot1 = new Float32Array(outCount);
    const rot2 = new Float32Array(outCount);
    const rot3 = new Float32Array(outCount);
    const scale0 = new Float32Array(outCount);
    const scale1 = new Float32Array(outCount);
    const scale2 = new Float32Array(outCount);
    const fdc0 = new Float32Array(outCount);
    const fdc1 = new Float32Array(outCount);
    const fdc2 = new Float32Array(outCount);
    const opacity = new Float32Array(outCount);
    const fRestOut: Float32Array[] = ctx.fRest.map(() => new Float32Array(outCount));

    for (let j = 0; j < outCount; j++) {
        const i = visible[j];
        const oidx = ctx.originalIndices ? Math.round(ctx.originalIndices[i]) : i;

        if (ctx.xyzBank && ctx.K_xyz > 0) {
            if (ctx.K_xyz === 1) {
                x[j] = ctx.xyzBank[oidx * 3 + 0];
                y[j] = ctx.xyzBank[oidx * 3 + 1];
                z[j] = ctx.xyzBank[oidx * 3 + 2];
            } else {
                const base = oidx * ctx.K_xyz * 3;
                const p0r = base + xyzInterp.k0 * 3;
                const p1r = base + xyzInterp.k1 * 3;
                x[j] = ctx.xyzBank[p0r + 0] * (1.0 - xyzInterp.u) + ctx.xyzBank[p1r + 0] * xyzInterp.u;
                y[j] = ctx.xyzBank[p0r + 1] * (1.0 - xyzInterp.u) + ctx.xyzBank[p1r + 1] * xyzInterp.u;
                z[j] = ctx.xyzBank[p0r + 2] * (1.0 - xyzInterp.u) + ctx.xyzBank[p1r + 2] * xyzInterp.u;
            }
        } else {
            x[j] = ctx.x?.[oidx] ?? 0.0;
            y[j] = ctx.y?.[oidx] ?? 0.0;
            z[j] = ctx.z?.[oidx] ?? 0.0;
        }

        if (!ctx.rotBank || ctx.K_rot === 0) {
            rot0[j] = ctx.rot_w?.[oidx] ?? 1.0;
            rot1[j] = ctx.rot_x?.[oidx] ?? 0.0;
            rot2[j] = ctx.rot_y?.[oidx] ?? 0.0;
            rot3[j] = ctx.rot_z?.[oidx] ?? 0.0;
        } else if (ctx.K_rot === 1) {
            const b = oidx * 4;
            if (ctx.rotationSemantic === 'xyzw') {
                rot0[j] = ctx.rotBank[b + 3];
                rot1[j] = ctx.rotBank[b + 0];
                rot2[j] = ctx.rotBank[b + 1];
                rot3[j] = ctx.rotBank[b + 2];
            } else {
                rot0[j] = ctx.rotBank[b + 0];
                rot1[j] = ctx.rotBank[b + 1];
                rot2[j] = ctx.rotBank[b + 2];
                rot3[j] = ctx.rotBank[b + 3];
            }
        } else {
            const base = oidx * ctx.K_rot * 4;
            const r0a = base + rotInterp.k0 * 4;
            const r1a = base + rotInterp.k1 * 4;

            let q0: [number, number, number, number];
            let q1: [number, number, number, number];

            if (ctx.rotationSemantic === 'xyzw') {
                q0 = [ctx.rotBank[r0a + 3], ctx.rotBank[r0a + 0], ctx.rotBank[r0a + 1], ctx.rotBank[r0a + 2]];
                q1 = [ctx.rotBank[r1a + 3], ctx.rotBank[r1a + 0], ctx.rotBank[r1a + 1], ctx.rotBank[r1a + 2]];
            } else {
                q0 = [ctx.rotBank[r0a + 0], ctx.rotBank[r0a + 1], ctx.rotBank[r0a + 2], ctx.rotBank[r0a + 3]];
                q1 = [ctx.rotBank[r1a + 0], ctx.rotBank[r1a + 1], ctx.rotBank[r1a + 2], ctx.rotBank[r1a + 3]];
            }

            const qr = slerp_np(q0, q1, rotInterp.u);
            rot0[j] = qr[0]; // W
            rot1[j] = qr[1]; // X
            rot2[j] = qr[2]; // Y
            rot3[j] = qr[3]; // Z
        }

        scale0[j] = ctx.s0?.[oidx] ?? 1.0;
        scale1[j] = ctx.s1?.[oidx] ?? 1.0;
        scale2[j] = ctx.s2?.[oidx] ?? 1.0;

        if (ctx.dcBank && ctx.K_dc > 0) {
            if (ctx.K_dc === 1) {
                fdc0[j] = ctx.dcBank[oidx * 3 + 0];
                fdc1[j] = ctx.dcBank[oidx * 3 + 1];
                fdc2[j] = ctx.dcBank[oidx * 3 + 2];
            } else {
                const base = oidx * ctx.K_dc * 3;
                const d0r = base + dcInterp.k0 * 3;
                const d1r = base + dcInterp.k1 * 3;
                fdc0[j] = ctx.dcBank[d0r + 0] * (1 - dcInterp.u) + ctx.dcBank[d1r + 0] * dcInterp.u;
                fdc1[j] = ctx.dcBank[d0r + 1] * (1 - dcInterp.u) + ctx.dcBank[d1r + 1] * dcInterp.u;
                fdc2[j] = ctx.dcBank[d0r + 2] * (1 - dcInterp.u) + ctx.dcBank[d1r + 2] * dcInterp.u;
            }
        } else {
            fdc0[j] = ctx.fdc0?.[oidx] ?? 0.0;
            fdc1[j] = ctx.fdc1?.[oidx] ?? 0.0;
            fdc2[j] = ctx.fdc2?.[oidx] ?? 0.0;
        }

        opacity[j] = finalOpacityLogit[j];

        for (let r = 0; r < fRestOut.length; r++) {
            fRestOut[r][j] = ctx.fRest[r]?.[oidx] ?? 0.0;
        }
    }

    const out: any = {
        count: outCount,
        x, y, z,
        rot_0: rot0, rot_1: rot1, rot_2: rot2, rot_3: rot3,
        scale_0: scale0, scale_1: scale1, scale_2: scale2,
        f_dc_0: fdc0, f_dc_1: fdc1, f_dc_2: fdc2,
        opacity
    };

    for (let r = 0; r < ctx.fRestNames.length; r++) {
        out[ctx.fRestNames[r]] = fRestOut[r];
    }

    return out;
}

export async function exportPLYSequence(
    data: any,
    baseName: string,
    progress?: (pct: number, msg: string) => void
): Promise<{ frameCount: number; buffers: ArrayBuffer[] }> {
    const ctx = createContext(data);
    if (ctx.count <= 0 || ctx.totalFrames <= 0) {
        return { frameCount: 0, buffers: [] };
    }

    const buffers: ArrayBuffer[] = [];
    for (let frame = 0; frame < ctx.totalFrames; frame++) {
        progress?.((frame / ctx.totalFrames) * 100, `Exporting frame ${frame + 1}/${ctx.totalFrames}`);
        const frameData = buildFrameData(ctx, frame);
        const outCount = frameData.count || 0;

        let buffer: ArrayBuffer;
        if (outCount > 0) {
            buffer = await PLYEncoder.encode(frameData);
        } else {
            buffer = await PLYEncoder.encode({ count: 0 });
        }

        buffers.push(buffer);
        progress?.(((frame + 1) / ctx.totalFrames) * 100, `Frame ${frame + 1}/${ctx.totalFrames} exported (${outCount} pts)`);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { frameCount: ctx.totalFrames, buffers };
}
