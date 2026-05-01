import re

with open('src/viewer/viewer-export-manager.ts', 'r') as f:
    text = f.read()

# Define the entire saveAsSOG4 method clearly
new_save_as_sog4 = """
    async saveAsSOG4() {
        const v = this.viewer as any;
        if (!v.lastParsedData) {
            alert("No data loaded.");
            return;
        }

        const abortController = new AbortController();
        const cancelBtn = document.getElementById('loading-cancel');
        const overlay = document.getElementById('loading-overlay');
        const statusEl = document.getElementById('loading-status');
        const detailEl = document.getElementById('loading-detail');
        const bar = document.getElementById('loading-step-progress');
        const substepsEl = document.getElementById('loading-substeps');
        const squares = Array.from(document.querySelectorAll('.step-square'));

        const resetSubsteps = () => {
            if (!substepsEl) return;
            substepsEl.innerHTML = '';
            substepsEl.classList.add('hidden');
            substepsEl.classList.remove('flex');
        };

        const setExportProgress = (pct: number, detail: string, meta?: SOG4EncodeProgressMeta) => {
            overlay?.classList.remove('hidden');
            if (statusEl) statusEl.innerText = 'EXPORTING SOG4';
            if (detailEl) detailEl.innerText = detail || '';
            if (bar) bar.style.width = `${Math.min(Math.max(pct, 0), 100)}%`;
            const stepMax = Math.max(squares.length - 1, 1);
            const step = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * stepMax);
            squares.forEach((square, idx) => {
                if (idx <= step) square.classList.add('reached');
                else square.classList.remove('reached');
            });
            if (meta?.stageId) {
                // Simplified: only show active
                substepsEl?.querySelectorAll('.loading-substep').forEach(row => {
                    if ((row as HTMLElement).dataset.stepId === meta.stageId) {
                        row.classList.remove('hidden');
                        row.classList.add('flex');
                        const fill = row.querySelector('.loading-substep-fill') as HTMLElement;
                        const pctTxt = row.querySelector('.font-mono') as HTMLElement;
                        const detTxt = row.querySelectorAll('div')[2] as HTMLElement;
                        if (fill) fill.style.width = `${meta.stagePct}%`;
                        if (pctTxt) pctTxt.innerText = `${Math.round(meta.stagePct || 0)}%`;
                        if (detTxt) detTxt.innerText = meta.detail || detail;
                    } else {
                        row.classList.remove('flex');
                        row.classList.add('hidden');
                    }
                });
            }
        };

        const initializeSubsteps = () => {
            if (!substepsEl) return;
            substepsEl.innerHTML = '';
            substepsEl.classList.remove('hidden');
            substepsEl.classList.add('flex');
            
            const propertyNames = v.lastParsedData?.plyData?.elements?.[0]?.properties?.map((prop: any) => prop.name) || [];
            const hasShn = propertyNames.some((name: string) => /^f_rest_\\d+$/.test(name));
            
            [
                { id: 'prepare', label: 'Prepare Export' },
                { id: 'filter', label: 'Filter Deleted' },
                { id: 'means', label: 'Means (XYZ)' },
                { id: 'rotations', label: 'Rotations' },
                { id: 'scales_opacity', label: 'Scales & Opacity' },
                { id: 'shn', label: 'SHN Palette', enabled: hasShn },
                { id: 'params', label: 'Params' },
                { id: 'zip', label: 'Package ZIP' },
                { id: 'finalize', label: 'Finalize Download' }
            ].forEach(step => {
                if (step.enabled === false) return;
                const row = document.createElement('div');
                row.className = 'loading-substep hidden flex-col gap-1 rounded-lg px-3 py-2';
                row.dataset.stepId = step.id;
                row.innerHTML = `
                    <div class="flex items-center justify-between gap-3">
                        <div class="text-[9px] font-bold uppercase tracking-[0.18rem] ui-text-primary">${step.label}</div>
                        <div class="text-[9px] font-mono uppercase ui-text-secondary opacity-80">0%</div>
                    </div>
                    <div class="text-[8px] font-mono uppercase tracking-tight ui-text-secondary opacity-60">Pending</div>
                    <div class="loading-substep-bar h-[4px] rounded-full overflow-hidden bg-white/5">
                        <div class="loading-substep-fill h-full rounded-full bg-emerald-500 transition-all duration-200" style="width: 0%"></div>
                    </div>
                `;
                substepsEl.appendChild(row);
            });
        };

        try {
            if (cancelBtn) {
                cancelBtn.classList.remove('hidden');
                cancelBtn.onclick = () => abortController.abort();
            }
            initializeSubsteps();
            
            const transform = this.resolveExportModelTransform();
            const cameras = (v.presetManager?.cameraPresets || []).map((c: any) => ({
                name: c.name, pos: [c.pos.x, c.pos.y, c.pos.z], pitch: c.pitch, yaw: c.yaw, textObjects: c.textObjects
            }));

            const deletedIndices = [];
            if (v.selectionTool?.selectionData) {
                const selData = v.selectionTool.selectionData;
                for (let i = 0; i < selData.length / 4; i++) {
                    if (selData[i * 4 + 1] > 0) deletedIndices.push(i);
                }
            }

            const encodeOverrides: any = {
                model_transform: transform,
                cameras: cameras,
                apply_deleted: deletedIndices.length > 0,
                deleted_indices: deletedIndices,
                postProcessing: {
                    exposure: v.postProcessingTool.exposure,
                    brightness: v.postProcessingTool.brightness,
                    contrast: v.postProcessingTool.contrast
                }
            };

            const buffer = await SOG4Encoder.encode(v.lastParsedData, encodeOverrides, {
                mode: 'standard',
                signal: abortController.signal,
                progress: (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => {
                    setExportProgress(8 + (pct * 0.84), msg, meta);
                }
            });

            const filename = `saved_${(v.currentFileName || 'model').replace(/\\.[^/.]+$/, "")}.sog4`;
            const blob = new Blob([buffer], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);

            setExportProgress(100, 'Done');
        } catch (e: any) {
            if (e.message === "Export cancelled" || abortController.signal.aborted) {
                console.log("[Export] SOG4 Export cancelled.");
            } else {
                console.error("[Export] SOG4 Save failed:", e);
                alert("Save failed: " + e.message);
            }
        } finally {
            if (cancelBtn) cancelBtn.classList.add('hidden');
            setTimeout(() => {
                overlay?.classList.add('hidden');
                resetSubsteps();
            }, 1000);
        }
    }
"""

text = re.sub(r'async saveAsSOG4\(\) \{.*? async saveAsPLY4Sequence', 'async saveAsSOG4() {' + new_save_as_sog4 + '\\n\\n    async saveAsPLY4Sequence', text, flags=re.DOTALL)

with open('src/viewer/viewer-export-manager.ts', 'w') as f:
    f.write(text)
