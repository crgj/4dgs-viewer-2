import * as pc from 'playcanvas';
import { PlyExporter } from '../utils/ply-exporter';
import { TrueSplatsLoader } from '../utils/truesplats-loader';
import { SOG4Encoder, type SOG4EncodeProgressMeta } from '../utils/sog4-encoder-wrapper';
import { PLY4Encoder } from '../utils/ply4-encoder';
import {
    chooseExportModelTransform,
    cloneModelTransform,
    DEFAULT_MODEL_TRANSFORM,
    normalizeLegacyModelTransform,
    normalizeModelTransform,
    type ModelTransform
} from '../utils/model-transform';
import type { Viewer } from '../main';
import type { CameraPreset } from '../types/viewer';

/**
 * #WDD 2026-04-20: Extracted from Viewer to reduce main.ts size.
 * Handles all export operations (PLY, TrueSplats, PLY4, SOG4).
 */
export class ViewerExportManager {
    constructor(private viewer: Viewer) {}

    public async exportPlySequence() {
        const v = this.viewer as any;
        if (!v.splatEntity || !v.splatEntity.gsplat) {
            alert("No Splat loaded to export!");
            return;
        }

        const component = v.splatEntity.gsplat as any;
        const asset = component.asset;
        if (!asset || !asset.resource) return;

        const resource = asset.resource as pc.GSplatResource;
        const splatData = resource.splatData;

        const data: any = {
            count: splatData.numSplats,
            plyData: { elements: [{ properties: [] }] },
        };

        const elem = (splatData as any).elements[0];
        data.plyData.elements[0] = elem;

        if (v.is4DGS) {
            data.is4DGS = true;
            data.keyframes = v.keyframes;
            data.rotKeyframes = v.rotKeyframes;
            data.xyzStride = v.xyzStride;
            data.rotStride = v.rotStride;
            data.trajectory = v.trajectoryData;
            data.rotTrajectory = v.rotTrajectoryData;
            data.lifetime_mu = splatData.getProp('lifetime_mu');
            data.lifetime_w = splatData.getProp('lifetime_w');
            data.lifetime_k = splatData.getProp('lifetime_k');
        }

        const totalFrames = v.totalFrames || Math.ceil(v.duration);
        await PlyExporter.exportSequence(data, totalFrames, `sequence_${v.currentFileName}`);
    }

    private async exportCurrentFrameToPly() {
        const v = this.viewer as any;
        if (!v.lastParsedData || !v.lifeTexData || !v.scalesTexData) {
            console.error("[Export] Cannot export: metadata or textures missing.", {
                parsed: !!v.lastParsedData,
                life: !!v.lifeTexData,
                scales: !!v.scalesTexData
            });
            alert("No 4DGS data loaded for texture export. (Is it 4DGS?)");
            return;
        }

        console.log(`[Export] Reconstructing frame ${v.currentTime.toFixed(2)} from textures...`);
        const component = (v.splatEntity?.gsplat || (v as any).splatComponent) as any;
        if (!component) {
            console.error("[Export] No GSplatComponent found on entity.");
            alert("No GSplatComponent found. Please ensure a splat is loaded.");
            return;
        }

        const asset = component.asset;
        const resource = (asset?.resource || (component as any).instance?.splatData?._resource) as any;
        const splatData = resource?.splatData || component.instance?.splatData || (v.lastParsedData as any);

        if (!splatData && !v.lastParsedData) {
            console.error("[Export] SplatData not found.", { resource: !!resource, instance: !!component.instance });
            alert("SplatData not found for export.");
            return;
        }

        const numSplats = splatData.numSplats || v.lastParsedData.count;

        const params = {
            keyframes: v.keyframes,
            xyzStride: v.xyzStride,
            rotKeyframes: v.rotKeyframes,
            rotStride: v.rotStride,
            dcKeyframes: v.dcKeyframes,
            dcStride: v.dcStride,
            texWidth: 4096
        };

        const exportSource = {
            getProp: (name: string) => splatData.getProp(name),
            originalIndices: v.originalIndices,
            opacitySemantic: v.lastParsedData.opacitySemantic,
            rotationSemantic: v.lastParsedData.rotationSemantic
        };

        const buffer = await PlyExporter.exportFrameFromTextures(
            numSplats,
            v.currentTime,
            v.duration,
            v.lifeTexData!,
            v.trajectoryData!,
            v.rotTrajectoryData!,
            v.dcTrajectoryData!,
            v.scalesTexData,
            params,
            exportSource
        );

        const filename = `gpu_reconstruct_${v.currentFileName}_f${v.currentTime.toFixed(1)}.ply`;
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        console.log(`[Export] Saved: ${filename}`);
    }

