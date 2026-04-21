import { PLY4Loader, type PLY4LoadProgressMeta } from './utils/ply4-loader';
import { SOG4Encoder, type SOG4EncodeProgressMeta } from './utils/sog4-encoder-wrapper';
import { PLYEncoder } from './utils/ply-encoder';
// #WDD 2026-04-19 弃用4DGS格式序列导出，改为导出为独立的标准PLY单帧文件，以便于外部的3DGS查看器兼容。
import { exportPLYSequence } from './utils/ply-sequence-exporter';
import JSZip from 'jszip';

type TaskStatus = 'queued' | 'preparing' | 'loading' | 'encoding' | 'downloading' | 'done' | 'error';
type StepStateKind = 'pending' | 'active' | 'done' | 'error';
type StepKey = 'prepare' | 'load' | 'encode' | 'download';

type BatchStep = {
    label: string;
    pct: number;
    state: StepStateKind;
    detail: string;
    childLabel: string;
    childPct: number;
    grandchildLabel: string;
    grandchildPct: number;
};

type BatchTask = {
    id: string;
    file: File;
    status: TaskStatus;
    overallPct: number;
    summary: string;
    error?: string;
    outputUrl?: string;
    outputName?: string;
    outputSize?: number;
    pointCount?: number;
    frameCount?: number;
    logs: string[];
    steps: Record<StepKey, BatchStep>;
    encodeHeartbeat?: number;
    encodeStartedAt?: number;
};

const STEP_ORDER: StepKey[] = ['prepare', 'load', 'encode', 'download'];
const STEP_WEIGHTS: Record<StepKey, number> = {
    prepare: 5,
    load: 25,
    encode: 65,
    download: 5
};

const createStep = (label: string): BatchStep => ({
    label,
    pct: 0,
    state: 'pending',
    detail: 'Pending',
    childLabel: '',
    childPct: 0,
    grandchildLabel: '',
    grandchildPct: 0
});

const escapeHtml = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit++;
    }
    return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
};

const clampPct = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

const buildTransformOverride = (parsed: any) => {
    const modelPos = parsed?.meta?.modelPos;
    const modelRot = parsed?.meta?.modelRot;
    const modelScale = parsed?.meta?.modelScale;

    return {
        pos: [modelPos?.x || 0, modelPos?.y || 0, modelPos?.z || 0],
        rot: [modelRot?.x || 0, modelRot?.y || 0, modelRot?.z || 0, modelRot?.w ?? 1],
        scale: [modelScale?.x || 1, modelScale?.y || 1, modelScale?.z || 1]
    };
};

class BatchConvertApp {
    private readonly fileInput = document.getElementById('batch-file-input') as HTMLInputElement;
    private readonly folderInput = document.getElementById('batch-folder-input') as HTMLInputElement;
    private readonly dropzone = document.getElementById('batch-dropzone') as HTMLDivElement;
    private readonly taskList = document.getElementById('batch-task-list') as HTMLDivElement;
    private readonly autoDownloadToggle = document.getElementById('auto-download-toggle') as HTMLInputElement;
    private readonly formatSog4 = document.getElementById('format-sog4') as HTMLInputElement;
    private readonly formatPlySeq = document.getElementById('format-plyseq') as HTMLInputElement;
    private readonly summaryQueued = document.getElementById('summary-queued') as HTMLDivElement;
    private readonly summaryDone = document.getElementById('summary-done') as HTMLDivElement;
    private readonly summaryError = document.getElementById('summary-error') as HTMLDivElement;
    private readonly summarySize = document.getElementById('summary-size') as HTMLDivElement;
    private readonly summaryProgressFill = document.getElementById('summary-progress-fill') as HTMLDivElement;
    private readonly summaryProgressLabel = document.getElementById('summary-progress-label') as HTMLSpanElement;
    private readonly tasks: BatchTask[] = [];
    private isConverting = false;
    private readonly visibleTaskLimit = 4;
    private sequenceZipCounter = 0;
    private renderQueued = false;
    private readonly logThrottle = new Map<string, { ts: number; pct: number }>();

    constructor() {
        this.bindEvents();
        this.render();
    }

