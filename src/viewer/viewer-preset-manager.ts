import * as pc from 'playcanvas';
import type { Viewer } from '../main';
import type { CameraPreset } from '../types/viewer';
import { applyI18n, t } from '../i18n';

/**
 * #WDD 2026-04-20: Extracted from Viewer to reduce main.ts size.
 * Handles camera presets, text overlays, and smooth camera animation.
 */
export class ViewerPresetManager {
    cameraPresets: CameraPreset[] = [];
    currentPresetIndex = -1;
    isCameraAnimating = false;
    isRecordingPresetVideo = false;
    isPreviewingPresetPath = false;
    wasPlayingBeforeAnim = false;
    animTargetPos = new pc.Vec3();
    animTargetPitch = 0;
    animTargetYaw = 0;
    animStartPos = new pc.Vec3();
    animStartPitch = 0;
    animStartYaw = 0;
    animProgress = 0;
    activeTextId: string | null = null;
    textOverlays: Map<string, HTMLElement> = new Map();
    private recordSegmentIndex = 0;
    private recordSegmentProgress = 0;
    private recordSegmentDuration = 2.0;
    private recordFrameRate = 30;
    private mediaRecorder: MediaRecorder | null = null;
    private recordedChunks: Blob[] = [];
    private recordingStream: MediaStream | null = null;

    constructor(private viewer: Viewer) {}

    /** Called each frame from the app update loop. */
    update(dt: number) {
        const v = this.viewer as any;
        this.updateTextVisibility();

        if (this.isRecordingPresetVideo || this.isPreviewingPresetPath) {
            this.updatePresetPathAnimation(dt);
            return;
        }

        // Smooth Camera Animation
        if (this.isCameraAnimating && v.camera) {
            this.animProgress += dt / 1.0; // Transition speed: 1.0 second total #WDD 2026-01-15
            if (this.animProgress >= 1) {
                this.animProgress = 1;
                this.isCameraAnimating = false;
                // Resume playback if it was playing before #WDD 2026-01-15
                if (this.wasPlayingBeforeAnim) {
                    v.togglePlay();
                    this.wasPlayingBeforeAnim = false;
                }
            }

            // Ease out cubic
            const t = 1 - Math.pow(1 - this.animProgress, 3);

            const currentPos = new pc.Vec3().lerp(this.animStartPos, this.animTargetPos, t);
            const currentPitch = pc.math.lerp(this.animStartPitch, this.animTargetPitch, t);
            const currentYaw = pc.math.lerp(this.animStartYaw, this.animTargetYaw, t);

            v.camera.setPosition(currentPos);
            v.camera.setEulerAngles(currentPitch, currentYaw, 0);
            v.pitch = currentPitch;
            v.yaw = currentYaw;

            // Update Transition Effect #WDD 2026-01-15
            const material = (v.splatEntity?.gsplat as any)?.instance?.material;
            if (material) {
                material.setParameter('uTime', v.currentTime);
                v.effects.update(this.animProgress, material);
            }
        } else {
            // Ensure effect is reset when not animating
            const material = (v.splatEntity?.gsplat as any)?.instance?.material;
            if (material) {
                v.effects.reset(material);
            }
        }
    }

