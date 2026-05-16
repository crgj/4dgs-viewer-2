import { autoAlign4DGSScene } from './index';
import type { GaussianPoint, Vec3 } from './types';
import { add, applyMatrix, dot, length, matMul, mul, rotationAroundAxis, sub } from './vector';

type TestResult = { name: string; pass: boolean; detail: string };

// #WDD-gpt 2026-05-16 - 合成场景自测，覆盖随机旋转、墙面动态点、飞絮噪声和失败场景
export function runAutoGroundAlignmentSelfTest() {
    const tests: Array<() => TestResult> = [
        testStandardStandingPerson,
        testWallDynamicPoints,
        testFloatingNoise,
        testTiltedWalls,
        testFailureCase
    ];
    const results = tests.map((fn) => fn());
    console.log('AutoGroundAlignment Self Test');
    for (const r of results) {
        console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
    }
    const allPass = results.every((r) => r.pass);
    if (!allPass) {
        throw new Error(`AutoGroundAlignment self test failed: ${results.filter((r) => !r.pass).map((r) => r.name).join(', ')}`);
    }
    return results;
}

function testStandardStandingPerson(): TestResult {
    const scene = makeScene({ seed: 1 });
    const result = autoAlign4DGSScene(scene.points, [], { debug: true, dynamicClusterMinPoints: 30, staticClusterMinPoints: 50 });
    return assertSuccess('standard standing person', scene, result);
}

function testWallDynamicPoints(): TestResult {
    const scene = makeScene({ seed: 2, wallDynamic: true });
    const result = autoAlign4DGSScene(scene.points, [], { debug: true, dynamicClusterMinPoints: 30, staticClusterMinPoints: 50 });
    const selected = result.personCluster?.diagnostics?.backgroundAttachmentPenalty ?? 0;
    const base = assertSuccess('wall dynamic points', scene, result);
    if (!base.pass) return base;
    return {
        name: base.name,
        pass: selected < 0.8,
        detail: `backgroundPenalty=${selected.toFixed(2)} confidence=${result.confidence.toFixed(2)}`
    };
}

function testFloatingNoise(): TestResult {
    const scene = makeScene({ seed: 3, staticNoise: 600, dynamicNoise: 420 });
    const result = autoAlign4DGSScene(scene.points, [], { debug: true, dynamicClusterMinPoints: 30, staticClusterMinPoints: 50 });
    return assertSuccess('floating noise', scene, result);
}

function testTiltedWalls(): TestResult {
    const scene = makeScene({ seed: 4, tiltedWall: true, wallDynamic: true });
    const result = autoAlign4DGSScene(scene.points, [], { debug: true, dynamicClusterMinPoints: 30, staticClusterMinPoints: 50 });
    return assertSuccess('tilted walls', scene, result);
}

function testFailureCase(): TestResult {
    const points: GaussianPoint[] = [];
    for (let i = 0; i < 120; i++) {
        points.push({ id: `d${i}`, position: [Math.sin(i) * 0.2, i / 120, Math.cos(i) * 0.2], motionLabel: 'dynamic', motionMagnitude: 0.1 });
    }
    const result = autoAlign4DGSScene(points, [], { debug: true, dynamicClusterMinPoints: 20 });
    return {
        name: 'failure case',
        pass: !result.success && result.errors.length > 0,
        detail: result.errors.join('; ')
    };
}

function assertSuccess(name: string, scene: ReturnType<typeof makeScene>, result: ReturnType<typeof autoAlign4DGSScene>): TestResult {
    if (!result.success || !result.transform) {
        return { name, pass: false, detail: `expected success, got errors=${result.errors.join('; ')} confidence=${result.confidence.toFixed(2)}` };
    }
    const transformedNormal = applyMatrix(result.transform.rotationMatrix, scene.groundNormal);
    const normalOk = dot(transformedNormal, [0, 1, 0]) > 0.96;
    const foot = result.transform.applyToPoint(result.footCenter || result.transform.footCenter);
    const footOk = length(foot) < 0.08;
    const personYs = scene.personPoints.map((p) => result.transform!.applyToPoint(p.position)[1]).sort((a, b) => a - b);
    const aboveRatio = personYs.filter((y) => y > -0.08).length / personYs.length;
    const yOk = aboveRatio > 0.86;
    const pass = normalOk && footOk && yOk && result.confidence > 0.45;
    return {
        name,
        pass,
        detail: `normalDot=${dot(transformedNormal, [0, 1, 0]).toFixed(3)} footLen=${length(foot).toFixed(3)} above=${aboveRatio.toFixed(2)} confidence=${result.confidence.toFixed(2)}`
    };
}