    private requestRender() {
        // #WDD-gpt 2026-04-20 - 批处理进度刷新节流：避免高频回调导致UI卡顿
        if (this.renderQueued) return;
        this.renderQueued = true;
        requestAnimationFrame(() => {
            this.renderQueued = false;
            this.render();
        });
    }

    private async yieldToBrowser() {
        // #WDD-gpt 2026-04-20 - 连续任务间让出主线程，降低第二个文件失败概率
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    private pushProgressLog(task: BatchTask, key: StepKey, pct: number, message: string) {
        // #WDD-gpt 2026-04-20 - 进度日志限流：减少日志风暴引发的主线程抖动
        const gateKey = `${task.id}:${key}`;
        const now = performance.now();
        const prev = this.logThrottle.get(gateKey);
        const shouldLog = !prev || (now - prev.ts >= 1200) || (Math.abs(pct - prev.pct) >= 5) || pct >= 99;
        if (!shouldLog) return;
        this.logThrottle.set(gateKey, { ts: now, pct });
        this.pushLog(task, message);
    }

    private startEncodeHeartbeat(task: BatchTask) {
        this.stopEncodeHeartbeat(task);
        task.encodeStartedAt = performance.now();
        // #WDD-gpt 2026-04-20 - 编码心跳：当某些阶段回调变慢时持续给用户反馈“仍在进行”
        task.encodeHeartbeat = window.setInterval(() => {
            if (task.status !== 'encoding') return;
            const started = task.encodeStartedAt || performance.now();
            const elapsedSec = Math.max(0, (performance.now() - started) / 1000);
            const step = task.steps.encode;
            const baseDetail = (step.detail || 'Encoding').replace(/\s•\s\d+(?:\.\d+)?s$/, '');
            const baseLabel = (step.grandchildLabel || step.childLabel || 'Working').replace(/\s•\selapsed\s\d+(?:\.\d+)?s$/, '');
            this.setStep(task, 'encode', {
                state: step.state === 'error' ? 'error' : 'active',
                detail: `${baseDetail} • ${elapsedSec.toFixed(1)}s`,
                grandchildLabel: `${baseLabel} • elapsed ${elapsedSec.toFixed(1)}s`
            });
            this.requestRender();
        }, 500);
    }

    private stopEncodeHeartbeat(task: BatchTask) {
        if (task.encodeHeartbeat) {
            window.clearInterval(task.encodeHeartbeat);
            task.encodeHeartbeat = undefined;
        }
    }

    private releaseParsedData(parsed: any) {
        // #WDD-gpt 2026-04-20 - 批量转换内存回收提示：显式断开大数组引用，缓解连续文件失败
        if (!parsed || typeof parsed !== 'object') return;
        const keys = [
            'trajectory', 'rotTrajectory', 'dcTrajectory',
            'sogBuffer', 'plyBuffer', 'rawData', 'rawFloatData'
        ];
        for (const key of keys) {
            if (key in parsed) (parsed as any)[key] = null;
        }
        if (parsed?.plyData?.elements?.[0]?.properties) {
            for (const prop of parsed.plyData.elements[0].properties) {
                if (prop && 'storage' in prop) prop.storage = null;
            }
        }
    }

    private bindEvents() {
        document.getElementById('batch-pick-files')?.addEventListener('click', () => this.fileInput.click());
        document.getElementById('batch-pick-folder')?.addEventListener('click', () => this.folderInput.click());
        document.getElementById('batch-convert-all')?.addEventListener('click', () => this.convertAll());
        document.getElementById('batch-clear')?.addEventListener('click', () => this.clearTasks());
        document.getElementById('batch-download-ready')?.addEventListener('click', () => this.downloadReadyTasks());

        this.fileInput.addEventListener('change', () => this.addFiles(this.fileInput.files));
        this.folderInput.addEventListener('change', () => this.addFiles(this.folderInput.files));

        ['dragenter', 'dragover'].forEach((type) => {
            window.addEventListener(type, (event) => {
                event.preventDefault();
                document.body.classList.add('is-global-dragover');
            });
        });

        ['dragleave', 'dragend', 'drop'].forEach((type) => {
            window.addEventListener(type, (event) => {
                event.preventDefault();
                document.body.classList.remove('is-global-dragover');
            });
        });

        window.addEventListener('drop', (event) => {
            event.preventDefault();
            this.addFiles(event.dataTransfer?.files || null);
        });

        this.taskList.addEventListener('click', (event) => {
            const target = event.target as HTMLElement | null;
            if (!target) return;
            const actionEl = target.closest<HTMLElement>('[data-action]');
            if (!actionEl) return;
            const action = actionEl.dataset.action;
            const taskId = actionEl.dataset.taskId;
            if (!action || !taskId) return;
            const task = this.tasks.find((item) => item.id === taskId);
            if (!task) return;

            if (action === 'download' && task.outputUrl) {
                this.triggerDownload(task.outputUrl, task.outputName || `${task.file.name}.sog4`);
            }

            if (action === 'retry' && !this.isConverting) {
                task.status = 'queued';
                task.error = undefined;
                task.summary = 'Queued for retry';
                task.logs = [];
                task.steps = this.createSteps();
                this.render();
            }
        });
    }

    private getExportFormat(): 'sog4' | 'plyseq' {
        if (this.formatPlySeq?.checked) return 'plyseq';
        return 'sog4';
    }

    private createSteps(): Record<StepKey, BatchStep> {
        const format = this.getExportFormat();
        return {
            prepare: createStep('Prepare Queue Item'),
            load: createStep('Load PLY4'),
            encode: createStep(format === 'plyseq' ? 'Export PLY Sequence' : 'Encode SOG4'),
            download: createStep('Download Output')
        };
    }

    private addFiles(fileList: FileList | null) {
        if (!fileList || fileList.length === 0) return;
        const incoming = Array.from(fileList).filter((file) => file.name.toLowerCase().endsWith('.ply4'));
        const existingKeys = new Set(this.tasks.map((task) => `${task.file.name}:${task.file.size}:${task.file.lastModified}`));

        for (const file of incoming) {
            const key = `${file.name}:${file.size}:${file.lastModified}`;
            if (existingKeys.has(key)) continue;
            existingKeys.add(key);
            this.tasks.push({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                file,
                status: 'queued',
                overallPct: 0,
                summary: `${file.name} queued`,
                logs: [`Queued ${file.name} (${formatBytes(file.size)})`],
                steps: this.createSteps()
            });
        }

        this.fileInput.value = '';
        this.folderInput.value = '';
        this.render();
    }

    private clearTasks() {
        if (this.isConverting) return;
        for (const task of this.tasks) {
            if (task.outputUrl) URL.revokeObjectURL(task.outputUrl);
        }
        this.tasks.length = 0;
        this.render();
    }

    private async convertAll() {
        if (this.isConverting) return;
        const queue = this.tasks.filter((task) => task.status === 'queued');
        if (queue.length === 0) return;

        this.isConverting = true;
        this.render();

        const format = this.getExportFormat();
        let frameOffset = 0;
        for (const task of queue) {
            await this.convertTask(task, frameOffset);
            await this.yieldToBrowser();
            if (format === 'plyseq') {
                frameOffset += task.frameCount || 0;
            }
        }

        this.isConverting = false;
        this.render();
    }

    private async convertTask(task: BatchTask, baseFrameOffset: number = 0) {
        let parsed: any = null;
        try {
            task.status = 'preparing';
            this.setStep(task, 'prepare', {
                state: 'active',
                pct: 15,
                detail: 'Preparing loader and encoder',
                childLabel: 'Queue Preparation',
                childPct: 15,
                grandchildLabel: `${task.file.name} • ${formatBytes(task.file.size)}`,
                grandchildPct: 15
            });
            this.pushLog(task, 'Preparing conversion runtime');
            this.requestRender();

            const loader = new PLY4Loader();
            this.setStep(task, 'prepare', {
                state: 'done',
                pct: 100,
                detail: 'Queue item ready',
                childLabel: 'Queue Preparation',
                childPct: 100,
                grandchildLabel: 'Waiting for PLY4 decode',
                grandchildPct: 100
            });

            task.status = 'loading';
            const loadOnce = async () => loader.load(task.file, (pct: number, message: string, meta?: PLY4LoadProgressMeta) => {
                this.setStep(task, 'load', {
                    state: pct >= 100 ? 'done' : 'active',
                    pct,
                    detail: meta?.detail || message,
                    childLabel: meta?.stageLabel || 'Load PLY4',
                    childPct: meta?.stagePct ?? pct,
                    grandchildLabel: meta?.substepLabel || meta?.detail || message,
                    grandchildPct: meta?.substepPct ?? meta?.stagePct ?? pct
                });
                task.summary = message;
                if (meta?.detail) this.pushProgressLog(task, 'load', pct, `Load • ${meta.detail}`);
                this.requestRender();
            });
            try {
                parsed = await loadOnce();
            } catch (loadError: any) {
                // #WDD-gpt 2026-04-20 - 第二个文件偶发加载失败：增加一次让步后重试
                this.pushLog(task, `Load retry • ${loadError?.message || String(loadError)}`);
                await this.yieldToBrowser();
                await new Promise((resolve) => setTimeout(resolve, 120));
                parsed = await loadOnce();
            }

            const pointCount = Number(parsed?.count || 0);
            const frameCount = Number(parsed?.frames || 1);
            task.pointCount = pointCount;
            task.frameCount = frameCount;
            this.pushLog(task, `Loaded ${pointCount.toLocaleString()} splats across ${frameCount.toLocaleString()} frame(s)`);
            this.setStep(task, 'load', {
                state: 'done',
                pct: 100,
                detail: 'PLY4 decode completed',
                childLabel: 'Load PLY4',
                childPct: 100,
                grandchildLabel: `${pointCount.toLocaleString()} splats ready`,
                grandchildPct: 100
            });

            task.status = 'encoding';
            const format = this.getExportFormat();
            let buffer: ArrayBuffer | Uint8Array;
            let outputName: string;

            if (format === 'plyseq') {
                const baseName = task.file.name.replace(/\.[^/.]+$/, '');
                
                // #WDD 2026-04-19 使用专门的新工具类导出为标准PLY序列，并自带结合了生命周期的透明度过滤。
                const { frameCount: totalFrames, buffers } = await exportPLYSequence(parsed, baseName, (pct, msg) => {
                    this.setStep(task, 'encode', {
                        state: pct >= 100 ? 'done' : 'active',
                        pct,
                        detail: msg,
                        childLabel: 'Export PLY Sequence',
                        childPct: pct,
                        grandchildLabel: msg,
                        grandchildPct: pct
                    });
                    task.summary = msg;
                    this.pushProgressLog(task, 'encode', pct, `Encode • ${msg}`);
                    this.requestRender();
                });

                task.summary = 'Packing into ZIP limit...';
                this.render();

                const zip = new JSZip();
                
                for (let i = 0; i < totalFrames; i++) {
                    const globalFrameIndex = baseFrameOffset + i;
                    const paddedIdx = String(globalFrameIndex).padStart(6, '0');
                    const fileName = `${paddedIdx}.ply`;
                    zip.file(fileName, buffers[i]);
                }

                const zipBlob = await zip.generateAsync({
                    type: 'blob',
                    compression: 'STORE'
                }, (meta) => {
                    this.setStep(task, 'encode', {
                        state: 'active',
                        pct: meta.percent,
                        detail: `Zipping... ${meta.percent.toFixed(0)}%`,
                        childLabel: 'Compress ZIP',
                        childPct: meta.percent,
                        grandchildLabel: 'Archive',
                        grandchildPct: meta.percent
                    });
                    this.pushProgressLog(task, 'encode', meta.percent, `Encode • ZIP ${meta.percent.toFixed(0)}%`);
                    this.requestRender();
                });

                const url = URL.createObjectURL(zipBlob);
                const zipFileName = `${String(this.sequenceZipCounter++).padStart(3, '0')}.zip`;
                this.triggerDownload(url, zipFileName);
                // Delay revoke to ensure download starts
                setTimeout(() => URL.revokeObjectURL(url), 2000);

                task.status = 'done';
                this.setStep(task, 'encode', { state: 'done', pct: 100 });
                this.setStep(task, 'download', { state: 'done', pct: 100 });
                task.summary = `Completed • ${totalFrames} frames saved`;
                this.requestRender();
                return;
            } else {
                // #WDD-gpt 2026-04-20 - 按需求禁用 fast/raw 路径，批量导出固定走标准 WebP 压缩
                const encodeOverrides = {
                    rawFloatPayload: false,
                    model_transform: buildTransformOverride(parsed)
                };
                this.startEncodeHeartbeat(task);
                buffer = await SOG4Encoder.encode(parsed, encodeOverrides, {
                    mode: 'standard',
                    progress: (pct: number, message: string, meta?: SOG4EncodeProgressMeta) => {
                        const cleanDetail = (meta?.detail || message).replace(/^\[(?:STD|FAST|RAW)\]\s*/, '');
                        const detail = meta?.stageLabel
                            ? `${meta.stageLabel} ${Math.round(meta?.stagePct ?? pct)}% • ${cleanDetail}`
                            : cleanDetail;
                        this.setStep(task, 'encode', {
                            state: pct >= 100 ? 'done' : 'active',
                            pct,
                            detail,
                            childLabel: meta?.stageLabel || message,
                            childPct: meta?.stagePct ?? pct,
                            grandchildLabel: detail,
                            grandchildPct: meta?.stagePct ?? pct
                        });
                        task.summary = detail;
                        this.pushProgressLog(task, 'encode', pct, `Encode • ${meta?.stageLabel || message} • ${detail}`);
                        this.requestRender();
                    }
                });
                outputName = `saved_${task.file.name.replace(/\.[^/.]+$/, '')}.sog4`;
                this.stopEncodeHeartbeat(task);
            }

            const blob = new Blob([buffer as BlobPart], { type: 'application/octet-stream' });
            if (task.outputUrl) URL.revokeObjectURL(task.outputUrl);
            task.outputUrl = URL.createObjectURL(blob);
            task.outputName = outputName;
            task.outputSize = blob.size;

            task.status = 'downloading';
            this.setStep(task, 'download', {
                state: 'active',
                pct: 35,
                detail: 'Preparing browser download',
                childLabel: 'Create Download Blob',
                childPct: 60,
                grandchildLabel: outputName,
                grandchildPct: 35
            });
            this.pushLog(task, `Output ready • ${outputName} • ${formatBytes(blob.size)}`);

            if (this.autoDownloadToggle.checked && task.outputUrl) {
                this.triggerDownload(task.outputUrl, outputName);
                this.pushLog(task, 'Auto download triggered');
            }

            this.setStep(task, 'download', {
                state: 'done',
                pct: 100,
                detail: this.autoDownloadToggle.checked ? 'Download triggered' : 'Download ready',
                childLabel: 'Finalize Output',
                childPct: 100,
                grandchildLabel: formatBytes(blob.size),
                grandchildPct: 100
            });

            task.status = 'done';
            task.summary = `Completed • ${formatBytes(blob.size)}`;
            this.requestRender();
        } catch (error: any) {
            this.stopEncodeHeartbeat(task);
            const message = error?.message || String(error);
            task.status = 'error';
            task.error = message;
            task.summary = message;
            const activeKey = STEP_ORDER.find((key) => task.steps[key].state === 'active') || 'prepare';
            this.setStep(task, activeKey, {
                state: 'error',
                detail: message,
                grandchildLabel: message,
                grandchildPct: task.steps[activeKey].grandchildPct
            });
            this.pushLog(task, `Error • ${message}`);
            this.requestRender();
        } finally {
            this.stopEncodeHeartbeat(task);
            this.releaseParsedData(parsed);
            parsed = null;
            await this.yieldToBrowser();
        }
    }

    private setStep(task: BatchTask, key: StepKey, patch: Partial<BatchStep>) {
        const next = { ...task.steps[key], ...patch };
        next.pct = clampPct(next.pct);
        next.childPct = clampPct(next.childPct);
        next.grandchildPct = clampPct(next.grandchildPct);
        task.steps[key] = next;

        const currentIndex = STEP_ORDER.indexOf(key);
        for (let i = 0; i < currentIndex; i++) {
            const prevKey = STEP_ORDER[i];
            if (task.steps[prevKey].state !== 'error' && task.steps[prevKey].pct < 100) {
                task.steps[prevKey] = {
                    ...task.steps[prevKey],
                    pct: 100,
                    childPct: 100,
                    grandchildPct: task.steps[prevKey].grandchildLabel ? 100 : task.steps[prevKey].grandchildPct,
                    state: 'done'
                };
            }
        }

        let weighted = 0;
        for (const stepKey of STEP_ORDER) {
            weighted += (task.steps[stepKey].pct / 100) * STEP_WEIGHTS[stepKey];
        }
        task.overallPct = clampPct(weighted);
    }

    private pushLog(task: BatchTask, message: string) {
        if (task.logs[task.logs.length - 1] === message) return;
        task.logs.push(message);
        if (task.logs.length > 8) task.logs.shift();
    }

    private downloadReadyTasks() {
        for (const task of this.tasks) {
            if (task.outputUrl && task.outputName) {
                this.triggerDownload(task.outputUrl, task.outputName);
            }
        }
    }

    private triggerDownload(url: string, filename: string) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
    }

