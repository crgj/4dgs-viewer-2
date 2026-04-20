import type { Viewer } from '../main';

/**
 * #WDD 2026-04-20: Extracted from Viewer to reduce main.ts size.
 * Handles timeline UI, playback controls, seek, and loop logic.
 */
export class ViewerTimelineManager {
    constructor(private viewer: Viewer) {}

    togglePlay() {
        const v = this.viewer as any;
        v.isPlaying = !v.isPlaying;
        if (v.isPlaying) {
            v.normalizeLoopRange();
            if (v.loopEnabled && (v.currentTime < v.loopStartFrame || v.currentTime > v.loopEndFrame)) {
                v.currentTime = v.loopStartFrame;
            }
            v.playbackTime = v.currentTime;
        }
        const playBtn = document.getElementById('play-pause');
        const simplePlayBtn = document.getElementById('simple-play-pause');

        const icon = v.isPlaying
            ? '<svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
            : '<svg viewBox="0 0 24 24" class="w-5 h-5 fill-current"><path d="M8 5v14l11-7z"/></svg>';

        const simpleIcon = v.isPlaying
            ? '<svg viewBox="0 0 24 24" class="w-6 h-6 fill-current"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
            : '<svg viewBox="0 0 24 24" class="w-6 h-6 fill-current"><path d="M8 5v14l11-7z"/></svg>';

        if (playBtn) playBtn.innerHTML = icon;
        if (simplePlayBtn) simplePlayBtn.innerHTML = simpleIcon;
    }

    updateTimelineTicks(duration: number) {
        const v = this.viewer as any;
        const container = document.getElementById('timeline-ticks');
        if (!container) return;
        container.innerHTML = '';

        const maxFrame = Math.max(0, Math.ceil(duration) - 1);
        let step = 1;
        if (maxFrame > 20) step = 5;
        if (maxFrame > 50) step = 10;
        if (maxFrame > 100) step = 20;

        for (let i = 0; i <= maxFrame; i += step) {
            const tick = document.createElement('div');
            tick.className = 'flex flex-col items-center';
            tick.innerHTML = `
                <div class="tick-mark"></div>
                <div class="tick-label">${i}</div>
            `;
            container.appendChild(tick);
        }

        v.renderTimelineDecorations();
    }

    getTimelineTotalFrames(): number {
        const v = this.viewer as any;
        return v.isSog4SequenceMode ? (v.sog4SequenceTotalFrames || v.duration || 1) : (v.duration || 1);
    }

    getTimelineMaxFrame(): number {
        return Math.max(0, Math.ceil(this.getTimelineTotalFrames()) - 1);
    }

    clampTimelineFrame(frame: number): number {
        const maxFrame = this.getTimelineMaxFrame();
        return Math.max(0, Math.min(maxFrame, Math.floor(frame)));
    }

    normalizeLoopRange() {
        const v = this.viewer as any;
        const maxFrame = this.getTimelineMaxFrame();
        v.loopStartFrame = Math.max(0, Math.min(maxFrame, Math.floor(v.loopStartFrame)));
        v.loopEndFrame = Math.max(0, Math.min(maxFrame, Math.floor(v.loopEndFrame || maxFrame)));
        if (v.loopEndFrame < v.loopStartFrame) {
            [v.loopStartFrame, v.loopEndFrame] = [v.loopEndFrame, v.loopStartFrame];
        }
    }

    resetTimelineTools() {
        const v = this.viewer as any;
        v.loopEnabled = false;
        v.loopStartFrame = 0;
        v.loopEndFrame = this.getTimelineMaxFrame();
        v.renderTimelineDecorations();
    }

    syncTimelineUI(displayFrame = Math.floor((this.viewer as any).currentTime), total = this.getTimelineMaxFrame()) {
        const slider = document.getElementById('time-slider') as HTMLInputElement | null;
        const timeLabel = document.getElementById('time-label');
        if (slider) {
            slider.max = total.toString();
            slider.step = '1';
            slider.value = Math.max(0, Math.min(total, Math.floor(displayFrame))).toString();
        }
        if (timeLabel) {
            timeLabel.innerText = `${Math.floor(displayFrame)} / ${Math.max(0, total)}`;
        }
    }

    renderTimelineDecorations() {
        const v = this.viewer as any;
        const maxFrame = this.getTimelineMaxFrame();
        const loopRange = document.getElementById('timeline-loop-range') as HTMLDivElement | null;
        const loopLabel = document.getElementById('timeline-loop-label');
        const loopToggle = document.getElementById('timeline-loop-toggle');
        if (!loopRange || !loopLabel) return;

        this.normalizeLoopRange();
        const percentFor = (frame: number) => maxFrame <= 0 ? 0 : (frame / maxFrame) * 100;

        if (v.loopEnabled && maxFrame > 0) {
            const startPct = percentFor(v.loopStartFrame);
            const endPct = percentFor(v.loopEndFrame);
            loopRange.classList.remove('hidden');
            loopRange.style.left = `${startPct}%`;
            loopRange.style.width = `${Math.max(0, endPct - startPct)}%`;
            loopLabel.textContent = `Loop ${v.loopStartFrame}-${v.loopEndFrame}`;
            loopToggle?.classList.add('active');
        } else {
            loopRange.classList.add('hidden');
            loopRange.style.left = '0%';
            loopRange.style.width = '0%';
            loopLabel.textContent = v.loopStartFrame !== 0 || v.loopEndFrame !== maxFrame
                ? `Range ${v.loopStartFrame}-${v.loopEndFrame}`
                : 'Full Range';
            loopToggle?.classList.remove('active');
        }
    }

    seekToFrame(frame: number, options: { pause?: boolean } = {}) {
        const v = this.viewer as any;
        const target = this.clampTimelineFrame(frame);
        if (options.pause && v.isPlaying) {
            this.togglePlay();
        }

        v.playbackTime = target;

        if (v.isSog4SequenceMode) {
            v.currentTime = target;
            const info = v.updateSog4SequenceTime();
            this.syncTimelineUI(info.displayFrame, Math.max(0, Math.ceil(info.total) - 1));
            return;
        }

        if (v.is4DGS && v.trajectoryData && !v.isSequenceMode) {
            v.requestSortedFrame(target);
        } else {
            v.currentTime = target;
            if (v.splatEntity?.gsplat) {
                (v.splatEntity.gsplat as any).time = target;
                const material = (v.splatEntity.gsplat as any).instance?.material;
                if (material) {
                    material.setParameter('uTime', target);
                    material.setParameter('uGlobalTotalFrames', v.duration);
                }
            }
            if (v.isSequenceMode) {
                void v.applySequenceFrame(target);
            }
        }

        this.syncTimelineUI(target, this.getTimelineMaxFrame());
    }

    stepFrame(delta: number) {
        this.seekToFrame((this.viewer as any).currentTime + delta, { pause: true });
    }
}
