import { PerformanceMonitor } from '../managers/performance-monitor';

export class PerformancePanel {
    private monitor: PerformanceMonitor;
    private container: HTMLElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private animationId: number | null = null;
    private fpsHistory: number[] = new Array(60).fill(0);

    constructor(monitor: PerformanceMonitor) {
        this.monitor = monitor;
        this.bindPanel();
        this.startUpdateLoop();
    }

    private bindPanel() {
        this.container = document.getElementById('panel-monitor');
        this.canvas = this.container?.querySelector('#perf-fps-chart') as HTMLCanvasElement | null;
        this.ctx = this.canvas?.getContext('2d') || null;
        this.fillDeviceInfo();
        this.updateTimelineTab();
    }

    private fillDeviceInfo() {
        const device = this.monitor.getDeviceCapability();
        this.updateElement('perf-device-tier', device.tier.toUpperCase());
        this.updateElement('perf-gpu-name', device.gpuRenderer || 'Unknown');
        this.updateElement('perf-cores', String(device.hardwareConcurrency));
        this.updateElement('perf-is-mobile', device.isMobile ? 'Yes' : 'No');
    }

    private startUpdateLoop() {
        const update = () => {
            this.updateDisplay();
            this.animationId = requestAnimationFrame(update);
        };
        update();
    }

    private updateDisplay() {
        const metrics = this.monitor.getCurrentMetrics();
        if (!metrics) return;

        this.updateGlobalElement('fps-display', metrics.fps.toString());

        if (!this.container) return;

        this.fpsHistory.push(metrics.fps);
        this.fpsHistory.shift();
        const avgFPS = this.fpsHistory.reduce((a, b) => a + b, 0) / this.fpsHistory.length;
        this.updateElement('perf-fps-avg', `avg: ${avgFPS.toFixed(0)}`);

        this.drawFpsChart();
        this.updateTimelineTab();
    }

    private updateElement(id: string, text: string) {
        const el = this.container?.querySelector(`#${id}`);
        if (el && el.textContent !== text) {
            el.textContent = text;
        }
    }

    private updateGlobalElement(id: string, text: string) {
        const el = document.getElementById(id);
        if (el && el.textContent !== text) {
            el.textContent = text;
        }
    }

    private drawFpsChart() {
        if (!this.ctx || !this.canvas) return;

        const width = this.canvas.width;
        const height = this.canvas.height;
        const padding = 4;
        const min = 0;
        const max = 60;
        const range = max - min || 1;

        this.ctx.clearRect(0, 0, width, height);

        const targetYPx = height - padding - (60 - min) / range * (height - 2 * padding);
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([2, 2]);
        this.ctx.beginPath();
        this.ctx.moveTo(0, targetYPx);
        this.ctx.lineTo(width, targetYPx);
        this.ctx.stroke();
        this.ctx.setLineDash([]);

        this.ctx.strokeStyle = '#10b981';
        this.ctx.lineWidth = 2;
        this.ctx.lineJoin = 'round';
        this.ctx.beginPath();

        this.fpsHistory.forEach((value, i) => {
            const x = (i / Math.max(this.fpsHistory.length - 1, 1)) * width;
            const y = height - padding - (value - min) / range * (height - 2 * padding);
            if (i === 0) this.ctx!.moveTo(x, y);
            else this.ctx!.lineTo(x, y);
        });

        this.ctx.stroke();
        this.ctx.lineTo(width, height);
        this.ctx.lineTo(0, height);
        this.ctx.closePath();

        const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, '#10b98140');
        gradient.addColorStop(1, '#10b98100');
        this.ctx.fillStyle = gradient;
        this.ctx.fill();
    }

    private updateTimelineTab() {
        if (!this.container) return;
        const phases = this.monitor.getLoadPhases();
        const warnings = this.monitor.getWarnings();

        const phasesContainer = this.container.querySelector('#perf-load-phases');
        if (phasesContainer) {
            if (phases.length === 0) {
                phasesContainer.innerHTML = '<div class="text-[10px] ui-text-dim text-center py-4">No load phases recorded</div>';
            } else {
                phasesContainer.innerHTML = phases.slice(-8).reverse().map((phase) => `
                    <div class="flex items-center justify-between text-[10px] bg-black/20 rounded-lg p-2">
                        <div class="min-w-0">
                            <div class="ui-text-secondary font-bold truncate">${phase.phase}</div>
                            <div class="ui-text-dim text-[9px] truncate">${phase.detail || ''}</div>
                        </div>
                        <div class="font-mono ui-text-primary ml-2">${phase.duration?.toFixed(1)}ms</div>
                    </div>
                `).join('');
            }
        }

        const warningsContainer = this.container.querySelector('#perf-warnings');
        if (warningsContainer) {
            if (warnings.length === 0) {
                warningsContainer.innerHTML = '<div class="text-[10px] ui-text-dim text-center py-4">No warnings</div>';
            } else {
                warningsContainer.innerHTML = warnings.slice(-6).reverse().map((w) => {
                    const colorClass = w.severity === 'critical'
                        ? 'text-red-400'
                        : w.severity === 'warning'
                            ? 'text-amber-400'
                            : 'text-blue-400';
                    return `
                        <div class="text-[10px] bg-black/20 rounded-lg p-2 ${colorClass}">
                            <div class="font-bold">${w.type}</div>
                            <div class="ui-text-secondary">${w.message}</div>
                        </div>
                    `;
                }).join('');
            }
        }
    }

    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
    }
}

export default PerformancePanel;