    private render() {
        const done = this.tasks.filter((task) => task.status === 'done').length;
        const errors = this.tasks.filter((task) => task.status === 'error').length;
        const totalOutputSize = this.tasks.reduce((sum, task) => sum + (task.outputSize || 0), 0);
        const overallPct = this.tasks.length > 0
            ? this.tasks.reduce((sum, task) => sum + task.overallPct, 0) / this.tasks.length
            : 0;

        this.summaryQueued.innerText = `${this.tasks.length}`;
        this.summaryDone.innerText = `${done}`;
        this.summaryError.innerText = `${errors}`;
        this.summarySize.innerText = formatBytes(totalOutputSize);
        this.summaryProgressFill.style.width = `${clampPct(overallPct)}%`;
        this.summaryProgressLabel.innerText = `${Math.round(clampPct(overallPct))}%`;

        if (this.tasks.length === 0) {
            this.taskList.innerHTML = `
                <div class="batch-empty">
                    <div class="batch-empty-visual">
                        <svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <rect x="18" y="24" width="34" height="48" rx="10" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.25)"/>
                            <rect x="44" y="18" width="34" height="48" rx="10" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.35)"/>
                            <path d="M28 58C42 46 53 62 66 50" stroke="#6EE7B7" stroke-width="6" stroke-linecap="round"/>
                            <circle cx="66" cy="50" r="6" fill="#38BDF8"/>
                        </svg>
                    </div>
                    <div class="text-sm font-semibold">No files queued yet.</div>
                    <div class="text-[11px] ui-text-secondary mt-2">Drop some <code>.ply4</code> files to begin.</div>
                </div>
            `;
            return;
        }

        const visibleTasks = this.tasks.slice(0, this.visibleTaskLimit);
        const hiddenCount = Math.max(0, this.tasks.length - visibleTasks.length);
        const parts = visibleTasks.map((task) => this.renderTask(task));
        if (hiddenCount > 0) parts.push(this.renderOverflowCard(hiddenCount));
        this.taskList.innerHTML = parts.join('');
    }