    private captureCurrentEntityModelTransform(): ModelTransform {
        const v = this.viewer as any;
        if (!v.splatEntity) return cloneModelTransform(DEFAULT_MODEL_TRANSFORM);
        const p = v.splatEntity.getLocalPosition();
        const r = v.splatEntity.getLocalRotation();
        const s = v.splatEntity.getLocalScale();
        return {
            pos: [p.x, p.y, p.z],
            rot: [r.x, r.y, r.z, r.w],
            scale: [s.x, s.y, s.z]
        };
    }

    public rememberLoadedModelTransform(parsed: any) {
        const v = this.viewer as any;
        v.sourceModelTransform =
            normalizeModelTransform(parsed?.model_transform) ||
            normalizeLegacyModelTransform(parsed?.meta);
        v.modelTransformEdited = false;
    }

    private resolveExportModelTransform(): ModelTransform {
        const v = this.viewer as any;
        const entityTransform = this.captureCurrentEntityModelTransform();
        const preserveSource = !!(v.lastParsedData?.isSOG4 && v.sourceModelTransform && !v.modelTransformEdited);
        if (preserveSource) {
            console.log('[Export] Preserving original SOG4 model_transform to avoid coordinate-system drift.', {
                source: v.sourceModelTransform,
                entity: entityTransform
            });
        }
        return chooseExportModelTransform({
            entityTransform,
            sourceTransform: v.sourceModelTransform,
            preserveSource
        });
    }

