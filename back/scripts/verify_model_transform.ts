import fs from 'fs';
import JSZip from 'jszip';
import { chooseExportModelTransform, normalizeModelTransform } from '../src/utils/model-transform.ts';

const readMeta = async (file: string) => {
    const buf = fs.readFileSync(file);
    const zip = await JSZip.loadAsync(buf);
    const metaFile = zip.file('meta.json');
    if (!metaFile) throw new Error(`meta.json not found in ${file}`);
    return JSON.parse(await metaFile.async('string'));
};

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
    const sourceFile = './public/sog4/小鼠.sog4';
    const sourceMeta = await readMeta(sourceFile);
    const sourceTransform = normalizeModelTransform(sourceMeta.model_transform);
    if (!sourceTransform) throw new Error(`Expected model_transform in ${sourceFile}`);

    const simulatedViewerTransform = {
        pos: [9, 8, 7] as [number, number, number],
        rot: [0.3, -0.4, 0.5, 0.6] as [number, number, number, number],
        scale: [1.2, 1.2, 1.2] as [number, number, number]
    };

    const preserved = chooseExportModelTransform({
        entityTransform: simulatedViewerTransform,
        sourceTransform,
        preserveSource: true
    });
    if (!equal(preserved, sourceTransform)) {
        throw new Error('Preserve-source path failed');
    }

    const edited = chooseExportModelTransform({
        entityTransform: simulatedViewerTransform,
        sourceTransform,
        preserveSource: false
    });
    if (!equal(edited, simulatedViewerTransform)) {
        throw new Error('Edited-transform path failed');
    }

    const identityMeta = await readMeta('./output/verify_sog4_diff/browser_saved_ts.sog4');
    const fallback = chooseExportModelTransform({
        entityTransform: simulatedViewerTransform,
        sourceTransform: normalizeModelTransform(identityMeta.model_transform),
        preserveSource: false
    });
    if (!equal(fallback, simulatedViewerTransform)) {
        throw new Error('Fallback path failed');
    }

    console.log(JSON.stringify({
        sourceFile,
        preserved,
        edited,
        fallback
    }, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