    private renderTask(task: BatchTask) {
        const actions: string[] = [];
        if (task.outputUrl && task.outputName) {
            actions.push(`<button class="batch-action-btn" data-action="download" data-task-id="${escapeHtml(task.id)}">Download</button>`);
        }
        if (task.status === 'error' && !this.isConverting) {
            actions.push(`<button class="batch-action-btn" data-action="retry" data-task-id="${escapeHtml(task.id)}">Retry</button>`);
        }

        const chipClass = task.status === 'done'
            ? 'batch-chip is-done'
            : task.status === 'error'
                ? 'batch-chip is-error'
                : task.status === 'queued'
                    ? 'batch-chip'
                    : 'batch-chip is-active';

        const metadata: string[] = [];
        metadata.push(formatBytes(task.file.size));
        if (task.pointCount) metadata.push(`${task.pointCount.toLocaleString()} splats`);
        if (task.frameCount) metadata.push(`${task.frameCount.toLocaleString()} frames`);
        if (task.outputSize) metadata.push(`out ${formatBytes(task.outputSize)}`);

        return `
            <article class="batch-task">
                <div class="batch-task-header">
                    <div>
                        <div class="text-sm font-semibold">${escapeHtml(task.file.name)}</div>
                        <div class="text-[11px] ui-text-secondary mt-1">${escapeHtml(metadata.join(' • '))}</div>
                    </div>
                    <div class="flex flex-col items-end gap-2">
                        <span class="${chipClass}">${escapeHtml(task.status)}</span>
                        <span class="text-[11px] ui-text-secondary">${Math.round(task.overallPct)}%</span>
                    </div>
                </div>

                <div class="mt-3">
                    <div class="flex items-center justify-between gap-3 text-[11px] ui-text-secondary mb-2">
                        <span>${escapeHtml(task.summary)}</span>
                        <span>${Math.round(task.overallPct)}%</span>
                    </div>
                    <div class="batch-progress-track">
                        <div class="batch-progress-fill" style="width: ${task.overallPct}%"></div>
                    </div>
                </div>

                <div class="batch-stage-row">
                    ${STEP_ORDER.map((key) => this.renderStep(task.steps[key])).join('')}
                </div>

                <div class="batch-step-detail">
                    <div class="batch-substep-row text-[10px] ui-text-secondary">
                        <span>${escapeHtml(this.getActiveStepLabel(task))}</span>
                        <span>${Math.round(this.getActiveStepPct(task))}%</span>
                    </div>
                    <div class="text-[10px] ui-text-secondary mt-1">${escapeHtml(this.getActiveStepDetail(task))}</div>
                    <div class="batch-progress-track mt-2">
                        <div class="batch-progress-fill" style="width: ${this.getActiveStepPct(task)}%"></div>
                    </div>
                </div>

                ${actions.length > 0 ? `<div class="batch-task-actions">${actions.join('')}</div>` : ''}
            </article>
        `;
    }