    async saveAsTrueSplats() {
        const v = this.viewer as any;
        if (!v.lastParsedData) {
            console.error("[Export] No data loaded.");
            return;
        }

        console.log(`[Export] Saving .truesplats...`);
        try {
            const transform = this.resolveExportModelTransform();

            const cameras = v.cameraPresets.map((c: CameraPreset) => ({
                name: c.name,
                pos: [c.pos.x, c.pos.y, c.pos.z],
                pitch: c.pitch,
                yaw: c.yaw,
                textObjects: c.textObjects
            }));

            const deletedIndices: number[] = [];
            if (v.selectionTool.selectionData) {
                const selData = v.selectionTool.selectionData;
                const numSplats = selData.length / 4;
                for (let i = 0; i < numSplats; i++) {
                    if (selData[i * 4 + 1] > 0) {
                        deletedIndices.push(i);
                    }
                }
            }

            const buffer = await TrueSplatsLoader.save(v.lastParsedData, {
                model_transform: transform,
                cameras: cameras,
                deleted_indices: deletedIndices,
                apply_deleted: true
            });
            const baseName = (v.currentFileName || 'model').replace(/\.[^/.]+$/, "");
            const filename = `saved_${baseName}.truesplats`;

            const blob = new Blob([buffer], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            console.log(`[Export] Saved .truesplats: ${filename}`);
        } catch (e: any) {
            console.error("[Export] Save failed:", e);
            alert("Save failed: " + e.message);
        }
    }

    async saveAsPLY4() {
        const v = this.viewer as any;
        console.log("[Export] saveAsPLY4 called. LastParsed:", v.lastParsedData);
        if (!v.lastParsedData) {
            alert("No data loaded.");
            return;
        }

        try {
            const overlay = document.getElementById('loading-overlay');
            const statusEl = document.getElementById('loading-status');
            const detailEl = document.getElementById('loading-detail');
            const bar = document.getElementById('loading-step-progress');
            const squares = Array.from(document.querySelectorAll('.step-square'));

            const setExportProgress = (pct: number, detail: string) => {
                overlay?.classList.remove('hidden');
                if (statusEl) statusEl.innerText = 'EXPORTING PLY4';
                if (detailEl) detailEl.innerText = detail || '';
                if (bar) bar.style.width = `${Math.min(Math.max(pct, 0), 100)}%`;
                const stepMax = Math.max(squares.length - 1, 1);
                const step = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * stepMax);
                squares.forEach((square, idx) => {
                    if (idx <= step) square.classList.add('reached');
                    else square.classList.remove('reached');
                });
            };

            setExportProgress(5, 'Encoding PLY4 binary...');

            const encodeOverrides = {
                selectionData: v.selectionTool?.selectionData,
                model_pos: v.splatEntity?.getLocalPosition(),
                model_rot: v.splatEntity?.getLocalRotation(),
                model_scale: v.splatEntity?.getLocalScale()
            };

            const buffer = await PLY4Encoder.encode(v.lastParsedData, encodeOverrides, (pct, msg) => {
                setExportProgress(10 + pct * 0.85, msg);
            });

            const baseName = (v.currentFileName || 'model').replace(/\.[^/.]+$/, "");
            const filename = `saved_${baseName}.ply4`;

            const blob = new Blob([buffer], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();

            setExportProgress(100, 'Export Complete');

        } catch (err) {
            console.error(err);
            alert("PLY4 Export failed: " + err);
        } finally {
            setTimeout(() => {
                const overlay = document.getElementById('loading-overlay');
                if (overlay) overlay.classList.add('hidden');
            }, 1000);
        }
    }

    async saveAsSOG4() {
        const v = this.viewer as any;
        console.log("[Export] saveAsSOG4 called. LastParsed:", v.lastParsedData);
        if (!v.lastParsedData) {
            alert("No data loaded.");
            return;
        }

        console.log(`[Export] Saving .sog4...`);
        try {
            const overlay = document.getElementById('loading-overlay');
            const statusEl = document.getElementById('loading-status');
            const detailEl = document.getElementById('loading-detail');
            const bar = document.getElementById('loading-step-progress');
            const substepsEl = document.getElementById('loading-substeps');
            const squares = Array.from(document.querySelectorAll('.step-square'));
            const propertyNames = v.lastParsedData?.plyData?.elements?.[0]?.properties?.map((prop: any) => prop.name) || [];
            const hasShn = propertyNames.some((name: string) => /^f_rest_\d+$/.test(name)) ||
                Object.keys(v.lastParsedData || {}).some((name) => /^f_rest_\d+$/.test(name));
            const hasXyzBank = Boolean(
                (v.lastParsedData?.keyframes > 0 && v.lastParsedData?.trajectory) ||
                v.lastParsedData?.xyzBank
            );
            const hasColorBank = Boolean(v.lastParsedData?.dcKeyframes > 0 && v.lastParsedData?.dcTrajectory);
            const hasRotationBank = Boolean(
                (v.lastParsedData?.rotKeyframes > 0 && v.lastParsedData?.rotTrajectory) ||
                v.lastParsedData?.rotBank
            );
            const hasParams = Boolean(v.lastParsedData?.lifetime_mu && v.lastParsedData?.lifetime_w);
            const stepDefinitions = [
                { id: 'prepare', label: 'Prepare Export', enabled: true },
                { id: 'filter', label: 'Filter Deleted', enabled: true },
                { id: 'means', label: 'Means (XYZ)', enabled: true },
                { id: 'rotations', label: 'Rotations', enabled: true },
                { id: 'scales_opacity', label: 'Scales & Opacity', enabled: true },
                { id: 'shn', label: 'SHN Palette', enabled: hasShn },
                { id: 'xyz_bank', label: 'XYZ Bank', enabled: hasXyzBank },
                { id: 'color_bank', label: 'Color Bank', enabled: hasColorBank },
                { id: 'rotation_bank', label: 'Rotation Bank', enabled: hasRotationBank },
                { id: 'params', label: 'Params', enabled: hasParams },
                { id: 'zip', label: 'Package ZIP', enabled: true },
                { id: 'finalize', label: 'Finalize Download', enabled: true }
            ].filter((step) => step.enabled);
            const stepNodes = new Map<string, {
                row: HTMLDivElement;
                detail: HTMLDivElement;
                pct: HTMLDivElement;
                fill: HTMLDivElement;
            }>();
            const resetSubsteps = () => {
                if (!substepsEl) return;
                substepsEl.innerHTML = '';
                substepsEl.classList.add('hidden');
                substepsEl.classList.remove('flex');
                stepNodes.clear();
            };
            const initializeSubsteps = () => {
                if (!substepsEl) return;
                substepsEl.innerHTML = '';
                substepsEl.classList.remove('hidden');
                substepsEl.classList.add('flex');
                stepDefinitions.forEach((step) => {
                    const row = document.createElement('div');
                    row.className = 'loading-substep rounded-lg px-3 py-2 hidden flex-col gap-1';
                    row.dataset.stepId = step.id;

                    const header = document.createElement('div');
                    header.className = 'flex items-center justify-between gap-3';

                    const label = document.createElement('div');
                    label.className = 'text-[9px] font-bold uppercase tracking-[0.18rem] ui-text-primary';
                    label.innerText = step.label;

                    const pct = document.createElement('div');
                    pct.className = 'text-[9px] font-mono uppercase ui-text-secondary opacity-80';
                    pct.innerText = '0%';

                    header.appendChild(label);
                    header.appendChild(pct);

                    const detail = document.createElement('div');
                    detail.className = 'text-[8px] font-mono uppercase tracking-tight ui-text-secondary opacity-60';
                    detail.innerText = 'Pending';

                    const barWrap = document.createElement('div');
                    barWrap.className = 'loading-substep-bar h-[4px] rounded-full overflow-hidden';

                    const fill = document.createElement('div');
                    fill.className = 'loading-substep-fill h-full rounded-full transition-all duration-200';
                    fill.style.width = '0%';

                    barWrap.appendChild(fill);
                    row.appendChild(header);
                    row.appendChild(detail);
                    row.appendChild(barWrap);
                    substepsEl.appendChild(row);
                    stepNodes.set(step.id, { row, detail, pct, fill });
                });
            };
            const updateSubstep = (stepId: string, pctValue: number, detail: string, state: 'pending' | 'active' | 'done' = 'active') => {
                const node = stepNodes.get(stepId);
                if (!node) return;
                const clamped = Math.min(Math.max(pctValue, 0), 100);
                node.fill.style.width = `${clamped}%`;
                node.pct.innerText = `${Math.round(clamped)}%`;
                node.detail.innerText = detail || 'Working';
                node.row.classList.toggle('is-active', state === 'active');
                node.row.classList.toggle('is-done', state === 'done');
                
                if (state === 'active') {
                    node.row.classList.remove('hidden');
                    node.row.classList.add('flex');
                } else {
                    node.row.classList.remove('flex');
                    node.row.classList.add('hidden');
                }
            };
            const completeMissingIntermediateSteps = (currentStepId: string) => {
                const currentIndex = stepDefinitions.findIndex((step) => step.id === currentStepId);
                if (currentIndex <= 0) return;
                for (let i = 0; i < currentIndex; i++) {
                    const prev = stepDefinitions[i];
                    const node = stepNodes.get(prev.id);
                    if (!node) continue;
                    if (node.fill.style.width !== '100%') {
                        updateSubstep(prev.id, 100, 'Done', 'done');
                    }
                }
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
                    completeMissingIntermediateSteps(meta.stageId);
                    updateSubstep(
                        meta.stageId,
                        meta.stagePct,
                        meta.detail || detail,
                        meta.stagePct >= 100 ? 'done' : 'active'
                    );
                }
            };

            initializeSubsteps();
            setExportProgress(0, 'Preparing export', {
                stageId: 'prepare',
                stageLabel: 'Prepare Export',
                stagePct: 0,
                overallPct: 0,
                detail: 'Collecting export inputs'
            });

            const transform = this.resolveExportModelTransform();

            const cameras = v.cameraPresets.map((c: CameraPreset) => ({
                name: c.name, pos: [c.pos.x, c.pos.y, c.pos.z], pitch: c.pitch, yaw: c.yaw,
                textObjects: c.textObjects
            }));

            const deletedIndices: number[] = [];
            if (v.selectionTool.selectionData) {
                const selData = v.selectionTool.selectionData;
                const numSplats = selData.length / 4;
                for (let i = 0; i < numSplats; i++) {
                    if (selData[i * 4 + 1] > 0) deletedIndices.push(i);
                }
            }
            setExportProgress(5, `Deleted splats: ${deletedIndices.length}`, {
                stageId: 'prepare',
                stageLabel: 'Prepare Export',
                stagePct: 100,
                overallPct: 5,
                detail: `Transform, cameras, and source state ready`
            });
            setExportProgress(6, `Deleted splats: ${deletedIndices.length}`, {
                stageId: 'filter',
                stageLabel: 'Filter Deleted',
                stagePct: deletedIndices.length > 0 ? 10 : 100,
                overallPct: 6,
                detail: deletedIndices.length > 0
                    ? `Marked ${deletedIndices.length} deleted splats`
                    : 'No deleted splats'
            });

            const origIndices = v.originalIndices || v.lastParsedData?.original_index || undefined;
            const hasDeletes = deletedIndices.length > 0;
            let buffer: Uint8Array;

            const encodeOverrides: any = {
                rawFloatPayload: false,
                model_transform: transform,
                cameras: cameras,
                postProcessing: {
                    exposure: v.postProcessingTool.exposure,
                    brightness: v.postProcessingTool.brightness,
                    contrast: v.postProcessingTool.contrast
                }
            };
            if (hasDeletes) {
                encodeOverrides.apply_deleted = true;
                encodeOverrides.deleted_indices = deletedIndices;
                if (origIndices) encodeOverrides.original_indices = origIndices;
            }

            buffer = await SOG4Encoder.encode(v.lastParsedData, encodeOverrides, {
                mode: 'standard',
                progress: (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => {
                    setExportProgress(8 + (pct * 0.84), `Encoding: ${msg}`, meta ? {
                        ...meta,
                        overallPct: 8 + (pct * 0.84)
                    } : undefined);
                }
            });
            v.lastParsedData.sogBuffer = buffer;
            v.lastParsedData.isSOG4 = true;
            v.lastParsedData.needsSOG4Rewrite = false;
            setExportProgress(94, 'Final archive ready', {
                stageId: 'finalize',
                stageLabel: 'Finalize Download',
                stagePct: 40,
                overallPct: 94,
                detail: 'Preparing browser download'
            });
            const baseName = (v.currentFileName || 'model').replace(/\.[^/.]+$/, "");
            const filename = `saved_${baseName}.sog4`;

            const blob = new Blob([buffer.buffer as ArrayBuffer], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            console.log(`[Export] Saved .sog4: ${filename}`);
            setExportProgress(100, 'Export complete', {
                stageId: 'finalize',
                stageLabel: 'Finalize Download',
                stagePct: 100,
                overallPct: 100,
                detail: filename
            });
            setTimeout(() => {
                overlay?.classList.add('hidden');
                resetSubsteps();
            }, 600);
        } catch (e: any) {
            console.error("[Export] Save SOG4 failed:", e);
            alert("Save failed: " + e.message);
            document.getElementById('loading-overlay')?.classList.add('hidden');
            const substepsEl = document.getElementById('loading-substeps');
            if (substepsEl) {
                substepsEl.innerHTML = '';
                substepsEl.classList.add('hidden');
                substepsEl.classList.remove('flex');
            }
        }
    }
}
