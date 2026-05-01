import re
import os

with open('/home/crgj/wdd/data/towdd/005/ply4_to_sog4.ts', 'r') as f:
    text = f.read()

# Remove node imports
text = re.sub(r'import fs = require\("fs"\);\n?', '', text)
text = re.sub(r'import os = require\("os"\);\n?', '', text)
text = re.sub(r'import path = require\("path"\);\n?', '', text)
text = re.sub(r'import \{ isMainThread, parentPort, workerData, Worker \} from "worker_threads";\n?', '', text)
text = re.sub(r'import JSZip = require\("jszip"\);\n?', 'import JSZip from "jszip";\n', text)
text = re.sub(r'import sharp = require\("sharp"\);\n?', '', text)

# Rewrite WebP encode with canvas
webp_code = """
async function addWebpFiles(zip: JSZip, state: ConversionState, concurrency?: number, yieldScheduler?: (force?: boolean) => Promise<void>): Promise<void> {
  const entries = Array.from(state.textures.entries());
  for (let i = 0; i < entries.length; i++) {
    const [filename, texture] = entries[i];
    const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(texture.width, texture.height) : document.createElement('canvas') as any;
    canvas.width = texture.width;
    canvas.height = texture.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Copy data
    const imgData = new ImageData(new Uint8ClampedArray(texture.data.buffer, texture.data.byteOffset, texture.data.byteLength), texture.width, texture.height);
    ctx.putImageData(imgData, 0, 0);
    
    let blob: Blob;
    if (typeof OffscreenCanvas !== 'undefined') {
        blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/webp', quality: 1 });
    } else {
        blob = await new Promise<Blob>((resolve) => (canvas as HTMLCanvasElement).toBlob(b => resolve(b!), 'image/webp', 1));
    }
    
    zip.file(filename, await blob.arrayBuffer(), { compression: "STORE" });
    if (yieldScheduler) await yieldScheduler();
  }
}
"""
text = re.sub(r'async function addWebpFiles.*?\n\}\n(?=\nfunction arrayToJson)', webp_code, text, flags=re.DOTALL)

# Disable workers for ND kmeans
text = re.sub(r'const useWorkers =.*?;', 'const useWorkers = false;', text)
text = re.sub(r'async function runKmeansLabelWorkers.*?\}\n(?=\nasync function kmeansNd)', '', text, flags=re.DOTALL)
text = re.sub(r'if \(useWorkers\) \{.*?\} else \{', '{', text, flags=re.DOTALL)

# Let kmeansNd yield
text = re.sub(
    r'async function kmeansNd\(data.*?\) \{',
    'async function kmeansNd(data: Float32Array, n: number, d: number, kRequested: number, iterations: number, batchSize = 1024, seed?: number, workerCount = 1, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<[Float32Array, Uint32Array]> {',
    text
)
# Insert yield in kmeansNd batch loops
text = re.sub(
    r'computeKmeansNdLabelsRange\(\{[^\}]*\}\);\s*\}',
    'computeKmeansNdLabelsRange({ \\g<0> });\n        if (scheduler) await scheduler(false, (iter + 0.5) / iterations);\n      }',
    text
)

# Insert yield in compressShN
text = re.sub(
    r'const \[shCentroids, shLabels\] = await kmeansNd\(shData, n, numCoeffs, paletteSize, iterations, 1024, seed, shnWorkers\);',
    r'const wrappedScheduler = scheduler ? async (force?: boolean, pct?: number) => await scheduler(force, pct) : undefined; const [shCentroids, shLabels] = await kmeansNd(shData, n, numCoeffs, paletteSize, iterations, 1024, seed, shnWorkers, wrappedScheduler);',
    text
)