    private renderStep(step: BatchStep) {
        const cls = [
            'batch-step',
            step.state === 'active' ? 'is-active' : '',
            step.state === 'done' ? 'is-done' : '',
            step.state === 'error' ? 'is-error' : ''
        ].filter(Boolean).join(' ');

        return `
            <section class="${cls}">
                <div class="batch-step-row text-[10px]">
                    <span class="font-semibold">${escapeHtml(step.label.split(' ')[0])}</span>
                    <span class="ui-text-secondary">${Math.round(step.pct)}%</span>
                </div>
                <div class="batch-progress-track mt-2">
                    <div class="batch-progress-fill" style="width: ${step.pct}%"></div>
                </div>
            </section>
        `;
    }

    private getActiveStep(task: BatchTask): BatchStep {
        return task.steps[STEP_ORDER.find((key) => task.steps[key].state === 'active') || STEP_ORDER.find((key) => task.steps[key].state === 'error') || 'prepare'];
    }

    private getActiveStepLabel(task: BatchTask): string {
        const step = this.getActiveStep(task);
        return step.childLabel || step.label;
    }

    private getActiveStepDetail(task: BatchTask): string {
        const step = this.getActiveStep(task);
        return step.grandchildLabel || step.detail;
    }

    private getActiveStepPct(task: BatchTask): number {
        const step = this.getActiveStep(task);
        return clampPct(step.childPct || step.pct);
    }

    private renderOverflowCard(hiddenCount: number) {
        return `
            <article class="batch-task batch-overflow-card">
                <div>
                    <div class="text-[10px] tracking-[0.18em] uppercase ui-text-secondary">More In Queue</div>
                    <div class="batch-overflow-count mt-3">+${hiddenCount}</div>
                    <div class="text-[11px] ui-text-secondary mt-3">Additional tasks are folded to keep the dashboard on one screen.</div>
                </div>
            </article>
        `;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new BatchConvertApp();
});
