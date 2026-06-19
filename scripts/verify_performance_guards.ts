import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const checks: Array<{ name: string; file: string; test: (source: string) => boolean }> = [
    {
        name: '4D playback applies visible frame before sort submission',
        file: 'src/main.ts',
        test: (source) => /if \(this\.isPlaying\) \{[\s\S]*this\.applyVisible4DFrame\(targetFrame\);[\s\S]*this\.updateDynamicPositions\(targetFrame\);[\s\S]*return;/.test(source)
    },
    {
        name: '4D playback keeps highest quality sort when worker is idle',
        file: 'src/main.ts',
        test: (source) => source.includes('worker 空闲即提交排序')
            && !source.includes('playbackSortMode')
            && !source.includes('playbackSortIntervals')
            && !source.includes('shouldRunPlaybackSortForFrame')
    },
    {
        name: 'paused seek keeps strict sorter wait path',
        file: 'src/main.ts',
        test: (source) => /if \(this\.isWaitingForSort\) \{\s*return;\s*\}\s*this\.pendingSortedFrame = targetFrame;\s*this\.updateDynamicPositions\(targetFrame\);/.test(source)
    },
    {
        name: 'debug ALL refresh uses throttled update loop path',
        file: 'src/main.ts',
        test: (source) => source.includes('this.refreshDebugAllPointsEntityThrottled();')
            && source.includes('Render ALL 是调试视图，播放时节流刷新')
    },
    {
        name: 'dynamic center update skips unchanged frames',
        file: 'src/main.ts',
        test: (source) => source.includes('if (frameIdx === this.lastUpdatedFrame) return;')
    },
    {
        name: 'Current invert does not inherit historical all-time scope',
        file: 'src/ui/selection-tool.ts',
        test: (source) => source.includes('反选模式以当前 UI 范围为准')
            && !/const invertAllTime =[^;]*selectionScope === 'alltime'/.test(source)
            && !/const shouldInvertAllTime =[^;]*selectionScope === 'alltime'/.test(source)
    }
];

const failures = checks.filter((check) => !check.test(read(check.file)));

if (failures.length > 0) {
    console.error('Performance guard verification failed:');
    for (const failure of failures) {
        console.error(`- ${failure.name} (${failure.file})`);
    }
    process.exit(1);
}

console.log(`Performance guard verification passed (${checks.length} checks).`);