# Wrapper SOG4Encoder
wrapper = """\n
export type SOG4EncodeProgressMeta = { stageId?: string; stageLabel?: string; stagePct?: number };

export class SOG4Encoder {
    static async encode(data: any, overrides: any = {}, options: any = {}): Promise<Uint8Array> {
        const count = data.count || data.plyData?.elements[0]?.count || 0;
        if (count === 0) throw new Error("No data to encode.");
        
        let p: any = {};
        const columns = new Map<string, Float32Array>();
        if (data.plyData?.elements?.[0]?.properties) {
            const props = data.plyData.elements[0].properties;
            for (let i = 0; i < props.length; i++) {
                p[props[i].name] = props[i].storage;
                columns.set(props[i].name, props[i].storage);
            }
        } else {
            p = data;
            for (const key of Object.keys(data)) {
                if (data[key] instanceof Float32Array || data[key] instanceof Uint8Array) {
                    columns.set(key, data[key]);
                }
            }
        }
        
        // Provide defaults
        if (!columns.has('x') && p.x) columns.set('x', p.x);
        if (!columns.has('y') && p.y) columns.set('y', p.y);
        if (!columns.has('z') && p.z) columns.set('z', p.z);
        if (!columns.has('rot_0') && p.rot_0) columns.set('rot_0', p.rot_0);
        if (!columns.has('rot_1') && p.rot_1) columns.set('rot_1', p.rot_1);
        if (!columns.has('rot_2') && p.rot_2) columns.set('rot_2', p.rot_2);
        if (!columns.has('rot_3') && p.rot_3) columns.set('rot_3', p.rot_3);
        if (!columns.has('scale_0') && p.scale_0) columns.set('scale_0', p.scale_0);
        if (!columns.has('scale_1') && p.scale_1) columns.set('scale_1', p.scale_1);
        if (!columns.has('scale_2') && p.scale_2) columns.set('scale_2', p.scale_2);
        if (!columns.has('f_dc_0') && p.f_dc_0) columns.set('f_dc_0', p.f_dc_0);
        if (!columns.has('f_dc_1') && p.f_dc_1) columns.set('f_dc_1', p.f_dc_1);
        if (!columns.has('f_dc_2') && p.f_dc_2) columns.set('f_dc_2', p.f_dc_2);
        if (!columns.has('opacity') && p.opacity) columns.set('opacity', p.opacity);
        for (const k of Object.keys(p)) {
            if (k.startsWith('f_rest_') && !columns.has(k)) columns.set(k, p[k]);
        }
        
        const ply: PlyData = {
           format: 'binary_little_endian',
           comments: [],
           elements: [{ name: 'vertex', count, properties: Array.from(columns.keys()).map(name => ({name, type: 'float32'})) }],
           vertex: { count, properties: Array.from(columns.keys()).map(name => ({name, type: 'float32'})), columns }
        };
        
        const iterations = overrides.iterations ?? 10;
        const seed = overrides.seed ?? 12345678;
        const n = count;
        const width = Math.ceil(Math.sqrt(n) / 4) * 4;
        const height = Math.ceil(n / width / 4) * 4;
        const state: ConversionState = { width, height, count: n, textures: new Map() };
        
        let customOut: any = { total_frames: 0 };
        const exportTransform = overrides.model_transform || (data && data.model_transform) || null;
        if (exportTransform) {
            const mt = exportTransform;
            if (mt.pos && mt.pos.length >= 3) customOut['model_pos'] = `${mt.pos[0]} ${mt.pos[1]} ${mt.pos[2]}`;
            if (mt.rot && mt.rot.length >= 4) customOut['model_rot'] = `${mt.rot[0]} ${mt.rot[1]} ${mt.rot[2]} ${mt.rot[3]}`;
            if (mt.scale && mt.scale.length >= 3) customOut['model_scale'] = `${mt.scale[0]} ${mt.scale[1]} ${mt.scale[2]}`;
        }
        const custom = Object.assign({}, data.custom || {}, overrides.custom || {}, customOut);
        
        const meta: Record<string, unknown> = {
            version: 2,
            asset: { generator: "master_ply_to_sog_native" },
            count: n,
            custom
        };
        
        const scheduler = async () => { await new Promise(r => setTimeout(r, 0)); };

        options.progress?.(10, "Compressing Means...", { stageLabel: "Means" });
        meta.means = compressMeans(requireColumn(ply, "x"), requireColumn(ply, "y"), requireColumn(ply, "z"), "means", state);

        options.progress?.(20, "Compressing Rotations...", { stageLabel: "Rotations" });
        let r0, r1, r2, r3;
        if (hasColumn(ply, "rot_0")) {
            r0 = requireColumn(ply, "rot_0"); r1 = requireColumn(ply, "rot_1"); r2 = requireColumn(ply, "rot_2"); r3 = requireColumn(ply, "rot_3");
        } else {
            r0 = makeFloat32(n, 1); r1 = makeFloat32(n); r2 = makeFloat32(n); r3 = makeFloat32(n);
        }
        meta.quats = compressQuats(r0, r1, r2, r3, "quats", state);
        
        options.progress?.(40, "Compressing Scales & Opacity...", { stageLabel: "Scales" });
        meta.scales = compressScales(requireColumn(ply, "scale_0"), requireColumn(ply, "scale_1"), requireColumn(ply, "scale_2"), "scales", iterations, state);
        meta.sh0 = compressSh0Op(requireColumn(ply, "f_dc_0"), requireColumn(ply, "f_dc_1"), requireColumn(ply, "f_dc_2"), requireColumn(ply, "opacity"), "sh0", iterations, state);
        
        const names = Array.from(columns.keys());
        const shKeys = names.filter((name) => name.startsWith("f_rest_"));
        if (shKeys.length > 0) {
            options.progress?.(60, `Compressing ${shKeys.length} SH coefficients...`, { stageLabel: "SHN" });
            meta.shN = await compressShN(collectShData(ply, shKeys), n, shKeys.length, iterations, state, seed, 1, scheduler);
        }

        if (hasColumn(ply, "lifetime_mu")) {
            options.progress?.(80, "Compressing Params...", { stageLabel: "Params" });
            meta.params = compressParams(requireColumn(ply, "lifetime_mu"), requireColumn(ply, "lifetime_w"), hasColumn(ply, "is_param") ? requireColumn(ply, "is_param") : makeFloat32(n), iterations, state);
        }
        
        const zip = new JSZip();
        options.progress?.(90, "Encoding WebP Textures...", { stageLabel: "WebP Compress" });
        await addWebpFiles(zip, state, 1, scheduler);
        
        zip.file("meta.json", JSON.stringify(meta, null, 2), { compression: "STORE" });
        options.progress?.(95, "Generating ZIP...", { stageLabel: "Zip Generation" });
        const content = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
        options.progress?.(100, "Done SOG4 Encode", { stageLabel: "Done" });
        return content;
    }
}
"""

text = re.sub(r'async function convertMasterToSog.*?\}\n\n', '', text, flags=re.DOTALL)
text = re.sub(r'function parseCli.*?\}\n\n', '', text, flags=re.DOTALL)
text = re.sub(r'if \(isMainThread.*?\}\n\n', '', text, flags=re.DOTALL)
text = re.sub(r'export \{ convertMasterToSog, parsePly \};\n?', '', text)

# add scheduler argument to compressShN
text = re.sub(
    r'async function compressShN\(shData: Float32Array, n: number, numCoeffs: number, iterations: number, state: ConversionState, seed: number \| undefined, shnWorkers: number\): Promise<Record<string, unknown>> \{',
    'async function compressShN(shData: Float32Array, n: number, numCoeffs: number, iterations: number, state: ConversionState, seed: number | undefined, shnWorkers: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<Record<string, unknown>> {',
    text
)

final_out = text + wrapper
with open('/home/crgj/wdd/work/@AtWork/Viewer/src/utils/sog4-encoder.ts', 'w') as out:
    out.write(final_out)
