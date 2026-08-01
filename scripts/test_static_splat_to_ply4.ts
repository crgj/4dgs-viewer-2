import assert from 'node:assert/strict';
import { PLYEncoder } from '../src/utils/ply-encoder';
import { PLY4Encoder } from '../src/utils/ply4-encoder';
import { PLY4Loader } from '../src/utils/ply4-loader';
import { convertStaticSplatToTwoKeyframePLY4 } from '../src/utils/static-splat-to-ply4';

const values = {
    x: new Float32Array([1, 4]),
    y: new Float32Array([2, 5]),
    z: new Float32Array([3, 6]),
    f_dc_0: new Float32Array([0.1, 0.4]),
    f_dc_1: new Float32Array([0.2, 0.5]),
    f_dc_2: new Float32Array([0.3, 0.6]),
    opacity: new Float32Array([2, 3]),
    scale_0: new Float32Array([-1, -2]),
    scale_1: new Float32Array([-1.1, -2.1]),
    scale_2: new Float32Array([-1.2, -2.2]),
    rot_0: new Float32Array([1, 1]),
    rot_1: new Float32Array([0, 0]),
    rot_2: new Float32Array([0, 0]),
    rot_3: new Float32Array([0, 0])
};

const staticPly = await PLYEncoder.encode({ count: 2, ...values });
const parsed: any = await new PLY4Loader().load(staticPly);
assert.equal(parsed.keyframes, 0);
assert.equal(parsed.is4DGS, false);

convertStaticSplatToTwoKeyframePLY4(parsed);

assert.equal(parsed.frames, 2);
assert.equal(parsed.keyframes, 2);
assert.equal(parsed.rotKeyframes, 2);
assert.equal(parsed.dcKeyframes, 2);
assert.equal(parsed.xyzStride, 1);
assert.equal(parsed.rotStride, 1);
assert.equal(parsed.dcStride, 1);
assert.equal(parsed.is4DGS, true);
assert.equal(parsed.rotationSemantic, 'wxyz');
assert.deepEqual(Array.from(parsed.trajectory), [1, 2, 3, 1, 2, 3, 4, 5, 6, 4, 5, 6]);
assert.deepEqual(Array.from(parsed.rotTrajectory), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

const properties = new Map(parsed.plyData.elements[0].properties.map((property: any) => [property.name, property.storage]));
assert.deepEqual(Array.from(properties.get('lifetime_mu') as Float32Array), [0.5, 0.5]);
assert.deepEqual(Array.from(properties.get('lifetime_w') as Float32Array), [1.5, 1.5]);
assert.deepEqual(Array.from(properties.get('lifetime_k') as Float32Array), [10, 10]);

parsed.trajectory[3] = 7;
parsed.rotTrajectory[4] = 0.5;
parsed.rotTrajectory[5] = 0.5;
parsed.dcTrajectory[3] = 0.9;

const encoded = await PLY4Encoder.encode(parsed);
const headerProbe = new TextDecoder('ascii').decode(encoded.slice(0, Math.min(encoded.byteLength, 4096)));
assert.match(headerProbe, /comment total_frames 2/);
assert.match(headerProbe, /property float xyz_bank_1_z/);
assert.match(headerProbe, /property float rot_bank_1_w/);
assert.match(headerProbe, /property float f_dc_bank_1_2/);

const decoded = await new PLY4Loader().load(encoded);
assert.equal(decoded.frames, 2);
assert.equal(decoded.keyframes, 2);
assert.equal(decoded.rotKeyframes, 2);
assert.equal(decoded.dcKeyframes, 2);
assert.equal(decoded.trajectory.length, 12);
assert.equal(decoded.rotTrajectory.length, 16);
assert.equal(decoded.dcTrajectory.length, 12);
const editedIndex = Array.from(decoded.x as Float32Array).findIndex((value) => value === 1);
assert.notEqual(editedIndex, -1);
assert.equal(decoded.trajectory[(editedIndex * 2 + 1) * 3], 7);
assert.equal(decoded.rotTrajectory[(editedIndex * 2 + 1) * 4], 0.5);
assert.ok(Math.abs(decoded.dcTrajectory[(editedIndex * 2 + 1) * 3] - 0.9) < 1e-6);

const selectionData = new Uint8Array(8);
selectionData[5] = 255;
const editedAndDeleted = await PLY4Encoder.encode(parsed, { selectionData });
const decodedAfterDelete = await new PLY4Loader().load(editedAndDeleted);
assert.equal(decodedAfterDelete.count, 1);

console.log('Static splat to two-keyframe PLY4 self-check passed.');
