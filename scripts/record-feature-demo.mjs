import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'artifacts', 'feature-demo-2026-06-13');
const framesDir = path.join(outDir, 'screens');
const chromeProfile = path.join(outDir, 'chrome-profile');
const chromePort = 9333;
const baseUrl = process.env.DEMO_URL || 'http://localhost:5175/';

await mkdir(framesDir, { recursive: true });
await mkdir(chromeProfile, { recursive: true });

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
    return res.json();
}

async function waitForChrome() {
    for (let i = 0; i < 80; i++) {
        try {
            const pages = await fetchJson(`http://127.0.0.1:${chromePort}/json/list`);
            const page = pages.find(p => p.type === 'page');
            if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        } catch {}
        await delay(250);
    }
    throw new Error('Chrome DevTools endpoint did not become ready');
}

class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.ws.addEventListener('message', event => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result || {});
            }
        });
    }
    async open() {
        if (this.ws.readyState === WebSocket.OPEN) return;
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
    }
    send(method, params = {}) {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    close() {
        this.ws.close();
    }
}

async function evalExpr(cdp, expression, awaitPromise = true) {
    const res = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true
    });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result?.value;
}

async function click(cdp, selector) {
    await evalExpr(cdp, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Missing selector: ${selector}');
        el.click();
    })()`);
    await delay(450);
}

async function snap(cdp, name, caption, duration = 3.2) {
    const result = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
    });
    const file = path.join(framesDir, `${String(slides.length + 1).padStart(2, '0')}-${name}.png`);
    await writeFile(file, Buffer.from(result.data, 'base64'));
    slides.push({ file, caption, duration });
}

const chromeArgs = [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${chromeProfile}`,
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,720',
    'about:blank'
];

const chrome = spawn('google-chrome', chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', data => process.stderr.write(data));

const slides = [];

try {
    const wsUrl = await waitForChrome();
    const cdp = new Cdp(wsUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false
    });

    await cdp.send('Page.navigate', { url: baseUrl });
    await delay(2500);
    await evalExpr(cdp, `localStorage.setItem('4dgs-viewer-language', 'zh'); location.reload();`);
    await delay(2500);
    await evalExpr(cdp, `document.body.style.cursor = 'default';`);

    await snap(cdp, 'home', '01 统一中英文界面：顶部语言按钮、Samples、本地 SOG4 样例入口都接入统一文案。');

    await click(cdp, '#toggle-samples');
    await snap(cdp, 'samples', '02 Samples 面板：从本地样例快速加载 SOG4，不需要手动拖拽文件。');

    await evalExpr(cdp, `(async () => {
        await window.viewer.fileLoader.loadSampleFile('./sog4/少女.sog4');
        const started = Date.now();
        while (Date.now() - started < 45000) {
            const hidden = document.getElementById('loading-overlay')?.classList.contains('hidden');
            if (window.viewer?.splatEntity && hidden) break;
            await new Promise(r => setTimeout(r, 250));
        }
        document.getElementById('download-overlay')?.classList.add('hidden');
        document.getElementById('loading-overlay')?.classList.add('hidden');
    })()`);
    await delay(1500);
    await snap(cdp, 'loaded', '03 加载完成：右侧保留紧凑 COMMON / PRESETS / INFO / SPECIAL 切换，底部时间轴显示当前帧。');

    await click(cdp, '[data-panel-target="panel-info"]');
    await delay(800);
    await snap(cdp, 'info-panel', '04 新增 INFO 面板：显示文件名、大小、格式、点数、帧数、生命周期、包围盒和内存/显存估算。');

    await click(cdp, '#render-mode-all-points');
    await delay(800);
    await snap(cdp, 'render-all', '05 Render ALL 调试：显示所有未删除点，青色代表 normal 可见，粉色代表 normal 隐藏。');

    await click(cdp, '[data-left-panel-tab="edit"]');
    await delay(500);
    await snap(cdp, 'edit-tab', '06 左侧 Edit 面板：Render ALL 下普通选择禁用，仅保留 Delete Hidden 用于清理 normal 模式不可见点。');

    await click(cdp, '#render-mode-outline');
    await delay(600);
    await click(cdp, '#scope-current');
    await click(cdp, '#select-mode-rings');
    await click(cdp, '#tool-brush');
    await snap(cdp, 'rings-mode', '07 选择命中方式：Centers 只看中心点，Rings 按当前屏幕可见高斯 footprint/轮廓命中。');

    await evalExpr(cdp, `(() => {
        const canvas = document.getElementById('application-canvas') || document.querySelector('canvas');
        if (!canvas) throw new Error('Missing canvas');
        const rect = canvas.getBoundingClientRect();
        const points = [[0.48,0.52],[0.52,0.50],[0.56,0.49],[0.60,0.51],[0.63,0.54]];
        const down = new MouseEvent('mousedown', { clientX: rect.left + rect.width * points[0][0], clientY: rect.top + rect.height * points[0][1], bubbles: true });
        window.dispatchEvent(down);
        for (const [x, y] of points.slice(1)) {
            window.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y, bubbles: true }));
        }
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: rect.left + rect.width * 0.63, clientY: rect.top + rect.height * 0.54, bubbles: true }));
    })()`);
    await delay(1000);
    await snap(cdp, 'rings-selected', '08 Rings 选择提速：当前视角 footprint 建缓存和屏幕网格，笔刷拖动只检查附近候选点。');

    await click(cdp, '#scope-alltime');
    await click(cdp, '#tool-rect');
    await snap(cdp, 'alltime', '09 Current / All-Time 合并为范围切换：同一组笔刷、方框、折线可切换当前帧或全时段选择。');

    await click(cdp, '#action-help');
    await delay(600);
    await snap(cdp, 'help', '10 Help 也接入中英文：选择工具、命中方式、Render ALL、All-Time 的说明集中维护。');

    await click(cdp, '#language-toggle');
    await delay(700);
    await snap(cdp, 'language', '11 语言状态保存在浏览器 localStorage：主页面与批处理页面共享中文/英文状态。');

    await cdp.send('Page.navigate', { url: `${baseUrl.replace(/\/$/, '')}/batch-convert.html` });
    await delay(1800);
    await snap(cdp, 'batch', '12 批处理页面同步中英文：批量 SOG4 转换和 PLY 序列导出入口共用同一套语言状态。');

    await writeFile(path.join(outDir, 'slides.json'), JSON.stringify(slides, null, 2));
    cdp.close();
} finally {
    chrome.kill('SIGTERM');
}

console.log(JSON.stringify({ outDir, framesDir, slides: slides.length }, null, 2));
