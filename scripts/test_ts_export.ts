import fs from 'fs';
import { PLY4Loader } from '../src/utils/ply4-loader';
import { exportPLYSequence } from '../src/utils/ply-sequence-exporter';

async function main() {
    const fileBuf = fs.readFileSync('/home/crgj/下载/saved_coser.ply4');
    // Convert Buffer to ArrayBuffer
    const arrayBuffer = fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);

    console.log("Loading PLY4 using PLY4Loader...");
    const loader = new PLY4Loader();
    const data = await loader.load(arrayBuffer, (p, m) => {
        if (p % 20 === 0) console.log(`Load: ${p}% - ${m}`);
    });

    console.log(`Exporting TS frames...`);
    const { buffers } = await exportPLYSequence(data, "test", (p, m) => {
        if (p % 20 === 0) console.log(`Export: ${p.toFixed(0)}% - ${m}`);
    });

    const frame0 = buffers[0];
    fs.writeFileSync('/tmp/frame_0000_ts.ply', Buffer.from(frame0));
    console.log("Wrote TS frame 0 to /tmp/frame_0000_ts.ply");
    
    // Also write frame 10
    if (buffers.length > 10) {
        fs.writeFileSync('/tmp/frame_0010_ts.ply', Buffer.from(buffers[10]));
        console.log("Wrote TS frame 10 to /tmp/frame_0010_ts.ply");
    }
}

main().catch(console.error);
