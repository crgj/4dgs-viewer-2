import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(repositoryRoot, 'public');
const manifest = JSON.parse(await readFile(resolve(publicRoot, 'model-gallery.json'), 'utf8'));
const expectedGroups = new Map([
    ['sog', '.sog'],
    ['sog4', '.sog4']
]);
const seenUrls = new Set();

for (const [groupId, extension] of expectedGroups) {
    const group = manifest.groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error(`Missing gallery group: ${groupId}`);
    const assetFiles = (await readdir(resolve(publicRoot, groupId)))
        .filter((name) => extname(name).toLowerCase() === extension)
        .sort();
    const catalogFiles = [];

    for (const item of group.items) {
        if (!item.name?.trim()) throw new Error(`${groupId}: item name is empty.`);
        if (seenUrls.has(item.url)) throw new Error(`Duplicate gallery URL: ${item.url}`);
        seenUrls.add(item.url);

        const assetPath = resolve(publicRoot, item.url.replace(/^\.\//, ''));
        await stat(assetPath);
        catalogFiles.push(assetPath.split('/').pop());

        const thumbnailPath = resolve(publicRoot, item.thumbnail.replace(/^\.\//, ''));
        const thumbnail = await readFile(thumbnailPath);
        if (thumbnail.toString('ascii', 0, 4) !== 'RIFF' || thumbnail.toString('ascii', 8, 12) !== 'WEBP') {
            throw new Error(`Invalid WebP thumbnail: ${item.thumbnail}`);
        }
        if (thumbnail.toString('ascii', 12, 16) !== 'VP8X') {
            throw new Error(`Thumbnail must use a VP8X header: ${item.thumbnail}`);
        }
        const width = thumbnail.readUIntLE(24, 3) + 1;
        const height = thumbnail.readUIntLE(27, 3) + 1;
        if (width > 256 || width <= 0 || height <= 0) {
            throw new Error(`Invalid thumbnail dimensions ${width}×${height}: ${item.thumbnail}`);
        }
    }

    if (assetFiles.join('\n') !== catalogFiles.sort().join('\n')) {
        throw new Error(`${groupId}: gallery manifest does not exactly match public/${groupId}.`);
    }
}

console.log(`Display gallery verification passed (${seenUrls.size} models, thumbnails ≤ 256px wide).`);
