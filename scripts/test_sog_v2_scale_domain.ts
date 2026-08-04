import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { decodeSogV2ScaleLogValue, SOGv2Loader } from '../src/utils/sog-v2-loader';

// #WDD-gpt  2026-08-04 - 回归验证 SOG v2 尺度只在 GSplatData 阶段指数化一次，防止所有高斯膨胀
const codebook = [-7.25, -4.5, -1.25, 0.75];
const storedScale = decodeSogV2ScaleLogValue(codebook, 1);
const linearScale = Math.exp(storedScale);
const doubleExpScale = Math.exp(linearScale);

assert.equal(storedScale, -4.5);
assert.ok(Math.abs(linearScale - Math.exp(-4.5)) < 1e-12);
assert.ok(linearScale < 0.02);
assert.ok(doubleExpScale > 1, 'The old double-exp path should demonstrate the oversized Gaussian regression.');
assert.throws(() => decodeSogV2ScaleLogValue([Number.NaN], 0), /invalid codebook value/);
assert.throws(() => decodeSogV2ScaleLogValue([], 255), /invalid codebook value/);

const scaleCodebook = new Array(256).fill(-5);
scaleCodebook[3] = -6.25;
scaleCodebook[7] = -4.75;
scaleCodebook[11] = -3.5;

const zip = new JSZip();
zip.file('meta.json', JSON.stringify({
    version: 2,
    count: 1,
    means: { mins: [0, 0, 0], maxs: [0, 0, 0], files: ['means_l.webp', 'means_u.webp'] },
    quats: { files: ['quats.webp'] },
    scales: { codebook: scaleCodebook, files: ['scales.webp'] },
    sh0: { codebook: [0], files: ['sh0.webp'] }
}));
for (const name of ['means_l.webp', 'means_u.webp', 'quats.webp', 'scales.webp', 'sh0.webp']) {
    zip.file(name, new Uint8Array([0]));
}

const decodedTextures = [
    new Uint8Array([0, 0, 0, 255]),
    new Uint8Array([0, 0, 0, 255]),
    new Uint8Array([128, 128, 128, 252]),
    new Uint8Array([3, 7, 11, 255]),
    new Uint8Array([0, 0, 0, 128])
];
const loader = new SOGv2Loader({
    async decode() {
        const data = decodedTextures.shift();
        if (!data) throw new Error('Unexpected SOG texture decode request.');
        return { data, width: 1, height: 1 };
    }
});
const parsed = await loader.parse(await zip.generateAsync({ type: 'arraybuffer' }), () => {});
const properties = new Map(parsed.plyData.elements[0].properties.map((property) => [property.name, property.storage]));

assert.deepEqual(Array.from(properties.get('scale_0') as Float32Array), [-6.25]);
assert.deepEqual(Array.from(properties.get('scale_1') as Float32Array), [-4.75]);
assert.deepEqual(Array.from(properties.get('scale_2') as Float32Array), [-3.5]);
assert.equal(decodedTextures.length, 0);

console.log('SOG v2 scale-domain self-check passed.');
