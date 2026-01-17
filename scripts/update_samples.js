import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const gszipDir = path.resolve(__dirname, '../public/gszip');
const outputFile = path.resolve(__dirname, '../public/samples.json');

function scanFiles() {
    if (!fs.existsSync(gszipDir)) {
        console.warn('Directory not found:', gszipDir);
        fs.writeFileSync(outputFile, JSON.stringify([]));
        return;
    }

    const files = fs.readdirSync(gszipDir);
    // Sort files to keep them consistent
    files.sort();

    const samples = files
        .filter(file => file.endsWith('.gszip') || file.endsWith('.ply') || file.endsWith('.truesplats'))
        .map(file => ({
            name: file,
            url: `./gszip/${file}`
        }));

    fs.writeFileSync(outputFile, JSON.stringify(samples, null, 2));
    console.log(`Generated ${outputFile} with ${samples.length} samples.`);
}

scanFiles();
