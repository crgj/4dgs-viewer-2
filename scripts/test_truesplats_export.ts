import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { TrueSplatsLoader, IImageDecoder } from '../src/utils/truesplats-loader.ts';

/**
 * NodeImageDecoder #WDD 2026-01-16
 * Bridges image decoding to Python's PIL since Node.js has no built-in WebP decoder.
 */
class NodeImageDecoder implements IImageDecoder {
    async decode(buffer: ArrayBuffer): Promise<{ data: Uint8Array; width: number; height: number; }> {
        // Use a small python script to get RGBA bytes
        const script = `
import sys, json
from PIL import Image
try:
    img = Image.open(sys.stdin.buffer)
    img = img.convert('RGBA')
    w, h = img.size
    meta = (json.dumps({"w": w, "h": h}) + "\\n").encode('ascii')
    sys.stdout.buffer.write(meta)
    sys.stdout.buffer.write(img.tobytes())
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
        const res = spawnSync('python3', ['-c', script], {
            input: Buffer.from(buffer),
            maxBuffer: 100 * 1024 * 1024 // #WDD 2026-01-16
        });
        if (res.status !== 0) {
            throw new Error("Python decoder failed: " + res.stderr.toString());
        }

        const out = res.stdout;
        // The script prints JSON on first line, followed by raw bytes
        const firstNewLine = out.indexOf(10); // 10 is '\n'
        const metaStr = out.subarray(0, firstNewLine).toString();
        const meta = JSON.parse(metaStr);
        const rawData = new Uint8Array(out.subarray(firstNewLine + 1));

        console.log(`[NodeImageDecoder] Decoded to ${meta.w}x${meta.h}, bytes=${rawData.length}`);
        return { data: rawData, width: meta.w, height: meta.h };
    }
}

async function main() {
    const inputPath = '/home/crgj/wdd/output/ok.truesplats';
    const outputDir = './output/ts_frames';

    if (!fs.existsSync(inputPath)) {
        console.error("Input file not found:", inputPath);
        process.exit(1);
    }

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log("[Test] Loading:", inputPath);
    const nodeBuf = fs.readFileSync(inputPath);
    // Ensure we get a clean ArrayBuffer slice
    const arrayBuffer = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);

    // Instantiate loader without pc.Application (it's optional now)
    const loader = new TrueSplatsLoader(undefined, new NodeImageDecoder());

    await loader.load(arrayBuffer, (p, msg) => {
        console.log(`[Progress ${p.toFixed(0)}%] ${msg}`);
    });

    // #WDD 2026-01-16 Export full sequence to /home/crgj/wdd/output/ts_export
    const finalOutputDir = "/home/crgj/wdd/output/ts_export";
    if (!fs.existsSync(finalOutputDir)) {
        fs.mkdirSync(finalOutputDir, { recursive: true });
    }

    const totalFrames = (loader as any).lastResult.frames || 50;
    console.log(`[Test] Exporting full sequence (0 to ${totalFrames - 1}) to ${finalOutputDir}...`);
    for (let t = 0; t < totalFrames; t++) {
        const plyBuf = loader.exportFrame(t);
        if (plyBuf) {
            const outPath = path.join(finalOutputDir, `frame_${t.toString().padStart(4, '0')}.ply`);
            fs.writeFileSync(outPath, Buffer.from(plyBuf));
            if (t % 10 === 0 || t === totalFrames - 1) console.log(`[Test] Exported ${outPath}`);
        }
    }
    console.log("[Test] TS Export Sequence Done.");
}

main().catch(console.error);
