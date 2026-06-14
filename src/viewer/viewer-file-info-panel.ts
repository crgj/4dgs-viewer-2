import { onLanguageChange, t } from '../i18n';

type NumericStats = {
    min: number;
    max: number;
    mean: number;
    sampled: number;
    total: number;
};

type InfoRow = {
    label: string;
    value: string;
};

type ChartDatum = {
    label: string;
    value: number;
    max: number;
    display: string;
};

const SAMPLE_LIMIT = 200000;

const escapeHtml = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

export class ViewerFileInfoPanel {
    private readonly root = document.getElementById('file-info-content') as HTMLElement | null;
    private refreshTimer: number | null = null;
    private renderCountCache: { frame: number; pointCount: number; deletedVersion: number; rendered: number } | null = null;

    constructor(private readonly viewer: any) {
        if (!this.root) return;
        this.render();
        onLanguageChange(() => this.render());
        this.refreshTimer = window.setInterval(() => this.render(), 1200);
    }

    refresh() {
        this.render();
    }

    destroy() {
        if (this.refreshTimer !== null) {
            window.clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    private render() {
        if (!this.root) return;

        const parsed = this.viewer.isSequenceMode ? null : (this.viewer.lastParsedData || null);
        const splatData = this.getSplatData();
        const pointCount = this.getPointCount(parsed, splatData);
        const frameInfo = this.getFrameInfo(parsed);
        const renderedCount = this.countRenderedGaussians(pointCount, frameInfo.localFrame);
        const rows = this.buildRows(parsed, splatData, pointCount, frameInfo, renderedCount);
        const lifetime = this.buildLifetimeRows(parsed, pointCount);
        const bounds = this.buildBoundsRows(pointCount);
        const memoryItems = this.buildMemoryItems(parsed);
        const memory = memoryItems.length
            ? memoryItems.map((item) => ({ label: item.label, value: this.formatBytes(item.value) }))
            : [{ label: t('info.memory'), value: '--' }];
        const segments = this.buildSegmentRows();
        const keyframes = this.buildKeyframeChart(parsed, frameInfo.totalFrames);

        this.root.innerHTML = `
            <div class="panel-note">${escapeHtml(t('info.note'))}</div>
            ${this.renderOverview(pointCount, renderedCount, frameInfo)}
            ${this.renderBarChart(t('info.renderChart'), [
                { label: t('info.renderedGaussians'), value: renderedCount, max: Math.max(1, pointCount), display: renderedCount.toLocaleString() },
                { label: t('info.hiddenGaussians'), value: Math.max(0, pointCount - renderedCount), max: Math.max(1, pointCount), display: Math.max(0, pointCount - renderedCount).toLocaleString() }
            ])}
            ${this.renderBarChart(t('info.frameChart'), [
                { label: t('info.currentFrame'), value: frameInfo.globalFrame + 1, max: frameInfo.totalFrames, display: `${frameInfo.globalFrame.toLocaleString()} / ${Math.max(0, frameInfo.totalFrames - 1).toLocaleString()}` }
            ])}
            ${keyframes.length ? this.renderBarChart(t('info.keyframeChart'), keyframes) : ''}
            ${memoryItems.length ? this.renderBarChart(t('info.memoryChart'), memoryItems.map((item) => ({
                label: item.label,
                value: item.value,
                max: Math.max(...memoryItems.map((entry) => entry.value), 1),
                display: this.formatBytes(item.value)
            }))) : ''}
            ${this.renderGrid(rows)}
            ${this.renderSection(t('info.lifecycle'), lifetime)}
            ${this.renderSection(t('info.bounds'), bounds)}
            ${this.renderSection(t('info.memory'), memory)}
            ${segments.length ? this.renderSection(t('info.sequence'), segments) : ''}
        `;
    }

    private buildRows(parsed: any, splatData: any, pointCount: number, frameInfo: { globalFrame: number; totalFrames: number }, renderedCount: number): InfoRow[] {
        const format = this.getFormat(parsed);
        const temporalSegments = this.viewer.sog4SequenceSegments?.length || 0;
        const sourceMode = this.viewer.isSog4SequenceMode && temporalSegments > 1
            ? t('info.sourceTemporalSequence')
            : (this.viewer.isSequenceMode ? t('info.sourceFrameSequence') : t('info.sourceSingleFile'));

        return [
            { label: t('info.fileName'), value: this.viewer.currentFileName || t('info.none') },
            { label: t('info.format'), value: format },
            { label: t('info.fileSize'), value: this.formatBytes(this.viewer.currentFileSize || 0) },
            { label: t('info.sourceMode'), value: sourceMode },
            { label: t('info.gaussianCount'), value: pointCount > 0 ? pointCount.toLocaleString() : '--' },
            { label: t('info.renderedGaussians'), value: renderedCount > 0 ? renderedCount.toLocaleString() : '--' },
            { label: t('info.frames'), value: frameInfo.totalFrames.toLocaleString() },
            { label: t('info.currentFrame'), value: frameInfo.globalFrame.toLocaleString() },
            { label: t('info.dynamic'), value: this.viewer.is4DGS ? t('info.yes') : t('info.no') },
            { label: t('info.positionKeys'), value: this.formatKeyStride(this.viewer.keyframes || parsed?.keyframes, this.viewer.xyzStride || parsed?.xyzStride) },
            { label: t('info.rotationKeys'), value: this.formatKeyStride(this.viewer.rotKeyframes || parsed?.rotKeyframes, this.viewer.rotStride || parsed?.rotStride) },
            { label: t('info.colorKeys'), value: this.formatKeyStride(this.viewer.dcKeyframes || parsed?.dcKeyframes, this.viewer.dcStride || parsed?.dcStride) },
            { label: t('info.opacitySemantic'), value: parsed?.opacitySemantic || '--' },
            { label: t('info.rotationSemantic'), value: parsed?.rotationSemantic || '--' },
            { label: t('info.propertyCount'), value: this.getPropertyNames(parsed, splatData).length.toLocaleString() }
        ];
    }

    private buildLifetimeRows(parsed: any, pointCount: number): InfoRow[] {
        const mu = this.getProperty(parsed, 'lifetime_mu');
        const w = this.getProperty(parsed, 'lifetime_w');
        const k = this.getProperty(parsed, 'lifetime_k');
        const hasLifeTexture = !!this.viewer.lifeTexData && pointCount > 0;
        const rows: InfoRow[] = [
            { label: t('info.hasLifetime'), value: (mu && w) || hasLifeTexture ? t('info.yes') : t('info.no') }
        ];

        mu ? this.pushStatsRows(rows, 'mu', mu) : this.pushLifeChannelStatsRows(rows, 'mu', 0, pointCount);
        w ? this.pushStatsRows(rows, 'w', w) : this.pushLifeChannelStatsRows(rows, 'w', 1, pointCount);
        k ? this.pushStatsRows(rows, 'k', k) : this.pushLifeChannelStatsRows(rows, 'k', 2, pointCount);
        return rows;
    }

    private buildBoundsRows(pointCount: number): InfoRow[] {
        const positions = this.viewer.cachedPositions as Float32Array | null | undefined;
        if (!positions || pointCount <= 0) return [{ label: t('info.bounds'), value: '--' }];

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const step = Math.max(1, Math.ceil(pointCount / SAMPLE_LIMIT));
        let sampled = 0;

        for (let i = 0; i < pointCount; i += step) {
            const idx = i * 3;
            const x = positions[idx + 0];
            const y = positions[idx + 1];
            const z = positions[idx + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
            sampled++;
        }

        if (!sampled) return [{ label: t('info.bounds'), value: '--' }];
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const cz = (minZ + maxZ) / 2;

        return [
            { label: t('info.min'), value: this.formatVec(minX, minY, minZ) },
            { label: t('info.max'), value: this.formatVec(maxX, maxY, maxZ) },
            { label: t('info.center'), value: this.formatVec(cx, cy, cz) },
            { label: t('info.extents'), value: this.formatVec(maxX - minX, maxY - minY, maxZ - minZ) },
            { label: t('info.sampled'), value: `${sampled.toLocaleString()} / ${pointCount.toLocaleString()}` }
        ];
    }

    private buildMemoryItems(parsed: any): ChartDatum[] {
        const rows: ChartDatum[] = [];
        this.pushArrayBytes(rows, t('info.positions'), this.viewer.cachedPositions);
        this.pushArrayBytes(rows, t('info.lifetimeTexture'), this.viewer.lifeTexData);
        this.pushArrayBytes(rows, t('info.scalesTexture'), this.viewer.scalesTexData);
        this.pushArrayBytes(rows, t('info.trajectory'), this.viewer.trajectoryData || parsed?.trajectory);
        this.pushArrayBytes(rows, t('info.rotationTrajectory'), this.viewer.rotTrajectoryData || parsed?.rotTrajectory);
        this.pushArrayBytes(rows, t('info.colorTrajectory'), this.viewer.dcTrajectoryData || parsed?.dcTrajectory);
        this.pushArrayBytes(rows, t('info.sourceBuffer'), parsed?.sogBuffer || parsed?.plyBuffer);
        return rows;
    }

    private buildSegmentRows(): InfoRow[] {
        const sequence = this.viewer.splatSequence;
        const segments = this.viewer.sog4SequenceSegments || [];
        const rows: InfoRow[] = [];
        if (sequence?.elements?.length) {
            rows.push({ label: t('info.segmentCount'), value: sequence.elements.length.toLocaleString() });
            rows.push({ label: t('info.activeSegment'), value: `${(sequence.activeElementIndex || 0) + 1} / ${sequence.elements.length}` });
        } else if (segments.length) {
            rows.push({ label: t('info.segmentCount'), value: segments.length.toLocaleString() });
            rows.push({ label: t('info.activeSegment'), value: `${(this.viewer.sog4SequenceIndex || 0) + 1} / ${segments.length}` });
        }

        const source = sequence?.elements?.length ? sequence.elements : segments;
        source.slice(0, 5).forEach((segment: any, index: number) => {
            const name = segment.name || `#${index + 1}`;
            const count = segment.pointCount || segment.parsed?.count || segment.header?.count;
            const duration = segment.duration || segment.parsed?.frames || segment.parsed?.maxMu;
            rows.push({
                label: `#${index + 1}`,
                value: `${name}${count ? ` • ${Number(count).toLocaleString()}` : ''}${duration ? ` • ${Number(duration).toLocaleString()}f` : ''}`
            });
        });
        if (source.length > 5) rows.push({ label: t('info.more'), value: `+${source.length - 5}` });
        return rows;
    }

    private renderGrid(rows: InfoRow[]) {
        return `<div class="file-info-grid">${rows.map((row) => this.renderRow(row)).join('')}</div>`;
    }

    private renderOverview(pointCount: number, renderedCount: number, frameInfo: { globalFrame: number; totalFrames: number }) {
        const renderPct = pointCount > 0 ? (renderedCount / pointCount) * 100 : 0;
        return `
            <div class="file-info-overview">
                ${this.renderMetric(t('info.renderedGaussians'), renderedCount > 0 ? renderedCount.toLocaleString() : '--', `${this.formatNumber(renderPct)}%`)}
                ${this.renderMetric(t('info.gaussianCount'), pointCount > 0 ? pointCount.toLocaleString() : '--', t('info.total'))}
                ${this.renderMetric(t('info.currentFrame'), frameInfo.globalFrame.toLocaleString(), `${frameInfo.totalFrames.toLocaleString()} ${t('info.frames')}`)}
            </div>
        `;
    }

    private renderMetric(label: string, value: string, meta: string) {
        return `
            <div class="file-info-metric">
                <span class="file-info-metric-label">${escapeHtml(label)}</span>
                <span class="file-info-metric-value">${escapeHtml(value)}</span>
                <span class="file-info-metric-meta">${escapeHtml(meta)}</span>
            </div>
        `;
    }

    private renderBarChart(title: string, data: ChartDatum[]) {
        return `
            <div class="file-info-chart">
                <div class="panel-label-row"><span class="panel-label">${escapeHtml(title)}</span></div>
                <div class="file-info-chart-bars">
                    ${data.map((item) => {
                        const pct = item.max > 0 ? Math.max(0, Math.min(100, (item.value / item.max) * 100)) : 0;
                        return `
                            <div class="file-info-chart-row">
                                <div class="file-info-chart-head">
                                    <span>${escapeHtml(item.label)}</span>
                                    <span>${escapeHtml(item.display)}</span>
                                </div>
                                <div class="file-info-chart-track">
                                    <div class="file-info-chart-fill" style="width: ${pct}%"></div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    private renderSection(title: string, rows: InfoRow[]) {
        return `
            <div class="file-info-section">
                <div class="panel-label-row"><span class="panel-label">${escapeHtml(title)}</span></div>
                <div class="file-info-grid">${rows.map((row) => this.renderRow(row)).join('')}</div>
            </div>
        `;
    }

    private renderRow(row: InfoRow) {
        return `
            <div class="file-info-row">
                <span class="file-info-label">${escapeHtml(row.label)}</span>
                <span class="file-info-value">${escapeHtml(row.value)}</span>
            </div>
        `;
    }

    private getFormat(parsed: any) {
        const name = String(this.viewer.currentFileName || '').toLowerCase();
        if (this.viewer.isSog4SequenceMode && (name.endsWith('.ply4') || this.viewer.ply4SequenceLoadMode === 'segmented')) {
            return `PLY4 ${String(this.viewer.ply4SequenceLoadMode || 'full').toUpperCase()}`;
        }
        if (name.endsWith('.sog4') || parsed?.isSOG4) return 'SOG4';
        if (name.endsWith('.sog')) return 'SOG';
        if (name.endsWith('.ply4')) return 'PLY4';
        if (name.endsWith('.ply')) return 'PLY';
        if (name.endsWith('.truesplats')) return 'TrueSplats';
        return parsed ? 'GSplat' : '--';
    }

    private getSplatData() {
        return (this.viewer.splatEntity?.gsplat as any)?.asset?.resource?.splatData
            || (this.viewer.splatEntity?.gsplat as any)?.instance?.splatData
            || null;
    }

    private getPointCount(parsed: any, splatData: any) {
        return Number(splatData?.numSplats || parsed?.count || Math.floor((this.viewer.cachedPositions?.length || 0) / 3) || 0);
    }

    private getFrameInfo(parsed: any) {
        const totalFrames = Math.max(1, Math.floor(this.viewer.getTimelineTotalFrames?.() || this.viewer.totalFrames || this.viewer.duration || parsed?.frames || parsed?.maxMu || 1));
        const globalFrame = Math.max(0, Math.min(totalFrames - 1, Math.floor(this.viewer.currentTime || 0)));
        const offsets = this.viewer.sog4SequenceOffsets;
        const index = Number.isInteger(this.viewer.sog4SequenceIndex) ? this.viewer.sog4SequenceIndex : 0;
        const segmentStart = Array.isArray(offsets) ? Number(offsets[index] || 0) : 0;
        const localFrame = Math.max(0, Math.floor(globalFrame - segmentStart));
        return { globalFrame, localFrame, totalFrames };
    }

    private getPropertyNames(parsed: any, splatData: any): string[] {
        const props = parsed?.plyData?.elements?.[0]?.properties;
        if (Array.isArray(props)) return props.map((prop: any) => prop.name).filter(Boolean);
        const elements = splatData?.elements?.[0]?.properties;
        if (Array.isArray(elements)) return elements.map((prop: any) => prop.name).filter(Boolean);
        return [];
    }

    private getProperty(parsed: any, name: string): Float32Array | null {
        const props = parsed?.plyData?.elements?.[0]?.properties;
        const prop = Array.isArray(props) ? props.find((entry: any) => entry.name === name) : null;
        if (prop?.storage instanceof Float32Array) return prop.storage;
        if (parsed?.[name] instanceof Float32Array) return parsed[name];
        return null;
    }

    private pushStatsRows(rows: InfoRow[], prefix: string, values: Float32Array | null) {
        const stats = this.calcStats(values);
        if (!stats) return;
        rows.push({ label: `${prefix} min/max`, value: `${this.formatNumber(stats.min)} / ${this.formatNumber(stats.max)}` });
        rows.push({ label: `${prefix} avg`, value: this.formatNumber(stats.mean) });
        if (stats.sampled < stats.total) rows.push({ label: `${prefix} ${t('info.sampled')}`, value: `${stats.sampled.toLocaleString()} / ${stats.total.toLocaleString()}` });
    }

    private pushLifeChannelStatsRows(rows: InfoRow[], prefix: string, channel: number, pointCount: number) {
        const stats = this.calcLifeChannelStats(channel, pointCount);
        if (!stats) return;
        rows.push({ label: `${prefix} min/max`, value: `${this.formatNumber(stats.min)} / ${this.formatNumber(stats.max)}` });
        rows.push({ label: `${prefix} avg`, value: this.formatNumber(stats.mean) });
        if (stats.sampled < stats.total) rows.push({ label: `${prefix} ${t('info.sampled')}`, value: `${stats.sampled.toLocaleString()} / ${stats.total.toLocaleString()}` });
    }

    private calcStats(values: Float32Array | null): NumericStats | null {
        if (!values || values.length === 0) return null;
        const total = values.length;
        const step = Math.max(1, Math.ceil(total / SAMPLE_LIMIT));
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        let sampled = 0;
        for (let i = 0; i < total; i += step) {
            const value = values[i];
            if (!Number.isFinite(value)) continue;
            min = Math.min(min, value);
            max = Math.max(max, value);
            sum += value;
            sampled++;
        }
        return sampled ? { min, max, mean: sum / sampled, sampled, total } : null;
    }

    private calcLifeChannelStats(channel: number, pointCount: number): NumericStats | null {
        const life = this.viewer.lifeTexData as Float32Array | null | undefined;
        if (!life || pointCount <= 0) return null;
        const total = Math.min(pointCount, Math.floor(life.length / 4));
        const step = Math.max(1, Math.ceil(total / SAMPLE_LIMIT));
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        let sampled = 0;
        for (let i = 0; i < total; i += step) {
            const value = life[i * 4 + channel];
            if (!Number.isFinite(value)) continue;
            min = Math.min(min, value);
            max = Math.max(max, value);
            sum += value;
            sampled++;
        }
        return sampled ? { min, max, mean: sum / sampled, sampled, total } : null;
    }

    private pushArrayBytes(rows: ChartDatum[], label: string, value: any) {
        const bytes = this.getByteLength(value);
        if (bytes > 0) rows.push({ label, value: bytes, max: bytes, display: this.formatBytes(bytes) });
    }

    private buildKeyframeChart(parsed: any, totalFrames: number): ChartDatum[] {
        const items = [
            { label: t('info.positionKeys'), value: Number(this.viewer.keyframes || parsed?.keyframes || 0) },
            { label: t('info.rotationKeys'), value: Number(this.viewer.rotKeyframes || parsed?.rotKeyframes || 0) },
            { label: t('info.colorKeys'), value: Number(this.viewer.dcKeyframes || parsed?.dcKeyframes || 0) }
        ];
        return items
            .filter((item) => Number.isFinite(item.value) && item.value > 0)
            .map((item) => ({
                label: item.label,
                value: item.value,
                max: Math.max(1, totalFrames),
                display: item.value.toLocaleString()
            }));
    }

    private countRenderedGaussians(pointCount: number, localFrame: number) {
        if (pointCount <= 0) return 0;
        const deletedVersion = this.getDeletedVersion();
        if (this.renderCountCache
            && this.renderCountCache.frame === localFrame
            && this.renderCountCache.pointCount === pointCount
            && this.renderCountCache.deletedVersion === deletedVersion) {
            return this.renderCountCache.rendered;
        }

        const deletedSet = this.getDeletedSet();
        const selectionData = this.viewer.selectionTool?.selectionData as Uint8Array | null | undefined;
        const opacity = this.getOpacity();
        let rendered = 0;
        for (let i = 0; i < pointCount; i++) {
            if (this.isDeleted(i, deletedSet, selectionData)) continue;
            if (!this.isLifetimeVisible(i, localFrame)) continue;
            if (!this.isOpacityVisible(i, opacity)) continue;
            rendered++;
        }

        this.renderCountCache = { frame: localFrame, pointCount, deletedVersion, rendered };
        return rendered;
    }

    private getDeletedVersion() {
        const selectionData = this.viewer.selectionTool?.selectionData as Uint8Array | null | undefined;
        let checksum = selectionData?.length || 0;
        if (selectionData?.length) {
            const count = Math.floor(selectionData.length / 4);
            const step = Math.max(1, Math.floor(count / 512));
            for (let i = 0; i < count; i += step) checksum = ((checksum * 33) ^ selectionData[i * 4 + 1]) >>> 0;
        }
        return checksum + ((this.viewer.lastParsedData?.deleted_indices?.length || 0) * 31);
    }

    private getDeletedSet() {
        const deleted = this.viewer.lastParsedData?.deleted_indices;
        if (!Array.isArray(deleted) || deleted.length === 0) return null;
        return new Set(deleted.map((value: any) => Math.floor(Number(value))).filter(Number.isFinite));
    }

    private isDeleted(index: number, deletedSet: Set<number> | null, selectionData?: Uint8Array | null) {
        const selIdx = index * 4;
        if (selectionData && selIdx + 1 < selectionData.length && selectionData[selIdx + 1] > 0) return true;
        return !!deletedSet?.has(index);
    }

    private isLifetimeVisible(index: number, frame: number) {
        const life = this.viewer.lifeTexData as Float32Array | null | undefined;
        if (!life) return true;
        const idx = index * 4;
        if (idx + 2 >= life.length) return true;
        const mu = life[idx + 0];
        const w = life[idx + 1];
        const k = life[idx + 2];
        const totalFrames = Math.max(1, Math.ceil(this.viewer.duration ?? 100));
        const segmentMax = Math.max(0, totalFrames - 1);
        const time = Math.floor(frame);
        if (time < 0 || time > segmentMax) return false;
        const lifeStart = mu - w;
        const lifeEnd = mu + w;
        if (lifeEnd <= 0 || lifeStart >= segmentMax || lifeEnd <= lifeStart) return false;
        const left = 1.0 / (1.0 + Math.exp(-k * (time - lifeStart)));
        const right = 1.0 / (1.0 + Math.exp(k * (time - lifeEnd)));
        return (left * right) > 0.01;
    }

    private isOpacityVisible(index: number, opacity: Float32Array | null) {
        if (!opacity || index >= opacity.length) return true;
        const raw = opacity[index];
        const alpha = raw >= 0 && raw <= 1 ? raw : 1 / (1 + Math.exp(-raw));
        return alpha > (1 / 255);
    }

    private getOpacity(): Float32Array | null {
        const splatData = this.getSplatData();
        const opacity = splatData?.getProp?.('opacity');
        if (opacity instanceof Float32Array) return opacity;
        return this.getProperty(this.viewer.lastParsedData, 'opacity');
    }

    private getByteLength(value: any): number {
        if (!value) return 0;
        if (isFiniteNumber(value.byteLength)) return value.byteLength;
        if (value.buffer && isFiniteNumber(value.buffer.byteLength)) return value.buffer.byteLength;
        return 0;
    }

    private formatKeyStride(keys: unknown, stride: unknown) {
        const k = Number(keys || 0);
        if (!Number.isFinite(k) || k <= 0) return '--';
        return `${Math.floor(k).toLocaleString()} @ ${Math.max(1, Number(stride || 1)).toLocaleString()}`;
    }

    private formatVec(x: number, y: number, z: number) {
        return `${this.formatNumber(x)}, ${this.formatNumber(y)}, ${this.formatNumber(z)}`;
    }

    private formatNumber(value: number) {
        if (!Number.isFinite(value)) return '--';
        const abs = Math.abs(value);
        if (abs >= 1000 || (abs > 0 && abs < 0.001)) return value.toExponential(2);
        return value.toFixed(abs >= 10 ? 2 : 4);
    }

    private formatBytes(bytes: number) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '--';
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit++;
        }
        return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
    }
}