    async recordPresetVideo() {
        const v = this.viewer as any;
        if (this.isRecordingPresetVideo || this.isPreviewingPresetPath) return;
        if (!v.camera || this.cameraPresets.length < 2) {
            this.setRecordStatus(t('preset.videoNeedPresets'));
            return;
        }

        const canvas = document.getElementById('application-canvas') as HTMLCanvasElement | null;
        const captureStream = canvas?.captureStream;
        if (!canvas || typeof captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
            this.setRecordStatus(t('preset.videoUnsupported'));
            return;
        }

        const mimeType = this.getSupportedVideoMimeType();
        if (!mimeType) {
            this.setRecordStatus(t('preset.videoUnsupported'));
            return;
        }

        this.isCameraAnimating = false;
        this.wasPlayingBeforeAnim = v.isPlaying;
        if (this.wasPlayingBeforeAnim) {
            this.seekViewerToFirstFrame();
        }

        this.recordedChunks = [];
        this.recordSegmentIndex = 0;
        this.recordSegmentProgress = 0;
        this.currentPresetIndex = 0;
        this.applyPresetCamera(this.cameraPresets[0]);
        this.syncPresetPathButtons();
        this.setRecordStatus(t('preset.videoRecording'));

        // #WDD-gpt 2026-06-18 - 直接录制 PlayCanvas canvas 输出，避免额外离屏渲染路径和 WebGL readPixels 带来的卡顿
        this.recordingStream = canvas.captureStream(this.recordFrameRate);
        this.mediaRecorder = new MediaRecorder(this.recordingStream, {
            mimeType,
            videoBitsPerSecond: 12_000_000
        });
        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) this.recordedChunks.push(event.data);
        };
        this.mediaRecorder.onstop = () => this.finishPresetVideoRecording(mimeType);
        this.mediaRecorder.start(250);
        this.isRecordingPresetVideo = true;
    }

    previewPresetAnimation() {
        const v = this.viewer as any;
        if (this.isRecordingPresetVideo || this.isPreviewingPresetPath) return;
        if (!v.camera || this.cameraPresets.length < 2) {
            this.setRecordStatus(t('preset.videoNeedPresets'));
            return;
        }

        this.isCameraAnimating = false;
        this.wasPlayingBeforeAnim = v.isPlaying;
        if (this.wasPlayingBeforeAnim) {
            this.seekViewerToFirstFrame();
        }
        this.recordSegmentIndex = 0;
        this.recordSegmentProgress = 0;
        this.currentPresetIndex = 0;
        this.applyPresetCamera(this.cameraPresets[0]);
        this.isPreviewingPresetPath = true;
        this.syncPresetPathButtons();
        this.setRecordStatus(t('preset.previewing'));
    }

    cancelPresetPathPlaybackForNewAsset() {
        if (!this.isRecordingPresetVideo && !this.isPreviewingPresetPath) {
            this.wasPlayingBeforeAnim = false;
            this.syncRecordAvailability();
            return;
        }

        // #WDD-gpt 2026-06-18 - 新模型加载前取消预览/录制路径，避免旧相机轨迹继续驱动新模型视图
        this.isPreviewingPresetPath = false;
        this.isRecordingPresetVideo = false;
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.onstop = null;
            this.mediaRecorder.stop();
        }
        this.mediaRecorder = null;
        this.recordingStream?.getTracks().forEach((track) => track.stop());
        this.recordingStream = null;
        this.recordedChunks = [];
        this.restoreRecordedPlaybackState();
        this.syncRecordAvailability();
    }

    private updatePresetPathAnimation(dt: number) {
        const v = this.viewer as any;
        if (!v.camera || this.cameraPresets.length < 2) {
            this.stopPresetPathAnimation();
            return;
        }

        const from = this.cameraPresets[this.recordSegmentIndex];
        const to = this.cameraPresets[this.recordSegmentIndex + 1];
        if (!from || !to) {
            this.stopPresetPathAnimation();
            return;
        }

        this.recordSegmentProgress += dt / this.recordSegmentDuration;
        const segmentT = Math.min(1, this.recordSegmentProgress);
        const easedT = segmentT * segmentT * (3 - 2 * segmentT);
        const pos = new pc.Vec3().lerp(from.pos, to.pos, easedT);
        const pitch = pc.math.lerp(from.pitch, to.pitch, easedT);
        const yaw = pc.math.lerp(from.yaw, to.yaw, easedT);

        v.camera.setPosition(pos);
        v.camera.setEulerAngles(pitch, yaw, 0);
        v.pitch = pitch;
        v.yaw = yaw;
        this.currentPresetIndex = this.recordSegmentIndex;

        const totalSegments = Math.max(1, this.cameraPresets.length - 1);
        const progress = (this.recordSegmentIndex + segmentT) / totalSegments;
        this.setRecordStatus(t(this.isRecordingPresetVideo ? 'preset.videoProgress' : 'preset.previewProgress', { percent: Math.round(progress * 100) }));

        if (segmentT < 1) return;
        this.recordSegmentIndex++;
        this.recordSegmentProgress = 0;
        if (this.recordSegmentIndex >= this.cameraPresets.length - 1) {
            this.currentPresetIndex = this.cameraPresets.length - 1;
            this.applyPresetCamera(this.cameraPresets[this.cameraPresets.length - 1]);
            this.stopPresetPathAnimation();
        }
    }

    private stopPresetPathAnimation() {
        const wasRecording = this.isRecordingPresetVideo;
        const wasPreviewing = this.isPreviewingPresetPath;
        this.isRecordingPresetVideo = false;
        this.isPreviewingPresetPath = false;
        if (wasRecording && this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        } else if (wasRecording) {
            this.finishPresetVideoRecording(this.getSupportedVideoMimeType() || 'video/webm');
        } else {
            this.restoreRecordedPlaybackState();
            this.syncPresetPathButtons();
            if (wasPreviewing) this.setRecordStatus(t('preset.previewDone'));
        }
    }

    private finishPresetVideoRecording(mimeType: string) {
        const v = this.viewer as any;
        this.isRecordingPresetVideo = false;
        this.isPreviewingPresetPath = false;
        this.syncPresetPathButtons();
        this.recordingStream?.getTracks().forEach((track) => track.stop());
        this.recordingStream = null;
        this.mediaRecorder = null;

        this.restoreRecordedPlaybackState();

        if (this.recordedChunks.length === 0) {
            this.setRecordStatus(t('preset.videoFailed'));
            return;
        }

        const blob = new Blob(this.recordedChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `camera-presets-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.setRecordStatus(t('preset.videoDone'));
    }

    private getSupportedVideoMimeType() {
        const candidates = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm'
        ];
        return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
    }

    private applyPresetCamera(preset: CameraPreset) {
        const v = this.viewer as any;
        if (!v.camera) return;
        v.camera.setPosition(preset.pos);
        v.camera.setEulerAngles(preset.pitch, preset.yaw, 0);
        v.pitch = preset.pitch;
        v.yaw = preset.yaw;
    }

    private seekViewerToFirstFrame() {
        const v = this.viewer as any;
        // #WDD-gpt 2026-06-18 - 录制前如果用户处于播放状态，动画时间线回到第 0 帧并继续播放，保持“播放中”状态不被录制流程暂停
        if (typeof v.seekToFrame === 'function') {
            v.seekToFrame(0, { pause: false });
        }
        v.currentTime = 0;
        v.playbackTime = 0;
        if (typeof v.syncTimelineUI === 'function') {
            v.syncTimelineUI(0);
        }
    }

    private restoreRecordedPlaybackState() {
        const v = this.viewer as any;
        if (!!v.isPlaying !== !!this.wasPlayingBeforeAnim && typeof v.togglePlay === 'function') {
            v.togglePlay();
        }
        this.wasPlayingBeforeAnim = false;
    }

    private setRecordStatus(text: string) {
        const status = document.getElementById('preset-record-status');
        if (status) status.textContent = text;
    }

    private syncPresetPathButtons() {
        const recordButton = document.getElementById('record-preset-video') as HTMLButtonElement | null;
        const previewButton = document.getElementById('preview-preset-animation') as HTMLButtonElement | null;
        const disabled = this.cameraPresets.length < 2 || this.isRecordingPresetVideo || this.isPreviewingPresetPath;
        if (recordButton) {
            recordButton.disabled = disabled;
            recordButton.classList.toggle('active', this.isRecordingPresetVideo);
        }
        if (previewButton) {
            previewButton.disabled = disabled;
            previewButton.classList.toggle('active', this.isPreviewingPresetPath);
        }
    }

    private syncRecordAvailability() {
        if (this.isRecordingPresetVideo || this.isPreviewingPresetPath) return;
        this.syncPresetPathButtons();
        this.setRecordStatus(t(this.cameraPresets.length < 2 ? 'preset.videoNeedPresets' : 'preset.videoReady'));
    }

    renderPresets() {
        const presetsList = document.getElementById('presets-list');
        if (!presetsList) return;
        presetsList.innerHTML = '';
        this.syncRecordAvailability();
        const v = this.viewer as any;
        this.cameraPresets.forEach((preset, index) => {
            const item = document.createElement('div');
            item.className = 'flex flex-col gap-1';

            const mainRow = document.createElement('div');
            mainRow.className = 'ui-item group justify-between py-1.5 px-2 cursor-grab active:cursor-grabbing';
            mainRow.setAttribute('draggable', 'true');
            mainRow.dataset.index = index.toString();

            mainRow.innerHTML = `
                <div class="flex items-center gap-2 overflow-hidden flex-1 cursor-pointer justify-between">
                    <div class="flex items-center gap-2 overflow-hidden">
                        <div class="ui-dot"></div>
                        <span class="preset-name text-[9px] ui-text-primary font-medium truncate">${preset.name}</span>
                    </div>
                    <svg viewBox="0 0 24 24" class="w-3 h-3 fill-current opacity-40 flex-shrink-0">
                        <path d="M7 10l5 5 5-5z"/>
                    </svg>
                </div>
                <div class="flex items-center gap-1">
                    <button class="add-text p-1 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:ui-text-highlight transition-all has-tooltip" aria-label="Add Text" data-tip="Text" data-i18n-aria-label="preset.text" data-i18n-data-tip="preset.text">
                        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                    </button>
                    <button class="delete-preset p-1 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-red-400 transition-all has-tooltip" aria-label="Delete Preset" data-tip="Delete" data-i18n-aria-label="preset.delete" data-i18n-data-tip="preset.delete">
                        <svg viewBox="0 0 24 24" class="w-3 h-3 fill-current"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
            `;
            applyI18n(mainRow);

            // --- Text Objects List for this preset #WDD 2026-01-15 ---
            const textObjectsList = document.createElement('div');
            textObjectsList.className = 'flex flex-col gap-0.5 ml-6 mb-1';
            if (preset.textObjects && preset.textObjects.length > 0) {
                preset.textObjects.forEach((textObj) => {
                    const textItem = document.createElement('div');
                    textItem.className = 'flex items-center justify-between group/text hover:bg-white/5 rounded px-1.5 py-0.5 cursor-pointer';
                    textItem.innerHTML = `
                        <span class="text-[8px] opacity-40 group-hover/text:opacity-100 truncate flex-1">${textObj.content || t('preset.empty')}</span>
                        <button class="delete-text p-0.5 opacity-0 group-hover/text:opacity-60 hover:!opacity-100 hover:text-red-400 transition-all has-tooltip" aria-label="Delete Text" data-tip="Delete" data-i18n-aria-label="preset.delete" data-i18n-data-tip="preset.delete">
                             <svg viewBox="0 0 24 24" class="w-2.5 h-2.5 fill-current"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </button>
                    `;
                    applyI18n(textItem);
                    textItem.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openTextEdit(textObj, index);
                    });
                    textItem.querySelector('.delete-text')?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        preset.textObjects = preset.textObjects?.filter(t => t.id !== textObj.id);
                        this.renderPresets();
                        this.syncTextOverlays();
                    });
                    textObjectsList.appendChild(textItem);
                });
            }

            item.appendChild(mainRow);
            item.appendChild(textObjectsList);

            // --- Rename Logic ---
            const nameSpan = mainRow.querySelector('.preset-name') as HTMLElement;
            nameSpan.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'text';
                input.value = preset.name;
                input.className = 'bg-black/50 border-none outline-none text-[9px] w-full ui-text-highlight px-1 rounded';

                const finishEdit = () => {
                    const newName = input.value.trim() || `CAM_${index + 1}`;
                    preset.name = newName;
                    this.renderPresets();
                };

                input.addEventListener('blur', finishEdit);
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') finishEdit();
                    if (e.key === 'Escape') this.renderPresets();
                });

                nameSpan.replaceWith(input);
                input.focus();
                input.select();
            });

            // --- Drag and Drop Logic ---
            mainRow.addEventListener('dragstart', (e) => {
                if (e.dataTransfer) {
                    e.dataTransfer.setData('text/plain', index.toString());
                    mainRow.classList.add('opacity-40');
                }
            });

            mainRow.addEventListener('dragend', () => {
                mainRow.classList.remove('opacity-40');
            });

            mainRow.addEventListener('dragover', (e) => {
                e.preventDefault();
                mainRow.classList.add('bg-white/5');
            });

            mainRow.addEventListener('dragleave', () => {
                mainRow.classList.remove('bg-white/5');
            });

            mainRow.addEventListener('drop', (e) => {
                e.preventDefault();
                mainRow.classList.remove('bg-white/5');
                const sourceIdx = parseInt(e.dataTransfer?.getData('text/plain') || '-1');
                if (sourceIdx !== -1 && sourceIdx !== index) {
                    const movedItem = this.cameraPresets.splice(sourceIdx, 1)[0];
                    this.cameraPresets.splice(index, 0, movedItem);
                    this.renderPresets();
                }
            });

            // Jump to preset
            mainRow.querySelector('.flex')?.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).tagName === 'INPUT') return;

                if (!v.camera) return;

                // --- Stop playback during animation #WDD 2026-01-15 ---
                this.wasPlayingBeforeAnim = v.isPlaying;
                if (v.isPlaying) {
                    v.togglePlay();
                }

                this.isCameraAnimating = true;
                this.animProgress = 0;
                this.animStartPos.copy(v.camera.getPosition());
                this.animStartPitch = v.pitch;
                this.animStartYaw = v.yaw;

                this.animTargetPos.copy(preset.pos);
                this.animTargetPitch = preset.pitch;
                this.animTargetYaw = preset.yaw;
            });

            // Add Text
            mainRow.querySelector('.add-text')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.addTextToPreset(index);
            });

            // Delete preset
            mainRow.querySelector('.delete-preset')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cameraPresets.splice(index, 1);
                this.renderPresets();
                this.syncTextOverlays();
            });

            presetsList.appendChild(item);
        });
    }

    // --- Text Object Management Methods #WDD 2026-01-15 ---

    addTextToPreset(index: number) {
        const preset = this.cameraPresets[index];
        if (!preset.textObjects) preset.textObjects = [];

        const id = `text_${Date.now()}`;
        const newText = {
            id: id,
            content: "New Annotation",
            font: "'Inter', sans-serif",
            fontSize: 24,
            color: "#ffffff",
            fontWeight: "normal",
            fontStyle: "normal",
            top: 50,
            left: 50
        };

        preset.textObjects.push(newText);
        this.renderPresets();
        this.syncTextOverlays();
        this.openTextEdit(newText, index);
    }

    openTextEdit(textObj: any, presetIndex: number) {
        this.activeTextId = textObj.id;
        const panel = document.getElementById('text-edit-panel');
        const contentArea = document.getElementById('text-edit-content') as HTMLTextAreaElement;
        const sizeSelect = document.getElementById('text-edit-size') as HTMLSelectElement;
        const colorInput = document.getElementById('text-edit-color') as HTMLInputElement;
        const fontSelect = document.getElementById('text-edit-font') as HTMLSelectElement;

        if (!panel || !contentArea || !sizeSelect || !colorInput || !fontSelect) return;

        contentArea.value = textObj.content;
        sizeSelect.value = textObj.fontSize.toString();
        colorInput.value = textObj.color;
        fontSelect.value = textObj.font;

        const boldBtn = document.getElementById('text-bold');
        const italicBtn = document.getElementById('text-italic');

        const updateStyleToggle = () => {
            if (boldBtn) boldBtn.classList.toggle('ui-text-highlight', textObj.fontWeight === 'bold');
            if (italicBtn) italicBtn.classList.toggle('ui-text-highlight', textObj.fontStyle === 'italic');
        };
        updateStyleToggle();

        panel.classList.add('show');

        // --- Dynamic Positioning near text obj #WDD 2026-01-15 ---
        const textEl = this.textOverlays.get(textObj.id);
        if (textEl) {
            const rect = textEl.getBoundingClientRect();
            let top = rect.bottom + 10;
            let left = rect.left;

            // Constrain to window
            const panelWidth = 288; // w-72
            const panelHeight = panel.offsetHeight || 300;
            if (left + panelWidth > window.innerWidth) left = window.innerWidth - panelWidth - 20;
            if (top + panelHeight > window.innerHeight) top = rect.top - panelHeight - 10;
            if (left < 10) left = 10;
            if (top < 10) top = 10;

            panel.style.top = `${top}px`;
            panel.style.left = `${left}px`;
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            panel.style.transform = 'scale(1)';
        }

        // --- Make Panel Draggable #WDD 2026-01-15 ---
        const header = panel.querySelector('.flex.items-center.justify-between');
        if (header) {
            (header as HTMLElement).style.cursor = 'move';
            let isDragging = false;
            let startX = 0, startY = 0;
            let initialTop = 0, initialLeft = 0;

            const onMouseDown = (e: MouseEvent) => {
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                initialTop = panel.offsetTop;
                initialLeft = panel.offsetLeft;
                e.preventDefault();
            };

            const onMouseMove = (e: MouseEvent) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                panel.style.top = `${initialTop + dy}px`;
                panel.style.left = `${initialLeft + dx}px`;
            };

            const onMouseUp = () => { isDragging = false; };

            header.addEventListener('mousedown', onMouseDown as any);
            window.addEventListener('mousemove', onMouseMove as any);
            window.addEventListener('mouseup', onMouseUp as any);
        }

        // Update handlers
        const updateText = () => {
            if (this.activeTextId !== textObj.id) return;
            textObj.content = contentArea.value;
            textObj.fontSize = parseInt(sizeSelect.value) || 24;
            textObj.color = colorInput.value;
            textObj.font = fontSelect.value;

            this.renderPresets();
            this.syncTextOverlays();
        };

        contentArea.oninput = updateText;
        sizeSelect.onchange = updateText;
        colorInput.oninput = updateText;
        fontSelect.onchange = updateText;

        if (boldBtn) {
            boldBtn.onclick = () => {
                textObj.fontWeight = textObj.fontWeight === 'bold' ? 'normal' : 'bold';
                updateStyleToggle();
                updateText();
            };
        }
        if (italicBtn) {
            italicBtn.onclick = () => {
                textObj.fontStyle = textObj.fontStyle === 'italic' ? 'normal' : 'italic';
                updateStyleToggle();
                updateText();
            };
        }

        const deleteBtn = document.getElementById('delete-text-obj');
        if (deleteBtn) {
            deleteBtn.onclick = () => {
                const preset = this.cameraPresets[presetIndex];
                preset.textObjects = preset.textObjects?.filter(t => t.id !== textObj.id);
                this.closeTextEdit();
                this.renderPresets();
                this.syncTextOverlays();
            };
        }
    }

    closeTextEdit() {
        this.activeTextId = null;
        document.getElementById('text-edit-panel')?.classList.remove('show');
    }

    syncTextOverlays() {
        const container = document.getElementById('text-overlay-container');
        if (!container) return;

        // Collect all text objects across all presets
        const allTextObjects: { text: any, preset: any }[] = [];
        this.cameraPresets.forEach(preset => {
            if (preset.textObjects) {
                preset.textObjects.forEach(t => allTextObjects.push({ text: t, preset }));
            }
        });

        // Remove old ones that no longer exist
        this.textOverlays.forEach((el, id) => {
            if (!allTextObjects.find(o => o.text.id === id)) {
                el.remove();
                this.textOverlays.delete(id);
            }
        });

        // Create or update
        allTextObjects.forEach(({ text, preset }) => {
            let el = this.textOverlays.get(text.id);
            if (!el) {
                el = document.createElement('div');
                el.className = 'text-object';
                el.id = text.id;
                container.appendChild(el);
                this.textOverlays.set(text.id, el);

                // Make draggable in screen space
                let isDragging = false;
                el.addEventListener('mousedown', (e) => {
                    isDragging = true;
                    this.openTextEdit(text, this.cameraPresets.indexOf(preset));
                    e.stopPropagation();
                });
                window.addEventListener('mousemove', (e) => {
                    if (isDragging && el) {
                        const top = (e.clientY / window.innerHeight) * 100;
                        const left = (e.clientX / window.innerWidth) * 100;
                        text.top = top;
                        text.left = left;
                        el.style.top = `${top}%`;
                        el.style.left = `${left}%`;
                    }
                });
                window.addEventListener('mouseup', () => { isDragging = false; });
            }

            el.innerText = text.content;
            el.style.fontFamily = text.font;
            el.style.fontSize = `${text.fontSize}px`;
            el.style.color = text.color;
            el.style.fontWeight = text.fontWeight;
            el.style.fontStyle = text.fontStyle;
            el.style.top = `${text.top}%`;
            el.style.left = `${text.left}%`;

            if (this.activeTextId === text.id) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
    }

    updateTextVisibility() {
        const v = this.viewer as any;
        if (!v.camera) return;
        const camPos = v.camera.getPosition();

        this.cameraPresets.forEach(preset => {
            if (!preset.textObjects) return;

            // Distance-based fade #WDD 2026-01-15
            const dist = camPos.distance(preset.pos);
            const fadeStart = 0.5;
            const fadeEnd = 3.0;
            let opacity = 1.0 - (dist - fadeStart) / (fadeEnd - fadeStart);
            opacity = Math.max(0, Math.min(1, opacity));

            preset.textObjects.forEach(textObj => {
                const el = this.textOverlays.get(textObj.id);
                if (el) {
                    el.style.opacity = opacity.toString();
                    el.style.pointerEvents = opacity > 0.1 ? 'auto' : 'none';
                    el.style.display = opacity > 0 ? 'block' : 'none';
                }
            });
        });
    }

    jumpToPreset(index: number) {
        const v = this.viewer as any;
        if (index < 0 || index >= this.cameraPresets.length) return;
        this.currentPresetIndex = index;
        const preset = this.cameraPresets[index];
        if (!v.camera) return;

        // --- Stop playback during animation #WDD 2026-01-15 ---
        this.wasPlayingBeforeAnim = v.isPlaying;
        if (v.isPlaying) {
            v.togglePlay();
        }

        this.isCameraAnimating = true;
        this.animProgress = 0;
        this.animStartPos.copy(v.camera.getPosition());
        this.animStartPitch = v.pitch;
        this.animStartYaw = v.yaw;

        this.animTargetPos.copy(preset.pos);
        this.animTargetPitch = preset.pitch;
        this.animTargetYaw = preset.yaw;
    }
}