function makeScene(config: { seed: number; wallDynamic?: boolean; tiltedWall?: boolean; staticNoise?: number; dynamicNoise?: number }) {
    const rand = makeRand(config.seed);
    const points: GaussianPoint[] = [];
    const personPoints: GaussianPoint[] = [];
    let id = 0;
    const addPoint = (position: Vec3, label: 'static' | 'dynamic', prefix: string) => {
        const p: GaussianPoint = {
            id: `${prefix}${id++}`,
            position,
            motionLabel: label,
            motionMagnitude: label === 'dynamic' ? 0.12 + rand() * 0.04 : 0,
            opacity: 0.8,
            scale: 0.015
        };
        points.push(p);
        if (prefix === 'person') personPoints.push(p);
        return p;
    };
    for (let i = 0; i < 900; i++) {
        const x = (rand() - 0.5) * 2.8;
        const z = (rand() - 0.5) * 2.8;
        const y = noise(rand, 0.015);
        addPoint([x, y, z], 'static', 'ground');
    }
    for (let i = 0; i < 620; i++) {
        const angle = rand() * Math.PI * 2;
        const h = rand() * 1.65 + 0.03;
        const radius = 0.16 + noise(rand, 0.035) + (h > 1.25 ? 0.08 : 0);
        const p = addPoint([Math.cos(angle) * radius + noise(rand, 0.025), h, Math.sin(angle) * radius + noise(rand, 0.025)], 'dynamic', 'person');
        p.positionsOverTime = [[p.position[0], p.position[1], p.position[2]], [p.position[0] + noise(rand, 0.05), p.position[1], p.position[2] + noise(rand, 0.05)]];
    }
    const wallTilt = config.tiltedWall ? 0.35 : 0;
    for (let i = 0; i < 600; i++) {
        const x = (rand() - 0.5) * 2.8;
        const y = rand() * 1.8;
        const z = -1.35 + wallTilt * y + noise(rand, 0.02);
        addPoint([x, y, z], 'static', 'wall');
    }
    if (config.wallDynamic) {
        for (let i = 0; i < 180; i++) {
            const x = -0.9 + rand() * 0.5;
            const y = 0.5 + rand() * 0.5;
            const z = -1.33 + wallTilt * y + noise(rand, 0.01);
            addPoint([x, y, z], 'dynamic', 'wallDyn');
        }
    }
    for (let i = 0; i < (config.staticNoise || 80); i++) {
        addPoint([(rand() - 0.5) * 4, (rand() - 0.2) * 2.4, (rand() - 0.5) * 4], 'static', 'noiseS').opacity = 0.2;
    }
    for (let i = 0; i < (config.dynamicNoise || 60); i++) {
        addPoint([(rand() - 0.5) * 4, (rand() - 0.2) * 2.4, (rand() - 0.5) * 4], 'dynamic', 'noiseD').opacity = 0.2;
    }

    const rot = randomRotation(config.seed + 100);
    for (const p of points) {
        p.position = applyMatrix(rot, p.position);
        if (p.positionsOverTime) p.positionsOverTime = p.positionsOverTime.map((x) => applyMatrix(rot, x));
    }
    const groundNormal = applyMatrix(rot, [0, 1, 0]);
    return { points, personPoints, groundNormal };
}

function randomRotation(seed: number) {
    const rand = makeRand(seed);
    const r1 = rotationAroundAxis([rand() - 0.5, rand() - 0.5, rand() - 0.5], rand() * Math.PI * 2);
    const r2 = rotationAroundAxis([rand() - 0.5, rand() - 0.5, rand() - 0.5], rand() * Math.PI * 2);
    return matMul(r2, r1);
}

function noise(rand: () => number, amp: number) {
    return (rand() + rand() + rand() - 1.5) * amp;
}

function makeRand(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('selfTest.ts')) {
    runAutoGroundAlignmentSelfTest();
}
