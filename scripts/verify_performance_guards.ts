import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const checks: Array<{ name: string; file: string; test: (source: string) => boolean }> = [
    {
        name: '4D playback applies visible frame only after combined sorter result',
        file: 'src/main.ts',
        test: (source) => /onSorted: \(result\) => \{[\s\S]*result\.requestId === this\.sortingTaskID[\s\S]*this\.applyVisible4DFrame\(this\.pendingSortedFrame\)/.test(source)
    },
    {
        name: '4D playback submits every accepted frame to combined worker without sort throttling',
        file: 'src/main.ts',
        test: (source) => source.includes('每帧仅向合并 Worker 发送时间和请求号')
            && source.includes('this.dynamicSorter.requestFrame(frameIdx, this.sortingTaskID);')
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
        name: 'dynamic 4D path exits before legacy center copy',
        file: 'src/main.ts',
        test: (source) => /if \(this\.dynamicSorter\) \{[\s\S]*this\.dynamicSorter\.requestFrame\(frameIdx, this\.sortingTaskID\);[\s\S]*return;[\s\S]*const centersCopy = new Float32Array\(centers\)/.test(source)
    },
    {
        name: 'selection texture is fetched once in splat shader',
        file: 'src/shaders/gsplat-shader.ts',
        test: (source) => (source.match(/texelFetch\(selectionTexture/g) || []).length === 1
    },
    {
        name: 'splat shader leaves color adjustment to full-screen post processing',
        file: 'src/shaders/gsplat-shader.ts',
        test: (source) => !source.includes('uniform float uBrightness')
            && !source.includes('uniform float uContrast')
            && !source.includes('uniform float uExposure')
    },
    {
        name: 'new asset load resets temporal banks and rejects stale sorter callbacks',
        file: 'src/main.ts',
        test: (source) => source.includes('public prepareSingleAssetLoad(generation: number)')
            && /this\.currentTime = 0;[\s\S]*this\.trajectoryData = null;[\s\S]*this\.lifeTexData = null;/.test(source)
            && source.includes('sorterEpoch !== this.dynamicSorterEpoch || activeInstance !== sorterInstance')
    },
    {
        name: 'stereo exit disables composite layer before restoring primary camera',
        file: 'src/rendering/stereo-view-controller.ts',
        test: (source) => /this\.compositeLayer\.enabled = false;[\s\S]*this\.primaryCamera\.camera\.enabled = this\.primaryCameraWasEnabled;/.test(source)
            && source.includes('this.requestPrimaryCameraRecovery();')
    },
    {
        name: 'column-interlaced stereo alternates eyes by physical pixel column',
        file: 'src/rendering/stereo-view-controller.ts',
        test: (source) => source.includes("'column-interlaced'")
            && source.includes('precision highp float;')
            && source.includes('mod(floor(gl_FragCoord.x), 2.0)')
            && source.includes('mix(leftColor, rightColor, 1.0 - columnParity)')
    },
    {
        name: 'column-interlaced display preserves native pixel ratio',
        file: 'src/display.ts',
        test: (source) => source.includes("mode === 'column-interlaced' ? deviceRatio")
    },
    // #WDD-gpt  2026-08-10 - 防止旋转起手再次把用户当前缩放距离恢复为模型完整可见距离
    {
        name: 'display orbit rotation preserves the current zoom distance',
        file: 'src/display.ts',
        test: (source) => !source.includes('ensureBoundingSphereVisible')
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
