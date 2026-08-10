import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(repositoryRoot, 'public');
const thumbnailsRoot = resolve(publicRoot, 'thumbnails');
const manifest = JSON.parse(await readFile(resolve(publicRoot, 'model-gallery.json'), 'utf8'));
const displayUrl = process.env.DISPLAY_THUMBNAIL_URL || 'http://127.0.0.1:5173/display.html';
const chromeBinary = process.env.DISPLAY_THUMBNAIL_CHROME || '/usr/bin/google-chrome';
const debuggingPort = Number(process.env.DISPLAY_THUMBNAIL_PORT || 9236);
// #WDD-gpt  2026-08-10 - 支持逗号分隔多个筛选词，一次浏览器会话批量生成新增模型缩略图
const itemFilters = (process.env.DISPLAY_THUMBNAIL_FILTER || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
const profileDirectory = await mkdtemp(resolve(tmpdir(), 'truesplats-thumbnails-'));

// #WDD-gpt 2026-08-04 - 通过真实展示运行时批量渲染 256×160 WebP，保证静态与动态格式缩略图使用同一加载链路
const chrome = spawn(chromeBinary, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    '--window-size=1280,800',
    'about:blank'
], { stdio: 'ignore' });

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const waitForTarget = async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
            const page = targets.find((target) => target.type === 'page');
            if (page?.webSocketDebuggerUrl) return page;
        } catch {
            // #WDD-gpt 2026-08-04 - Chrome 尚未开放调试端口时继续短轮询
        }
        await delay(250);
    }
    throw new Error('Timed out waiting for Chrome DevTools.');
};

const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
});

let callId = 0;
const pendingCalls = new Map();
socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const pending = pendingCalls.get(message.id);
    if (!pending) return;
    pendingCalls.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
});

const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const id = ++callId;
    pendingCalls.set(id, { resolve: resolveCall, reject: rejectCall });
    socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
};

const waitForModel = async (name) => {
    for (let attempt = 0; attempt < 360; attempt++) {
        const state = await evaluate(`(() => ({
            ready: Boolean(window.displayViewer?.splatEntity) && document.getElementById('display-loading')?.classList.contains('hidden'),
            failed: !document.getElementById('display-error')?.classList.contains('hidden'),
            message: document.getElementById('display-error-message')?.textContent || ''
        }))()`);
        if (state.failed) throw new Error(`${name}: ${state.message || 'model load failed'}`);
        if (state.ready) return;
        await delay(500);
    }
    throw new Error(`${name}: timed out while loading model.`);
};

try {
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false
    });

    let completed = 0;
    const items = manifest.groups
        .flatMap((group) => group.items)
        .filter((item) => itemFilters.length === 0 || itemFilters.some((itemFilter) =>
            item.url.toLowerCase().includes(itemFilter) || item.name.toLowerCase().includes(itemFilter)
        ));
    if (items.length === 0) throw new Error(`No gallery item matched: ${itemFilters.join(', ')}`);
    for (const item of items) {
        const pageUrl = new URL(displayUrl);
        pageUrl.searchParams.set('model', item.url);
        pageUrl.searchParams.set('name', item.name);
        pageUrl.searchParams.set('autoplay', '0');
        pageUrl.searchParams.set('thumbnail', '1');
        await call('Page.navigate', { url: pageUrl.href });
        await waitForModel(item.name);
        await delay(1000);

        if (item.url.toLowerCase().endsWith('.sog4')) {
            await evaluate(`(() => {
                const viewer = window.displayViewer;
                const canvas = document.getElementById('application-canvas');
                const sample = document.createElement('canvas');
                sample.width = 320;
                sample.height = 200;
                const context = sample.getContext('2d', { willReadFrequently: true });
                context.drawImage(canvas, 0, 0, sample.width, sample.height);
                const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
                const xs = [];
                const ys = [];
                for (let y = 0; y < sample.height; y++) {
                    for (let x = 0; x < sample.width; x++) {
                        const index = (y * sample.width + x) * 4;
                        const difference = Math.abs(pixels[index] - 6) + Math.abs(pixels[index + 1] - 8) + Math.abs(pixels[index + 2] - 10);
                        if (difference > 22) { xs.push(x); ys.push(y); }
                    }
                }
                if (xs.length < 20) return false;
                xs.sort((a, b) => a - b);
                ys.sort((a, b) => a - b);
                const low = Math.floor((xs.length - 1) * 0.005);
                const high = Math.ceil((xs.length - 1) * 0.995);
                const fill = Math.max((xs[high] - xs[low] + 1) / sample.width, (ys[high] - ys[low] + 1) / sample.height);
                viewer.orbitDistance *= Math.max(0.22, Math.min(1.4, fill / 0.72));
                viewer.updateOrbitCamera();
                return true;
            })()`);
            await delay(500);
        }

        const screenshot = await call('Page.captureScreenshot', {
            format: 'webp',
            quality: 84,
            fromSurface: true,
            captureBeyondViewport: false,
            clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.2 }
        });
        const relativeOutput = item.thumbnail.replace(/^\.\//, '');
        const outputPath = resolve(publicRoot, relativeOutput);
        if (!outputPath.startsWith(`${thumbnailsRoot}/`)) throw new Error(`Unsafe thumbnail path: ${item.thumbnail}`);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'));
        completed++;
        console.log(`[${completed}/${items.length}] ${item.name} -> ${relativeOutput}`);
    }
} finally {
    try {
        await call('Browser.close');
    } catch {
        chrome.kill('SIGTERM');
    }
    socket.close();
    await Promise.race([
        new Promise((resolveExit) => chrome.once('exit', resolveExit)),
        delay(2000)
    ]);
    try {
        await rm(profileDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
        console.warn(`[Thumbnail] Temporary profile cleanup deferred: ${error.message}`);
    }
}
