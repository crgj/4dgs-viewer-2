import fs from 'node:fs/promises';
import path from 'node:path';

import { PLY4Loader } from '../src/utils/ply4-loader.ts';
import { PLY4Encoder } from '../src/utils/ply4-encoder.ts';

type Args = {
    input: string;
    output: string;
};

const DEFAULT_INPUT = '/media/crgj/9b112943-ef0f-408c-9192-a94c13debf35/ysw/master500000.ply4';
const DEFAULT_OUTPUT = '/media/crgj/9b112943-ef0f-408c-9192-a94c13debf35/ysw/master500000_rewrapped.ply4';

function parseArgs(argv: string[]): Args {
    let input = DEFAULT_INPUT;
    let output = DEFAULT_OUTPUT;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--input' && argv[i + 1]) {
            input = argv[++i];
        } else if (arg === '--output' && argv[i + 1]) {
            output = argv[++i];
        }
    }

    return { input, output };
}

async function main() {
    const { input, output } = parseArgs(process.argv.slice(2));
    console.log(`[Rewrap] Input: ${input}`);
    console.log(`[Rewrap] Output: ${output}`);

    const fileBuffer = await fs.readFile(input);
    const file = new File([fileBuffer], path.basename(input), { type: 'application/octet-stream' });

    const loader = new PLY4Loader();
    const parsed = await loader.load(file, (_pct: number, msg: string) => {
        if (msg) {
            console.log(`[Rewrap] ${msg}`);
        }
    });

    const encoded = await PLY4Encoder.encode(parsed, {}, (pct, msg) => {
        console.log(`[Rewrap] Encode ${pct.toFixed(1)}% ${msg}`);
    });

    await fs.writeFile(output, Buffer.from(encoded));
    console.log('[Rewrap] Done.');
}

main().catch((err) => {
    console.error('[Rewrap] Failed:', err);
    process.exitCode = 1;
});
