import * as pc from 'playcanvas';
import { PlyExporter } from './utils/ply-exporter';
import { splatCoreVS, splatMainVS, splatMainPS } from './shaders/gsplat-shader';
import { sequenceSplatCoreVS, sequenceSplatMainVS, sequenceSplatMainPS } from './shaders/gsplat-sequence-shader';
import { canCompressVertexElementSH, compressVertexElementSHToLevel1, type PlyVertexElement } from './algorithms/sh-compression';
import { analyzeModelHealth, applyModelHealthAutoFix, type ModelHealthReport } from './algorithms/model-health';
import {
    buildNeverVisibleFlags,
    getPointEffectiveAlphaAtFrame,
    getRenderedBaseAlpha,
    NORMAL_RENDER_ALPHA_DISCARD
} from './algorithms/hidden-point-visibility';
import { Sam3WebClient, captureCanvasImageData, selectGaussianIndicesFromMask, type Sam3MaskResult } from './algorithms/sam3-web';

import { TrueSplatsLoader } from './utils/truesplats-loader';
import { SOG4Loader } from './utils/sog4-loader'; // #WDD 2026-01-18 SOG4 Support
import { PLY4Loader } from './utils/ply4-loader'; // #WDD 2026-01-21 PLY4 Support
import { SOGv2Loader } from './utils/sog-v2-loader'; // #WDD 2026-07-31 原始 PlayCanvas 官方 SOG v2 支持
import { SelectionTool } from './ui/selection-tool';
import { SmartSelectionTool } from './ui/smart-selection-tool';
import { GaussianEffects } from './particle-effects';
import { ARHandler } from './utils/ar-handler';
import { SkyboxManager } from './managers/skybox-manager'; // #WDD 2026-01-21
import { PostProcessingTool } from './ui/post-processing/post-processing-tool'; // #WDD 2026-01-30
import { Ply4RelightingController, ply4RelightingVS } from './rendering/ply4-relighting'; // #WDD-gpt 2026-07-31 - 接入独立 PLY4 重光照算法与 UI 状态
import { StereoViewController } from './rendering/stereo-view-controller'; // #WDD-gpt  2026-08-03 - 接入独立的左右分屏立体观看控制器
import { DynamicGsplatSorter } from './rendering/dynamic-gsplat-sorter'; // #WDD-gpt 2026-08-04 - 接入 4D 插值、活动集与排序合并 Worker
import { FaceTracker } from './utils/face-tracker'; // #WDD 2026-02-03
import { ViewerPresetManager } from './viewer/viewer-preset-manager';
import { ViewerFaceTrackingManager } from './viewer/viewer-face-tracking-manager';
import { ViewerFileLoader } from './viewer/viewer-file-loader';
import { SOG4Encoder, type SOG4EncodeProgressMeta } from './utils/sog4-encoder';
import { PLY4Encoder } from './utils/ply4-encoder'; // #WDD 2026-03-31
import { PerformanceMonitor } from './managers/performance-monitor'; // #WDD 2026-04-11 Performance
import { PerformancePanel } from './ui/performance-panel'; // #WDD 2026-04-11 Performance
import {
    chooseExportModelTransform,
    cloneModelTransform,
    DEFAULT_MODEL_TRANSFORM,
    normalizeLegacyModelTransform,
    normalizeModelTransform,
    type ModelTransform
} from './utils/model-transform';
import type { CameraPreset, SequenceFrameData, SplatSequence, SplatSequenceElement } from './types/viewer';
import { ViewerExportManager } from './viewer/viewer-export-manager';
import { ViewerTimelineManager } from './viewer/viewer-timeline-manager';
import { ViewerSceneManager } from './viewer/viewer-scene-manager';
import { ViewerFileInfoPanel } from './viewer/viewer-file-info-panel';
import { applyI18n, bindLanguageToggle, t } from './i18n';

type DebugNeverVisibleCache = {
    count: number;
    durationFrames: number;
    lifeTexData: Float32Array | null;
    opacity: Float32Array | null;
    opacitySemantic: string;
    flags: Uint8Array;
};

export class Viewer {
    app: pc.Application;
    camera: pc.Entity | null = null;
    splatEntity: pc.Entity | null = null;
    prevTime = 0;
    duration = 1.0;
    fps = 30; // Default playback fps
    currentFileName: string | null = null;
    currentFileSize: number | null = null;
    private currentTransformCacheKey: string | null = null;
    private sourceModelTransform: ModelTransform | null = null;
    private modelTransformEdited = false;
    originalFrames: number | null = null;
    private isPlaying = false;
    currentTime = 0;
    private playbackTime = 0;
    private currentPresetIndex = -1;

    // Cache for Selection Tool
    cachedPositions: Float32Array | null = null;
    selectionTool: SelectionTool;
    smartSelectionTool: SmartSelectionTool;
    arHandler: ARHandler;
    postProcessingTool: PostProcessingTool; // #WDD 2026-01-30
    private ply4Relighting: Ply4RelightingController;
    private stereoView: StereoViewController;
    private effects: GaussianEffects;
    private isHighQuality = true; // Used by adaptive quality fallback.
    private adaptiveQualityLevel = 0;
    private active4DSplatCount = 0;
    private renderActivityUntil = 0;
    private renderOnDemandReady = false;
    private readonly lastRenderedCameraMatrix = new Float32Array(16);

    private pitch = 0;
    private yaw = 0;
    private gridEntity: pc.Entity | null = null;
    private axesEntity: pc.Entity | null = null;

    // Mobile / Orbit Mode State
    private isOrbitMode = false; // If true, camera orbits 0,0,0
    private orbitDistance = 5.0; // Distance for orbit mode

    private skyboxManager: SkyboxManager; // #WDD 2026-01-21

    // #WDD 2026-04-11 Performance Monitor
    private performanceMonitor: PerformanceMonitor;
    private performancePanel: PerformancePanel;
    private simpleMemorySummaryTimer: number | null = null;
    private labHealthReport: ModelHealthReport | null = null;
    private sam3WebClient: Sam3WebClient | null = null;
    private sam3MaskResult: Sam3MaskResult | null = null;
    private sam3ModelReady = false;
    private sam3MaskPreviewVisible = false;
    private sam3LastUploadImage: ImageData | null = null;
    private readonly sam3ApiKeyStorageKey = '4dgs-viewer.sam3.roboflowApiKey';

    // Debugging #WDD 2026-01-15
    private swizzleMode = 1; // 0=yzwx, 1=xyzw, 2=wxyz
    private gaussianRenderMode = 0; // 0=normal, 1=center point, 2=ellipse outline, 3=debug all points
    private shLevel = 3;
    private debugAllPointsEntity: pc.Entity | null = null;
    private debugAllPointsSourceEntity: pc.Entity | null = null;
    private debugAllPointsCount = 0;
    private debugAllPointsFrame = -1;
    private debugAllPointsMaterial: pc.Material | null = null;
    private debugAllPointsColors: Float32Array | null = null;
    private readonly debugAllPointsSize = 6.0;
    private debugNeverVisibleCache: DebugNeverVisibleCache | null = null;

    private is4DGS = false;
    private trajectoryData: Float32Array | null = null;
    private trajectoryTexture: pc.Texture | null = null;
    private keyframes = 0;
    private xyzStride = 1;
    private rotTrajectoryData: Float32Array | null = null;
    private rotKeyframes = 0;
    private rotStride = 1;
    private totalFrames = 0;
    lifeTexData: Float32Array | null = null;
    private scalesTexData: Float32Array | null = null;
    private originalIndices: Float32Array | null = null; // #WDD 2026-01-17
    private lastParsedData: any = null;
    private hasLoggedSorterKeys: boolean = false;
    // #WDD 2026-03-31: Sort-Before-Render Synchronization
    private isWaitingForSort = false;
    private sortingTaskID = 0;
    private lastCompletedSortTaskID = 0;
    private pendingSortedFrame: number | null = null;
    private dynamicSorter: DynamicGsplatSorter | null = null;
    private dynamicSorterEpoch = 0;
    private assetLoadGeneration = 0;
    private debugAllPointsLastRefreshMs = 0;
    private timelinePlaybackLastSyncMs = 0;
    private readonly playbackTimelineSyncIntervalMs = 80;

    // --- Sequence Playback (static-per-frame) ---
    private isSequenceMode = false;
    private sequenceAssets: pc.Asset[] = [];
    private sequenceFrameIndex = -1;
    private sequenceBands = 0;
    private sequenceApplyTimer: number | null = null;
    private sequenceRequestId = 0;
    private sequenceDesiredFrameIndex = -1;
    private sequencePrefetchCount = 3; // number of frames to prebuild around the current frame
    private sequencePreloadAllMaxFrames = 200;
    private sequenceSwapWarmupRafCount = 2; // for very large frames, 1 RAF may still "blink" on first draw
    private sequenceEntityPool: pc.Entity[] = [];
    private sequenceFrameToEntity: Map<number, pc.Entity> = new Map();
    private sequenceEntityToFrame: Map<pc.Entity, number> = new Map();
    private sequencePrefetchInFlight: Set<number> = new Set();
    // Large splats can take multiple frames to become render-ready; reserve pool entities while building
    // so we don't reuse the same entity concurrently (which causes flicker/incorrect swaps).
    private sequenceReservedEntities: Set<pc.Entity> = new Set();
    private sequenceEntityBuildTarget: WeakMap<pc.Entity, number> = new WeakMap();
    private sequenceActiveEntity: pc.Entity | null = null;
    private sequenceSwapRaf: number | null = null;
    private sequencePendingSwapFrame: number | null = null;
    private sequencePendingSwapEntity: pc.Entity | null = null;
    private loopEnabled = false;
    private loopStartFrame = 0;
    private loopEndFrame = 0;

    // --- SOG4 Segment Sequence (temporal-per-segment) ---
    private isSog4SequenceMode = false;
    private sog4SequenceFiles: File[] = [];
    private sog4SequenceSegments: {
        name: string;
        parsed: any;
        asset: pc.Asset | null;
        entity: pc.Entity | null;
        duration: number;
        file?: File;
        header?: any;
    }[] = [];
    private sog4SequenceName: string | null = null;
    private sog4SequenceSharedTransform: { pos: number[]; rot: number[]; scale: number[] } | null = null;
    private sog4SequenceIndex = 0;
    private sog4SequenceTotalFrames = 0;
    private sog4SequenceOffsets: number[] = [];
    private sog4SequenceLoading = false;
    private sog4SequenceRequestId = 0;
    private ply4SequenceLoadMode: 'full' | 'segmented' = 'full';
    private readonly PLY4_SEGMENTED_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;
    private sequenceEditStates = new Map<number, { selectionData: Uint8Array | null; allTimeSelectionData: Uint8Array | null }>();
    private lazySegmentProgressEl: HTMLElement | null = null;
    private lazySegmentProgressBarEl: HTMLElement | null = null;
    private lazySegmentProgressTitleEl: HTMLElement | null = null;
    private lazySegmentProgressDetailEl: HTMLElement | null = null;
    private lazyBlockerEl: HTMLElement | null = null;
    private splatSequence: SplatSequence | null = null;

    private getSequenceParentEntity(): pc.Entity {
        if (this.arHandler && this.arHandler.isARRunning && this.arHandler.arAnchor) return this.arHandler.arAnchor;
        return this.app.root;
    }

    // Called by ARHandler after the AR anchor is created and the current splat is reparented.
    public onARStartedForSequence() {
        if (!this.isSequenceMode) return;
        if (!this.arHandler?.arAnchor) return;
        const anchor = this.arHandler.arAnchor;

        // Keep local placement identical across frames: copy from the current visible entity.
        const base = this.splatEntity;
        const basePos = base ? base.getLocalPosition().clone() : new pc.Vec3();
        const baseRot = base ? base.getLocalRotation().clone() : new pc.Quat();
        const baseScale = base ? base.getLocalScale().clone() : new pc.Vec3(1, 1, 1);

        for (const ent of this.sequenceEntityPool) {
            if (!ent) continue;
            // Move under anchor so it tracks the marker in AR.
            if (ent.parent !== anchor) ent.reparent(anchor);
            ent.setLocalPosition(basePos);
            ent.setLocalRotation(baseRot);
            ent.setLocalScale(baseScale);
        }
    }

    // Called by ARHandler before destroying the AR anchor so we don't lose hidden sequence entities.
    public onARStoppingForSequence(targetParent: pc.Entity) {
        if (!this.isSequenceMode) return;
        for (const ent of this.sequenceEntityPool) {
            if (!ent) continue;
            if (ent.parent !== targetParent) ent.reparent(targetParent);
        }
    }

    private shouldPreloadAllSequenceFrames(totalFrames: number): boolean {
        // Optional override: localStorage.setItem('sequence_preload_all', '1' | '0')
        const v = localStorage.getItem('sequence_preload_all');
        if (v === '1') return true;
        if (v === '0') return false;
        return totalFrames > 0 && totalFrames <= this.sequencePreloadAllMaxFrames;
    }

    private async waitForGsplatMaterial(ent: pc.Entity, shouldContinue: () => boolean, timeoutMs: number = 15000): Promise<any | null> {
        const start = performance.now();
        while (performance.now() - start < timeoutMs) {
            if (!shouldContinue()) return null;
            const inst = (ent.gsplat as any)?.instance;
            if (inst?.material) return inst;
            await new Promise((r) => setTimeout(r, 16));
        }
        return null;
    }

    private async waitForSequenceGsplatMaterial(ent: pc.Entity, timeoutMs: number = 15000): Promise<any | null> {
        return this.waitForGsplatMaterial(ent, () => this.isSequenceMode, timeoutMs);
    }

    private async waitRafs(count: number): Promise<void> {
        for (let i = 0; i < count; i++) {
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
    }

    constructor() {
        const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;
        if (!canvas) {
            console.error("Canvas element not found!");
            throw new Error("Canvas element not found!");
        }

        // --- Robust WebGL Initialization #WDD 2026-01-08 修复WebGL启动错误 ---
        const options: any = {
            mouse: new pc.Mouse(canvas),
            touch: new pc.TouchDevice(canvas),
            elementInput: new pc.ElementInput(canvas)
        };

        try {
            this.app = new pc.Application(canvas, {
                ...options,
                graphicsDeviceOptions: {
                    // #WDD-gpt 2026-08-04 - 高斯自身已执行屏幕空间低通，关闭 MSAA 以降低透明覆盖和立体双眼填充成本
                    antialias: false,
                    alpha: false,
                    // #WDD-gpt 2026-06-18 - 在线 SAM3 需要从 WebGL canvas 截图上传；关闭 preserveDrawingBuffer 会导致 drawImage 读到黑图
                    preserveDrawingBuffer: true,
                    powerPreference: 'high-performance'
                }
            });
        } catch (e) {
            console.warn("High-performance WebGL failed, retrying with defaults...", e);
            try {
                this.app = new pc.Application(canvas, options);
            } catch (e2) {
                console.error("Critical: WebGL not supported even with defaults.", e2);
                document.body.innerHTML = `< div style = "padding:20px; color:white; background:#222; font-family:sans-serif;" >
    <h2>WebGL Not Supported </h2>
        < p > This viewer requires WebGL.Please ensure your browser supports it and hardware acceleration is enabled.</p>
            </div>`;
                throw e2;
            }
        }

        this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
        this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
        this.app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, 2);


        window.addEventListener('resize', () => {
            this.app.resizeCanvas();
            this.requestRender(250);
        });

        this.setupScene();

        // Init Selection Tool
        this.selectionTool = new SelectionTool(this.app, this);
        this.smartSelectionTool = new SmartSelectionTool(this);
        this.effects = new GaussianEffects(this.app);
        this.skyboxManager = new SkyboxManager(this.app); // #WDD 2026-01-21
        this.arHandler = new ARHandler(this);
        this.ply4Relighting = new Ply4RelightingController(this.app); // #WDD-gpt 2026-07-31 - 初始化可关闭的 PLY4 重光照控制器
        this.stereoView = new StereoViewController(this.app, this.camera!, () => {
            this.selectionTool?.setTool('none');
        }, () => this.togglePlay(), () => this.isPlaying, () => {
            // #WDD-gpt 2026-08-04 - 立体模式双倍完整画幅渲染时重新应用像素比上限
            this.applyRenderPixelRatio();
            this.requestRender(500);
        });
        this.postProcessingTool = new PostProcessingTool(this.app, this.camera!.camera!, (settings) => {
            // #WDD-gpt 2026-08-04 - 颜色调整移到透明混合后的全屏通道，并同步到立体合成通道
            this.stereoView.setColorAdjustments(settings.brightness, settings.contrast, settings.exposure);
            this.requestRender(250);
        });

        // #WDD 2026-02-03 Face Tracker is initialized by ViewerFaceTrackingManager

        // #WDD 2026-04-11 Init Performance Monitor
        this.performanceMonitor = new PerformanceMonitor(this.app, {
            targetFPS: 30,
            adaptiveQuality: true,
            mobileDowngrade: true,
            largeModelMode: false,
            progressiveLoading: true,
            showWarnings: true
        });
        this.performancePanel = new PerformancePanel(this.performanceMonitor);

        // Expose the viewer/monitor for diagnostics panels and tooling.
        (window as any).viewer = this;
        (window as any).performanceMonitor = this.performanceMonitor;

        this.setupEventListeners();
        this.initSkyboxSelector(); // #WDD 2026-01-21

        // #WDD 2026-01-21 Mobile/Orbit Mode Detection
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
        if (isMobile) {
            this.isOrbitMode = true;
            document.body.classList.add('mobile-mode');
            // Ensure UI is in simple mode
            this.toggleUIVisibility(true);
        }

        this.app.start();
        this.setupRenderOnDemand();
        this.app.on('update', (dt: number) => {
            this.onUpdate(dt);
            this.updateRenderScheduling();
        });
        this.requestRender(1000);
    }

    updateToggleButton(btn: HTMLElement | null, active: boolean) {
        if (!btn) return;
        if (active) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    private destroyDebugAllPointsEntity() {
        if (this.debugAllPointsEntity) {
            this.debugAllPointsEntity.destroy();
            this.debugAllPointsEntity = null;
        }
        this.debugAllPointsSourceEntity = null;
        this.debugAllPointsCount = 0;
        this.debugAllPointsFrame = -1;
        this.debugAllPointsColors = null;
        this.debugNeverVisibleCache = null;
    }

    private setPrimarySplatVisibility(visible: boolean) {
        if (this.isSequenceMode) {
            if (visible) {
                const active = this.sequenceActiveEntity || this.splatEntity;
                if (active) active.enabled = true;
            } else {
                this.sequenceEntityPool.forEach((ent) => { ent.enabled = false; });
            }
            return;
        }

        if (this.isSog4SequenceMode) {
            if (visible) {
                this.setSog4SequenceVisibleSegment(this.sog4SequenceIndex);
            } else {
                this.sog4SequenceSegments.forEach((seg) => {
                    if (seg.entity) seg.entity.enabled = false;
                });
            }
            return;
        }

        if (this.splatEntity) this.splatEntity.enabled = visible;
    }

    private syncDebugAllPointsTransform(source: pc.Entity | null) {
        if (!source || !this.debugAllPointsEntity) return;
        const sourceParent = source.parent || this.app.root;
        if (this.debugAllPointsEntity.parent !== sourceParent) {
            sourceParent.addChild(this.debugAllPointsEntity);
        }
        this.debugAllPointsEntity.setLocalPosition(source.getLocalPosition());
        this.debugAllPointsEntity.setLocalRotation(source.getLocalRotation());
        this.debugAllPointsEntity.setLocalScale(source.getLocalScale());
    }

    private readDebugParsedProp(name: string): Float32Array | null {
        const parsed = this.lastParsedData;
        if (!parsed) return null;
        if (parsed[name] instanceof Float32Array) return parsed[name] as Float32Array;
        const props = parsed?.plyData?.elements?.[0]?.properties || [];
        const hit = props.find((p: any) => p?.name === name);
        return (hit?.storage as Float32Array) || null;
    }

    private getDebugParsedPositions(frame: number): Float32Array | null {
        const x = this.readDebugParsedProp('x');
        const y = this.readDebugParsedProp('y');
        const z = this.readDebugParsedProp('z');
        if (!x || !y || !z) return null;

        const count = Math.min(x.length, y.length, z.length);
        const positions = new Float32Array(count * 3);
        const trajectory = this.lastParsedData?.trajectory as Float32Array | null | undefined;
        const keyframes = Math.max(0, Math.floor(this.lastParsedData?.keyframes || this.keyframes || 0));
        const stride = Math.max(1, Math.floor(this.lastParsedData?.xyzStride || this.xyzStride || 1));

        if (trajectory && keyframes > 0 && trajectory.length >= count * keyframes * 3) {
            const keyframeMax = Math.max(0, (keyframes - 1) * stride);
            const maxTime = Math.max(0, Math.min(this.duration - 1, keyframeMax));
            const tClamped = Math.max(0, Math.min(frame, maxTime));
            const k0 = keyframes <= 1 ? 0 : Math.min(Math.floor(tClamped / stride), keyframes - 1);
            const k1 = keyframes <= 1 ? 0 : Math.min(k0 + 1, keyframes - 1);
            const t0 = k0 * stride;
            const t1 = k1 * stride;
            const ratio = (k0 === k1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));
            const origIndices = this.originalIndices || this.readDebugParsedProp('original_index');
            for (let i = 0; i < count; i++) {
                const oidx = origIndices ? Math.round(origIndices[i] || 0) : i;
                const base = oidx * keyframes * 3;
                const b0 = base + k0 * 3;
                const b1 = base + k1 * 3;
                positions[i * 3 + 0] = trajectory[b0 + 0] + (trajectory[b1 + 0] - trajectory[b0 + 0]) * ratio;
                positions[i * 3 + 1] = trajectory[b0 + 1] + (trajectory[b1 + 1] - trajectory[b0 + 1]) * ratio;
                positions[i * 3 + 2] = trajectory[b0 + 2] + (trajectory[b1 + 2] - trajectory[b0 + 2]) * ratio;
            }
            return positions;
        }

        for (let i = 0; i < count; i++) {
            positions[i * 3 + 0] = x[i];
            positions[i * 3 + 1] = y[i];
            positions[i * 3 + 2] = z[i];
        }
        return positions;
    }

    private getDebugAllPointsPositions(): Float32Array | null {
        const parsed = this.getDebugParsedPositions(Math.floor(this.currentTime));
        const current = this.getCurrentPositions();
        if (parsed && (!current || parsed.length > current.length)) return parsed;
        if (current && current.length >= 3) return current;
        if (parsed && parsed.length >= 3) return parsed;

        const splatData = (this.splatEntity?.gsplat as any)?.asset?.resource?.splatData
            || (this.splatEntity?.gsplat as any)?.instance?.splatData
            || null;
        const x = splatData?.getProp?.('x') as Float32Array | null;
        const y = splatData?.getProp?.('y') as Float32Array | null;
        const z = splatData?.getProp?.('z') as Float32Array | null;
        if (!x || !y || !z) return null;

        const count = Math.min(x.length, y.length, z.length);
        const positions = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            positions[i * 3 + 0] = x[i];
            positions[i * 3 + 1] = y[i];
            positions[i * 3 + 2] = z[i];
        }
        return positions;
    }

    private createDebugAllPointsMaterial(): pc.Material {
        const material = new pc.Material();
        material.shader = new pc.Shader(this.app.graphicsDevice, {
            name: 'DebugAllGaussianPointsShader',
            attributes: {
                vertex_position: pc.SEMANTIC_POSITION,
                vertex_color: pc.SEMANTIC_COLOR
            },
            vshader: `
                attribute vec3 vertex_position;
                attribute vec4 vertex_color;
                uniform mat4 matrix_model;
                uniform mat4 matrix_viewProjection;
                uniform float uPointSize;
                varying vec4 vColor;

                void main(void) {
                    gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
                    gl_PointSize = uPointSize;
                    vColor = vertex_color;
                }
            `,
            fshader: `
                precision mediump float;
                varying vec4 vColor;

                void main(void) {
                    vec2 p = gl_PointCoord - vec2(0.5);
                    if (dot(p, p) > 0.25) discard;
                    gl_FragColor = vColor;
                }
            `
        });
        material.depthWrite = true;
        material.blendType = pc.BLEND_NONE;
        material.setParameter('uPointSize', this.debugAllPointsSize);
        material.update();
        return material;
    }

    private getCurrentSplatData(): any | null {
        return (this.splatEntity?.gsplat as any)?.asset?.resource?.splatData
            || (this.splatEntity?.gsplat as any)?.instance?.splatData
            || null;
    }

    private getDebugDeletedIndexSet(): Set<number> | null {
        const deleted = this.lastParsedData?.deleted_indices;
        if (!Array.isArray(deleted) || deleted.length === 0) return null;
        return new Set(deleted.map((v: any) => Math.floor(Number(v))).filter(Number.isFinite));
    }

    private isDebugPointDeleted(index: number, deletedSet: Set<number> | null = this.getDebugDeletedIndexSet()): boolean {
        const sel = this.selectionTool?.selectionData || null;
        const selIdx = index * 4;
        if (sel && selIdx + 1 < sel.length && sel[selIdx + 1] > 0) return true;
        return !!deletedSet?.has(index);
    }

    private isDebugPointLifetimeVisible(index: number, frame: number): boolean {
        const lifeTexData = this.lifeTexData;
        if (!lifeTexData) return true;

        const idx = index * 4;
        if (idx + 2 >= lifeTexData.length) return true;

        const mu = lifeTexData[idx + 0];
        const w = lifeTexData[idx + 1];
        const k = lifeTexData[idx + 2];
        const totalFrames = Math.ceil(this.duration ?? 100);
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

    private isDebugPointOpacityVisible(index: number, opacity: Float32Array | null = ((this.getCurrentSplatData()?.getProp?.('opacity') as Float32Array | null) || this.readDebugParsedProp('opacity')) || null): boolean {
        if (!opacity || index >= opacity.length) return true;
        const raw = opacity[index];
        const alpha = raw >= 0 && raw <= 1 ? raw : 1 / (1 + Math.exp(-raw));
        return alpha > (1 / 255);
    }

    private isDebugPointLifetimeEverVisible(index: number, durationFrames: number): boolean {
        const lifeTexData = this.lifeTexData;
        if (!lifeTexData) return true;

        const idx = index * 4;
        if (idx + 2 >= lifeTexData.length) return true;

        const mu = lifeTexData[idx + 0];
        const w = lifeTexData[idx + 1];
        const k = lifeTexData[idx + 2];
        const segmentMax = Math.max(0, durationFrames - 1);
        const lifeStart = mu - w;
        const lifeEnd = mu + w;
        if (lifeEnd <= 0 || lifeStart >= segmentMax || lifeEnd <= lifeStart || !Number.isFinite(k)) return false;

        const candidates = new Set<number>();
        const addCandidate = (value: number) => {
            if (!Number.isFinite(value)) return;
            const clamped = Math.max(0, Math.min(segmentMax, value));
            candidates.add(Math.floor(clamped));
            candidates.add(Math.ceil(clamped));
        };
        addCandidate(mu);
        addCandidate(lifeStart);
        addCandidate(lifeEnd);
        addCandidate(0);
        addCandidate(segmentMax);

        for (const frame of candidates) {
            if (this.isDebugPointLifetimeVisible(index, frame)) return true;
        }
        return false;
    }

    private getDebugNeverVisibleFlags(count: number): Uint8Array {
        const opacity = ((this.getCurrentSplatData()?.getProp?.('opacity') as Float32Array | null) || this.readDebugParsedProp('opacity')) || null;
        const durationFrames = Math.max(1, Math.ceil(this.duration ?? this.totalFrames ?? 1));
        const opacitySemantic = String(this.lastParsedData?.opacitySemantic || '');
        const cached = this.debugNeverVisibleCache;
        if (
            cached &&
            cached.count === count &&
            cached.durationFrames === durationFrames &&
            cached.lifeTexData === this.lifeTexData &&
            cached.opacity === opacity &&
            cached.opacitySemantic === opacitySemantic
        ) {
            return cached.flags;
        }

        const flags = buildNeverVisibleFlags({
            count,
            totalFrames: durationFrames,
            opacity,
            opacitySemantic,
            lifeTexData: this.lifeTexData
        });
        this.debugNeverVisibleCache = { count, durationFrames, lifeTexData: this.lifeTexData, opacity, opacitySemantic, flags };
        return flags;
    }

    public isDebugPointNeverNormallyVisible(index: number): boolean {
        if (this.isDebugPointDeleted(index)) return false;
        const sourcePositions = this.getDebugAllPointsPositions();
        const count = sourcePositions ? Math.floor(sourcePositions.length / 3) : Math.max(0, Math.floor((this.selectionTool?.selectionData?.length || 0) / 4));
        if (index < 0 || index >= count) return false;
        return this.getDebugNeverVisibleFlags(count)[index] > 0;
    }

    public collectDebugNeverVisiblePointIndices(): number[] {
        const sourcePositions = this.getDebugAllPointsPositions();
        const count = sourcePositions ? Math.floor(sourcePositions.length / 3) : Math.max(0, Math.floor((this.selectionTool?.selectionData?.length || 0) / 4));
        if (count <= 0) return [];
        const deletedSet = this.getDebugDeletedIndexSet();
        const flags = this.getDebugNeverVisibleFlags(count);
        const targets: number[] = [];
        for (let i = 0; i < count; i++) {
            if (flags[i] && !this.isDebugPointDeleted(i, deletedSet)) targets.push(i);
        }
        return targets;
    }

    private trajectoryKeyframeAffectsVisibleFrame(index: number, keyframe: number): boolean {
        const opacityVisible = this.isDebugPointOpacityVisible(index);
        if (!this.lifeTexData) return opacityVisible;
        if (!opacityVisible) return false;

        const stride = Math.max(1, this.xyzStride || 1);
        const totalFrames = Math.max(1, Math.ceil(this.duration ?? this.totalFrames ?? 1));
        const segmentMax = Math.max(0, totalFrames - 1);
        const keyTime = keyframe * stride;
        const start = Math.max(0, Math.ceil(keyTime - stride));
        const end = Math.min(segmentMax, Math.floor(keyTime + stride));

        for (let frame = start; frame <= end; frame++) {
            if (this.isDebugPointLifetimeVisible(index, frame)) return true;
        }
        return false;
    }

    private refreshTrajectoryTextureFromData() {
        if (!this.trajectoryTexture || !this.trajectoryData || !this.keyframes) return;
        const count = Math.max(0, Number(this.getCurrentSplatData()?.numSplats || this.lastParsedData?.count || Math.floor((this.cachedPositions?.length || 0) / 3)));
        if (count <= 0) return;

        const texture = this.trajectoryTexture;
        const traj = this.trajectoryData;
        const K = this.keyframes;
        const origIndices = this.originalIndices;
        const dst = texture.lock();
        const texData = new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4);

        for (let i = 0; i < count; i++) {
            const oidx = origIndices ? Math.round(origIndices[i]) : i;
            const base = oidx * K * 3;
            for (let k = 0; k < K; k++) {
                const srcOff = base + k * 3;
                const dstOff = (i * K + k) * 4;
                texData[dstOff + 0] = traj[srcOff + 0] || 0;
                texData[dstOff + 1] = traj[srcOff + 1] || 0;
                texData[dstOff + 2] = traj[srcOff + 2] || 0;
                texData[dstOff + 3] = 1.0;
            }
        }

        texture.unlock();
    }

    public zeroInvisibleTrajectoryKeyframesForDeleteHidden(targetIndices: number[]): { clearedKeyframes: number; touchedPoints: number } {
        const trajectory = (this.lastParsedData?.trajectory as Float32Array | undefined) || this.trajectoryData;
        const keyframes = Number(this.lastParsedData?.keyframes || this.keyframes || 0);
        if (!trajectory || !keyframes || !Array.isArray(targetIndices) || targetIndices.length === 0) {
            return { clearedKeyframes: 0, touchedPoints: 0 };
        }

        const sourcePositions = this.getDebugAllPointsPositions();
        const count = sourcePositions ? Math.floor(sourcePositions.length / 3) : Math.max(0, Math.floor((this.selectionTool?.selectionData?.length || 0) / 4));
        const originalIndexLimit = Math.floor(trajectory.length / (keyframes * 3));
        const maxCount = Math.floor(this.lifeTexData ? Math.min(count, this.lifeTexData.length / 4) : count);
        // #WDD-gpt  2026-07-29 - 只清理本次确认删除的隐藏点，避免修复导出把所有高斯的不可见轨迹关键帧写到原点
        const targets = new Set(targetIndices
            .map((value) => Math.floor(Number(value)))
            .filter((value) => Number.isFinite(value) && value >= 0 && value < maxCount));
        let clearedKeyframes = 0;
        let touchedPoints = 0;

        for (const i of targets) {
            const oidx = this.originalIndices ? Math.round(this.originalIndices[i]) : i;
            if (oidx < 0 || oidx >= originalIndexLimit) continue;

            let touched = false;
            const base = oidx * keyframes * 3;
            for (let k = 0; k < keyframes; k++) {
                if (this.trajectoryKeyframeAffectsVisibleFrame(i, k)) continue;
                const off = base + k * 3;
                if (trajectory[off] !== 0 || trajectory[off + 1] !== 0 || trajectory[off + 2] !== 0) {
                    trajectory[off] = 0;
                    trajectory[off + 1] = 0;
                    trajectory[off + 2] = 0;
                    clearedKeyframes++;
                    touched = true;
                }
            }
            if (touched) touchedPoints++;
        }

        if (clearedKeyframes > 0) {
            // #WDD-gpt 2026-06-14 - Delete Hidden 同步清零不可见生命周期区域的轨迹关键点，保留可见插值需要的相邻关键点
            this.trajectoryData = trajectory;
            if (this.lastParsedData) this.lastParsedData.trajectory = trajectory;
            this.debugNeverVisibleCache = null;
            this.refreshTrajectoryTextureFromData();
            this.lastUpdatedFrame = -1;
            this.updateDynamicPositions(Math.floor(this.currentTime));
        }

        return { clearedKeyframes, touchedPoints };
    }

    public isDebugPointNormallyVisible(index: number, frame: number = Math.floor(this.currentTime)): boolean {
        if (this.isDebugPointDeleted(index)) return false;
        const opacity = ((this.getCurrentSplatData()?.getProp?.('opacity') as Float32Array | null) || this.readDebugParsedProp('opacity')) || null;
        const effectiveAlpha = getPointEffectiveAlphaAtFrame({
            index,
            frame: Math.floor(frame),
            totalFrames: Math.max(1, Math.ceil(this.duration ?? this.totalFrames ?? 1)),
            opacity,
            opacitySemantic: this.lastParsedData?.opacitySemantic,
            lifeTexData: this.lifeTexData
        });
        return effectiveAlpha >= NORMAL_RENDER_ALPHA_DISCARD;
    }

    private buildDebugAllPointsRenderData(sourcePositions: Float32Array, frame: number): { positions: Float32Array; colors: Float32Array; sourceCount: number; visibleCount: number; hiddenCount: number; deletedCount: number } {
        const sourceCount = Math.floor(sourcePositions.length / 3);
        const deletedSet = this.getDebugDeletedIndexSet();
        const neverVisibleFlags = this.getDebugNeverVisibleFlags(sourceCount);
        let visibleCount = 0;
        let hiddenCount = 0;
        let deletedCount = 0;

        for (let i = 0; i < sourceCount; i++) {
            const deleted = this.isDebugPointDeleted(i, deletedSet);
            if (deleted) {
                deletedCount++;
                continue;
            }
            if (neverVisibleFlags[i]) hiddenCount++;
            else visibleCount++;
        }

        const outputCount = visibleCount + hiddenCount;
        const positions = new Float32Array(outputCount * 3);
        const colors = new Float32Array(outputCount * 4);
        let outPoint = 0;

        for (let i = 0; i < sourceCount; i++) {
            // #WDD-gpt 2026-06-13 - render ALL 不再绘制已删除点；删除 hidden 后需要从 debug mesh 中消失
            if (this.isDebugPointDeleted(i, deletedSet)) continue;

            const neverVisible = neverVisibleFlags[i] > 0;
            const src = i * 3;
            const dst = outPoint * 3;
            positions[dst + 0] = sourcePositions[src + 0];
            positions[dst + 1] = sourcePositions[src + 1];
            positions[dst + 2] = sourcePositions[src + 2];

            const out = outPoint * 4;
            if (!neverVisible) {
                colors[out + 0] = 0.0;
                colors[out + 1] = 1.0;
                colors[out + 2] = 0.9;
                colors[out + 3] = 1.0;
            } else {
                colors[out + 0] = 1.0;
                colors[out + 1] = 0.08;
                colors[out + 2] = 0.06;
                colors[out + 3] = 1.0;
            }
            outPoint++;
        }

        this.debugAllPointsColors = colors;
        if (hiddenCount > 0 || deletedCount > 0) {
            console.log(`[Debug All Points] ${hiddenCount.toLocaleString()} never-visible + ${deletedCount.toLocaleString()} deleted / ${sourceCount.toLocaleString()} source points.`);
        }
        return { positions, colors, sourceCount, visibleCount, hiddenCount, deletedCount };
    }

    private setSelectionToolbarForRenderAll(active: boolean) {
        const toolbar = document.getElementById('selection-toolbar');
        if (!toolbar) return;
        const showLeftPanelTab = (tabName: string) => {
            // #WDD-gpt 2026-06-13 - Render ALL 需要切到左侧面板级 Edit tab 才能显示 Delete Hidden
            document.querySelectorAll<HTMLElement>('[data-left-panel-tab]').forEach((tab) => {
                const isActive = tab.dataset.leftPanelTab === tabName;
                tab.classList.toggle('active', isActive);
                tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });
            document.querySelectorAll<HTMLElement>('[data-left-panel]').forEach((panel) => {
                const isActive = panel.dataset.leftPanel === tabName;
                panel.classList.toggle('hidden', !isActive);
                panel.style.display = isActive ? ((tabName === 'edit' || tabName === 'lab') ? 'flex' : '') : 'none';
                panel.setAttribute('aria-hidden', isActive ? 'false' : 'true');
            });
        };
        const setEditPanelDisabled = (disabled: boolean) => {
            // #WDD-gpt 2026-06-13 - Render ALL 下保留 Edit 面板结构，但除 Delete Hidden 外禁用所有编辑按钮
            toolbar.classList.toggle('selection-render-all-locked', disabled);
            this.selectionTool?.setRenderAllSelectionDisabled?.(disabled);
            toolbar.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
                const allowed = button.id === 'action-delete-hidden';
                button.disabled = disabled && !allowed;
                button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
            });
        };

        if (!active) {
            for (const id of ['selection-current-tools', 'selection-alltime-tools', 'selection-action-tools', 'selection-operation-tools', 'selection-mode-tools', 'selection-delete-tools']) {
                const group = document.getElementById(id);
                if (!group) continue;
                group.classList.remove('hidden');
                group.style.display = '';
                group.setAttribute('aria-hidden', 'false');
            }
            document.getElementById('action-delete')?.classList.remove('hidden');
            document.getElementById('action-delete-hidden')?.classList.remove('hidden');
            document.getElementById('action-help')?.classList.remove('hidden');
            setEditPanelDisabled(false);
            this.selectionTool?.refreshLazyModeVisibility?.();
            const activeTab = document.querySelector<HTMLElement>('[data-left-panel-tab].active')?.dataset.leftPanelTab || 'smart';
            showLeftPanelTab(activeTab);
            return;
        }

        showLeftPanelTab('edit');
        toolbar.classList.remove('hidden');
        toolbar.style.display = 'flex';
        const deleteTools = document.getElementById('selection-delete-tools');
        if (deleteTools) {
            // #WDD-gpt 2026-06-13 - 兼容旧容器 ID，Render ALL 的清理入口现在在 Edit 面板内
            deleteTools.classList.remove('hidden');
            deleteTools.style.display = '';
            deleteTools.setAttribute('aria-hidden', 'false');
        }
        for (const id of ['selection-current-tools', 'selection-alltime-tools', 'selection-action-tools', 'selection-operation-tools', 'selection-mode-tools']) {
            const group = document.getElementById(id);
            if (!group) continue;
            group.classList.remove('hidden');
            group.style.display = '';
            group.setAttribute('aria-hidden', 'false');
        }
        document.getElementById('action-delete')?.classList.remove('hidden');
        document.getElementById('action-delete-hidden')?.classList.remove('hidden');
        document.getElementById('action-help')?.classList.add('hidden');
        setEditPanelDisabled(true);
        if (this.selectionTool?.currentTool !== 'none') this.selectionTool.setTool('none');
    }

    private refreshDebugAllPointsEntity() {
        if (this.gaussianRenderMode !== 3) return;
        const source = this.splatEntity;
        const frame = Math.floor(this.currentTime);
        const sourcePositions = this.getDebugAllPointsPositions();
        if (!source || !sourcePositions || sourcePositions.length < 3) {
            this.destroyDebugAllPointsEntity();
            return;
        }

        const renderData = this.buildDebugAllPointsRenderData(sourcePositions, frame);
        if (renderData.positions.length < 3) {
            this.destroyDebugAllPointsEntity();
            this.setPrimarySplatVisibility(false);
            this.setSelectionToolbarForRenderAll(true);
            return;
        }

        const count = renderData.visibleCount + renderData.hiddenCount;
        const needsRebuild = !this.debugAllPointsEntity
            || this.debugAllPointsSourceEntity !== source
            || this.debugAllPointsCount !== count;
        const needsPositionUpdate = needsRebuild || this.debugAllPointsFrame !== frame;

        if (needsRebuild) {
            this.destroyDebugAllPointsEntity();

            const mesh = new pc.Mesh(this.app.graphicsDevice);
            mesh.setPositions(renderData.positions, 3);
            mesh.setColors(renderData.colors, 4);
            mesh.update(pc.PRIMITIVE_POINTS);

            if (!this.debugAllPointsMaterial) {
                // #WDD-gpt 2026-06-13 - 自定义 point shader 设置 gl_PointSize，让 ALL 点云比默认 1px 更容易看清
                this.debugAllPointsMaterial = this.createDebugAllPointsMaterial();
            }

            const entity = new pc.Entity('DebugAllGaussianPoints');
            entity.addComponent('render', {
                meshInstances: [new pc.MeshInstance(mesh, this.debugAllPointsMaterial)]
            });
            (source.parent || this.app.root).addChild(entity);
            this.debugAllPointsEntity = entity;
            this.debugAllPointsSourceEntity = source;
            this.debugAllPointsCount = count;
            console.log(`[Debug All Points] Showing ${count.toLocaleString()} non-deleted splat centers without lifetime/opacity filtering.`);
        } else {
            const mesh = this.debugAllPointsEntity!.render?.meshInstances?.[0]?.mesh;
            if (mesh) {
                if (needsPositionUpdate) mesh.setPositions(renderData.positions, 3);
                mesh.setColors(renderData.colors, 4);
                mesh.update(pc.PRIMITIVE_POINTS);
            }
        }
        this.debugAllPointsFrame = frame;

        this.syncDebugAllPointsTransform(source);
        this.debugAllPointsEntity!.enabled = true;
        this.setPrimarySplatVisibility(false);
        this.setSelectionToolbarForRenderAll(true);
    }

    private refreshDebugAllPointsEntityThrottled(force = false) {
        if (this.gaussianRenderMode !== 3) return;
        if (!force) {
            const now = performance.now();
            const intervalMs = this.isPlaying ? 180 : 66;
            if (now - this.debugAllPointsLastRefreshMs < intervalMs) return;
            this.debugAllPointsLastRefreshMs = now;
        } else {
            this.debugAllPointsLastRefreshMs = performance.now();
        }
        // #WDD-gpt 2026-06-18 - Render ALL 是调试视图，播放时节流刷新，避免持续重建点云拖慢 4D 动态展示
        this.refreshDebugAllPointsEntity();
    }

    private applyGaussianRenderMode() {
        if (this.gaussianRenderMode === 3) {
            // #WDD-gpt 2026-06-13 - ALL 模式使用独立点云 entity，不再改主 GSplat shader，避免破坏 PLY4 normal
            this.refreshDebugAllPointsEntityThrottled(true);
            return;
        }

        if (this.debugAllPointsEntity) this.debugAllPointsEntity.enabled = false;
        this.setSelectionToolbarForRenderAll(false);
        this.setPrimarySplatVisibility(true);

        const apply = (ent: pc.Entity | null) => {
            if (!ent?.gsplat) return;
            const instance = (ent.gsplat as any).instance;
            if (instance?.material) {
                instance.material.setParameter('uRenderMode', this.gaussianRenderMode);
                instance.material.update();
            }
        };

        if (this.isSequenceMode || this.isSog4SequenceMode) {
            this.sequenceEntityPool.forEach((ent) => apply(ent));
            this.sog4SequenceSegments.forEach((seg) => apply(seg.entity));
        }

        apply(this.splatEntity);
    }

    private applySHLevel() {
        const apply = (ent: pc.Entity | null) => {
            if (!ent?.gsplat) return;
            const instance = (ent.gsplat as any).instance;
            if (instance?.material) {
                instance.material.setParameter('uSHLevel', this.shLevel);
                instance.material.update();
            }
        };

        if (this.isSequenceMode || this.isSog4SequenceMode) {
            this.sequenceEntityPool.forEach((ent) => apply(ent));
            this.sog4SequenceSegments.forEach((seg) => apply(seg.entity));
        }

        apply(this.splatEntity);
    }

    private bindSHLevelControls() {
        const buttons = [
            document.getElementById('sh-level-0') as HTMLElement | null,
            document.getElementById('sh-level-1') as HTMLElement | null,
            document.getElementById('sh-level-2') as HTMLElement | null,
            document.getElementById('sh-level-3') as HTMLElement | null
        ];

        const updateButtons = () => {
            buttons.forEach((button, level) => this.updateToggleButton(button, this.shLevel === level));
        };

        buttons.forEach((button, level) => {
            button?.addEventListener('click', () => {
                this.shLevel = level;
                this.applySHLevel();
                updateButtons();
            });
        });

        updateButtons();
    }

    private bindLabControls() {
        document.getElementById('lab-compress-sh')?.addEventListener('click', () => this.compressActiveSHToLevel1());
        document.getElementById('lab-health-check')?.addEventListener('click', () => this.checkActiveModelHealth());
        document.getElementById('lab-health-fix')?.addEventListener('click', () => this.fixActiveModelHealth());
        this.bindSam3ApiKeyCache();
        document.getElementById('lab-sam3-load')?.addEventListener('click', () => void this.loadSam3WebModel());
        document.getElementById('lab-sam3-segment')?.addEventListener('click', () => void this.segmentCurrentViewWithSam3());
        document.getElementById('lab-sam3-select')?.addEventListener('click', () => this.selectCurrentSam3Mask());
        document.getElementById('lab-sam3-preview')?.addEventListener('click', () => this.toggleSam3MaskPreview());
        for (const id of ['lab-sam3-align-x', 'lab-sam3-align-y', 'lab-sam3-align-scale', 'lab-sam3-align-flip-x', 'lab-sam3-align-flip-y']) {
            document.getElementById(id)?.addEventListener('input', () => this.renderSam3MaskPreview());
            document.getElementById(id)?.addEventListener('change', () => this.renderSam3MaskPreview());
        }
        document.getElementById('lab-health-report')?.addEventListener('click', (event) => {
            const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-health-code]');
            if (row?.dataset.healthCode) this.selectLabHealthIssue(row.dataset.healthCode);
        });
        document.getElementById('lab-health-report')?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-health-code]');
            if (!row?.dataset.healthCode) return;
            event.preventDefault();
            this.selectLabHealthIssue(row.dataset.healthCode);
        });
    }

    private setLabSHStatus(key: string, vars?: Record<string, string | number>) {
        const status = document.querySelector<HTMLElement>('#lab-sh-status .panel-stat-value');
        if (status) status.textContent = t(key, vars);
    }

    public resetTransientStateForNewAsset(options: { preserveSelection?: boolean; segmentSwitch?: boolean } = {}) {
        this.labHealthReport = null;
        this.debugNeverVisibleCache = null;
        this.sam3MaskResult = null;
        this.sam3LastUploadImage = null;
        this.sam3MaskPreviewVisible = false;
        this.renderSam3MaskPreview();
        this.renderSam3UploadPreview();
        document.getElementById('ply4-health-gate')?.remove();
        this.setLabSHStatus('lab.ready');
        this.setSam3Status(this.sam3ModelReady ? 'lab.sam3.ready' : 'lab.sam3.idle');
        this.updateSam3Buttons();

        const summary = document.getElementById('lab-health-summary');
        if (summary) {
            summary.textContent = t('lab.health.notChecked');
            summary.removeAttribute('title');
        }
        const report = document.getElementById('lab-health-report');
        if (report) {
            report.innerHTML = `<div class="lab-health-empty">${this.escapeHTML(t('lab.health.notCheckedHint'))}</div>`;
        }
        const fixButton = document.getElementById('lab-health-fix') as HTMLButtonElement | null;
        if (fixButton) fixButton.disabled = true;

        if (!options.preserveSelection) {
            this.selectionTool?.clearHistory?.();
        }
        if (!options.segmentSwitch) {
            this.presetManager?.cancelPresetPathPlaybackForNewAsset?.();
        }

        // #WDD 2026-07-04: 第二次加载文件时彻底重置选择/智能圆柱/分段编辑状态，避免残留
        this.selectionTool?.resetForNewAsset?.();
        this.smartSelectionTool?.resetForNewAsset?.();
        this.sequenceEditStates.clear();

        const allPointsStatus = document.getElementById('debug-all-points-status');
        if (allPointsStatus) allPointsStatus.textContent = '';
    }

    // #WDD-gpt 2026-08-04 - 用加载代次阻止较早完成的异步模型覆盖用户后来选择的模型
    public beginAssetLoadRequest() {
        return ++this.assetLoadGeneration;
    }

    public isAssetLoadRequestCurrent(generation: number) {
        return generation === this.assetLoadGeneration;
    }

    // #WDD-gpt 2026-08-04 - 单模型替换前清空上一模型的时间、轨迹和排序状态，避免第二次加载复用旧缓冲
    public prepareSingleAssetLoad(generation: number) {
        if (!this.isAssetLoadRequestCurrent(generation)) return false;
        if (this.isPlaying) this.togglePlay();
        this.disposeDynamicSorter();
        this.currentTime = 0;
        this.playbackTime = 0;
        this.duration = 1;
        this.totalFrames = 1;
        this.originalFrames = null;
        this.lastParsedData = null;
        this.is4DGS = false;
        this.trajectoryData = null;
        this.trajectoryTexture = null;
        this.keyframes = 0;
        this.xyzStride = 1;
        this.rotTrajectoryData = null;
        this.rotKeyframes = 0;
        this.rotStride = 1;
        this.dcTrajectoryData = null;
        this.dcKeyframes = 0;
        this.dcStride = 1;
        this.lifeTexData = null;
        this.scalesTexData = null;
        this.originalIndices = null;
        this.posArrays = null;
        this.cachedPositions = null;
        this.hasLoggedSorterKeys = false;
        return true;
    }

    // #WDD-gpt 2026-08-04 - 统一作废 Worker 回调和等待帧，确保旧排序结果不能写入新模型实例
    private disposeDynamicSorter() {
        this.dynamicSorterEpoch++;
        this.dynamicSorter?.destroy();
        this.dynamicSorter = null;
        this.active4DSplatCount = 0;
        this.isWaitingForSort = false;
        this.pendingSortedFrame = null;
        this.lastUpdatedFrame = -1;
        this.sortingTaskID++;
        this.lastCompletedSortTaskID = this.sortingTaskID;
    }

    private bindSam3ApiKeyCache() {
        const input = document.getElementById('lab-sam3-api-key') as HTMLInputElement | null;
        if (!input) return;

        // #WDD-gpt 2026-06-18 - 用户要求网页缓存在线 SAM3 key；仅保存到当前浏览器 localStorage，不写入源码或构建产物
        const cached = this.readLocalSetting(this.sam3ApiKeyStorageKey);
        if (cached && !input.value) input.value = cached;
        input.addEventListener('input', () => {
            const value = input.value.trim();
            if (value) {
                this.writeLocalSetting(this.sam3ApiKeyStorageKey, value);
            } else {
                this.removeLocalSetting(this.sam3ApiKeyStorageKey);
                this.sam3ModelReady = false;
                this.sam3MaskResult = null;
                this.updateSam3Buttons();
            }
        });
    }

    private readLocalSetting(key: string) {
        try {
            return window.localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    private writeLocalSetting(key: string, value: string) {
        try {
            window.localStorage.setItem(key, value);
        } catch {
            // Ignore storage failures so SAM3 can still work for the current page session.
        }
    }

    private removeLocalSetting(key: string) {
        try {
            window.localStorage.removeItem(key);
        } catch {
            // Ignore storage failures so clearing the visible input still works.
        }
    }

    private setSam3Status(key: string, vars?: Record<string, string | number>) {
        const status = document.getElementById('lab-sam3-status');
        if (status) {
            const text = t(key, vars);
            status.textContent = text;
            status.title = text;
        }
    }

    private updateSam3Buttons() {
        const segment = document.getElementById('lab-sam3-segment') as HTMLButtonElement | null;
        const select = document.getElementById('lab-sam3-select') as HTMLButtonElement | null;
        const preview = document.getElementById('lab-sam3-preview') as HTMLButtonElement | null;
        if (segment) segment.disabled = !this.sam3ModelReady;
        if (select) select.disabled = !this.sam3MaskResult;
        if (preview) preview.disabled = !this.sam3MaskResult;
    }

    private async loadSam3WebModel() {
        try {
            this.setSam3Status('lab.sam3.loading');
            this.sam3WebClient = this.sam3WebClient || new Sam3WebClient();
            const apiKey = (document.getElementById('lab-sam3-api-key') as HTMLInputElement | null)?.value.trim() || '';
            if (!apiKey) {
                this.setSam3Status('lab.sam3.noKey');
                this.sam3ModelReady = false;
                this.sam3MaskPreviewVisible = false;
                this.renderSam3MaskPreview();
                return;
            }
            await this.sam3WebClient.init({ apiKey });
            this.writeLocalSetting(this.sam3ApiKeyStorageKey, apiKey);
            this.sam3ModelReady = true;
            this.sam3MaskResult = null;
            this.sam3MaskPreviewVisible = false;
            this.renderSam3MaskPreview();
            this.setSam3Status('lab.sam3.ready');
        } catch (err) {
            this.sam3ModelReady = false;
            console.warn('[SAM3 Web] Load failed', err);
            this.setSam3Status('lab.sam3.failed', { message: err instanceof Error ? err.message : String(err) });
        } finally {
            this.updateSam3Buttons();
        }
    }

    private async segmentCurrentViewWithSam3() {
        if (!this.sam3WebClient || !this.sam3ModelReady) {
            this.setSam3Status('lab.sam3.notLoaded');
            return;
        }
        const canvas = document.getElementById('application-canvas') as HTMLCanvasElement | null;
        const prompt = (document.getElementById('lab-sam3-prompt') as HTMLInputElement | null)?.value.trim() || 'object';
        if (!canvas) {
            this.setSam3Status('lab.sam3.noCanvas');
            return;
        }
        try {
            this.setSam3Status('lab.sam3.segmenting');
            await this.waitRafs(1);
            const uploadMaxSize = Math.max(640, Math.min(1400, Math.round(Math.max(this.app.graphicsDevice.width, this.app.graphicsDevice.height) * 0.5)));
            const image = captureCanvasImageData(canvas, uploadMaxSize);
            this.sam3LastUploadImage = image;
            this.renderSam3UploadPreview();
            this.sam3MaskResult = await this.sam3WebClient.segment(image, prompt);
            this.sam3MaskPreviewVisible = true;
            this.renderSam3MaskPreview();
            this.setSam3Status('lab.sam3.maskReady', { width: `${this.sam3MaskResult.width}x${this.sam3MaskResult.height}`, height: `${this.sam3MaskResult.maskPixels}px ${this.sam3MaskResult.debugSummary}` });
        } catch (err) {
            this.sam3MaskResult = null;
            this.sam3MaskPreviewVisible = false;
            this.renderSam3MaskPreview();
            console.warn('[SAM3 Web] Segment failed', err);
            this.setSam3Status('lab.sam3.failed', { message: err instanceof Error ? err.message : String(err) });
        } finally {
            this.updateSam3Buttons();
        }
    }

    private selectCurrentSam3Mask() {
        const mask = this.sam3MaskResult;
        const positions = this.getCurrentPositions();
        const camera = this.camera?.camera || null;
        if (!mask || !positions || !this.splatEntity || !camera) {
            this.setSam3Status('lab.sam3.noSelectionSource');
            return;
        }
        const selection = selectGaussianIndicesFromMask({
            positions,
            entity: this.splatEntity,
            camera,
            mask: mask.mask,
            maskWidth: mask.width,
            maskHeight: mask.height,
            screenWidth: mask.projectionWidth || this.app.graphicsDevice.clientRect?.width || mask.width,
            screenHeight: mask.projectionHeight || this.app.graphicsDevice.clientRect?.height || mask.height,
            ...this.getSam3MaskAlignment()
        });
        console.log('[SAM3 Online] selection projection', {
            maskPixels: selection.maskPixels,
            projectedPoints: selection.projectedPoints,
            hitPoints: selection.indices.length,
            maskSize: `${mask.width}x${mask.height}`,
            sourceSize: `${mask.sourceWidth}x${mask.sourceHeight}`,
            projectionSize: `${mask.projectionWidth}x${mask.projectionHeight}`,
            screenSize: `${this.app.graphicsDevice.width}x${this.app.graphicsDevice.height}`,
            align: this.getSam3MaskAlignment()
        });
        const count = this.selectionTool?.selectIndices(selection.indices, true, true) || 0;
        this.setSam3Status('lab.sam3.selected', { count });
    }

    private toggleSam3MaskPreview() {
        if (!this.sam3MaskResult) return;
        this.sam3MaskPreviewVisible = !this.sam3MaskPreviewVisible;
        this.renderSam3MaskPreview();
    }

    private renderSam3MaskPreview() {
        const canvas = document.getElementById('sam3-mask-preview') as HTMLCanvasElement | null;
        const thumb = document.getElementById('lab-sam3-mask-thumb') as HTMLCanvasElement | null;
        const sourceCanvas = document.getElementById('application-canvas') as HTMLCanvasElement | null;
        if (!canvas && !thumb) return;
        if (!this.sam3MaskResult || !this.sam3MaskPreviewVisible) {
            canvas?.classList.add('hidden');
            thumb?.classList.add('hidden');
            const ctx = canvas?.getContext('2d');
            const thumbCtx = thumb?.getContext('2d');
            if (canvas) ctx?.clearRect(0, 0, canvas.width, canvas.height);
            if (thumb) thumbCtx?.clearRect(0, 0, thumb.width, thumb.height);
            return;
        }

        const mask = this.sam3MaskResult;
        if (canvas) {
            // #WDD-gpt 2026-06-18 - 预览层使用 WebGL drawing buffer 尺寸，避免 CSS 尺寸和 worldToScreen 坐标系混用导致 mask 偏移/缩放错误
            canvas.width = this.app.graphicsDevice.width || sourceCanvas?.width || mask.width;
            canvas.height = this.app.graphicsDevice.height || sourceCanvas?.height || mask.height;
        }
        const scratch = document.createElement('canvas');
        scratch.width = mask.width;
        scratch.height = mask.height;
        const scratchCtx = scratch.getContext('2d');
        if (!scratchCtx) return;

        const image = scratchCtx.createImageData(mask.width, mask.height);
        // #WDD-gpt 2026-06-18 - 将 SAM3 二值 mask 画成绿色透明预览，用于定位在线返回 mask 与当前视图的偏移/翻转问题
        for (let i = 0; i < mask.mask.length; i++) {
            const offset = i * 4;
            image.data[offset + 0] = 0;
            image.data[offset + 1] = 255;
            image.data[offset + 2] = 130;
            image.data[offset + 3] = mask.mask[i] > 0 ? 190 : 0;
        }
        scratchCtx.putImageData(image, 0, 0);
        if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.imageSmoothingEnabled = false;
                const align = this.getSam3MaskAlignment();
                const drawW = canvas.width * align.maskScale;
                const drawH = canvas.height * align.maskScale;
                const drawX = (canvas.width - drawW) * 0.5 + align.maskOffsetX;
                const drawY = (canvas.height - drawH) * 0.5 + align.maskOffsetY;
                ctx.save();
                ctx.translate(canvas.width * 0.5, canvas.height * 0.5);
                ctx.scale(align.flipX ? -1 : 1, align.flipY ? -1 : 1);
                ctx.translate(-canvas.width * 0.5, -canvas.height * 0.5);
                ctx.drawImage(scratch, drawX, drawY, drawW, drawH);
                ctx.restore();
                canvas.classList.remove('hidden');
                console.log('[SAM3 Online] preview mapping', {
                    maskSize: `${mask.width}x${mask.height}`,
                    overlayBuffer: `${canvas.width}x${canvas.height}`,
                    sourceBuffer: `${sourceCanvas?.width || 0}x${sourceCanvas?.height || 0}`,
                    sourceClient: `${sourceCanvas?.clientWidth || 0}x${sourceCanvas?.clientHeight || 0}`,
                    graphicsDevice: `${this.app.graphicsDevice.width}x${this.app.graphicsDevice.height}`,
                    align
                });
            }
        }
        if (thumb) {
            const thumbCtx = thumb.getContext('2d');
            thumb.width = 240;
            thumb.height = Math.max(1, Math.round(240 * (mask.height / Math.max(1, mask.width))));
            if (thumbCtx) {
                thumbCtx.clearRect(0, 0, thumb.width, thumb.height);
                thumbCtx.imageSmoothingEnabled = false;
                thumbCtx.drawImage(scratch, 0, 0, thumb.width, thumb.height);
                thumb.classList.remove('hidden');
            }
        }
    }

    private getSam3MaskAlignment() {
        const readNumber = (id: string, fallback: number) => {
            const value = Number((document.getElementById(id) as HTMLInputElement | null)?.value);
            return Number.isFinite(value) ? value : fallback;
        };
        return {
            maskOffsetX: readNumber('lab-sam3-align-x', 0),
            maskOffsetY: readNumber('lab-sam3-align-y', 0),
            maskScale: Math.max(0.05, readNumber('lab-sam3-align-scale', 1)),
            flipX: !!(document.getElementById('lab-sam3-align-flip-x') as HTMLInputElement | null)?.checked,
            flipY: !!(document.getElementById('lab-sam3-align-flip-y') as HTMLInputElement | null)?.checked
        };
    }

    private renderSam3UploadPreview() {
        const thumb = document.getElementById('lab-sam3-upload-thumb') as HTMLCanvasElement | null;
        const image = this.sam3LastUploadImage;
        if (!thumb) return;
        if (!image) {
            thumb.classList.add('hidden');
            const ctx = thumb.getContext('2d');
            ctx?.clearRect(0, 0, thumb.width, thumb.height);
            return;
        }
        thumb.width = 240;
        thumb.height = Math.max(1, Math.round(240 * (image.height / Math.max(1, image.width))));
        const scratch = document.createElement('canvas');
        scratch.width = image.width;
        scratch.height = image.height;
        const scratchCtx = scratch.getContext('2d');
        const ctx = thumb.getContext('2d');
        if (!scratchCtx || !ctx) return;
        // #WDD-gpt 2026-06-18 - 显示实际上传到在线 SAM3 的截图，便于对比返回 mask 是否对应当前视图
        scratchCtx.putImageData(image, 0, 0);
        ctx.clearRect(0, 0, thumb.width, thumb.height);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(scratch, 0, 0, thumb.width, thumb.height);
        thumb.classList.remove('hidden');
    }

    private getActiveVertexElement(): PlyVertexElement | null {
        const component = (this.splatEntity?.gsplat as any) || null;
        const asset = component?._assetReference?.asset || (component?.asset ? this.app.assets.get(component.asset) : null);
        const vertexElement = asset?.resource?.splatData?.elements?.[0] || null;
        return vertexElement as PlyVertexElement | null;
    }

    private clearSplatSHTextures(splat: any) {
        for (const texture of [splat?.sh1to3Texture, splat?.sh4to7Texture, splat?.sh8to11Texture, splat?.sh12to15Texture]) {
            if (!texture?.lock) continue;
            const data = texture.lock();
            data.fill(0);
            texture.unlock();
        }
    }

    private refreshActiveSplatColorAndSH(vertexElement: PlyVertexElement) {
        if (!this.splatEntity?.gsplat) return;
        const component = this.splatEntity.gsplat as any;
        const instance = component.instance;
        const asset = component?._assetReference?.asset || (component?.asset ? this.app.assets.get(component.asset) : null);
        const splatData = new (pc.GSplatData as any)([vertexElement]);
        if (asset?.resource) asset.resource.splatData = splatData;
        const x = vertexElement.properties.find((prop) => prop.name === 'x')?.storage;
        const y = vertexElement.properties.find((prop) => prop.name === 'y')?.storage;
        const z = vertexElement.properties.find((prop) => prop.name === 'z')?.storage;
        if (x && y && z) {
            const count = Math.min(vertexElement.count, x.length, y.length, z.length);
            if (!this.cachedPositions || this.cachedPositions.length !== count * 3) this.cachedPositions = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                this.cachedPositions[i * 3 + 0] = x[i];
                this.cachedPositions[i * 3 + 1] = y[i];
                this.cachedPositions[i * 3 + 2] = z[i];
            }
        }

        const splat = instance?.splat || asset?.resource?.splat || null;
        if (splat?.updateColorData) splat.updateColorData(splatData);
        if (splat?.updateSHData && splat?.hasSH) {
            this.clearSplatSHTextures(splat);
            splat.updateSHData(splatData);
        }

        instance?.material?.update?.();
        this.applySHLevel();
    }

    private refreshActiveSplatData(vertexElement: PlyVertexElement) {
        if (!this.splatEntity?.gsplat) return;
        const component = this.splatEntity.gsplat as any;
        const instance = component.instance;
        const asset = component?._assetReference?.asset || (component?.asset ? this.app.assets.get(component.asset) : null);
        const splatData = new (pc.GSplatData as any)([vertexElement]);
        if (asset?.resource) asset.resource.splatData = splatData;

        const splat = instance?.splat || asset?.resource?.splat || null;
        if (splat?.updateColorData) splat.updateColorData(splatData);
        if (splat?.updateTransformData) splat.updateTransformData(splatData);
        if (splat?.updateSHData && splat?.hasSH) {
            this.clearSplatSHTextures(splat);
            splat.updateSHData(splatData);
        }

        instance?.material?.update?.();
        this.applySHLevel();
        this.debugNeverVisibleCache = null;
        this.refreshDebugAllPointsEntity();
    }

    private getSHCompressionCameraPositions(): [number, number, number][] {
        const entity = this.splatEntity;
        const cameraPositions: [number, number, number][] = [];
        if (!entity) return cameraPositions;

        const inverseWorld = new pc.Mat4();
        inverseWorld.copy(entity.getWorldTransform()).invert();
        const currentLocal = new pc.Vec3();
        inverseWorld.transformPoint(this.camera?.getPosition?.() || new pc.Vec3(0, 0, 3), currentLocal);
        const radius = Math.max(currentLocal.length(), 1e-3);
        const count = 64;
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));

        for (let i = 0; i < count; i++) {
            const y = 1 - (2 * (i + 0.5)) / count;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = i * goldenAngle;
            const x = Math.cos(theta) * r;
            const z = Math.sin(theta) * r;
            cameraPositions.push([x * radius, y * radius, z * radius]);
        }
        return cameraPositions;
    }

    private compressActiveSHToLevel1() {
        const vertexElement = this.getActiveVertexElement();
        if (!vertexElement) {
            this.setLabSHStatus('lab.noModel');
            return;
        }
        if (!canCompressVertexElementSH(vertexElement)) {
            this.setLabSHStatus('lab.noSH');
            return;
        }

        try {
            this.setLabSHStatus('lab.processing');
            const result = compressVertexElementSHToLevel1(vertexElement, {
                cameraPositions: this.getSHCompressionCameraPositions(),
                regularization: 1e-4
            });
            this.refreshActiveSplatColorAndSH(vertexElement);
            this.setLabSHStatus('lab.done', { count: result.gaussianCount, views: result.sampleViewCount });
            console.log('[Lab] SH compressed to SH0+SH1', result);
        } catch (err) {
            console.error('[Lab] SH compression failed', err);
            this.setLabSHStatus('lab.failed');
        }
    }

    private checkActiveModelHealth() {
        const report = this.getActiveModelHealthReport();
        this.renderLabHealthReport(report, 'lab.health.checked');
    }

    private fixActiveModelHealth() {
        const result = this.applyActiveModelHealthAutoFix();
        if (!result) {
            this.renderLabHealthReport(this.withViewerHealthIssues(analyzeModelHealth(null)), 'lab.health.noModel');
            return;
        }
        this.renderLabHealthReport(this.getActiveModelHealthReport(), 'lab.health.fixed', { count: result.changedValueCount });
        console.log('[Lab] Model health auto fix', result);
    }

    public getPLY4ExportHealthReport() {
        return this.getExportHealthReport();
    }

    public applyPLY4ExportHealthAutoFix() {
        return this.applyExportHealthAutoFix();
    }

    public getExportHealthReport() {
        // #WDD-gpt 2026-07-16 - 保存预检统一调用包含最终透明度隐藏点检测的 Viewer 健康报告
        return this.getActiveModelHealthReport();
    }

    public applyExportHealthAutoFix() {
        return this.applyActiveModelHealthAutoFix();
    }

    private applyActiveModelHealthAutoFix() {
        const vertexElement = this.getActiveVertexElement();
        if (!vertexElement) {
            return null;
        }

        const result = applyModelHealthAutoFix(vertexElement);
        if (result.changedValueCount > 0) {
            this.refreshActiveSplatData(vertexElement);
        }
        const hiddenTargets = this.collectDebugNeverVisiblePointIndices();
        const deletedHidden = hiddenTargets.length > 0 && typeof this.selectionTool?.deleteIndices === 'function'
            ? this.selectionTool.deleteIndices(hiddenTargets)
            : 0;
        // #WDD-gpt  2026-07-29 - 导出健康修复仅清理刚标记删除的隐藏点，保持其余高斯跨帧轨迹和选择 ID 不变
        const cleanup = deletedHidden > 0 ? this.zeroInvisibleTrajectoryKeyframesForDeleteHidden(hiddenTargets) : null;
        if (deletedHidden > 0) {
            this.debugNeverVisibleCache = null;
            this.refreshDebugAllPointsEntity();
        }
        return { ...result, deletedHidden, cleanup, changedValueCount: result.changedValueCount + deletedHidden };
    }

    private getActiveModelHealthReport() {
        return this.withViewerHealthIssues(analyzeModelHealth(this.getActiveVertexElement()));
    }

    private withViewerHealthIssues(report: ModelHealthReport): ModelHealthReport {
        if (!this.splatEntity) return report;
        const hiddenIndices = this.collectDebugNeverVisiblePointIndices();
        if (hiddenIndices.length === 0) return report;

        // #WDD-gpt 2026-06-18 - Delete Hidden 的检测依赖 Viewer 生命周期/opacity/删除状态，这里作为 Viewer 层健康项合并进 Lab 报告
        const hiddenIssue = {
            code: 'never-visible-hidden',
            severity: 'warning' as const,
            messageKey: 'lab.health.issue.hiddenNeverVisible',
            count: hiddenIndices.length,
            fixable: true,
            indices: hiddenIndices
        };

        const issues = [...report.issues.filter((issue) => issue.code !== hiddenIssue.code), hiddenIssue];
        return {
            ...report,
            issueCount: issues.length,
            warningCount: issues.filter((issue) => issue.severity === 'warning').length,
            errorCount: issues.filter((issue) => issue.severity === 'error').length,
            fixableCount: issues.filter((issue) => issue.fixable).length,
            issues
        };
    }

    private renderLabHealthReport(report: ModelHealthReport, statusKey: string, vars?: Record<string, string | number>) {
        this.labHealthReport = report;
        const summary = document.getElementById('lab-health-summary');
        const reportEl = document.getElementById('lab-health-report');
        const fixButton = document.getElementById('lab-health-fix') as HTMLButtonElement | null;

        if (summary) {
            summary.textContent = t(statusKey, vars);
            summary.title = t('lab.health.summaryTitle', {
                count: report.gaussianCount,
                errors: report.errorCount,
                warnings: report.warningCount,
                fixable: report.fixableCount
            });
        }
        if (fixButton) fixButton.disabled = report.fixableCount === 0;
        if (!reportEl) return;

        if (report.issues.length === 0) {
            reportEl.innerHTML = `<div class="lab-health-empty">${this.escapeHTML(t('lab.health.clean'))}</div>`;
            return;
        }

        reportEl.innerHTML = report.issues.map((issue) => {
            const severity = this.escapeHTML(issue.severity.toUpperCase());
            const label = this.escapeHTML(t(issue.messageKey));
            const fix = issue.fixable ? `<span class="lab-health-fixable">${this.escapeHTML(t('lab.health.fixable'))}</span>` : '';
            const selectable = issue.indices.length > 0;
            return `<div class="lab-health-issue lab-health-${this.escapeHTML(issue.severity)} ${selectable ? 'lab-health-selectable' : ''}" data-health-code="${this.escapeHTML(issue.code)}" ${selectable ? 'role="button" tabindex="0"' : ''}>
                <span class="lab-health-severity">${severity}</span>
                <span class="lab-health-message">${label}</span>
                <span class="lab-health-count">${issue.count.toLocaleString()}</span>
                ${fix}
            </div>`;
        }).join('');
    }

    private selectLabHealthIssue(code: string) {
        const issue = this.labHealthReport?.issues.find((item) => item.code === code);
        if (!issue || issue.indices.length === 0) return;
        const selected = this.selectionTool?.selectIndices(issue.indices, true, true) || 0;
        const summary = document.getElementById('lab-health-summary');
        if (summary) summary.textContent = t('lab.health.selected', { count: selected });
        document.querySelectorAll<HTMLElement>('.lab-health-issue.is-selected').forEach((row) => row.classList.remove('is-selected'));
        document.querySelector<HTMLElement>(`.lab-health-issue[data-health-code="${CSS.escape(code)}"]`)?.classList.add('is-selected');
        console.log('[Lab] Selected health issue points', { code, selected });
    }

    private escapeHTML(value: string) {
        return value.replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char] || char));
    }

    private bindGaussianRenderModeControls() {
        const buttons = {
            normal: document.getElementById('render-mode-normal') as HTMLElement | null,
            center: document.getElementById('render-mode-center') as HTMLElement | null,
            outline: document.getElementById('render-mode-outline') as HTMLElement | null,
            all: document.getElementById('render-mode-all-points') as HTMLElement | null
        };

        const updateButtons = () => {
            this.updateToggleButton(buttons.normal, this.gaussianRenderMode === 0);
            this.updateToggleButton(buttons.center, this.gaussianRenderMode === 1);
            this.updateToggleButton(buttons.outline, this.gaussianRenderMode === 2);
            this.updateToggleButton(buttons.all, this.gaussianRenderMode === 3);
        };

        buttons.normal?.addEventListener('click', () => {
            this.gaussianRenderMode = 0;
            this.applyGaussianRenderMode();
            updateButtons();
        });
        buttons.center?.addEventListener('click', () => {
            this.gaussianRenderMode = 1;
            this.applyGaussianRenderMode();
            updateButtons();
        });
        buttons.outline?.addEventListener('click', () => {
            this.gaussianRenderMode = 2;
            this.applyGaussianRenderMode();
            updateButtons();
        });
        buttons.all?.addEventListener('click', () => {
            this.gaussianRenderMode = 3;
            this.applyGaussianRenderMode();
            updateButtons();
        });

        updateButtons();
    }

    private bindSidebarTabs() {
        const tabs = Array.from(document.querySelectorAll('.sidebar-tab')) as HTMLElement[];
        const panels = Array.from(document.querySelectorAll('.sidebar-panel-view')) as HTMLElement[];
        if (!tabs.length || !panels.length) return;

        const activate = (targetId: string) => {
            tabs.forEach((tab) => this.updateToggleButton(tab, tab.dataset.panelTarget === targetId));
            panels.forEach((panel) => panel.classList.toggle('hidden', panel.id !== targetId));
        };

        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const targetId = tab.dataset.panelTarget;
                if (targetId) activate(targetId);
            });
        });

        activate('panel-common');
    }

    private bindSimpleMemorySummary() {
        const memValue = document.getElementById('simple-memory-value');
        const gpuValue = document.getElementById('simple-gpu-memory-value');
        const memCard = document.getElementById('simple-memory-card');
        const gpuCard = document.getElementById('simple-gpu-memory-card');
        if (!memValue || !gpuValue || !memCard || !gpuCard) return;
        if (this.simpleMemorySummaryTimer !== null) return;

        // #WDD-gpt 2026-06-13 - 简化面板显示内存/显存摘要，详情放入多行 tooltip
        const update = () => {
            const stats = this.getSimpleMemoryStats();
            memValue.textContent = stats.memoryShort;
            gpuValue.textContent = stats.gpuShort;
            memCard.setAttribute('data-tip', stats.memoryDetail);
            memCard.setAttribute('title', stats.memoryDetail);
            gpuCard.setAttribute('data-tip', stats.gpuDetail);
            gpuCard.setAttribute('title', stats.gpuDetail);
        };

        update();
        this.simpleMemorySummaryTimer = window.setInterval(update, 1000);
    }

    private getSimpleMemoryStats() {
        const metrics = this.performanceMonitor.getCurrentMetrics();
        const device = this.performanceMonitor.getDeviceCapability();
        const modelCpuBytes = this.estimateModelCpuBytes();
        const textureBytes = this.estimateModelTextureBytes();
        const sourceBytes = this.getByteLength(this.lastParsedData?.sogBuffer || this.lastParsedData?.plyBuffer);
        const jsHeapBytes = typeof metrics?.memoryUsage === 'number' ? metrics.memoryUsage * 1024 * 1024 : 0;
        const gpuBytes = typeof metrics?.gpuMemory === 'number' ? metrics.gpuMemory : 0;
        const browserTextureBytes = typeof metrics?.textureMemory === 'number' ? metrics.textureMemory : 0;
        const memoryShortBytes = jsHeapBytes || modelCpuBytes + sourceBytes;
        const gpuShortBytes = gpuBytes || textureBytes || browserTextureBytes;

        const memoryDetail = [
            `JS Heap: ${jsHeapBytes ? this.formatCompactBytes(jsHeapBytes) : 'unavailable'}`,
            `Model CPU: ${this.formatCompactBytes(modelCpuBytes)}`,
            `Source Buffer: ${this.formatCompactBytes(sourceBytes)}`,
            `Points: ${this.getLoadedPointCount().toLocaleString()}`
        ].join('\n');

        const gpuDetail = [
            `WebGL Total: ${gpuBytes ? this.formatCompactBytes(gpuBytes) : 'unavailable'}`,
            `WebGL Textures: ${browserTextureBytes ? this.formatCompactBytes(browserTextureBytes) : 'unavailable'}`,
            `Model Texture Est: ${this.formatCompactBytes(textureBytes)}`,
            `GPU: ${device.gpuRenderer || 'unknown'}`,
            `Max Texture: ${device.maxTextureSize.toLocaleString()}`
        ].join('\n');

        return {
            memoryShort: memoryShortBytes ? this.formatCompactBytes(memoryShortBytes) : '--',
            gpuShort: gpuShortBytes ? this.formatCompactBytes(gpuShortBytes) : '--',
            memoryDetail,
            gpuDetail
        };
    }

    private estimateModelCpuBytes() {
        const parsed = this.lastParsedData || {};
        const values = [
            this.cachedPositions,
            this.originalIndices,
            parsed.trajectory,
            parsed.rotTrajectory,
            parsed.dcTrajectory,
            parsed.lifetime_mu,
            parsed.lifetime_w,
            parsed.lifetime_k
        ];
        const props = parsed?.plyData?.elements?.[0]?.properties;
        if (Array.isArray(props)) {
            props.forEach((prop: any) => values.push(prop?.storage));
        }
        return this.sumUniqueByteLengths(values);
    }

    private estimateModelTextureBytes() {
        const parsed = this.lastParsedData || {};
        return this.sumUniqueByteLengths([
            this.lifeTexData,
            this.scalesTexData,
            this.trajectoryData || parsed.trajectory,
            this.rotTrajectoryData || parsed.rotTrajectory,
            (this as any).dcTrajectoryData || parsed.dcTrajectory,
            this.selectionTool?.selectionTexture ? this.selectionTool?.selectionData : null,
            this.selectionTool?.selectionTexture ? this.selectionTool?.allTimeSelectionData : null
        ]);
    }

    private sumUniqueByteLengths(values: any[]) {
        const seen = new Set<ArrayBufferLike>();
        let total = 0;
        for (const value of values) {
            if (!value) continue;
            const buffer = value.buffer as ArrayBufferLike | undefined;
            if (buffer) {
                if (seen.has(buffer)) continue;
                seen.add(buffer);
            }
            total += this.getByteLength(value);
        }
        return total;
    }

    private getByteLength(value: any): number {
        if (!value) return 0;
        if (typeof value.byteLength === 'number' && Number.isFinite(value.byteLength)) return value.byteLength;
        if (value.buffer && typeof value.buffer.byteLength === 'number' && Number.isFinite(value.buffer.byteLength)) return value.buffer.byteLength;
        return 0;
    }

    private getLoadedPointCount() {
        const splatData = (this.splatEntity?.gsplat as any)?.asset?.resource?.splatData
            || (this.splatEntity?.gsplat as any)?.instance?.splatData
            || null;
        return Number(splatData?.numSplats || this.lastParsedData?.count || Math.floor((this.cachedPositions?.length || 0) / 3) || 0);
    }

    private formatCompactBytes(bytes: number) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '--';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return `${value.toFixed(unit === 0 ? 0 : value >= 10 ? 1 : 2)}${units[unit]}`;
    }

    private setupScene() { return this.sceneManager.setupScene(); }
    private initGrid() { return this.sceneManager.initGrid(); }
    private initAxes() { return this.sceneManager.initAxes(); }

    // #WDD 2026-01-16 Restored for internal logic / verification
    private setupEventListeners() {

        // 1. Disable Right-Click Context Menu
        window.addEventListener('contextmenu', e => e.preventDefault());

        const openBtn = document.getElementById('open-file');
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const resetBtn = document.getElementById('reset-cam');
        const exportTimestampBtn = document.getElementById('export-timestamp'); // #WDD 2026-01-16

        openBtn?.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.fileLoader.handleFileSelect(e));
        resetBtn?.addEventListener('click', () => this.resetCamera());

        const startArBtn = document.getElementById('start-ar');
        const arSelect = document.getElementById('ar-camera-select') as HTMLSelectElement;

        // Populate Cameras
        let isPopulatingCameras = false;
        const populateCameras = async () => {
            // Only populate if not already populated (beyond placeholder)
            if (!arSelect || arSelect.options.length > 1) return;
            // #WDD 2026-01-18 Fix: Prevent concurrent camera population
            if (isPopulatingCameras) return;

            isPopulatingCameras = true;
            try {
                const devices = await this.arHandler.getCameraDevices();

                // Double check after await in case another process somehow intervened (unlikely with flag but safe)
                // #WDD 2026-01-19: Clear existing options (keep placeholder at index 0) before populating to avoid duplicates
                while (arSelect.options.length > 1) {
                    arSelect.remove(1);
                }

                devices.forEach((d, i) => {
                    const opt = document.createElement('option');
                    opt.value = d.deviceId;
                    opt.text = d.label || `Camera ${i + 1}`;
                    arSelect.appendChild(opt);
                });
            } finally {
                isPopulatingCameras = false;
            }
        };

        // Populate only on explicit interaction (click) to avoid random camera light activation
        // startArBtn?.addEventListener('mouseenter', populateCameras);
        // arSelect?.addEventListener('mouseenter', populateCameras);

        arSelect?.addEventListener('click', populateCameras); // For mobile/touch

        startArBtn?.addEventListener('click', async () => {
            // Stop Face Tracking if active
            if (this.faceTrackingManager.isFaceTracking) {
                this.faceTrackingManager.faceTracker.stop();
                this.faceTrackingManager.isFaceTracking = false;
                this.updateToggleButton(document.getElementById('start-face-tracking'), false);
                document.getElementById('face-tracker-video-container')?.classList.add('hidden');
            }

            await populateCameras(); // Ensure populated before start if clicked rapidly

            // #WDD 2026-01-19: Update button state AFTER AR action completes
            if (this.arHandler.isARRunning) {
                this.arHandler.stop();
                this.updateToggleButton(startArBtn, false);
            } else {
                const deviceId = arSelect?.value;
                // If placeholder selected, pass undefined (default)
                await this.arHandler.start(deviceId || undefined);
                this.updateToggleButton(startArBtn, this.arHandler.isARRunning);
            }
        });

        // Handle Select Change
        arSelect?.addEventListener('change', () => {
            if (this.arHandler.isARRunning) {
                this.arHandler.stop();
                this.arHandler.start(arSelect.value).then(() => {
                    this.updateToggleButton(startArBtn, true);
                });
            } else {
                this.arHandler.start(arSelect.value).then(() => {
                    this.updateToggleButton(startArBtn, true);
                });
            }
        });

        // #WDD 2026-02-03 Face Tracking UI Logic
        const faceBtn = document.getElementById('start-face-tracking');
        const faceSelect = document.getElementById('face-tracking-camera-select') as HTMLSelectElement;
        const faceVideoContainer = document.getElementById('face-tracker-video-container');
        const faceVideoToggle = document.getElementById('toggle-face-video');

        const populateFaceCameras = async () => {
            if (!faceSelect || faceSelect.options.length > 1) return;
            // Reuse FaceTracker static helper
            const devices = await FaceTracker.getCameras();
            while (faceSelect.options.length > 1) faceSelect.remove(1);
            devices.forEach((d, i) => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.text = d.label || `Cam ${i + 1}`;
                faceSelect.appendChild(opt);
            });
        };

        faceSelect?.addEventListener('click', populateFaceCameras);

        faceBtn?.addEventListener('click', async () => {
            // Stop AR if active
            if (this.arHandler.isARRunning) {
                this.arHandler.stop();
                this.updateToggleButton(startArBtn, false);
            }

            if (this.faceTrackingManager.isFaceTracking) {
                this.faceTrackingManager.faceTracker.stop();
                this.faceTrackingManager.isFaceTracking = false;
                this.updateToggleButton(faceBtn, false);
                faceVideoContainer?.classList.add('hidden');
            } else {
                await populateFaceCameras();
                const deviceId = faceSelect?.value || undefined;
                try {
                    await this.faceTrackingManager.faceTracker.start(deviceId);
                    this.faceTrackingManager.isFaceTracking = true;
                    this.updateToggleButton(faceBtn, true);

                    // Show video container
                    faceVideoContainer?.classList.remove('hidden');

                    // Capture current position as base
                    // Capture base frame for orbit
                    if (this.camera) {
                        this.faceTrackingManager.faceTrackingBasePos.copy(this.camera.getPosition());
                        this.faceTrackingManager.faceTrackingBaseRight.copy(this.camera.right);
                        this.faceTrackingManager.faceTrackingBaseUp.copy(this.camera.up);

                        // User requested LookAt Origin (0,0,0)
                        this.faceTrackingManager.faceTrackingTarget.set(0, 0, 0);
                    }
                    this.faceTrackingManager.faceTrackingOffset.set(0, 0, 0);

                } catch (e) {
                    console.error("Failed to start face tracking", e);
                    alert("Failed to start face tracking. See console.");
                }
            }
        });

        // Handle select change for face tracking
        faceSelect?.addEventListener('change', () => {
            if (this.faceTrackingManager.isFaceTracking) {
                this.faceTrackingManager.faceTracker.stop();
                this.faceTrackingManager.faceTracker.start(faceSelect.value);
            }
        });

        faceVideoToggle?.addEventListener('click', () => {
            // Minimize/Maximize or close? User said "can hide".
            // Since there is a button inside the video container, maybe it toggles visibility.
            // But if we hide the container, we can't click it again.
            // So maybe this button just collapses it or we need a way to show it back.
            // Let's make it toggle the SIZE or hide it.
            // If hidden, how to bring back? "摄像机图像显示在屏幕的右下角（可以隐藏）"
            // Maybe the main toggle button (faceBtn) controls "Mode", and this small button hides the preview.
            // But if I hide the preview, the container disappears.
            // I'll leave it as "Close Preview" but keep tracking running.
            // But to show it again? Maybe I need a "Show Preview" checkbox or just click the main button again?
            // Actually, let's make it minimize.
            // But for now, simple toggle of 'hidden' class on the video element itself?
            // Container needs to stay potentially.
            // No, simplest: Hide the whole container. To show again, users might toggle the feature off/on.
            // Or better: The main setup toggles the mode. The video window can be closed.
            faceVideoContainer?.classList.add('hidden');
        });

        const btnExportSog = document.getElementById('btn-export-sog');
        btnExportSog?.addEventListener('click', () => {
            this.saveAsSOG4();
        });
        const btnExportPly4 = document.getElementById('btn-export-ply4');
        btnExportPly4?.addEventListener('click', () => {
            this.saveAsPLY4();
        });
        // #WDD-gpt  2026-07-16 - 绑定首页右上角独立的等点数 PLY 序列导出按钮
        const btnExportEqualCountPlySequence = document.getElementById('btn-export-equal-count-ply-sequence');
        btnExportEqualCountPlySequence?.addEventListener('click', () => {
            this.exportManager.exportEqualCountPlySequence();
        });
        const btnExportPly4Sequence = document.getElementById('btn-export-ply4-sequence');
        btnExportPly4Sequence?.addEventListener('click', () => {
            this.saveAsPLY4Sequence();
        });
        this.refreshExportButtons();
        const sidebar = document.getElementById('sidebar');
        const playbar = document.getElementById('playbar-container');
        const selectionToolbar = document.getElementById('selection-toolbar');
        const toggleUI = document.getElementById('toggle-ui');
        const headerBrand = document.getElementById('header-brand');

        const doToggle = () => this.toggleUIVisibility();


        toggleUI?.addEventListener('click', doToggle);
        const simplePrev = document.getElementById('simple-prev');
        const simpleNext = document.getElementById('simple-next');
        const simplePlay = document.getElementById('simple-play-pause');
        const simpleToggleUI = document.getElementById('simple-toggle-ui');
        this.bindSimpleMemorySummary();

        simplePrev?.addEventListener('click', () => {
            if (this.presetManager.cameraPresets.length === 0) return;
            let nextIdx = this.presetManager.currentPresetIndex - 1;
            if (nextIdx < 0) nextIdx = this.presetManager.cameraPresets.length - 1;
            this.presetManager.jumpToPreset(nextIdx);
        });
        simpleNext?.addEventListener('click', () => {
            if (this.presetManager.cameraPresets.length === 0) return;
            let nextIdx = this.presetManager.currentPresetIndex + 1;
            if (nextIdx >= this.presetManager.cameraPresets.length) nextIdx = 0;
            this.presetManager.jumpToPreset(nextIdx);
        });
        simplePlay?.addEventListener('click', () => this.togglePlay());
        simpleToggleUI?.addEventListener('click', doToggle);

        // --- Double Click to Toggle UI 已经被移除，留给多边形的双击截断操作 ---

        // Listen to Grid/Axes toggles in main index.html
        const btnGrid = document.getElementById('toggle-grid');
        const btnAxes = document.getElementById('toggle-axes');

        btnGrid?.addEventListener('click', () => {
            if (this.gridEntity) this.gridEntity.enabled = !this.gridEntity.enabled;
            this.updateToggleButton(btnGrid, this.gridEntity?.enabled ?? false);
        });

        btnAxes?.addEventListener('click', () => {
            if (this.axesEntity) this.axesEntity.enabled = !this.axesEntity.enabled;
            this.updateToggleButton(btnAxes, this.axesEntity?.enabled ?? false);
        });

        // Init Button States
        if (btnGrid) this.updateToggleButton(btnGrid, this.gridEntity?.enabled ?? false);
        if (btnAxes) this.updateToggleButton(btnAxes, this.axesEntity?.enabled ?? false);
        this.bindSidebarTabs();
        this.bindGaussianRenderModeControls();
        this.bindSHLevelControls();
        this.bindLabControls();

        const dropZone = document.getElementById('drop-zone');
        const dropMsg = document.getElementById('drop-msg');

        window.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone?.classList.add('active');
            if (dropMsg) dropMsg.style.opacity = '0.5';
        });
        window.addEventListener('dragleave', () => {
            dropZone?.classList.remove('active');
            if (dropMsg) dropMsg.style.opacity = '0.1';
        });
        window.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropZone?.classList.remove('active');
            if (dropMsg) dropMsg.style.opacity = '0.1';

            const files = await this.fileLoader.collectDroppedFiles(e);
            if (files.length > 0) {
                await this.fileLoader.handleDroppedFiles(files);
            }
        });


        const updateObjectTransform = () => {
            if (!this.splatEntity) return;
            const px = parseFloat((document.getElementById('pos-x') as HTMLInputElement).value) || 0;
            const py = parseFloat((document.getElementById('pos-y') as HTMLInputElement).value) || 0;
            const pz = parseFloat((document.getElementById('pos-z') as HTMLInputElement).value) || 0;
            const rx = parseFloat((document.getElementById('rot-x') as HTMLInputElement).value) || 0;
            const ry = parseFloat((document.getElementById('rot-y') as HTMLInputElement).value) || 0;
            const rz = parseFloat((document.getElementById('rot-z') as HTMLInputElement).value) || 0;
            const s = parseFloat((document.getElementById('scale-uniform') as HTMLInputElement | null)?.value || '1') || 1;

            this.splatEntity.setPosition(px, py, pz);
            this.splatEntity.setEulerAngles(rx, ry, rz);
            this.splatEntity.setLocalScale(s, s, s);
            this.modelTransformEdited = true;

            if (this.isSog4SequenceMode && this.sog4SequenceSegments.length) {
                const q = this.splatEntity.getLocalRotation();
                this.sog4SequenceSharedTransform = { pos: [px, py, pz], rot: [q.x, q.y, q.z, q.w], scale: [s, s, s] };
                for (const seg of this.sog4SequenceSegments) {
                    if (!seg.entity) continue;
                    seg.entity.setLocalPosition(px, py, pz);
                    seg.entity.setLocalEulerAngles(rx, ry, rz);
                    seg.entity.setLocalScale(s, s, s);
                }
            }

        };


        // --- View Presets ---
        document.getElementById('view-top')?.addEventListener('click', () => {
            if (!this.camera) return;
            this.camera.setPosition(0, 5, 0);
            this.camera.setEulerAngles(-90, 0, 0);
            this.pitch = -90; this.yaw = 0;
        });

        // --- Custom Debug Toggle (K Key) #WDD 2026-01-15 ---
        window.addEventListener('keydown', (e) => {
            if (e.key === 'k' || e.key === 'K') {
                this.swizzleMode = (this.swizzleMode + 1) % 3;
                console.log(`[Debug] Switched Swizzle Mode to: ${this.swizzleMode} (0=yzwx, 1=xyzw, 2=wxyz)`);

                if (this.splatEntity?.gsplat) {
                    const instance = (this.splatEntity.gsplat as any).instance;
                    if (instance && instance.material) {
                        instance.material.setParameter('uSwizzleMode', this.swizzleMode);
                        instance.material.update();
                    }
                }
            }
            if (e.key === 'l' || e.key === 'L') {
                // Log Texture debug info
                console.log("--- Texture Debug Info ---");
                if (this.splatEntity?.gsplat) {
                    const instance = (this.splatEntity.gsplat as any).instance;
                    // We can't easily read GPU texture back here without async, but we can check sizes
                    // Actually we logged sizes during load.
                }
            }
        });

        document.getElementById('view-front')?.addEventListener('click', () => {
            if (!this.camera) return;
            this.camera.setPosition(0, 0, 5);
            this.camera.setEulerAngles(0, 0, 0);
            this.pitch = 0; this.yaw = 0;
        });
        document.getElementById('view-side')?.addEventListener('click', () => {
            if (!this.camera) return;
            this.camera.setPosition(5, 0, 0);
            this.camera.setEulerAngles(0, 90, 0);
            this.pitch = 0; this.yaw = 90;
        });

        // --- Themes ---
        const themeBtn = document.getElementById('toggle-theme');
        let currentTheme = 'dark';

        // --- Transition Effect Toggle #WDD 2026-01-15 ---
        const transitionBtn = document.getElementById('toggle-transition-effect');
        transitionBtn?.addEventListener('click', () => {
            this.effects.isEnabled = !this.effects.isEnabled;
            this.updateToggleButton(transitionBtn, this.effects.isEnabled);
        });
        if (transitionBtn) this.updateToggleButton(transitionBtn, this.effects.isEnabled);

        const updateTheme = (theme: string) => {
            currentTheme = theme;
            if (this.camera?.camera) {
                if (theme === 'light') {
                    this.camera.camera.clearColor = new pc.Color(0.95, 0.96, 0.98, 1);
                    document.body.classList.add('theme-light');
                } else {
                    this.camera.camera.clearColor = new pc.Color(0.1, 0.1, 0.1, 1);
                    document.body.classList.remove('theme-light');
                }
                // Keep the button 'active' (highlighted) to match other tools in the panel
                if (themeBtn) this.updateToggleButton(themeBtn, true);
            }
        };

        // Initialize state: make it active (green) by default to match Grid/Axes
        if (themeBtn) this.updateToggleButton(themeBtn, true);

        themeBtn?.addEventListener('click', () => {
            updateTheme(currentTheme === 'dark' ? 'light' : 'dark');
        });

        const fpsItems = document.querySelectorAll('.fps-item');
        fpsItems.forEach(item => {
            item.addEventListener('click', () => {
                const val = (item as HTMLElement).dataset.value;
                if (val) {
                    this.fps = parseInt(val);
                    // Update active state
                    fpsItems.forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                }
            });
        });

        const playBtn = document.getElementById('play-pause');
        const timeSlider = document.getElementById('time-slider') as HTMLInputElement;
        const stepBackBtn = document.getElementById('step-frame-back');
        const stepForwardBtn = document.getElementById('step-frame-forward');
        const loopSetStartBtn = document.getElementById('loop-set-start');
        const loopSetEndBtn = document.getElementById('loop-set-end');
        const loopToggleBtn = document.getElementById('timeline-loop-toggle');

        playBtn?.addEventListener('click', () => this.togglePlay());
        stepBackBtn?.addEventListener('click', () => this.stepFrame(-1));
        stepForwardBtn?.addEventListener('click', () => this.stepFrame(1));
        loopSetStartBtn?.addEventListener('click', () => {
            this.loopStartFrame = this.clampTimelineFrame(this.currentTime);
            this.normalizeLoopRange();
            this.renderTimelineDecorations();
        });
        loopSetEndBtn?.addEventListener('click', () => {
            this.loopEndFrame = this.clampTimelineFrame(this.currentTime);
            this.normalizeLoopRange();
            this.renderTimelineDecorations();
        });
        loopToggleBtn?.addEventListener('click', () => {
            this.normalizeLoopRange();
            this.loopEnabled = !this.loopEnabled;
            if (this.loopEnabled) {
                this.seekToFrame(Math.max(this.loopStartFrame, this.currentTime), { pause: false });
            }
            this.renderTimelineDecorations();
        });

        let isScrubbing = false;

        timeSlider?.addEventListener('mousedown', () => { isScrubbing = true; });
        timeSlider?.addEventListener('mouseup', () => { isScrubbing = false; });
        timeSlider?.addEventListener('touchstart', () => { isScrubbing = true; });
        timeSlider?.addEventListener('touchend', () => { isScrubbing = false; });

        // Ensure slider has fine granularity for dragging
        if (timeSlider) timeSlider.step = "1";

        timeSlider?.addEventListener('input', () => {
            const requestedFrame = parseFloat(timeSlider.value);
            this.seekToFrame(requestedFrame, { pause: false });
        });

        // Close text edit when clicking anywhere outside
        window.addEventListener('mousedown', (e) => {
            const panel = document.getElementById('text-edit-panel');
            if (panel && panel.classList.contains('show')) {
                const target = e.target as HTMLElement;
                const isOverlay = target.closest('#text-overlay-container');
                const isPanel = target.closest('#text-edit-panel');
                const isPresetBtn = target.closest('.add-text');

                if (!isOverlay && !isPanel && !isPresetBtn) {
                    this.presetManager.closeTextEdit();
                }
            }
        });

        // --- Interaction & Keyboard ---
        let isLMB = false;
        let isRMB = false;
        const lastMousePos = new pc.Vec2();
        const keys: Record<string, boolean> = {};
        let isUIInteracting = false;
        let isHoveringUI = false; // #WDD 2026-01-15 Tracking hover state separately

        // Block camera when mouse is over UI panels
        // #WDD 2026-01-15 Added 'control-panel' to the list to cover the entire right area
        // #WDD 2026-01-19 Added all UI panels to strictly block camera control
        // #WDD-gpt 2026-05-17 帮助弹窗也要阻断相机控制
        const uiPanels = [
            'sidebar',
            'control-panel',
            'time-controls',
            'header-brand',
            'selection-toolbar',
            'selection-top-right-toolbar',
            'left-tools-panel',
            'smart-selection-panel',
            'lab-panel',
            'text-edit-panel',
            'simplified-panel',
            'samples-dropdown',
            'loading-overlay',
            'help-modal',
            'stereo-controls' // #WDD-gpt  2026-08-04 - 拖动立体视差时阻断全局鼠标事件，避免中心相机同步旋转
        ];
        uiPanels.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('mouseenter', () => { isHoveringUI = true; });
            el.addEventListener('mouseleave', () => { isHoveringUI = false; });
            el.addEventListener('mousedown', (e) => {
                isHoveringUI = true; // Extra safety
                e.stopPropagation();
            });
            el.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: false }); // #WDD 2026-01-19 Block scroll explicitly
            el.addEventListener('touchstart', (e) => {
                isHoveringUI = true;
                // Don't stop propagation if we want the actual touch event to reach children (like buttons)
                // but we want to prevent the camera from moving.
            }, { passive: true });
        });

        window.addEventListener('mouseup', () => {
            isLMB = false;
            isRMB = false;
            // #WDD 2026-01-15 Removed reset here as it was breaking camera lock when mouse is still over UI
            // if (!activeScrubInput) isUIInteracting = false; 
            document.body.style.cursor = 'default';
        });

        // --- Scrub Logic (Drag to change) ---
        let activeScrubInput: HTMLInputElement | null = null;
        let scrubStartX = 0;
        let scrubStartVal = 0;

        // #WDD-gpt 2026-05-16 - 通用 scrub 输入绑定：支持鼠标拖拽改变数值
        const bindScrubInput = (input: HTMLInputElement, onChange: () => void, stepScale = 0.05) => {
            input.addEventListener('input', onChange);

            input.addEventListener('mousedown', (e) => {
                activeScrubInput = input;
                isUIInteracting = true;
                scrubStartX = e.clientX;
                scrubStartVal = parseFloat(input.value) || 0;
                document.body.style.cursor = 'ew-resize';
                input.select();
                e.stopPropagation(); // Avoid sidebar mousedown interference
            });

            input.addEventListener('touchstart', (e) => {
                activeScrubInput = input;
                isUIInteracting = true;
                scrubStartX = e.touches[0].clientX;
                scrubStartVal = parseFloat(input.value) || 0;
                input.select();
                e.stopPropagation();
            }, { passive: true });

            // Store step scale on element for handleMove to read
            (input as any)._scrubStep = stepScale;
            (input as any)._scrubOnChange = onChange;
        };

        ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scale-uniform'].forEach(id => {
            const input = document.getElementById(id) as HTMLInputElement;
            if (!input) return;
            const step = input.id.startsWith('rot') ? 1 : (input.id === 'scale-uniform' ? 0.02 : 0.05);
            bindScrubInput(input, updateObjectTransform, step);
        });

        // #WDD-gpt 2026-05-16 - 圆柱选择区输入框也支持 scrub 拖拽
        const smartSelectionTool = (this as any).smartSelectionTool;
        ['smart-cylinder-radius', 'smart-cylinder-height', 'smart-cylinder-x', 'smart-cylinder-z', 'smart-cylinder-ground'].forEach(id => {
            const input = document.getElementById(id) as HTMLInputElement;
            if (!input) return;
            bindScrubInput(input, () => {
                if (smartSelectionTool && typeof smartSelectionTool.updateCylinderFromInputs === 'function') {
                    smartSelectionTool.updateCylinderFromInputs();
                }
            }, 0.01);
        });

        const handleMove = (clientX: number) => {
            if (!activeScrubInput) return;
            isUIInteracting = true;
            const delta = clientX - scrubStartX;
            const step = (activeScrubInput as any)._scrubStep ?? 0.05;
            const newVal = scrubStartVal + delta * step;

            if (activeScrubInput.id.startsWith('rot')) {
                activeScrubInput.value = Math.round(newVal).toString();
            } else if (activeScrubInput.id === 'scale-uniform') {
                activeScrubInput.value = Math.max(0.0001, newVal).toFixed(3);
            } else if (activeScrubInput.id.startsWith('smart-cylinder-')) {
                activeScrubInput.value = newVal.toFixed(3);
            } else {
                activeScrubInput.value = newVal.toFixed(2);
            }

            const onChange = (activeScrubInput as any)._scrubOnChange;
            if (onChange) onChange();
            else updateObjectTransform();
        };

        window.addEventListener('mousemove', (e) => handleMove(e.clientX));
        window.addEventListener('touchmove', (e) => {
            if (activeScrubInput) {
                handleMove(e.touches[0].clientX);
                if (e.cancelable) e.preventDefault(); // Prevent scrolling while scrubbing
            }
        }, { passive: false });

        window.addEventListener('keydown', (e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

            if (e.key.toLowerCase() === 'h') {
                this.toggleUIVisibility();
            }
            if (e.key === ' ') {
                e.preventDefault();
                this.togglePlay();
            }
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.stepFrame(-1);
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.stepFrame(1);
            }
            // #WDD 2026-01-16 'e' key removed
        });

        const handleEnd = () => {
            if (activeScrubInput) {
                activeScrubInput = null;
                isUIInteracting = false;
                document.body.style.cursor = 'default';
            }
        };

        window.addEventListener('mouseup', handleEnd);
        window.addEventListener('touchend', handleEnd);

        // Initialize rotation state from default camera
        this.pitch = 0;
        this.yaw = 0;

        window.addEventListener('keydown', (e) => {
            if (isUIInteracting || isHoveringUI) return; // #WDD 2026-01-15 Also check hover
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

            keys[e.code] = true;
            if (e.code === 'Space') {
                e.preventDefault();
                this.togglePlay();
            }
            if (e.code === 'Escape') {
                if (this.selectionTool && this.selectionTool.currentTool !== 'none') {
                    this.selectionTool.setTool('none');
                }
            }
        });
        window.addEventListener('keyup', (e) => { keys[e.code] = false; });

        // #WDD 2026-04-20: Double-click on canvas to restore full UI when in hidden mode
        let lastMouseDownTime = 0;
        this.app.mouse.on(pc.EVENT_MOUSEDOWN, (e: any) => {
            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (isUIInteracting || isHoveringUI || isEditing) return; // #WDD 2026-01-15 Also check hover
            if (e.button === pc.MOUSEBUTTON_LEFT) isLMB = true;
            if (e.button === pc.MOUSEBUTTON_RIGHT) isRMB = true;
            lastMousePos.set(e.x, e.y);

            // Detect double-click on canvas when UI is hidden -> restore full UI
            const now = Date.now();
            if (this.isUIHidden() && (now - lastMouseDownTime) < 300) {
                this.toggleUIVisibility(false);
            }
            lastMouseDownTime = now;
        });

        this.app.mouse.on(pc.EVENT_MOUSEMOVE, (e: pc.MouseEvent) => {
            // #WDD 2026-01-18 Lock Camera in AR
            if (this.arHandler && this.arHandler.isARRunning) return;

            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (!this.camera || isUIInteracting || isHoveringUI || isEditing || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return; // #WDD 2026-01-15 Also check hover
            const dx = e.x - lastMousePos.x;
            const dy = e.y - lastMousePos.y;

            if (isLMB) {
                this.yaw -= dx * 0.2;
                this.pitch -= dy * 0.2;
                this.pitch = Math.max(-89, Math.min(89, this.pitch));

                if (this.isOrbitMode) {
                    // Keep orbit distance consistent with any manual camera moves (e.g. WASD translate).
                    // Otherwise the next orbit update snaps back to the old stored orbitDistance.
                    this.orbitDistance = Math.max(1.0, this.camera.getPosition().length());

                    // #WDD 2026-01-21 Orbit around origin (0,0,0)
                    // Convert spherical to cartesian
                    // Assuming orbitDistance is maintained
                    // Actually, let's keep current distance or use fixed? User asked for "move on a sphere".
                    // Let's use current distance from origin to allow zoom
                    this.orbitCameraUpdates();
                } else {
                    this.camera.setEulerAngles(this.pitch, this.yaw, 0);
                }
            } else if (isRMB) {
                if (!this.isOrbitMode) {
                    this.camera.translateLocal(-dx * 0.01, dy * 0.01, 0);
                }
            }
            lastMousePos.set(e.x, e.y);
        });

        // Zoom logic #WDD 2026-01-15
        this.app.mouse.on(pc.EVENT_MOUSEWHEEL, (e: any) => {
            // #WDD 2026-01-18 Lock Camera in AR
            if (this.arHandler && this.arHandler.isARRunning) return;

            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (this.camera && !isUIInteracting && !isEditing && (!this.selectionTool || this.selectionTool.currentTool === 'none')) {
                if (this.isOrbitMode) {
                    this.orbitDistance -= e.wheel * 0.5;
                    this.orbitDistance = Math.max(1.0, this.orbitDistance);
                    this.orbitCameraUpdates();
                } else {
                    this.camera.translateLocal(0, 0, -e.wheel * 0.5);
                }
            }
        });

        // --- Touch Support ---
        let lastTouchDistance = 0;
        let lastTouchPos = new pc.Vec2();
        let prevTouchCount = 0;

        this.app.touch.on(pc.EVENT_TOUCHSTART, (e: any) => {
            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (isUIInteracting || isEditing || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return;

            prevTouchCount = e.touches.length;

            if (e.touches.length === 1) {
                lastMousePos.set(e.touches[0].x, e.touches[0].y);
            } else if (e.touches.length === 2) {
                const t0 = e.touches[0];
                const t1 = e.touches[1];
                lastTouchDistance = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                lastTouchPos.set((t0.x + t1.x) / 2, (t0.y + t1.y) / 2);
            }
        });

        this.app.touch.on(pc.EVENT_TOUCHMOVE, (e: any) => {
            // #WDD 2026-01-18 Lock Camera in AR
            if (this.arHandler && this.arHandler.isARRunning) return;

            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            if (!this.camera || isUIInteracting || isEditing || (this.selectionTool && this.selectionTool.currentTool !== 'none')) return;
            // e.event.preventDefault(); // Managed by PlayCanvas TouchDevice usually, but good for safety

            // Detect touch count change (switch between single/multi touch) and reset anchors
            if (e.touches.length !== prevTouchCount) {
                prevTouchCount = e.touches.length;
                if (e.touches.length === 1) {
                    lastMousePos.set(e.touches[0].x, e.touches[0].y);
                } else if (e.touches.length === 2) {
                    const t0 = e.touches[0];
                    const t1 = e.touches[1];
                    lastTouchDistance = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                    lastTouchPos.set((t0.x + t1.x) / 2, (t0.y + t1.y) / 2);
                }
                return; // Skip movement this frame to avoid jumps
            }

            if (e.touches.length === 1) {
                const t = e.touches[0];
                const dx = t.x - lastMousePos.x;
                const dy = t.y - lastMousePos.y;
                this.yaw -= dx * 0.2;
                this.pitch -= dy * 0.2;
                this.pitch = Math.max(-89, Math.min(89, this.pitch));

                if (this.isOrbitMode) {
                    this.orbitCameraUpdates();
                } else {
                    this.camera.setEulerAngles(this.pitch, this.yaw, 0);
                }
                lastMousePos.set(t.x, t.y);
            } else if (e.touches.length === 2 && !this.isOrbitMode) { // Disable pan in Orbit Mode for now, allow Zoom
                const t0 = e.touches[0];
                const t1 = e.touches[1];

                // Pinch to Zoom
                const dist = Math.hypot(t0.x - t1.x, t0.y - t1.y);
                const deltaDist = dist - lastTouchDistance;

                if (this.isOrbitMode) {
                    this.orbitDistance -= deltaDist * 0.02;
                    this.orbitDistance = Math.max(1.0, this.orbitDistance);
                    this.orbitCameraUpdates();
                } else {
                    this.camera.translateLocal(0, 0, -deltaDist * 0.02); // Faster zoom for touch
                }
                lastTouchDistance = dist;

                // Two-finger Pan
                const midX = (t0.x + t1.x) / 2;
                const midY = (t0.y + t1.y) / 2;
                const dx = midX - lastTouchPos.x;
                const dy = midY - lastTouchPos.y;
                this.camera.translateLocal(-dx * 0.01, dy * 0.01, 0);
                lastTouchPos.set(midX, midY);
            }
        });

        this.app.touch.on(pc.EVENT_TOUCHEND, (e: pc.TouchEvent) => {
            // Update count, but rely on TOUCHMOVE to reset anchors if needed
            // If we reset here, TOUCHMOVE sees "same count" and might jump if coordinates shifted
            // If we don't reset here, TOUCHMOVE sees "diff count" and triggers the guard.
            // However, updating the count is good practice for state tracking.
            // Let's NOT update prevTouchCount here, to force TOUCHMOVE to detect the mismatch.
            // But if we stop touching completely (count 0), we should probably know.
            if (e.touches.length === 0) {
                prevTouchCount = 0;
            }
        });

        this.app.on('update', (dt: number) => {
            this.presetManager.update(dt);

            // WASD Camera Movement - blocked only if we are actively scrubbing or focused on UI
            const activeEl = document.activeElement as HTMLElement;
            const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);

            const isEditing = !!document.getElementById('text-edit-panel')?.classList.contains('show');
            // #WDD 2026-01-18 Lock Camera in AR (Added isARRunning check)
            if (this.camera && !isUIInteracting && !isHoveringUI && !isEditing && !this.presetManager.isCameraAnimating && !isTyping && !(this.arHandler && this.arHandler.isARRunning)) {
                const speed = dt * 5;
                if (this.isOrbitMode) {
                    // In orbit mode, WASD should behave like zoom (W/S) and not break the orbit constraints.
                    let changed = false;
                    if (keys['KeyW']) { this.orbitDistance = Math.max(1.0, this.orbitDistance - speed); changed = true; }
                    if (keys['KeyS']) { this.orbitDistance = Math.max(1.0, this.orbitDistance + speed); changed = true; }
                    if (changed) this.orbitCameraUpdates();
                } else {
                    if (keys['KeyW']) this.camera.translateLocal(0, 0, -speed);
                    if (keys['KeyS']) this.camera.translateLocal(0, 0, speed);
                    if (keys['KeyA']) this.camera.translateLocal(-speed, 0, 0);
                    if (keys['KeyD']) this.camera.translateLocal(speed, 0, 0);
                }
                if (keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD']) {
                    // Sync overlays on manual move too? Maybe not every frame, but proximity needs it.
                }
                if (!this.isOrbitMode) {
                    if (keys['KeyQ']) this.camera.translateLocal(0, -speed, 0);
                    if (keys['KeyE']) this.camera.translateLocal(0, speed, 0);
                }
            }

            if (this.isPlaying) {
                const totalFrames = this.isSog4SequenceMode ? (this.sog4SequenceTotalFrames || this.duration) : this.duration;
                const globalMaxTime = Math.max(0, totalFrames - 1.0);
                this.normalizeLoopRange();
                const loopStart = this.loopEnabled ? this.loopStartFrame : 0;
                const loopEnd = this.loopEnabled ? Math.min(this.loopEndFrame, globalMaxTime) : globalMaxTime;

                if (this.is4DGS && this.trajectoryData && !this.isSog4SequenceMode && !this.isSequenceMode) {
                    this.playbackTime += dt * this.fps;
                    if (this.playbackTime > loopEnd) {
                        this.playbackTime = loopStart;
                    }
                    const nextFrame = Math.floor(this.playbackTime);
                    if (nextFrame !== Math.floor(this.currentTime)) {
                        this.requestSortedFrame(nextFrame);
                    }
                } else {
                    if (!this.isWaitingForSort) {
                        this.currentTime += dt * this.fps;
                    }
                    if (this.currentTime > loopEnd) {
                        this.currentTime = loopStart;
                        if (this.isSog4SequenceMode) {
                            const targetSeg = this.getSog4SegmentIndex(loopStart);
                            void this.activateSog4SequenceSegment(targetSeg);
                        }
                    }
                }

                let displayFrame = 0;
                let total = 0;
                if (this.isSog4SequenceMode) {
                    const info = this.updateSog4SequenceTime();
                    displayFrame = info.displayFrame;
                    total = Math.max(0, Math.ceil(info.total) - 1);
                } else {
                    // For UI, we floor to closest frame
                    displayFrame = Math.floor(this.currentTime);
                    // #WDD 2026-01-16 Fix: Display 0 to N-1
                    total = Math.max(0, Math.ceil(this.duration) - 1); // Duration is roughly max frame index or count

                    // Sequence mode switches whole gsplat assets per frame (static-per-frame playback).
                    if (this.isSequenceMode) {
                        void this.applySequenceFrame(displayFrame);
                    }

                    if (this.splatEntity?.gsplat) {
                        // #wdd-claude 2026-06-11 修复高频崩溃: instance 在异步加载/换段瞬间可能为 undefined，
                        // 原先 .instance.material 缺可选链会在 onUpdate(每帧)抛 TypeError。补 ?. 与其它访问点一致。
                        const material = (this.splatEntity.gsplat as any).instance?.material;
                        if (material) {
                            const shaderTime = Math.floor(this.currentTime); // #WDD 2026-01-18: Integer time
                            material.setParameter('uTime', shaderTime);
                            material.setParameter('uGlobalTotalFrames', this.duration);
                        }
                    }
                }

                // Only auto-update slider if user is NOT scrubbing
                if (timeSlider && !isScrubbing) {
                    timeSlider.value = displayFrame.toString();
                }
                this.syncTimelineUIForPlayback(displayFrame, total);
            } else {
                
                // Also update on scrub
                if (this.isSog4SequenceMode) {
                    const info = this.updateSog4SequenceTime();
                    this.syncTimelineUI(info.displayFrame, Math.max(0, Math.ceil(info.total) - 1));
                } else {
                    if (this.splatEntity?.gsplat) {
                        // #wdd-claude 2026-06-11 修复高频崩溃: 同上, instance 可能未就绪, 补可选链。
                        const material = (this.splatEntity.gsplat as any).instance?.material;
                        if (material) {
                            const shaderTime = Math.floor(this.currentTime); // #WDD 2026-01-18: Integer time
                            material.setParameter('uTime', shaderTime);
                            material.setParameter('uGlobalTotalFrames', this.duration);
                        }
                    }

                    if (this.isSequenceMode) {
                        void this.applySequenceFrame(Math.floor(this.currentTime));
                    }
                    this.syncTimelineUI(Math.floor(this.currentTime), Math.max(0, Math.ceil(this.duration) - 1));
                }
            }

            // #WDD-gpt 2026-06-13 - ALL 点云模式按当前帧刷新位置，但不经过生命周期/透明度/删除过滤
            this.refreshDebugAllPointsEntityThrottled();
        });

        // --- Samples Dropdown ---
        const toggleSamples = document.getElementById('toggle-samples');
        const samplesDropdown = document.getElementById('samples-dropdown');

        toggleSamples?.addEventListener('click', (e) => {
            samplesDropdown?.classList.toggle('hidden');
            toggleSamples.classList.toggle('open');
            e.stopPropagation();
        });

        window.addEventListener('click', (e) => {
            if (!samplesDropdown?.contains(e.target as Node)) {
                samplesDropdown?.classList.add('hidden');
                toggleSamples?.classList.remove('open');
            }
        });

        const initSamples = async () => {
            if (!samplesDropdown) return;
            try {
                // 1. Fetch config first
                const response = await fetch('./samples.json');
                if (!response.ok) return;
                const samples = await response.json() as { name: string, url: string, mirror?: string }[];



                // Clear existing
                samplesDropdown.innerHTML = '';

                samples.forEach(sample => {
                    const pUrl = sample.url;
                    const mode = "Local";

                    const btn = document.createElement('button');
                    btn.className = 'sample-item ui-item group';
                    btn.dataset.url = pUrl;
                    btn.title = `Source: ${mode}`;
                    btn.innerHTML = `
                        <div class="ui-dot bg-blue-400"></div>
                        <span class="text-[10px] ui-text-primary font-medium">${sample.name}</span>
                    `;
                    btn.addEventListener('click', () => {
                        console.log(`[SmartLoader] Loading ${sample.name} via ${mode}: ${pUrl}`);
                        this.fileLoader.loadSampleFile(pUrl);
                        samplesDropdown?.classList.add('hidden');
                        toggleSamples?.classList.remove('open');
                    });
                    samplesDropdown.appendChild(btn);
                });
            } catch (err) {
                console.warn('Failed to load samples.json', err);
            }
        };

        initSamples();

        // --- Camera Presets ---
        const addPresetBtn = document.getElementById('add-preset');
        const clearPresetsBtn = document.getElementById('clear-presets');
        const previewPresetAnimationBtn = document.getElementById('preview-preset-animation');
        const recordPresetVideoBtn = document.getElementById('record-preset-video');

        this.presetManager.renderPresets();
        addPresetBtn?.addEventListener('click', () => {
            if (!this.camera) return;
            this.presetManager.cameraPresets.push({
                name: `CAM_${this.presetManager.cameraPresets.length + 1}`,
                pos: this.camera.getPosition().clone(),
                pitch: this.pitch,
                yaw: this.yaw
            });
            this.presetManager.renderPresets();
        });

        clearPresetsBtn?.addEventListener('click', () => {
            if (confirm('Clear all presets?')) {
                this.presetManager.cameraPresets = [];
                this.presetManager.renderPresets();
            }
        });

        recordPresetVideoBtn?.addEventListener('click', () => {
            void this.presetManager.recordPresetVideo();
        });

        previewPresetAnimationBtn?.addEventListener('click', () => {
            this.presetManager.previewPresetAnimation();
        });
    }

    private togglePlay() { return this.timelineManager.togglePlay(); }

    private isUIHidden() {
        const sidebar = document.getElementById('sidebar');
        return sidebar?.classList.contains('sidebar-hidden');
    }

    private toggleUIVisibility(forceHidden?: boolean) {
        const sidebar = document.getElementById('sidebar');
        const playbar = document.getElementById('playbar-container');
        const selectionToolbar = document.getElementById('selection-toolbar');
        const selectionTopbar = document.getElementById('selection-top-right-toolbar');
        const leftToolsPanel = document.getElementById('left-tools-panel');
        const smartSelectionPanel = document.getElementById('smart-selection-panel');
        const labPanel = document.getElementById('lab-panel');
        const controlPanel = document.getElementById('control-panel');
        const simplifiedPanel = document.getElementById('simplified-panel');

        const shouldHide = forceHidden !== undefined ? forceHidden : !this.isUIHidden();
        const wasOrbitMode = this.isOrbitMode;

        if (shouldHide) {
            sidebar?.classList.add('sidebar-hidden');
            playbar?.classList.add('bottom-bar-hidden');
            selectionToolbar?.classList.add('tools-hidden');
            selectionTopbar?.classList.add('tools-hidden');
            leftToolsPanel?.classList.add('tools-hidden');
            smartSelectionPanel?.classList.add('tools-hidden');
            labPanel?.classList.add('tools-hidden');
            controlPanel?.classList.add('panel-hidden');
            simplifiedPanel?.classList.remove('hidden-panel');
        } else {
            sidebar?.classList.remove('sidebar-hidden');
            playbar?.classList.remove('bottom-bar-hidden');
            selectionToolbar?.classList.remove('tools-hidden');
            selectionTopbar?.classList.remove('tools-hidden');
            leftToolsPanel?.classList.remove('tools-hidden');
            smartSelectionPanel?.classList.remove('tools-hidden');
            labPanel?.classList.remove('tools-hidden');
            controlPanel?.classList.remove('panel-hidden');
            simplifiedPanel?.classList.add('hidden-panel');
        }

        // #WDD 2026-01-21 Sync Orbit Mode with UI state (Simple Mode = Orbit Mode)
        // Mobile users are locked in Orbit Mode handled by initialization logic, 
        // but if they somehow toggle UI, we enforce relation unless specifically overridden.
        // Actually, for consistency: Simple UI -> Orbit Mode. Full UI -> Editor Mode.
        this.isOrbitMode = shouldHide;
        if (shouldHide && !wasOrbitMode) {
            this.faceTrackingManager.syncOrbitFromCamera();
        }

        // #WDD 2026-01-21 Auto-hide Grid and Axes in Simple Mode
        if (this.gridEntity) this.gridEntity.enabled = !shouldHide;
        if (this.axesEntity) this.axesEntity.enabled = !shouldHide;

        // #WDD 2026-01-21 Manage Skybox Visibility via Manager
        if (shouldHide) {
            // In Simple Mode, show skybox
            this.setSkybox(this.selectedSkyboxName);
        } else {
            // In Editor Mode, hide skybox
            this.skyboxManager.clearSkybox();
        }
    }





    private createSequenceProgressUpdater() {
        const overlay = document.getElementById('loading-overlay');
        const statusEl = document.getElementById('loading-status');
        const detailEl = document.getElementById('loading-detail');
        const bar = document.getElementById('loading-step-progress');
        const squares = Array.from(document.querySelectorAll('.step-square'));
        return (step: number, status: string, detail?: string) => {
            overlay?.classList.remove('hidden');
            if (statusEl) statusEl.innerText = status;
            if (detailEl) detailEl.innerText = detail || '';
            if (bar) {
                const maxIndex = Math.max(squares.length - 1, 1);
                const pct = Math.min(Math.max((step / maxIndex) * 100, 0), 100);
                bar.style.width = `${pct}%`;
            }
            squares.forEach((square, idx) => {
                if (idx <= step) square.classList.add('reached');
                else square.classList.remove('reached');
            });
        };
    }

    private activeLoadingSequenceCleanup() {
        // #WDD-gpt 2026-06-13 - 新序列加载前清理独立 ALL 点云，避免旧 debug mesh 残留
        this.destroyDebugAllPointsEntity();
        this.disposeDynamicSorter();
        if (this.splatEntity) {
            this.splatEntity.destroy();
            this.splatEntity = null;
        }
        // #WDD-gpt 2026-07-31 - 旧渲染实体销毁后再释放重光照纹理，避免加载期间引用失效
        this.ply4Relighting.disposeAllNormalTextures();
        this.presetManager.cameraPresets = [];
        this.presetManager.renderPresets();
        this.isSequenceMode = false;
        this.sequenceAssets = [];
        this.sequenceFrameIndex = -1;
        this.sequenceBands = 0;
        this.sequenceRequestId = 0;
        this.sequenceDesiredFrameIndex = -1;
        if (this.sequenceApplyTimer !== null) {
            window.clearInterval(this.sequenceApplyTimer);
            this.sequenceApplyTimer = null;
        }
        this.sequenceEntityPool.forEach((e) => e.destroy());
        this.sequenceEntityPool = [];
        this.sequenceFrameToEntity.clear();
        this.sequenceEntityToFrame.clear();
        this.sequencePrefetchInFlight.clear();
        this.sequenceReservedEntities.clear();
        this.sequenceEntityBuildTarget = new WeakMap();
        this.sequenceActiveEntity = null;
        if (this.sequenceSwapRaf !== null) {
            window.cancelAnimationFrame(this.sequenceSwapRaf);
            this.sequenceSwapRaf = null;
        }
        this.isSog4SequenceMode = false;
        this.sog4SequenceFiles = [];
        this.sog4SequenceSegments = [];
        this.sog4SequenceTotalFrames = 0;
        this.sog4SequenceOffsets = [];
        this.sog4SequenceName = null;
        this.sog4SequenceSharedTransform = null;
        this.sog4SequenceIndex = 0;
        this.sog4SequenceLoading = false;
        this.sog4SequenceRequestId++;
        this.ply4SequenceLoadMode = 'full';
        this.sequenceEditStates.clear();
        this.updatePly4SequenceLoadModeBadge('hidden');
        this.lazySegmentProgressEl?.classList.add('hidden');
        // #WDD-gpt 2026-04-20 - 清理旧序列对象，避免新加载沿用过期元素
        this.splatSequence = null;
        this.refreshExportButtons();
    }

    // #WDD-gpt 2026-04-20 - 多段落编辑状态下切换导出按钮：隐藏单文件导出，显示序列导出
    public refreshExportButtons() {
        const btnExportSog = document.getElementById('btn-export-sog');
        const btnExportPly4 = document.getElementById('btn-export-ply4');
        const btnExportPly4Sequence = document.getElementById('btn-export-ply4-sequence');
        const isMultiSegment = this.isSog4SequenceMode && this.sog4SequenceSegments.length > 1;

        btnExportSog?.classList.toggle('hidden', isMultiSegment);
        btnExportPly4?.classList.toggle('hidden', isMultiSegment);
        btnExportPly4Sequence?.classList.toggle('hidden', !isMultiSegment);
        btnExportPly4Sequence?.classList.toggle('flex', isMultiSegment);
    }

    // #WDD-gpt 2026-04-20 - 新增统一序列模型：将当前 temporal segments 投影为 SplatSequence
    private rebuildSplatSequenceFromTemporalSegments(sequenceName: string) {
        const elements: SplatSequenceElement[] = this.sog4SequenceSegments.map((seg, idx) => {
            const start = this.sog4SequenceOffsets[idx] || 0;
            const duration = Math.max(1, Math.floor(seg.duration || 1));
            return {
                name: seg.name,
                type: seg.name.toLowerCase().endsWith('.ply4') ? 'ply4' : 'sog4',
                duration,
                globalStartFrame: start,
                globalEndFrame: start + duration,
                parsed: seg.parsed,
                asset: seg.asset,
                entity: seg.entity
            };
        });
        this.splatSequence = {
            name: sequenceName,
            elements,
            totalFrames: this.sog4SequenceTotalFrames || Math.max(1, this.duration),
            activeElementIndex: Math.max(0, this.sog4SequenceIndex || 0)
        };
    }

    // #WDD-gpt 2026-04-20 - 单文件 ply4/sog4 也按“单元素序列”处理
    private configureSingleElementTemporalSequence(
        file: File,
        parsed: any,
        asset: pc.Asset,
        entity: pc.Entity,
        duration: number
    ) {
        const type: 'ply4' | 'sog4' = file.name.toLowerCase().endsWith('.ply4') ? 'ply4' : 'sog4';
        this.isSog4SequenceMode = true;
        this.sog4SequenceFiles = [file];
        this.sog4SequenceSegments = [{ name: file.name, parsed, asset, entity, duration }];
        this.sog4SequenceOffsets = [0];
        this.sog4SequenceTotalFrames = Math.max(1, Math.floor(duration || 1));
        this.sog4SequenceIndex = 0;
        this.sog4SequenceName = `${file.name}_sequence`;
        this.sog4SequenceLoading = false;
        this.rebuildSplatSequenceFromTemporalSegments(this.sog4SequenceName);
        if (this.splatSequence) {
            this.splatSequence.elements[0].type = type;
            this.splatSequence.activeElementIndex = 0;
        }
    }

    // #WDD-gpt 2026-04-20 - 通过 asset 反查序列元素，用于绑定每个元素的运行时纹理/缓存
    private getSplatSequenceElementByAsset(asset: pc.Asset | null): SplatSequenceElement | null {
        if (!asset || !this.splatSequence) return null;
        return this.splatSequence.elements.find((el) => el.asset === asset) || null;
    }

    private async parsePlyFrame(file: File): Promise<SequenceFrameData> {
        const buffer = await file.arrayBuffer();
        // #WDD 2026-07-31 Fix: 之前用 TextDecoder('ascii').decode(整个buffer) 再用字符串索引
        // 当字节偏移,但浏览器对 >=0x80 字节会替换成 U+FFFD 或合并多字节序列,导致字符串长度≠字节长度,
        // bodyStart 偏移错位 → "Offset is outside the bounds of the DataView"。
        // 改为: 只在 header 区域(纯 ASCII)做字节级扫描,bodyStart 用真实字节偏移。
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        // 字节级查找 "end_header\n",得到 header 文本与 body 的真实字节边界。
        const decoder = new TextDecoder('ascii');
        const SEARCH_CAP = Math.min(bytes.length, 2 * 1024 * 1024); // header 不会超过 2MB
        let headerEndByte = -1;
        // 逐行扫描,在字节流里找 'end_header' 行尾的换行。
        const probe = decoder.decode(bytes.slice(0, SEARCH_CAP));
        const m = probe.match(/end_header\r?\n/);
        if (!m || m.index === undefined) {
            // #WDD 2026-07-31 诊断: 文件不含 end_header, 打印前 256 字节的 hex+ascii,
            // 并识别常见 magic bytes, 帮助判断真实格式(ASCII PLY / gzip / .splat / .ksplat / .glb / .sog 等)。
            const head = bytes.slice(0, Math.min(256, bytes.length));
            const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = Array.from(head).map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '·').join('');
            const magic = (b: number[]) => b.every((v, i) => bytes[i] === v);
            let guess = '';
            if (magic([0x1f, 0x8b])) guess = ' → looks like GZIP (compressed)';
            else if (magic([0x50, 0x4b, 0x03, 0x04]) || magic([0x50, 0x4b, 0x05, 0x06])) guess = ' → looks like ZIP (maybe .sog/.sog4)';
            else if (magic([0x67, 0x6c, 0x54, 0x46])) guess = ' → looks like glTF/GLB';
            else if (probe.slice(0, 15).toLowerCase().includes('ply')) guess = ' → starts with "ply" but no end_header (maybe ASCII PLY with CRLF, or truncated)';
            console.error('[PLY seq] file is NOT a binary PLY (no end_header). first 256 bytes:');
            console.error('  hex:   ', hex);
            console.error('  ascii: ', ascii);
            console.error('  guess: ', guess || ' → unknown format');
            throw new Error(
                `PLY missing end_header (not a binary PLY). First bytes hex: ${hex.slice(0, 64)}... ` +
                `ascii: "${ascii.slice(0, 32)}...". File: ${file.name}, size: ${bytes.length} bytes. ${guess}`
            );
        }
        headerEndByte = m.index + m[0].length;

        // header 区域是纯 ASCII,这里用字符串解析是安全的。
        const headerText = decoder.decode(bytes.slice(0, headerEndByte));
        const lines = headerText.split(/\r?\n/);
        let vertexCount = 0;
        let currentElement = '';
        let isLittleEndian = true;
        const propertyDefs: {
            name: string;
            size: number;
            reader: (view: DataView, offset: number, littleEndian: boolean) => number;
        }[] = [];

        const typeReaders: Record<string, { size: number; reader: (view: DataView, offset: number, littleEndian: boolean) => number }> = {
            'char': { size: 1, reader: (view, offset) => view.getInt8(offset) },
            'int8': { size: 1, reader: (view, offset) => view.getInt8(offset) },
            'uchar': { size: 1, reader: (view, offset) => view.getUint8(offset) },
            'uint8': { size: 1, reader: (view, offset) => view.getUint8(offset) },
            'short': { size: 2, reader: (view, offset, le) => view.getInt16(offset, le) },
            'int16': { size: 2, reader: (view, offset, le) => view.getInt16(offset, le) },
            'ushort': { size: 2, reader: (view, offset, le) => view.getUint16(offset, le) },
            'uint16': { size: 2, reader: (view, offset, le) => view.getUint16(offset, le) },
            'int': { size: 4, reader: (view, offset, le) => view.getInt32(offset, le) },
            'int32': { size: 4, reader: (view, offset, le) => view.getInt32(offset, le) },
            'uint': { size: 4, reader: (view, offset, le) => view.getUint32(offset, le) },
            'uint32': { size: 4, reader: (view, offset, le) => view.getUint32(offset, le) },
            'float': { size: 4, reader: (view, offset, le) => view.getFloat32(offset, le) },
            'float32': { size: 4, reader: (view, offset, le) => view.getFloat32(offset, le) },
            'double': { size: 8, reader: (view, offset, le) => view.getFloat64(offset, le) },
            'float64': { size: 8, reader: (view, offset, le) => view.getFloat64(offset, le) }
        };

        for (const lineRaw of lines) {
            const line = lineRaw.trim();
            if (!line) continue;
            const parts = line.split(/\s+/);
            if (parts[0] === 'format') {
                const fmt = parts[1];
                if (fmt === 'binary_big_endian') {
                    isLittleEndian = false;
                } else if (fmt !== 'binary_little_endian') {
                    throw new Error('Only binary PLY sequences are supported.');
                }
            } else if (parts[0] === 'element') {
                currentElement = parts[1];
                if (currentElement === 'vertex') {
                    vertexCount = parseInt(parts[2], 10);
                }
            } else if (parts[0] === 'property' && currentElement === 'vertex') {
                if (parts[1] === 'list') continue;
                const type = parts[1].toLowerCase();
                const name = parts[2];
                const typeInfo = typeReaders[type];
                if (!typeInfo) {
                    throw new Error(`Unsupported property type in PLY sequence: ${type}`);
                }
                propertyDefs.push({ name, size: typeInfo.size, reader: typeInfo.reader });
            }
        }

        const bodyStart = headerEndByte; // 真实字节偏移
        const rowSize = propertyDefs.reduce((sum, def) => sum + def.size, 0);
        // #WDD 2026-07-31 诊断: 打印 header 摘要, 便于定位 body 越界的真实原因。
        console.log('[PLY seq] headerEndByte:', headerEndByte, 'vertexCount:', vertexCount, 'rowSize:', rowSize,
            'props:', propertyDefs.map((d) => `${d.name}:${d.size}`).join(','));
        // #WDD 2026-07-31 防御: 校验 body 字节数是否足够容纳声明的顶点,给出明确报错而非 DataView 越界。
        const expectedBodyBytes = vertexCount * rowSize;
        if (rowSize === 0) {
            throw new Error('PLY has no float properties in the vertex element.');
        }
        if (bodyStart + expectedBodyBytes > bytes.length) {
            // 常见原因: ①该 PLY 是 ASCII 格式而非 binary ②header 含多个 element ③文本/二进制混排
            throw new Error(
                `PLY body size mismatch: header declares ${vertexCount} vertices × ${rowSize} bytes ` +
                `= ${expectedBodyBytes} bytes, but only ${bytes.length - bodyStart} bytes remain after header ` +
                `(bodyStart=${bodyStart}, fileBytes=${bytes.length}, format=${isLittleEndian ? 'LE' : 'BE'}). ` +
                `Header: ${headerText.replace(/\n/g, ' | ').slice(0, 300)}`
            );
        }
        const propertyArrays: Record<string, Float32Array> = {};
        propertyDefs.forEach((def) => {
            propertyArrays[def.name] = new Float32Array(vertexCount);
        });

        for (let i = 0; i < vertexCount; i++) {
            let offset = bodyStart + i * rowSize;
            for (const def of propertyDefs) {
                const value = def.reader(view, offset, isLittleEndian);
                propertyArrays[def.name][i] = value;
                offset += def.size;
            }
        }

        return {
            count: vertexCount,
            propertyNames: propertyDefs.map((def) => def.name),
            propertyValues: propertyArrays
        };
    }

    private createGsplatAssetFromVertexElement(assetName: string, vertexElement: any): pc.Asset {
        const splatData = new (pc.GSplatData as any)([vertexElement]);
        const resource = new pc.GSplatResource(this.app.graphicsDevice, splatData);
        const asset = new pc.Asset(assetName, 'gsplat', { url: '' });
        asset.resource = resource;
        asset.loaded = true;
        this.app.assets.add(asset);
        return asset;
    }

    private setupSequenceShader(instance: any, bands: number) {
        const material = instance.material;
        material.setParameter('uTime', 0.0);
        material.setParameter('uTransitionFactor', 0.0);
        material.setParameter('uSwizzleMode', this.swizzleMode);
        material.setParameter('uGlobalTotalFrames', this.duration);
        material.setParameter('uOpacityScale', 1.0);
        material.setParameter('uRenderMode', this.gaussianRenderMode);
        material.setParameter('uSHLevel', this.shLevel);
        if (this.selectionTool?.selectionTexture) {
            material.setParameter('selectionTexture', this.selectionTool.selectionTexture);
        }
        material.setParameter('isSelectionMode', 0.0);

        if ((material as any).__sequenceShaderInjected) {
            material.update();
            return;
        }
        (material as any).__sequenceShaderInjected = true;

        const originalGetShaderVariant = material.getShaderVariant;

        material.getShaderVariant = function (device: any, scene: any, defs: any, unused: any, pass: any, sortedLights: any, viewUniformFormat: any, viewBindGroupFormat: any) {
            const library = device.getProgramLibrary();
            const originalGetProgram = library.getProgram;

            library.getProgram = function (name: string, options: any, processingOptions: any) {
                if (name === 'splat') {
                    if (!options.defines) options.defines = [];

                    // For sequence we intentionally do NOT enable 4D/lifetime defines.
                    if (bands >= 1 && !options.defines.includes('USE_SH1')) options.defines.push('USE_SH1');
                    if (bands >= 2 && !options.defines.includes('USE_SH2')) options.defines.push('USE_SH2');
                    if (bands >= 3 && !options.defines.includes('USE_SH3')) options.defines.push('USE_SH3');

                    const shaderPassInfo = (pc as any).ShaderPass?.get(device)?.getByIndex?.(options.pass);
                    let passDefines = shaderPassInfo?.shaderDefines ? `${shaderPassInfo.shaderDefines}\n` : '';
                    // Ensure PICK_PASS is defined for pick passes (some versions may not set shaderDefines correctly)
                    if (options.pass === 2 /* pc.PASS_PICK */) { // #WDD 2026-04-03 修复 PlayCanvas 1.77 缺少 PASS_PICK 导出问题
                        if (!passDefines.includes('PICK_PASS')) {
                            passDefines += '#define PICK_PASS\n';
                        }
                    }
                    const optionDefines = options.defines.map((d: string) => `#define ${d}`).join('\n');
                    const defines = passDefines + optionDefines + '\n';
                    const version = "#version 300 es\n";

                    const vsCode = version + defines + sequenceSplatCoreVS + sequenceSplatMainVS;
                    const fsCode = version + defines + "precision mediump float;\n" + sequenceSplatMainPS;

                    const shaderDefinition = {
                        attributes: {
                            vertex_position: pc.SEMANTIC_POSITION,
                            vertex_id_attrib: pc.SEMANTIC_ATTR13
                        },
                        vshader: vsCode,
                        fshader: fsCode
                    };
                    return new pc.Shader(device, shaderDefinition);
                }
                return originalGetProgram.call(this, name, options, processingOptions);
            };

            const result = originalGetShaderVariant.apply(this, arguments);
            library.getProgram = originalGetProgram;
            return result;
        };

        if ((material as any).clearVariants) {
            (material as any).clearVariants();
        }
        material.update();
    }

    private ensureSequenceSelectionTextureForAsset(asset: pc.Asset, forceReset: boolean = false) {
        try {
            const resource = asset.resource as pc.GSplatResource;
            const splatData = resource.splatData;
            const numSplats = splatData.numSplats;

            const resAny = asset.resource as any;
            const texWidth = (resAny?.colorTexture?.width || resAny?.transformATexture?.width || Math.ceil(Math.sqrt(numSplats))) as number;
            const texHeight = Math.ceil(numSplats / texWidth);

            const existing = this.selectionTool?.selectionTexture;
            const needsRecreate = forceReset || !existing || existing.width !== texWidth || existing.height !== texHeight;
            if (needsRecreate) {
                // Match the gsplat UV addressing to avoid undefined texelFetch results.
                (this.selectionTool as any).initWithSize(numSplats, texWidth, texHeight);
            }
        } catch (e) {
            console.warn('[Sequence] ensureSequenceSelectionTextureForAsset failed:', e);
        }
    }

    // #WDD-kimi 2026-04-20 - 为序列段落创建独立选择状态，避免不同段落复用同一 selection 缓冲
    private createSequenceSelectionStateForAsset(asset: pc.Asset, seedSelectionData?: Uint8Array | null): {
        selectionData: Uint8Array;
        allTimeSelectionData: Uint8Array;
        selectionTexture: pc.Texture;
    } | null {
        try {
            const resource = asset.resource as pc.GSplatResource;
            const splatData = resource.splatData;
            const numSplats = splatData.numSplats;
            const resAny = asset.resource as any;
            const texWidth = (resAny?.colorTexture?.width || resAny?.transformATexture?.width || Math.ceil(Math.sqrt(numSplats))) as number;
            const texHeight = Math.ceil(numSplats / texWidth);
            const bytes = texWidth * texHeight * 4;

            const selectionData = new Uint8Array(bytes);
            if (seedSelectionData && seedSelectionData.length > 0) {
                selectionData.set(seedSelectionData.subarray(0, Math.min(seedSelectionData.length, selectionData.length)));
            }
            const allTimeSelectionData = new Uint8Array(bytes);

            const selectionTexture = new pc.Texture(this.app.graphicsDevice, {
                width: texWidth,
                height: texHeight,
                format: pc.PIXELFORMAT_R8_G8_B8_A8,
                mipmaps: false,
                minFilter: pc.FILTER_NEAREST,
                magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                addressV: pc.ADDRESS_CLAMP_TO_EDGE,
                name: 'selectionTexture'
            });
            const lock = selectionTexture.lock();
            lock.set(selectionData);
            selectionTexture.unlock();

            return { selectionData, allTimeSelectionData, selectionTexture };
        } catch (e) {
            console.warn('[Sequence] createSequenceSelectionStateForAsset failed:', e);
            return null;
        }
    }

    private getSequenceFrameRangeToPrefetch(centerFrame: number): number[] {
        const targets: number[] = [];
        const maxFrame = this.sequenceAssets.length - 1;
        for (let d = 1; d <= this.sequencePrefetchCount; d++) {
            const fwd = centerFrame + d;
            const back = centerFrame - d;
            if (fwd <= maxFrame) targets.push(fwd);
            if (back >= 0) targets.push(back);
        }
        return targets;
    }

    private evictSequenceCacheIfNeeded(keepAroundFrame: number) {
        const maxCached = Math.max(2, this.sequencePrefetchCount * 2 + 1);
        if (this.sequenceFrameToEntity.size <= maxCached) return;

        // Evict the frame farthest from current desired frame.
        let evictFrame: number | null = null;
        let bestDist = -1;
        for (const frame of this.sequenceFrameToEntity.keys()) {
            const dist = Math.abs(frame - keepAroundFrame);
            if (dist > bestDist) {
                bestDist = dist;
                evictFrame = frame;
            }
        }
        if (evictFrame === null) return;
        const ent = this.sequenceFrameToEntity.get(evictFrame);
        if (!ent) return;
        if (ent === this.sequenceActiveEntity || ent === this.sequencePendingSwapEntity || this.sequenceReservedEntities.has(ent)) return;
        this.sequenceFrameToEntity.delete(evictFrame);
        this.sequenceEntityToFrame.delete(ent);
        ent.enabled = false;
    }

    private async buildSequenceEntityForFrame(frameIndex: number): Promise<void> {
        if (!this.isSequenceMode) return;
        if (frameIndex < 0 || frameIndex >= this.sequenceAssets.length) return;
        if (this.sequenceFrameToEntity.has(frameIndex)) return;
        if (this.sequencePrefetchInFlight.has(frameIndex)) return;

        this.sequencePrefetchInFlight.add(frameIndex);
        let ent: pc.Entity | null = null;
        try {
            this.evictSequenceCacheIfNeeded(this.sequenceDesiredFrameIndex >= 0 ? this.sequenceDesiredFrameIndex : frameIndex);

            // Find a free entity in the pool.
            for (const e of this.sequenceEntityPool) {
                if (
                    !this.sequenceEntityToFrame.has(e) &&
                    !this.sequenceReservedEntities.has(e) &&
                    e !== this.sequenceActiveEntity &&
                    e !== this.sequencePendingSwapEntity
                ) {
                    ent = e;
                    break;
                }
            }

            // If none free, evict an existing cached entry.
            if (!ent) {
                let evictFrame: number | null = null;
                let bestDist = -1;
                const around = this.sequenceDesiredFrameIndex >= 0 ? this.sequenceDesiredFrameIndex : frameIndex;
                for (const f of this.sequenceFrameToEntity.keys()) {
                    const dist = Math.abs(f - around);
                    if (dist > bestDist) {
                        bestDist = dist;
                        evictFrame = f;
                    }
                }
                if (evictFrame !== null) {
                    const candidate = this.sequenceFrameToEntity.get(evictFrame) || null;
                    if (
                        candidate &&
                        candidate !== this.sequenceActiveEntity &&
                        candidate !== this.sequencePendingSwapEntity &&
                        !this.sequenceReservedEntities.has(candidate)
                    ) {
                        ent = candidate;
                    }
                    if (ent) {
                        this.sequenceFrameToEntity.delete(evictFrame);
                        this.sequenceEntityToFrame.delete(ent);
                        ent.enabled = false;
                    }
                }
            }

            if (!ent) return;

            this.sequenceReservedEntities.add(ent);
            this.sequenceEntityBuildTarget.set(ent, frameIndex);

            const asset = this.sequenceAssets[frameIndex];
            (ent.gsplat as any).asset = asset;

            // Wait until instance exists so we can inject the sequence shader upfront (hidden preload).
            const triesMax = 120;
            for (let tries = 0; tries < triesMax; tries++) {
                if (!this.isSequenceMode) return;
                if (this.sequenceEntityBuildTarget.get(ent) !== frameIndex) return;
                const inst = (ent.gsplat as any)?.instance;
                if (inst?.material) {
                    this.setupSequenceShader(inst, this.sequenceBands);
                    this.sequenceFrameToEntity.set(frameIndex, ent);
                    this.sequenceEntityToFrame.set(ent, frameIndex);
                    this.sequenceReservedEntities.delete(ent);
                    return;
                }
                await new Promise((r) => setTimeout(r, 16));
            }
        } finally {
            this.sequencePrefetchInFlight.delete(frameIndex);
            if (ent && this.sequenceEntityBuildTarget.get(ent) === frameIndex) {
                this.sequenceReservedEntities.delete(ent);
            }
        }
    }

    private async prefetchSequenceAround(frameIndex: number) {
        const targets = this.getSequenceFrameRangeToPrefetch(frameIndex);
        for (const f of targets) {
            // Fire-and-forget; limiting concurrency keeps the UI responsive.
            void this.buildSequenceEntityForFrame(f);
        }
    }

    private setSequenceOpacity(ent: pc.Entity | null, opacity: number) {
        if (!ent?.gsplat) return;
        const inst = (ent.gsplat as any).instance;
        if (inst?.material) {
            inst.material.setParameter('uOpacityScale', opacity);
            inst.material.update();
        }
    }

    private swapSequenceActiveEntity(next: pc.Entity, frameIndex: number) {
        const prev = this.sequenceActiveEntity;
        if (prev === next) return;

        // If the exact same swap is already pending, don't keep canceling/rescheduling it.
        // Doing so can starve the RAF callback and make playback appear "stuck".
        if (this.sequencePendingSwapFrame === frameIndex && this.sequencePendingSwapEntity === next) return;

        if (this.sequenceSwapRaf !== null) {
            window.cancelAnimationFrame(this.sequenceSwapRaf);
            this.sequenceSwapRaf = null;
        }

        // If we had a previously-prepared "next" entity (enabled with opacity 0), clean it up.
        // This prevents stray entities from lingering enabled when the target frame changes.
        const oldPendingEnt = this.sequencePendingSwapEntity;
        if (oldPendingEnt && oldPendingEnt !== prev && oldPendingEnt !== next) {
            this.setSequenceOpacity(oldPendingEnt, 1.0);
            oldPendingEnt.enabled = false;
        }

        this.sequencePendingSwapFrame = frameIndex;
        this.sequencePendingSwapEntity = next;

        // Two-phase swap to avoid both-frames-visible "ghosting":
        // Phase A: render next invisibly for N frames to warm up GPU/shader.
        // Phase B (next RAF): hide prev and show next, with no frame where both are visible.
        next.enabled = true;
        this.setSequenceOpacity(next, 0.0);
        this.setSequenceOpacity(prev, 1.0);

        const requestId = this.sequenceRequestId;
        const warmupRafs = Math.max(1, this.sequenceSwapWarmupRafCount | 0);
        const tick = (remaining: number) => {
            this.sequenceSwapRaf = window.requestAnimationFrame(() => {
                this.sequenceSwapRaf = null;

                // Abort if a newer request arrived.
                if (requestId !== this.sequenceRequestId || this.sequenceDesiredFrameIndex !== frameIndex) {
                    // Only clear if this callback still corresponds to the currently pending swap.
                    if (this.sequencePendingSwapFrame === frameIndex && this.sequencePendingSwapEntity === next) {
                        this.sequencePendingSwapFrame = null;
                        this.sequencePendingSwapEntity = null;
                    }
                    return;
                }

                if (remaining > 1) {
                    tick(remaining - 1);
                    return;
                }

                this.setSequenceOpacity(prev, 0.0);
                this.setSequenceOpacity(next, 1.0);
                if (prev) prev.enabled = false;

                // Reset opacity on the old entity for future reuse.
                this.setSequenceOpacity(prev, 1.0);

                this.sequenceActiveEntity = next;
                this.splatEntity = next;
                this.sequenceFrameIndex = frameIndex;
                // #WDD-gpt 2026-06-13 - sequence 切帧后 ALL 点云刷新到当前激活帧，并继续隐藏原 GSplat
                this.refreshDebugAllPointsEntity();

                if (this.sequencePendingSwapFrame === frameIndex && this.sequencePendingSwapEntity === next) {
                    this.sequencePendingSwapFrame = null;
                    this.sequencePendingSwapEntity = null;
                }
            });
        };
        tick(warmupRafs);
    }

    private async requestSequenceFrame(frameIndex: number) {
        if (!this.isSequenceMode) return;
        if (frameIndex < 0 || frameIndex >= this.sequenceAssets.length) return;

        // Avoid spamming swaps for the same target; the playback loop calls this every tick.
        if (frameIndex === this.sequenceFrameIndex) return;
        if (this.sequencePendingSwapFrame === frameIndex) return;

        this.sequenceDesiredFrameIndex = frameIndex;
        void this.prefetchSequenceAround(frameIndex);

        // If already cached and ready, swap instantly.
        const cached = this.sequenceFrameToEntity.get(frameIndex);
        if (cached && cached.gsplat) {
            const active = this.sequenceActiveEntity;
            if (active && active !== cached) {
                cached.setLocalPosition(active.getLocalPosition());
                cached.setLocalRotation(active.getLocalRotation());
                cached.setLocalScale(active.getLocalScale());
            }
            this.swapSequenceActiveEntity(cached, frameIndex);
            this.fileLoader.updateStats(this.sequenceAssets[frameIndex]);
            return;
        }

        // Not ready yet: build a pool entity for it, then swap when ready (keeps current visible).
        await this.buildSequenceEntityForFrame(frameIndex);
        // If user/auto-play requested a different frame while we were building, don't swap to an old one.
        if (this.sequenceDesiredFrameIndex !== frameIndex) return;
        const ready = this.sequenceFrameToEntity.get(frameIndex);
        if (ready) {
            const active = this.sequenceActiveEntity;
            if (active && active !== ready) {
                ready.setLocalPosition(active.getLocalPosition());
                ready.setLocalRotation(active.getLocalRotation());
                ready.setLocalScale(active.getLocalScale());
            }
            this.swapSequenceActiveEntity(ready, frameIndex);
            this.fileLoader.updateStats(this.sequenceAssets[frameIndex]);
        }
    }

    private async applySequenceFrame(frameIndex: number) {
        // Backwards-compatible wrapper used by the playback loop.
        await this.requestSequenceFrame(frameIndex);
    }

    private async startSequencePlayback(assets: pc.Asset[], label: string, bands: number, progress: (step: number, status: string, detail?: string) => void) {
        if (!assets.length) throw new Error('No sequence frames to play.');

        // Do not auto-play sequences on load.
        if (this.isPlaying) this.togglePlay();

        this.activeLoadingSequenceCleanup();

        this.isSequenceMode = true;
        this.is4DGS = false;
        this.trajectoryData = null;
        this.trajectoryTexture = null;
        this.keyframes = 0;
        this.xyzStride = 1;
        this.rotTrajectoryData = null;
        this.rotKeyframes = 0;
        this.rotStride = 1;

        this.sequenceAssets = assets;
        this.sequenceBands = bands;
        this.sequenceFrameIndex = -1;

        this.currentFileName = label;
        // Keep transform caching stable per dropped sequence, not shared across all sequences of the same type.
        const first = assets[0]?.name || 'frame0';
        const last = assets[assets.length - 1]?.name || 'frameN';
        this.currentTransformCacheKey = `seq_${label}_${assets.length}_${first}_${last}`;
        this.duration = assets.length;
        this.totalFrames = assets.length;
        this.currentTime = 0;
        this.playbackTime = 0;
        this.fileInfoPanel.refresh();

        const preloadAll = this.shouldPreloadAllSequenceFrames(assets.length);
        if (preloadAll) {
            progress(1, 'LOADING', `Preloading ${assets.length} frames to GPU (may take a while)`);

            const parent = this.getSequenceParentEntity();
            this.sequenceEntityPool = [];
            this.sequenceFrameToEntity.clear();
            this.sequenceEntityToFrame.clear();
            this.sequencePrefetchInFlight.clear();
            this.sequenceReservedEntities.clear();
            this.sequenceEntityBuildTarget = new WeakMap();

            for (let i = 0; i < assets.length; i++) {
                const ent = new pc.Entity(`GSplatSeq_${i}`);
                ent.addComponent('gsplat', { asset: assets[i] });
                ent.enabled = i === 0;
                parent.addChild(ent);
                this.sequenceEntityPool.push(ent);
                this.sequenceFrameToEntity.set(i, ent);
                this.sequenceEntityToFrame.set(ent, i);
            }

            this.sequenceActiveEntity = this.sequenceEntityPool[0];
            this.splatEntity = this.sequenceActiveEntity;

            this.resetObjectTransformUI();


            // Ensure every frame's instance exists + sequence shader is injected.
            for (let i = 0; i < assets.length; i++) {
                if (!this.isSequenceMode) return;
                const ent = this.sequenceFrameToEntity.get(i);
                if (!ent) continue;
                // Temporarily enable to force instance/material creation in some cases.
                const wasEnabled = ent.enabled;
                if (!wasEnabled) ent.enabled = true;
                const inst = await this.waitForSequenceGsplatMaterial(ent);
                if (inst?.material) {
                    this.setupSequenceShader(inst, this.sequenceBands);
                    // Keep non-active entities hidden after shader injection.
                    if (i !== 0) {
                        this.setSequenceOpacity(ent, 0.0);
                        ent.enabled = false;
                    } else {
                        this.setSequenceOpacity(ent, 1.0);
                    }
                }
                if (!wasEnabled && i !== 0) ent.enabled = false;

                if (i % 10 === 0) {
                    const step = Math.min(8, 1 + Math.floor((i / Math.max(1, assets.length - 1)) * 7));
                    progress(step, 'LOADING', `Preparing frame ${i + 1} / ${assets.length}`);
                }
            }

            // Make sure all entities share the same transform (pos/rot/scale).
            const base = this.sequenceActiveEntity;
            if (base) {
                for (let i = 1; i < assets.length; i++) {
                    const ent = this.sequenceFrameToEntity.get(i);
                    if (!ent) continue;
                    ent.setLocalPosition(base.getLocalPosition());
                    ent.setLocalRotation(base.getLocalRotation());
                    ent.setLocalScale(base.getLocalScale());
                }
            }

            // Optional GPU warmup pass: draw each frame invisibly once so fast switching is stutter-free.
            for (let i = 1; i < assets.length; i++) {
                if (!this.isSequenceMode) return;
                const ent = this.sequenceFrameToEntity.get(i);
                if (!ent) continue;
                ent.enabled = true;
                this.setSequenceOpacity(ent, 0.0);
                await this.waitRafs(this.sequenceSwapWarmupRafCount);
                ent.enabled = false;
                this.setSequenceOpacity(ent, 1.0);
            }

            this.sequenceDesiredFrameIndex = 0;
            this.sequenceFrameIndex = 0;
        } else {
            // Streaming mode: pre-create a small pool of hidden GSplat entities and pre-build nearby frames into them.
            // This avoids "blank" time when rapidly seeking / switching frames.
            const poolSize = Math.min(assets.length, Math.max(2, this.sequencePrefetchCount * 2 + 3));
            const parent = this.getSequenceParentEntity();
            this.sequenceEntityPool = [];
            for (let i = 0; i < poolSize; i++) {
                const ent = new pc.Entity(`GSplatSeq_${i}`);
                ent.addComponent('gsplat', { asset: assets[0] });
                ent.enabled = i === 0;
                parent.addChild(ent);
                this.sequenceEntityPool.push(ent);
            }

            this.sequenceActiveEntity = this.sequenceEntityPool[0];
            this.splatEntity = this.sequenceActiveEntity;

            this.resetObjectTransformUI();


            // Ensure the active entity is fully ready + shader injected, then cache it as frame 0.
            this.sequenceDesiredFrameIndex = 0;
            this.sequenceFrameIndex = -1;
            await this.buildSequenceEntityForFrame(0);
            const cached0 = this.sequenceFrameToEntity.get(0);
            if (cached0) {
                // Apply cached/UI transform to the first visible frame before starting playback.
                // Without this, frame 0 can briefly render at the default transform.
                const active = this.sequenceActiveEntity;
                if (active && active !== cached0) {
                    cached0.setLocalPosition(active.getLocalPosition());
                    cached0.setLocalRotation(active.getLocalRotation());
                    cached0.setLocalScale(active.getLocalScale());
                }
                this.swapSequenceActiveEntity(cached0, 0);
            }

            void this.prefetchSequenceAround(0);
        }

        // UI
        const container = document.getElementById('timeline-ticks');
        if (container) container.innerHTML = '';
        this.resetTimelineTools();
        this.updateTimelineTicks(this.duration);

        this.syncTimelineUI(0, Math.max(0, Math.ceil(this.duration) - 1));

        progress(9, 'READY', 'System Update Complete');
        window.setTimeout(() => { document.getElementById('loading-overlay')?.classList.add('hidden'); }, 600);
        // Sequences should not force "simplified mode" on load.
        this.toggleUIVisibility(false);

        // Inject shader on the initial active instance when it exists
        await this.applySequenceFrame(0);
    }

    private async loadPlySequence(files: File[]): Promise<void> {
        const overlay = document.getElementById('loading-overlay');
        const progress = this.createSequenceProgressUpdater();
        this.currentFileSize = files.reduce((sum, file) => sum + file.size, 0);
        this.resetTransientStateForNewAsset();
        progress(0, 'PREPARING', `Parsing ${files.length} PLY frames`);
        let succeeded = false;
        try {
            // #WDD 2026-05-12 Sort files numerically to fix playback order
            const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            const assets: pc.Asset[] = [];
            for (let i = 0; i < sorted.length; i++) {
                const file = sorted[i];
                const frame = await this.parsePlyFrame(file);
                const vertexElement = {
                    name: 'vertex',
                    count: frame.count,
                    properties: frame.propertyNames.map((name) => ({ name, type: 'float', storage: frame.propertyValues[name] }))
                };
                assets.push(this.createGsplatAssetFromVertexElement(file.name, vertexElement));
                const step = Math.min(8, Math.floor((i / Math.max(1, sorted.length - 1)) * 8));
                progress(step, 'LOADING', `Loaded ${file.name}`);
            }
            await this.startSequencePlayback(assets, 'PLY Sequence', 0, progress);
            succeeded = true;
        } catch (err) {
            console.error('PLY sequence load failed', err);
            alert('Failed to load PLY sequence: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            if (!succeeded) {
                overlay?.classList.add('hidden');
            }
        }
    }

    // #WDD-gpt 2026-05-16 - 按用户要求将 PLY4/SOG4 序列导入预检预算固定为 10GB
    private getAdaptiveSequenceImportBudgetBytes() {
        const gib = 1024 * 1024 * 1024;
        return 10 * gib;
    }

    private shouldUseSegmentedPly4Mode(totalSize: number) {
        return totalSize > this.PLY4_SEGMENTED_THRESHOLD_BYTES;
    }

    private formatImportBudget(bytes: number) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    // #WDD-gpt 2026-05-16 - 在 UI 上常驻标注 PLY4 序列当前读取模式
    private updatePly4SequenceLoadModeBadge(mode: 'hidden' | 'full' | 'lazy', totalSize = 0, segmentCount = 0) {
        const badge = document.getElementById('sequence-load-mode-badge');
        if (!badge) return;
        if (mode === 'hidden') {
            badge.classList.add('hidden');
            badge.textContent = 'PLY4 FULL';
            badge.title = 'Current sequence loading mode';
            this.selectionTool?.refreshLazyModeVisibility?.();
            return;
        }
        const isLazy = mode === 'lazy';
        badge.classList.remove('hidden');
        badge.textContent = isLazy ? 'PLY4 LAZY' : 'PLY4 FULL';
        badge.title = isLazy
            ? `PLY4 Lazy segmented buffering: ${segmentCount} segments, ${this.formatImportBudget(totalSize)} total. Only the active segment is decoded/render-cached.`
            : `PLY4 full loading: ${segmentCount} segments, ${this.formatImportBudget(totalSize)} total.`;
        badge.classList.toggle('bg-cyan-500/15', isLazy);
        badge.classList.toggle('text-cyan-300', isLazy);
        badge.classList.toggle('border-cyan-400/20', isLazy);
        badge.classList.toggle('bg-emerald-500/15', !isLazy);
        badge.classList.toggle('text-emerald-300', !isLazy);
        badge.classList.toggle('border-emerald-400/20', !isLazy);
        this.selectionTool?.refreshLazyModeVisibility?.();
    }

    // #WDD-gpt 2026-05-16 - 提供给手工选择 UI 判断 Lazy 模式下是否隐藏区域/笔刷工具
    public isPly4LazySequenceMode() {
        return this.isSog4SequenceMode && this.ply4SequenceLoadMode === 'segmented' && this.sog4SequenceSegments.length > 1;
    }



    // #WDD-gpt 2026-05-16 - 大 PLY4 序列自动切换 lazy 模式时主动告知用户
    private showPly4LazyModeDialog(totalSize: number, segmentCount: number) {
        return new Promise<void>((resolve) => {
            // #WDD-gpt 2026-05-16 - 用项目内玻璃风格弹窗替代浏览器 alert，避免破坏 UI 一致性
            document.getElementById('ply4-lazy-mode-dialog')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'ply4-lazy-mode-dialog';
            overlay.className = 'ply4-lazy-mode-dialog';
            overlay.innerHTML = `
                <div class="ply4-lazy-mode-card">
                    <div class="ply4-lazy-mode-kicker">PLY4 Sequence Mode</div>
                    <div class="ply4-lazy-mode-title">Lazy Segmented Buffering</div>
                    <div class="ply4-lazy-mode-body">
                        <div class="ply4-lazy-mode-row">
                            <span>Total Size</span>
                            <strong>${this.formatImportBudget(totalSize)}</strong>
                        </div>
                        <div class="ply4-lazy-mode-row">
                            <span>Segments</span>
                            <strong>${segmentCount}</strong>
                        </div>
                        <p>The current PLY4 sequence is larger than 4.0 GB. Lazy segmented buffering will be used automatically.</p>
                        <ul>
                            <li>Headers are read first to build the full timeline.</li>
                            <li>Only the visible segment is decoded and uploaded to the GPU.</li>
                            <li>Selection and deletion state is saved per segment.</li>
                            <li>Playback pauses when switching to an uncached segment and shows loading progress.</li>
                        </ul>
                    </div>
                    <div class="ply4-lazy-mode-actions">
                        <button id="ply4-lazy-mode-continue" class="ui-btn ply4-lazy-mode-button">Continue</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            const close = () => {
                overlay.remove();
                resolve();
            };
            overlay.querySelector('#ply4-lazy-mode-continue')?.addEventListener('click', close, { once: true });
        });
    }

    // #WDD 2026-07-04: 通用自定义确认对话框（替代浏览器 confirm），复用 ply4-lazy-mode 玻璃风格，返回 Promise<boolean>
    public showConfirmDialog(opts: {
        kicker?: string;
        title: string;
        bodyHtml?: string;
        okLabel?: string;
        cancelLabel?: string;
        danger?: boolean;
    }): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            document.getElementById('app-confirm-dialog')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'app-confirm-dialog';
            overlay.className = 'ply4-lazy-mode-dialog';
            const kicker = opts.kicker ? `<div class="ply4-lazy-mode-kicker">${opts.kicker}</div>` : '';
            const body = opts.bodyHtml ? `<div class="ply4-lazy-mode-body">${opts.bodyHtml}</div>` : '';
            overlay.innerHTML = `
                <div class="ply4-lazy-mode-card">
                    ${kicker}
                    <div class="ply4-lazy-mode-title">${opts.title}</div>
                    ${body}
                    <div class="ply4-lazy-mode-actions" style="gap:8px;">
                        <button id="app-confirm-cancel" class="ui-btn ply4-lazy-mode-button">${opts.cancelLabel ?? 'Cancel'}</button>
                        <button id="app-confirm-ok" class="ui-btn ply4-lazy-mode-button">${opts.okLabel ?? 'OK'}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            if (opts.danger) {
                overlay.querySelector('#app-confirm-ok')?.classList.add('active');
            }
            const finish = (result: boolean) => { overlay.remove(); resolve(result); };
            overlay.querySelector('#app-confirm-ok')?.addEventListener('click', () => finish(true), { once: true });
            overlay.querySelector('#app-confirm-cancel')?.addEventListener('click', () => finish(false), { once: true });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); }, { once: true });
        });
    }

    // #WDD-gpt 2026-05-16 - Lazy 模式按段解码时在右下角显示读取进度
    private ensureLazySegmentProgressUI() {
        if (this.lazySegmentProgressEl) return;
        const el = document.createElement('div');
        el.id = 'lazy-segment-progress';
        el.className = 'lazy-segment-progress hidden';
        el.innerHTML = `
            <div class="lazy-segment-progress-title" id="lazy-segment-progress-title">PLY4 Lazy Segment</div>
            <div class="lazy-segment-progress-track">
                <div class="lazy-segment-progress-bar" id="lazy-segment-progress-bar"></div>
            </div>
            <div class="lazy-segment-progress-detail" id="lazy-segment-progress-detail">Waiting</div>
        `;
        document.body.appendChild(el);
        this.lazySegmentProgressEl = el;
        this.lazySegmentProgressBarEl = document.getElementById('lazy-segment-progress-bar');
        this.lazySegmentProgressTitleEl = document.getElementById('lazy-segment-progress-title');
        this.lazySegmentProgressDetailEl = document.getElementById('lazy-segment-progress-detail');
    }

    private ensureLazyBlockerUI() {
        if (this.lazyBlockerEl) return;
        const el = document.createElement('div');
        el.id = 'lazy-blocker';
        el.className = 'lazy-blocker hidden';
        document.body.appendChild(el);
        this.lazyBlockerEl = el;
    }

    private showLazyBlocker() {
        this.ensureLazyBlockerUI();
        this.lazyBlockerEl?.classList.remove('hidden');
    }

    private hideLazyBlocker() {
        this.lazyBlockerEl?.classList.add('hidden');
    }

    private showLazySegmentProgress(percent: number, title: string, detail: string) {
        this.ensureLazySegmentProgressUI();
        const p = Math.max(0, Math.min(100, percent));
        this.lazySegmentProgressEl?.classList.remove('hidden');
        if (this.lazySegmentProgressBarEl) this.lazySegmentProgressBarEl.style.width = `${p}%`;
        if (this.lazySegmentProgressTitleEl) this.lazySegmentProgressTitleEl.textContent = title;
        if (this.lazySegmentProgressDetailEl) this.lazySegmentProgressDetailEl.textContent = detail;
        this.showLazyBlocker();
    }

    private hideLazySegmentProgress(delayMs = 500) {
        window.setTimeout(() => {
            this.lazySegmentProgressEl?.classList.add('hidden');
            this.hideLazyBlocker();
        }, delayMs);
    }

    // #WDD-gpt 2026-05-16 - 播放推进到未缓存 PLY4 段时先暂停，避免时间轴继续越过正在加载的片段
    private pausePlaybackForLazySegment(segmentName: string) {
        if (!this.isPlaying) return;
        this.togglePlay();
        this.playbackTime = this.currentTime;
        this.showLazySegmentProgress(0, 'PLY4 Lazy Loading', `Paused while loading ${segmentName}`);
    }

    
    private async loadSog4Sequence(files: File[]): Promise<void> {
        let totalSize = 0;
        for (const f of files) totalSize += f.size;
        this.currentFileSize = totalSize;
        
        const maxLimitBytes = this.getAdaptiveSequenceImportBudgetBytes();
        
        if (totalSize > maxLimitBytes) {
           alert(`[Memory Preflight Blocked]\n\nLoading was aborted.\n\nThe selected SOG4 sequence totals ${this.formatImportBudget(totalSize)}, exceeding the current 10GB processing budget (${this.formatImportBudget(maxLimitBytes)}).\n\nRecommended action: select fewer sequence segments and process them in batches, or use a machine with more GPU/system memory and a 64-bit browser.`);
           return;
        }

        this.resetTransientStateForNewAsset();
        const overlay = document.getElementById('loading-overlay');
        const progress = this.createSequenceProgressUpdater();
        progress(0, 'PREPARING', `Loading ${files.length} SOG4 segments`);
        let succeeded = false;
        try {
            this.activeLoadingSequenceCleanup();

            // #WDD 2026-05-12 Update: Use numeric sort to ensure segment sequence like 1, 2, 10 instead of 1, 10, 2
            const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            this.isSog4SequenceMode = true;
            this.sog4SequenceFiles = sorted;
            const base = sorted[0]?.name ? sorted[0].name.replace(/\.sog4$/i, '') : 'sog4_sequence';
            this.sog4SequenceName = `${base}_sequence.sog4`;
            this.sog4SequenceSharedTransform = null;
            this.sog4SequenceSegments = [];
            this.sog4SequenceOffsets = [];
            this.sog4SequenceTotalFrames = 0;
            this.sog4SequenceIndex = 0;
            this.sog4SequenceLoading = true;
            const requestId = ++this.sog4SequenceRequestId;

            const loader = new SOG4Loader(this.app);
            for (let i = 0; i < sorted.length; i++) {
                const file = sorted[i];
                const step = Math.min(8, Math.floor((i / Math.max(1, sorted.length - 1)) * 8));
                progress(step, 'LOADING', `Parsing ${file.name}`);
                const parsed = await loader.load(file, () => { });
                const duration = Math.max(1, Math.floor(parsed.frames || parsed.maxMu || 100));
                this.sog4SequenceOffsets.push(this.sog4SequenceTotalFrames);
                this.sog4SequenceTotalFrames += duration;
                this.sog4SequenceSegments.push({ name: file.name, parsed, asset: null, entity: null, duration });
            }

            if (!this.sog4SequenceSegments.length) throw new Error('No SOG4 segments parsed');
            for (let i = 0; i < this.sog4SequenceSegments.length; i++) {
                const step = Math.min(8, 4 + Math.floor((i / Math.max(1, this.sog4SequenceSegments.length - 1)) * 4));
                progress(step, 'PREPARING', `Preparing ${this.sog4SequenceSegments[i].name}`);
                await this.prepareSog4SequenceSegment(i);
            }
            this.resetTimelineTools();
            await this.activateSog4SequenceSegment(0);
            this.currentTime = 0;
            this.playbackTime = 0;
            this.rebuildSplatSequenceFromTemporalSegments(this.sog4SequenceName || 'sog4_sequence');

            const first = this.sog4SequenceSegments[0];
            if (first?.parsed?.cameras && Array.isArray(first.parsed.cameras)) {
                this.presetManager.cameraPresets = first.parsed.cameras.map((c: any) => ({
                    name: c.name,
                    pos: new pc.Vec3(c.pos[0], c.pos[1], c.pos[2]),
                    pitch: c.pitch,
                    yaw: c.yaw,
                    textObjects: c.textObjects
                }));
                this.presetManager.renderPresets();
            }
            if (first?.parsed?.postProcessing) {
                this.postProcessingTool.exposure = first.parsed.postProcessing.exposure || 1.0;
                this.postProcessingTool.brightness = first.parsed.postProcessing.brightness || 0.0;
                this.postProcessingTool.contrast = first.parsed.postProcessing.contrast || 0.0;
                this.postProcessingTool.applySettings();
            }

            if (this.sog4SequenceRequestId === requestId) {
                this.sog4SequenceLoading = false;
            }
            this.refreshExportButtons();
            this.updateTransformUIFromEntity();
            this.fileInfoPanel.refresh();

            // #WDD 2026-05-16: Do not auto-play or hide UI on SOG4 sequence load

            setTimeout(() => { if (overlay) overlay.classList.add('hidden'); }, 200);

            succeeded = true;
        } catch (err) {
            console.error('SOG4 sequence load failed', err);
            alert('Failed to load SOG4 sequence: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            if (!succeeded) {
                this.isSog4SequenceMode = false;
                this.sog4SequenceFiles = [];
                this.sog4SequenceSegments = [];
                this.sog4SequenceOffsets = [];
                this.sog4SequenceTotalFrames = 0;
                this.sog4SequenceIndex = 0;
                this.sog4SequenceLoading = false;
                this.refreshExportButtons();
                overlay?.classList.add('hidden');
            }
        }
    }

    // #WDD-gpt 2026-04-20 - 新增 PLY4 多段序列读取，和 SOG4 一样按段累计总帧
    private async loadPly4Sequence(files: File[], skipLazyDialog = false): Promise<void> {
        let totalSize = 0;
        for (const f of files) totalSize += f.size;
        this.currentFileSize = totalSize;

        const useSegmentedMode = this.shouldUseSegmentedPly4Mode(totalSize);
        const maxLimitBytes = this.getAdaptiveSequenceImportBudgetBytes();

        if (!useSegmentedMode && totalSize > maxLimitBytes) {
           alert(`[Memory Preflight Blocked]\n\nLoading was aborted.\n\nThe selected PLY4 sequence totals ${this.formatImportBudget(totalSize)}, exceeding the current 10GB processing budget (${this.formatImportBudget(maxLimitBytes)}).\n\nEven after preflight, very large PLY4 files can still hit browser ArrayBuffer or GPU driver limits.\n\nRecommended action: select fewer sequence segments and process them in batches, or use a machine with more GPU/system memory and a 64-bit browser.`);
           return;
        }
        if (useSegmentedMode && !skipLazyDialog) {
            await this.showPly4LazyModeDialog(totalSize, files.length);
        }

        this.resetTransientStateForNewAsset();
        const overlay = document.getElementById('loading-overlay');
        const progress = this.createSequenceProgressUpdater();
        progress(0, 'PREPARING', `${useSegmentedMode ? 'Segmented buffering' : 'Loading'} ${files.length} PLY4 segments`);
        let succeeded = false;
        try {
            this.activeLoadingSequenceCleanup();
            this.updatePly4SequenceLoadModeBadge(useSegmentedMode ? 'lazy' : 'full', totalSize, files.length);

            // #WDD 2026-05-12 Update: Use numeric sort to ensure segment sequence like 1, 2, 10 instead of 1, 10, 2
            const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            this.isSog4SequenceMode = true;
            this.sog4SequenceFiles = sorted;
            const base = sorted[0]?.name ? sorted[0].name.replace(/\.ply4$/i, '') : 'ply4_sequence';
            this.sog4SequenceName = `${base}_sequence.ply4`;
            this.sog4SequenceSharedTransform = null;
            this.sog4SequenceSegments = [];
            this.sog4SequenceOffsets = [];
            this.sog4SequenceTotalFrames = 0;
            this.sog4SequenceIndex = 0;
            this.sog4SequenceLoading = true;
            this.ply4SequenceLoadMode = useSegmentedMode ? 'segmented' : 'full';
            this.sequenceEditStates.clear();
            const requestId = ++this.sog4SequenceRequestId;

            const loader = new PLY4Loader();
            for (let i = 0; i < sorted.length; i++) {
                const file = sorted[i];
                const step = Math.min(8, Math.floor((i / Math.max(1, sorted.length - 1)) * 8));
                progress(step, useSegmentedMode ? 'INSPECTING' : 'LOADING', `${useSegmentedMode ? 'Reading header' : 'Parsing'} ${file.name}`);
                const parsed = useSegmentedMode ? null : await loader.load(file, () => { });
                const header = useSegmentedMode ? await loader.inspectFile(file) : null;
                const duration = Math.max(1, Math.floor((parsed?.frames || parsed?.maxMu || header?.duration || 100)));
                this.sog4SequenceOffsets.push(this.sog4SequenceTotalFrames);
                this.sog4SequenceTotalFrames += duration;
                this.sog4SequenceSegments.push({ name: file.name, parsed, asset: null, entity: null, duration, file, header });
            }

            if (!this.sog4SequenceSegments.length) throw new Error('No PLY4 segments parsed');
            if (!useSegmentedMode) {
                for (let i = 0; i < this.sog4SequenceSegments.length; i++) {
                    const step = Math.min(8, 4 + Math.floor((i / Math.max(1, this.sog4SequenceSegments.length - 1)) * 4));
                    progress(step, 'PREPARING', `Preparing ${this.sog4SequenceSegments[i].name}`);
                    await this.prepareSog4SequenceSegment(i);
                }
            } else {
                progress(8, 'BUFFERING', 'Preparing first visible segment only');
            }
            this.resetTimelineTools();
            this.rebuildSplatSequenceFromTemporalSegments(this.sog4SequenceName || 'ply4_sequence');
            this.selectionTool?.refreshLazyModeVisibility?.();
            await this.activateSog4SequenceSegment(0);
            this.currentTime = 0;
            this.playbackTime = 0;

            const first = this.sog4SequenceSegments[0];
            if (first?.parsed?.cameras && Array.isArray(first.parsed.cameras)) {
                this.presetManager.cameraPresets = first.parsed.cameras.map((c: any) => ({
                    name: c.name,
                    pos: new pc.Vec3(c.pos[0], c.pos[1], c.pos[2]),
                    pitch: c.pitch,
                    yaw: c.yaw,
                    textObjects: c.textObjects
                }));
                this.presetManager.renderPresets();
            }
            if (first?.parsed?.postProcessing) {
                this.postProcessingTool.exposure = first.parsed.postProcessing.exposure || 1.0;
                this.postProcessingTool.brightness = first.parsed.postProcessing.brightness || 0.0;
                this.postProcessingTool.contrast = first.parsed.postProcessing.contrast || 0.0;
                this.postProcessingTool.applySettings();
            }

            if (this.sog4SequenceRequestId === requestId) {
                this.sog4SequenceLoading = false;
            }
            this.refreshExportButtons();
            this.selectionTool?.refreshLazyModeVisibility?.();
            this.updateTransformUIFromEntity();
            this.fileInfoPanel.refresh();

            // #WDD 2026-05-16: Do not auto-play or hide UI on PLY4 sequence load

            setTimeout(() => { if (overlay) overlay.classList.add('hidden'); }, 200);
            succeeded = true;
        } catch (err) {
            console.error('PLY4 sequence load failed', err);
            alert('Failed to load PLY4 sequence: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            if (!succeeded) {
                this.isSog4SequenceMode = false;
                this.sog4SequenceFiles = [];
                this.sog4SequenceSegments = [];
                this.sog4SequenceOffsets = [];
                this.sog4SequenceTotalFrames = 0;
                this.sog4SequenceIndex = 0;
                this.sog4SequenceLoading = false;
                this.ply4SequenceLoadMode = 'full';
                this.sequenceEditStates.clear();
                this.updatePly4SequenceLoadModeBadge('hidden');
                this.refreshExportButtons();
                overlay?.classList.add('hidden');
            }
        }
    }



    
    private async applyParsedSog4Segment(parsed: any, name: string, options: { preload?: boolean; hideEntity?: boolean } = {}): Promise<{ asset: pc.Asset; entity: pc.Entity; duration: number }> {
        const overlay = document.getElementById('loading-overlay');

        if (!options.preload) {
            const sharedName = this.isSog4SequenceMode ? (this.sog4SequenceName || name) : name;
            this.currentFileName = sharedName;
            this.currentTransformCacheKey = sharedName;
        }

        if (!options.preload) {
            // #WDD-gpt 2026-06-13 - 单段加载替换模型前清理独立 ALL 点云
            this.destroyDebugAllPointsEntity();
            this.disposeDynamicSorter();
            if (this.splatEntity) this.splatEntity.destroy();
            // #WDD-gpt 2026-07-31 - 单模型替换时在旧实体销毁后释放重光照法线纹理
            this.ply4Relighting.disposeAllNormalTextures();
            this.presetManager.cameraPresets = [];
            this.presetManager.renderPresets();
            this.isSequenceMode = false;
            this.sequenceAssets = [];
            this.sequenceFrameIndex = -1;
            this.sequenceBands = 0;
        }

        const scElem = document.getElementById('splat-count');
        if (scElem) scElem.innerText = '--';

        this.lastParsedData = parsed;
        const count = parsed.count;

        const elements = parsed.plyData.elements;
        const vertexElement = elements[0];
        const splatData = new (pc.GSplatData as any)([vertexElement]);
        const resource = new pc.GSplatResource(this.app.graphicsDevice, splatData);

        const blob = new Blob([parsed.sogBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const asset = new pc.Asset(name, 'gsplat', { url: url });
        asset.resource = resource;
        asset.loaded = true;
        this.app.assets.add(asset);

        const entity = new pc.Entity('GSplat');
        entity.addComponent('gsplat', { asset: asset });
        if (options.hideEntity) {
            entity.enabled = false;
        }

        let arScaleFactor = 1.0;
        this.app.root.addChild(entity);
        if (this.arHandler && this.arHandler.isARRunning && this.arHandler.arAnchor) {
            console.log("[Viewer] AR Active: Reparenting new Splat to AR Anchor");
            this.arHandler.arAnchor.addChild(entity);
            entity.setLocalPosition(0, 0, 0);
            entity.setLocalRotation(new pc.Quat().setFromEulerAngles(0, 0, 0));
            const pScale = this.arHandler.arAnchor.getLocalScale().x;
            console.log(`[Viewer] AR Anchor Scale: ${pScale}`);
            if (pScale !== 0) {
                arScaleFactor = 1.0 / pScale;
            }
        }

        this.splatEntity = entity;

        
        const shared = this.sog4SequenceSharedTransform;
        if (shared) {
            if (shared.pos) entity.setLocalPosition(shared.pos[0], shared.pos[1], shared.pos[2]);
            if (shared.rot) entity.setLocalRotation(new pc.Quat(shared.rot[0], shared.rot[1], shared.rot[2], shared.rot[3]));
            if (shared.scale) entity.setLocalScale(shared.scale[0], shared.scale[1], shared.scale[2]);
        } else if (parsed.model_transform) {
            const t = parsed.model_transform;
            this.sog4SequenceSharedTransform = { pos: t.pos || [0, 0, 0], rot: t.rot || [0, 0, 0, 1], scale: t.scale || [1, 1, 1] };
            if (t.pos) entity.setLocalPosition(t.pos[0], t.pos[1], t.pos[2]);
            if (t.rot) entity.setLocalRotation(new pc.Quat(t.rot[0], t.rot[1], t.rot[2], t.rot[3]));
            if (t.scale) entity.setLocalScale(t.scale[0], t.scale[1], t.scale[2]);
        } else {
            this.sog4SequenceSharedTransform = this.sog4SequenceSharedTransform || { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
        }


        console.log("[Viewer] Final Entity World Pos:", entity.getPosition().toString());
        console.log("[Viewer] Final Entity World Scale:", entity.getLocalScale().toString());

        if (!options.preload && !this.isSog4SequenceMode && parsed.cameras && Array.isArray(parsed.cameras)) {
            this.presetManager.cameraPresets = parsed.cameras.map((c: any) => ({
                name: c.name,
                pos: new pc.Vec3(c.pos[0], c.pos[1], c.pos[2]),
                pitch: c.pitch,
                yaw: c.yaw,
                textObjects: c.textObjects
            }));
            this.presetManager.renderPresets();
            console.log(`[TrueSplats] Restored ${this.presetManager.cameraPresets.length} Camera Presets`);
        }

        const duration = parsed.frames || parsed.maxMu || 100;
        this.finalizeGSplatLoad(asset, count, null, duration, parsed, { suppressUI: options.preload });

        if (!options.preload && !this.isSog4SequenceMode && parsed.postProcessing) {
            console.log('[Viewer] Applying postProcessing from file:', parsed.postProcessing);
            this.postProcessingTool.exposure = parsed.postProcessing.exposure || 1.0;
            this.postProcessingTool.brightness = parsed.postProcessing.brightness || 0.0;
            this.postProcessingTool.contrast = parsed.postProcessing.contrast || 0.0;
            this.postProcessingTool.applySettings();
            const expInput = document.getElementById('pp-exposure') as HTMLInputElement;
            const briInput = document.getElementById('pp-brightness') as HTMLInputElement;
            const conInput = document.getElementById('pp-contrast') as HTMLInputElement;
            if (expInput) {
                expInput.value = this.postProcessingTool.exposure.toString();
                const expVal = document.getElementById('val-exposure');
                if (expVal) expVal.innerText = this.postProcessingTool.exposure.toFixed(1);
            }
            if (briInput) {
                briInput.value = this.postProcessingTool.brightness.toString();
                const briVal = document.getElementById('val-brightness');
                if (briVal) briVal.innerText = this.postProcessingTool.brightness > 0 ? '+' + this.postProcessingTool.brightness.toFixed(2) : this.postProcessingTool.brightness.toFixed(2);
            }
            if (conInput) {
                conInput.value = this.postProcessingTool.contrast.toString();
                const conVal = document.getElementById('val-contrast');
                if (conVal) conVal.innerText = this.postProcessingTool.contrast > 0 ? '+' + this.postProcessingTool.contrast.toFixed(2) : this.postProcessingTool.contrast.toFixed(2);
            }
        }

        if (!options.preload) {
            setTimeout(() => { if (overlay) overlay.classList.add('hidden'); }, 200);
        }

        return { asset, entity, duration };
    }

    private async advanceSog4Sequence(): Promise<void> {
        if (!this.isSog4SequenceMode || this.sog4SequenceSegments.length === 0) return;
        if (this.sog4SequenceLoading) return;

        this.sog4SequenceLoading = true;
        const nextIndex = (this.sog4SequenceIndex + 1) % this.sog4SequenceSegments.length;
        const requestId = ++this.sog4SequenceRequestId;

        try {
            await this.activateSog4SequenceSegment(nextIndex);
            this.currentTime = this.sog4SequenceOffsets[nextIndex] || 0;
            this.playbackTime = this.currentTime;
        } catch (err) {
            console.error('SOG4 segment switch failed', err);
            alert('Failed to switch SOG4 segment: ' + (err instanceof Error ? err.message : String(err)));
            this.isSog4SequenceMode = false;
            this.sog4SequenceFiles = [];
            this.sog4SequenceSegments = [];
            this.sog4SequenceOffsets = [];
            this.sog4SequenceTotalFrames = 0;
            this.sog4SequenceIndex = 0;
        } finally {
            if (this.sog4SequenceRequestId === requestId) {
                this.sog4SequenceLoading = false;
            }
        }
    }

    
    private getSog4SegmentIndex(globalTime: number): number {
        if (!this.sog4SequenceOffsets.length) return 0;
        let idx = this.sog4SequenceOffsets.length - 1;
        for (let i = 0; i < this.sog4SequenceOffsets.length; i++) {
            const start = this.sog4SequenceOffsets[i];
            const end = (i + 1 < this.sog4SequenceOffsets.length) ? this.sog4SequenceOffsets[i + 1] : this.sog4SequenceTotalFrames;
            if (globalTime >= start && globalTime < end) {
                idx = i;
                break;
            }
        }
        return idx;
    }

    private applySog4LocalTime(localTime: number) {
        const shaderTime = Math.floor(localTime);
        // SOG4 multi-segment playback still uses dynamic 4DGS trajectories, so the
        // depth sorter must be updated with the segment-local frame as well.
        // Otherwise the shader moves splats to the correct XYZ, but blending keeps
        // using stale centers from the previous segment/frame, which shows up as
        // black speckles / opacity corruption.
        if (this.is4DGS && this.trajectoryData && !this.isWaitingForSort) {
            this.updateDynamicPositions(shaderTime);
        }
        if (this.splatEntity?.gsplat) {
            const material = (this.splatEntity.gsplat as any).instance.material;
            if (material) {
                material.setParameter('uTransitionFactor', 0.0);
                material.setParameter('uRotationFactor', 0.0);
                material.setParameter('uTime', shaderTime);
                material.setParameter('uGlobalTotalFrames', this.duration);
            }
        }
    }

    private setSog4SequenceVisibleSegment(activeIndex: number | null) {
        // #WDD-gpt 2026-06-22 - Render ALL 使用独立点云，暂停刷新段时间时不能重新打开主 GSplat，否则会和 ALL 点云交替显示造成闪烁
        if (this.gaussianRenderMode === 3 && activeIndex !== null) {
            activeIndex = null;
        }
        for (let i = 0; i < this.sog4SequenceSegments.length; i++) {
            const entity = this.sog4SequenceSegments[i]?.entity;
            if (!entity) continue;
            entity.enabled = activeIndex !== null && i === activeIndex;
        }
    }

    private attachSog4SequenceEntity(entity: pc.Entity, parsed: any) {
        this.app.root.addChild(entity);
        if (this.arHandler && this.arHandler.isARRunning && this.arHandler.arAnchor) {
            this.arHandler.arAnchor.addChild(entity);
            entity.setLocalPosition(0, 0, 0);
            entity.setLocalRotation(new pc.Quat().setFromEulerAngles(0, 0, 0));
        }

        const shared = this.sog4SequenceSharedTransform;
        if (shared) {
            if (shared.pos) entity.setLocalPosition(shared.pos[0], shared.pos[1], shared.pos[2]);
            if (shared.rot) entity.setLocalRotation(new pc.Quat(shared.rot[0], shared.rot[1], shared.rot[2], shared.rot[3]));
            if (shared.scale) entity.setLocalScale(shared.scale[0], shared.scale[1], shared.scale[2]);
            return;
        }

        if (parsed?.model_transform) {
            const t = parsed.model_transform;
            this.sog4SequenceSharedTransform = { pos: t.pos || [0, 0, 0], rot: t.rot || [0, 0, 0, 1], scale: t.scale || [1, 1, 1] };
            if (t.pos) entity.setLocalPosition(t.pos[0], t.pos[1], t.pos[2]);
            if (t.rot) entity.setLocalRotation(new pc.Quat(t.rot[0], t.rot[1], t.rot[2], t.rot[3]));
            if (t.scale) entity.setLocalScale(t.scale[0], t.scale[1], t.scale[2]);
            return;
        }

        // #WDD-gpt 2026-04-20 - 多段 PLY4 读取时也要应用 parsed.meta 里的位姿，否则 UI 显示正确但实体不生效
        if (parsed?.meta) {
            const modelPos = parsed.meta.modelPos;
            const modelRot = parsed.meta.modelRot;
            const modelScale = parsed.meta.modelScale;
            const pos = modelPos ? [modelPos.x || 0, modelPos.y || 0, modelPos.z || 0] : [0, 0, 0];
            const rot = modelRot ? [modelRot.x || 0, modelRot.y || 0, modelRot.z || 0, modelRot.w ?? 1] : [0, 0, 0, 1];
            const scale = modelScale ? [modelScale.x || 1, modelScale.y || 1, modelScale.z || 1] : [1, 1, 1];
            this.sog4SequenceSharedTransform = { pos, rot, scale };
            entity.setLocalPosition(pos[0], pos[1], pos[2]);
            entity.setLocalRotation(new pc.Quat(rot[0], rot[1], rot[2], rot[3]));
            entity.setLocalScale(scale[0], scale[1], scale[2]);
        }
    }

    private createSog4SegmentAsset(parsed: any, name: string): pc.Asset {
        if (!parsed?.sogBuffer) {
            // #WDD-gpt 2026-04-20 - PLY4 分段没有 sogBuffer，改用 plyData 构建资源
            return this.createGsplatAssetFromVertexElement(name, parsed.plyData.elements[0]);
        }
        const vertexElement = parsed.plyData.elements[0];
        const splatData = new (pc.GSplatData as any)([vertexElement]);
        const resource = new pc.GSplatResource(this.app.graphicsDevice, splatData);

        const blob = new Blob([parsed.sogBuffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const asset = new pc.Asset(name, 'gsplat', { url });
        asset.resource = resource;
        asset.loaded = true;
        this.app.assets.add(asset);
        return asset;
    }

    private async prepareSog4SequenceSegment(index: number): Promise<void> {
        const segment = this.sog4SequenceSegments[index];
        if (!segment) return;
        if (segment.asset && segment.entity) return;
        const wasLoading = this.sog4SequenceLoading;
        this.sog4SequenceLoading = true;
        try {
        if (!segment.parsed && segment.file) {
            // #WDD-gpt 2026-05-16 - 分段缓冲模式在真正显示该段时才解码 PLY4，避免全序列同时占用内存
            const loader = new PLY4Loader();
            if (this.ply4SequenceLoadMode === 'segmented') {
                this.showLazySegmentProgress(2, 'PLY4 Lazy Loading', `Opening ${segment.name}`);
            }
            segment.parsed = await loader.load(segment.file, (progress, message, meta) => {
                if (this.ply4SequenceLoadMode !== 'segmented') return;
                const pct = Math.min(88, Math.max(2, progress * 0.88));
                const chunk = meta?.chunkIndex && meta?.chunkCount ? ` • chunk ${meta.chunkIndex}/${meta.chunkCount}` : '';
                const rows = meta?.rowsRead && meta?.rowCount ? ` • ${meta.rowsRead.toLocaleString()}/${meta.rowCount.toLocaleString()}` : '';
                this.showLazySegmentProgress(pct, `PLY4 Lazy ${index + 1}/${this.sog4SequenceSegments.length}`, `${segment.name} • ${message}${chunk}${rows}`);
            });
            segment.duration = Math.max(1, Math.floor(segment.parsed.frames || segment.parsed.maxMu || segment.duration || 100));
            const element = this.splatSequence?.elements?.[index];
            if (element) {
                element.parsed = segment.parsed;
                element.duration = segment.duration;
                element.globalEndFrame = element.globalStartFrame + segment.duration;
            }
        }
        if (!segment.parsed) {
            this.sog4SequenceLoading = wasLoading;
            return;
        }

        if (this.ply4SequenceLoadMode === 'segmented') {
            this.showLazySegmentProgress(90, `PLY4 Lazy ${index + 1}/${this.sog4SequenceSegments.length}`, `Uploading ${segment.name} to GPU`);
        }
        const asset = this.createSog4SegmentAsset(segment.parsed, segment.name);
        segment.asset = asset;

        const entity = new pc.Entity('GSplat');
        entity.addComponent('gsplat', { asset });
        this.attachSog4SequenceEntity(entity, segment.parsed);
        entity.enabled = true;
        segment.entity = entity;
        const element = this.splatSequence?.elements?.[index];
        if (element) {
            element.parsed = segment.parsed;
            element.asset = asset;
            element.entity = entity;
            element.duration = segment.duration;
            element.globalEndFrame = element.globalStartFrame + segment.duration;
        }

        const inst = await this.waitForGsplatMaterial(
            entity,
            () => this.isSog4SequenceMode && this.sog4SequenceSegments[index]?.entity === entity
        );
        if (!inst) {
            this.sog4SequenceLoading = wasLoading;
            return;
        }
        entity.enabled = false;
        if (this.ply4SequenceLoadMode === 'segmented') {
            this.showLazySegmentProgress(96, `PLY4 Lazy ${index + 1}/${this.sog4SequenceSegments.length}`, `Prepared ${segment.name}`);
        }
        } finally {
            this.sog4SequenceLoading = wasLoading;
        }
    }

    // #WDD-gpt 2026-05-16 - 分段缓冲时把选择/删除状态从可销毁的渲染资源中复制出来
    private saveSog4SegmentEditState(index: number) {
        if (index < 0) return;
        const element = this.splatSequence?.elements?.[index];
        const runtime = element?.runtime as any;
        const selectionData = runtime?.selectionData instanceof Uint8Array
            ? runtime.selectionData
            : (index === this.sog4SequenceIndex && this.selectionTool?.selectionData instanceof Uint8Array ? this.selectionTool.selectionData : null);
        const allTimeSelectionData = runtime?.allTimeSelectionData instanceof Uint8Array
            ? runtime.allTimeSelectionData
            : (index === this.sog4SequenceIndex && this.selectionTool?.allTimeSelectionData instanceof Uint8Array ? this.selectionTool.allTimeSelectionData : null);
        if (!selectionData && !allTimeSelectionData) return;
        this.sequenceEditStates.set(index, {
            selectionData: selectionData ? new Uint8Array(selectionData) : null,
            allTimeSelectionData: allTimeSelectionData ? new Uint8Array(allTimeSelectionData) : null
        });
    }

    // #WDD-gpt 2026-05-16 - 恢复分段缓存释放前保存的选择/删除通道
    private applySog4SegmentEditState(index: number) {
        const saved = this.sequenceEditStates.get(index);
        const element = this.splatSequence?.elements?.[index];
        const runtime = element?.runtime as any;
        if (!saved || !runtime) return;
        if (saved.selectionData && runtime.selectionData instanceof Uint8Array) {
            runtime.selectionData.set(saved.selectionData.subarray(0, Math.min(saved.selectionData.length, runtime.selectionData.length)));
        }
        if (saved.allTimeSelectionData && runtime.allTimeSelectionData instanceof Uint8Array) {
            runtime.allTimeSelectionData.set(saved.allTimeSelectionData.subarray(0, Math.min(saved.allTimeSelectionData.length, runtime.allTimeSelectionData.length)));
        }
        if (runtime.selectionTexture && runtime.selectionData instanceof Uint8Array) {
            const lock = runtime.selectionTexture.lock();
            lock.set(runtime.selectionData);
            runtime.selectionTexture.unlock();
            this.updateSelectionUniform(runtime.selectionTexture);
        }
    }

    // #WDD-gpt 2026-05-16 - 释放非活动 PLY4 段的 GPU/CPU 渲染缓存，只保留独立编辑状态
    private prunePly4SegmentCache(activeIndex: number) {
        if (this.ply4SequenceLoadMode !== 'segmented') return;
        for (let i = 0; i < this.sog4SequenceSegments.length; i++) {
            if (i === activeIndex) continue;
            const segment = this.sog4SequenceSegments[i];
            if (!segment) continue;
            const element = this.splatSequence?.elements?.[i] as any;
            this.saveSog4SegmentEditState(i);
            if (segment.entity) {
                segment.entity.destroy();
                segment.entity = null;
            }
            if (segment.asset) {
                try {
                    const resource = segment.asset.resource as any;
                    if (resource && typeof resource.destroy === 'function') resource.destroy();
                    this.app.assets.remove(segment.asset);
                } catch (err) {
                    console.warn('[PLY4 Sequence] Failed to release segment asset:', segment.name, err);
                }
                segment.asset = null;
            }
            // #WDD-gpt 2026-07-31 - 分段缓存淘汰时同步释放该段的重光照法线纹理
            this.ply4Relighting.disposeNormalTexture(element?.runtime?.relightingNormalTexture);
            segment.parsed = null;
            if (element) {
                element.parsed = null;
                element.asset = null;
                element.entity = null;
                element.runtime = null;
            }
        }
    }

    private clearActiveSog4SequenceRenderState() {
        this.disposeDynamicSorter();
        this.splatEntity = null;
        this.is4DGS = false;
        this.trajectoryData = null;
        this.trajectoryTexture = null;
        this.keyframes = 0;
        this.xyzStride = 1;
        this.rotTrajectoryData = null;
        this.rotKeyframes = 0;
        this.rotStride = 1;
        this.dcTrajectoryData = null;
        this.dcKeyframes = 0;
        this.dcStride = 1;
        this.posArrays = null;
        this.originalIndices = null;
        this.cachedPositions = null;
        this.lifeTexData = null;
        this.scalesTexData = null;
    }

    private updateSog4SequenceTime() {
        const total = Math.max(1, this.sog4SequenceTotalFrames || this.duration || 1);
        const maxTime = Math.max(0, total - 1);
        const t = Math.max(0, Math.min(this.currentTime, maxTime));
        const segIndex = this.getSog4SegmentIndex(t);
        if (segIndex !== this.sog4SequenceIndex) {
            // #WDD-gpt 2026-05-16 - 分段缓冲切段需要异步解码，当前 tick 先返回，避免同步大内存分配
            if (!this.sog4SequenceLoading) {
                const targetSegment = this.sog4SequenceSegments[segIndex];
                if (this.ply4SequenceLoadMode === 'segmented' && targetSegment && (!targetSegment.asset || !targetSegment.entity)) {
                    this.pausePlaybackForLazySegment(targetSegment.name);
                }
                this.sog4SequenceLoading = true;
                void this.activateSog4SequenceSegment(segIndex).finally(() => {
                    this.sog4SequenceLoading = false;
                });
            }
            return { displayFrame: Math.floor(t), total };
        }
        const offset = this.sog4SequenceOffsets[segIndex] || 0;
        const localTime = t - offset;
        this.setSog4SequenceVisibleSegment(segIndex);
        this.applySog4LocalTime(localTime);
        return { displayFrame: Math.floor(t), total };
    }

    private async activateSog4SequenceSegment(index: number): Promise<void> {
        const segment = this.sog4SequenceSegments[index];
        if (!segment) return;
        if (this.sog4SequenceIndex === index && this.splatEntity && this.lastParsedData === segment.parsed) {
            this.setSog4SequenceVisibleSegment(index);
            return;
        }
        this.saveSog4SegmentEditState(this.sog4SequenceIndex);
        if (this.ply4SequenceLoadMode === 'segmented' && (!segment.asset || !segment.entity)) {
            this.pausePlaybackForLazySegment(segment.name);
        }
        if (!segment.asset || !segment.entity) {
            await this.prepareSog4SequenceSegment(index);
        }
        if (!segment.asset || !segment.entity || !segment.parsed) {
            console.warn('[SOG4 Sequence] Segment was not prepared before activation:', index, segment.name);
            return;
        }

        this.clearActiveSog4SequenceRenderState();

        this.sog4SequenceIndex = index;
        if (this.splatSequence) {
            this.splatSequence.activeElementIndex = index;
        }
        this.currentFileName = this.sog4SequenceName || segment.name;
        this.currentTransformCacheKey = this.currentFileName;
        this.splatEntity = segment.entity;
        this.lastParsedData = segment.parsed;
        this.resetTransientStateForNewAsset({ preserveSelection: true, segmentSwitch: true });

        // #WDD-kimi 2026-04-20 - 优先复用段内保存的选择状态，避免切段后删除状态丢失
        const preBoundElement = this.getSplatSequenceElementByAsset(segment.asset);
        if (preBoundElement?.runtime?.selectionData || preBoundElement?.runtime?.allTimeSelectionData) {
            if (!preBoundElement.runtime.selectionTexture) {
                const seed = (preBoundElement.runtime.selectionData as Uint8Array | null)
                    || (preBoundElement.runtime.allTimeSelectionData as Uint8Array | null)
                    || null;
                const restored = this.createSequenceSelectionStateForAsset(segment.asset, seed);
                if (restored) {
                    preBoundElement.runtime.selectionTexture = restored.selectionTexture;
                    preBoundElement.runtime.selectionData = restored.selectionData;
                    const prevAllTime = preBoundElement.runtime.allTimeSelectionData as Uint8Array | null;
                    if (prevAllTime && prevAllTime.length > 0) {
                        restored.allTimeSelectionData.set(prevAllTime.subarray(0, Math.min(prevAllTime.length, restored.allTimeSelectionData.length)));
                    }
                    preBoundElement.runtime.allTimeSelectionData = restored.allTimeSelectionData;
                } else {
                    this.ensureSequenceSelectionTextureForAsset(segment.asset, false);
                    preBoundElement.runtime.selectionTexture = this.selectionTool?.selectionTexture || null;
                }
            }
            if (this.selectionTool) {
                this.selectionTool.selectionData = preBoundElement.runtime.selectionData;
                this.selectionTool.allTimeSelectionData = preBoundElement.runtime.allTimeSelectionData;
                this.selectionTool.selectionTexture = preBoundElement.runtime.selectionTexture;
            }
            const activeSelectionData = preBoundElement.runtime.selectionData as Uint8Array | null;
            if (preBoundElement.runtime.selectionTexture && activeSelectionData) {
                const lock = preBoundElement.runtime.selectionTexture.lock();
                lock.set(activeSelectionData);
                preBoundElement.runtime.selectionTexture.unlock();
                this.updateSelectionUniform(preBoundElement.runtime.selectionTexture);
            }
        } else {
            // #WDD-kimi 2026-04-20 - 首次激活该段时创建独立选择状态，防止“当前帧工具”跨段污染
            const fresh = this.createSequenceSelectionStateForAsset(segment.asset, null);
            if (fresh) {
                if (preBoundElement) {
                    const rt = (preBoundElement.runtime || (preBoundElement.runtime = {} as any)) as any;
                    rt.selectionData = fresh.selectionData;
                    rt.allTimeSelectionData = fresh.allTimeSelectionData;
                    rt.selectionTexture = fresh.selectionTexture;
                }
                if (this.selectionTool) {
                    this.selectionTool.selectionData = fresh.selectionData;
                    this.selectionTool.allTimeSelectionData = fresh.allTimeSelectionData;
                    this.selectionTool.selectionTexture = fresh.selectionTexture;
                }
                this.updateSelectionUniform(fresh.selectionTexture);
            } else {
                this.ensureSequenceSelectionTextureForAsset(segment.asset, false);
            }
        }
        this.finalizeGSplatLoad(segment.asset, segment.parsed.count, null, segment.duration, segment.parsed, { suppressUI: true });
        this.applySog4SegmentEditState(index);
        if (this.selectionTool?.selectionTexture) {
            this.updateSelectionUniform(this.selectionTool.selectionTexture);
            this.updateSelectionModeParams(false);
        }

        // #WDD-gpt 2026-04-20 - 激活元素后回填 viewer 运行时引用，显式对齐到该队列元素
        const activeElement = this.getSplatSequenceElementByAsset(segment.asset);
        if (activeElement?.runtime) {
            this.is4DGS = activeElement.runtime.is4DGS;
            this.duration = activeElement.runtime.totalFrames;
            this.totalFrames = activeElement.runtime.totalFrames;
            this.keyframes = activeElement.runtime.keyframes;
            this.xyzStride = activeElement.runtime.xyzStride;
            this.rotKeyframes = activeElement.runtime.rotKeyframes;
            this.rotStride = activeElement.runtime.rotStride;
            this.dcKeyframes = activeElement.runtime.dcKeyframes;
            this.dcStride = activeElement.runtime.dcStride;
            this.lifeTexData = activeElement.runtime.lifeTexData;
            this.scalesTexData = activeElement.runtime.scalesTexData;
            this.trajectoryData = activeElement.runtime.trajectoryData;
            this.trajectoryTexture = activeElement.runtime.trajectoryTexture;
            this.rotTrajectoryData = activeElement.runtime.rotTrajectoryData;
            this.dcTrajectoryData = activeElement.runtime.dcTrajectoryData;
            this.originalIndices = activeElement.runtime.originalIndices;
            this.posArrays = activeElement.runtime.posArrays;
            this.cachedPositions = activeElement.runtime.cachedPositions;
            if (this.selectionTool) {
                this.selectionTool.selectionData = activeElement.runtime.selectionData;
                this.selectionTool.allTimeSelectionData = activeElement.runtime.allTimeSelectionData;
                this.selectionTool.selectionTexture = activeElement.runtime.selectionTexture;
            }
        }

        this.duration = segment.duration;
        this.totalFrames = this.duration;
        this.originalFrames = this.duration;


        this.setSog4SequenceVisibleSegment(index);
        const segmentStart = this.sog4SequenceOffsets[index] || 0;
        const localTime = Math.max(0, Math.min(segment.duration - 1, Math.floor(this.currentTime - segmentStart)));
        // #WDD-gpt 2026-06-22 - 切到第二段及以后暂停时应保持目标局部帧，避免先显示第 0 帧再被下一帧纠正造成闪烁
        this.applySog4LocalTime(localTime);
        // #WDD-gpt 2026-06-13 - 多段 PLY4 激活段变化后，ALL 点云跟随当前段刷新
        this.refreshDebugAllPointsEntity();
        this.updateTimelineTicks(this.sog4SequenceTotalFrames || this.duration);
        this.syncTimelineUI(this.currentTime, Math.max(0, Math.ceil(this.sog4SequenceTotalFrames || this.duration) - 1));
        this.fileLoader.updateStats(segment.asset);
        this.updateTransformUIFromEntity();
        this.fileInfoPanel.refresh();
        if (this.ply4SequenceLoadMode === 'segmented') {
            this.showLazySegmentProgress(100, `PLY4 Lazy ${index + 1}/${this.sog4SequenceSegments.length}`, `Ready ${segment.name}`);
            this.hideLazySegmentProgress(700);
        }
        this.prunePly4SegmentCache(index);
    }

    private async loadSogSequence(files: File[]): Promise<void> {
        const overlay = document.getElementById('loading-overlay');
        const progress = this.createSequenceProgressUpdater();
        this.currentFileSize = files.reduce((sum, file) => sum + file.size, 0);
        this.resetTransientStateForNewAsset();
        progress(0, 'PREPARING', `Parsing ${files.length} SOG frames`);
        let succeeded = false;
        const loader = new TrueSplatsLoader(this.app);
        const parseSOG = (loader as any).parseSOG.bind(loader);
        const sogV2Loader = new SOGv2Loader();
        try {
            // #WDD 2026-05-12 Sort files numerically to fix playback order
            const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            const assets: pc.Asset[] = [];
            let bands = 0;
            for (let i = 0; i < sorted.length; i++) {
                const file = sorted[i];
                const step = Math.min(8, Math.floor((i / Math.max(1, sorted.length - 1)) * 8));
                progress(step, 'LOADING', `Parsing ${file.name}`);
                const buffer = await file.arrayBuffer();
                // #WDD 2026-07-31 SOG 版本分流:
                //   - 官方 PlayCanvas SOG v2(meta.version === 2) 走 SOGv2Loader
                //   - 其他(项目 TrueSplats 私有 .sog)维持原 parseSOG,保持向后兼容
                const version = await SOGv2Loader.detectVersion(buffer);
                let parsed: any;
                if (version === 2) {
                    console.log(`[SOG] ${file.name}: detected official SOG v2, using SOGv2Loader`);
                    parsed = await sogV2Loader.parse(buffer, () => { });
                } else {
                    console.log(`[SOG] ${file.name}: version=${version}, using TrueSplats parseSOG`);
                    parsed = await parseSOG(buffer, () => { });
                }
                bands = parsed.bands || bands;
                const vertexElement = parsed.plyData.elements[0];
                assets.push(this.createGsplatAssetFromVertexElement(file.name, vertexElement));
            }
            await this.startSequencePlayback(assets, 'SOG Sequence', bands, progress);
            succeeded = true;
        } catch (err) {
            console.error('SOG sequence load failed', err);
            alert('Failed to load SOG sequence: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            if (!succeeded) {
                overlay?.classList.add('hidden');
            }
        }
    }








    // #WDD 2026-01-17: Dynamic Sorting Update
    // #WDD 2026-01-17: Dynamic Sorting Update
    // #WDD 2026-01-17: Dynamic Sorting Update
    private lastUpdatedFrame = -1;
    private applyVisible4DFrame(frame: number) {
        const clamped = Math.max(0, Math.floor(frame));
        this.currentTime = clamped;
        if (!this.isPlaying) {
            this.playbackTime = clamped;
        }
        if (this.splatEntity?.gsplat) {
            const material = (this.splatEntity.gsplat as any).instance?.material;
            if (material) {
                material.setParameter('uTime', clamped);
                material.setParameter('uGlobalTotalFrames', this.duration);
            }
        }
        // #WDD-gpt 2026-06-13 - 4D 动态排序应用帧后同步 ALL 点云位置
        this.refreshDebugAllPointsEntityThrottled(!this.isPlaying);
        this.syncTimelineUIForPlayback(clamped, this.getTimelineMaxFrame());
    }

    private requestSortedFrame(frame: number) {
        if (!this.is4DGS || !this.trajectoryData || this.isSequenceMode) {
            const target = Math.max(0, Math.floor(frame));
            this.currentTime = target;
            this.playbackTime = target;
            return;
        }

        const targetFrame = Math.max(0, Math.floor(frame));
        if (targetFrame === Math.floor(this.currentTime)) {
            return;
        }

        if (this.isPlaying) {
            if (this.isWaitingForSort) return;
            // #WDD-gpt 2026-06-24 - 大点数 4DGS 播放时必须等待 sorter 完成后再推进 shader 时间，避免新帧位置与旧帧深度顺序混用造成严重闪烁
            this.pendingSortedFrame = targetFrame;
            this.updateDynamicPositions(targetFrame);
            return;
        }

        if (this.isWaitingForSort) {
            return;
        }
        this.pendingSortedFrame = targetFrame;
        this.updateDynamicPositions(targetFrame);
    }

    private updateDynamicPositions(time: number) {
        if (!this.posArrays || !this.trajectoryData || !this.is4DGS) return;
        if (!this.splatEntity || !this.splatEntity.gsplat) return;

        const frameIdx = Math.floor(time);
        // #WDD 2026-03-31: If frame hasn't changed, skip CPU calculation to save performance.
        if (frameIdx === this.lastUpdatedFrame) return;
        this.lastUpdatedFrame = frameIdx;

        if (this.dynamicSorter) {
            // #WDD-gpt 2026-08-04 - 每帧仅向合并 Worker 发送时间和请求号，轨迹与生命周期数据只在加载时复制一次
            this.isWaitingForSort = true;
            this.sortingTaskID++;
            this.dynamicSorter.requestFrame(frameIdx, this.sortingTaskID);
            this.requestRender(80);
            return;
        }

        const K = this.keyframes;
        const stride = this.xyzStride;
        const traj = this.trajectoryData;
        const N = this.posArrays.x.length;

        // Calculate interpolation vars with end-cap safety
        const keyframeMax = Math.max(0, (K - 1) * stride);
        const maxTime = Math.max(0, Math.min(this.duration - 1, keyframeMax));
        const tClamped = Math.max(0, Math.min(time, maxTime));
        const idx = stride > 0 ? Math.floor(tClamped / stride) : 0;
        const k0 = K <= 1 ? 0 : Math.min(Math.max(0, idx), K - 1);
        const k1 = K <= 1 ? 0 : Math.min(k0 + 1, K - 1);

        const t0 = k0 * stride;
        const t1 = k1 * stride;
        const ratio = (k0 === k1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));

        const xArr = this.posArrays.x;
        const yArr = this.posArrays.y;
        const zArr = this.posArrays.z;

        // Optimized loop
        const origIndices = this.originalIndices;

        // #WDD 2026-01-17: Sync to Sorter
        const instance = (this.splatEntity.gsplat as any).instance;
        const centers = instance?.sorter?.centers;

        for (let i = 0; i < N; i++) {
            // If we have original indices (sorted -> original mapping), usage it.
            // Otherwise assume data is pre-sorted.
            const oidx = origIndices ? Math.round(origIndices[i]) : i;
            const base = oidx * K * 3;
            const b0 = base + k0 * 3;
            const b1 = base + k1 * 3;

            const x0 = traj[b0 + 0], y0 = traj[b0 + 1], z0 = traj[b0 + 2];
            const x1 = traj[b1 + 0], y1 = traj[b1 + 1], z1 = traj[b1 + 2];

            const nx = x0 + (x1 - x0) * ratio;
            const ny = y0 + (y1 - y0) * ratio;
            const nz = z0 + (z1 - z0) * ratio;

            xArr[i] = nx;
            yArr[i] = ny;
            zArr[i] = nz;

            if (centers) {
                centers[i * 3 + 0] = nx;
                centers[i * 3 + 1] = ny;
                centers[i * 3 + 2] = nz;
            }
        }

        // #WDD 2026-01-17: Force Worker Update
        // instance.sorter.centers is updated, but Worker has a stale copy.
        // We must send the new centers to the worker.
        if (centers && instance.sorter.worker) {
            // Important: varying checks to ensure stability
            // We MUST copy the buffer because sending it transfers ownership (detaches it),
            // which would crash the Main Thread on the next frame access.
            this.isWaitingForSort = true;
            this.sortingTaskID++;
            const centersCopy = new Float32Array(centers);
            instance.sorter.worker.postMessage({
                centers: centersCopy.buffer
            }, [centersCopy.buffer]);
        }

        // PlayCanvas's GSplat sorter reads these arrays (referenced by GSplatData) naturally 
        // when calculating depth, assuming it runs every frame.
    }

    // #WDD 2026-04-18: Get positions at a specific time without modifying current state
    public getPositionsAtTime(time: number, out?: Float32Array): Float32Array | null {
        if (!this.cachedPositions) return null;

        // If not 4DGS, positions don't change over time
        if (!this.posArrays || !this.trajectoryData || !this.is4DGS) {
            return this.cachedPositions;
        }

        const K = this.keyframes;
        const stride = this.xyzStride;
        const traj = this.trajectoryData;
        const origIndices = this.originalIndices;
        const N = this.posArrays.x.length;

        const keyframeMax = Math.max(0, (K - 1) * stride);
        const maxTime = Math.max(0, Math.min(this.duration - 1, keyframeMax));
        const tClamped = Math.max(0, Math.min(time, maxTime));
        const idx = stride > 0 ? Math.floor(tClamped / stride) : 0;
        const k0 = K <= 1 ? 0 : Math.min(Math.max(0, idx), K - 1);
        const k1 = K <= 1 ? 0 : Math.min(k0 + 1, K - 1);
        const t0 = k0 * stride;
        const t1 = k1 * stride;
        const ratio = (k0 === k1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));

        const result = out || new Float32Array(N * 3);

        for (let i = 0; i < N; i++) {
            const oidx = origIndices ? Math.round(origIndices[i]) : i;
            const base = oidx * K * 3;
            const b0 = base + k0 * 3;
            const b1 = base + k1 * 3;

            const x0 = traj[b0 + 0], y0 = traj[b0 + 1], z0 = traj[b0 + 2];
            const x1 = traj[b1 + 0], y1 = traj[b1 + 1], z1 = traj[b1 + 2];

            result[i * 3 + 0] = x0 + (x1 - x0) * ratio;
            result[i * 3 + 1] = y0 + (y1 - y0) * ratio;
            result[i * 3 + 2] = z0 + (z1 - z0) * ratio;
        }

        return result;
    }

    private posArrays: { x: Float32Array, y: Float32Array, z: Float32Array } | null = null;

    // #WDD Support for Color Trajectory
    private dcTrajectoryData: Float32Array | null = null;
    private dcKeyframes = 0;
    private dcStride = 1;

    private finalizeGSplatLoad(asset: pc.Asset, numSplats: number, plyData: any, originalFrames: number | null, parsed: any, options: { suppressUI?: boolean } = {}) {
        this.duration = originalFrames || (parsed ? (parsed.frames || parsed.maxMu) : 100) || 100;
        if (parsed && !originalFrames) {
            const keyframeMax = (() => {
                const k = parsed.keyframes || 0;
                const s = parsed.xyzStride || 1;
                return k > 1 ? (k - 1) * s + 1 : 1;
            })();
            const rotKeyframeMax = (() => {
                const k = parsed.rotKeyframes || 0;
                const s = parsed.rotStride || 1;
                return k > 1 ? (k - 1) * s + 1 : 1;
            })();
            this.duration = Math.max(this.duration, keyframeMax, rotKeyframeMax);
        }
        this.totalFrames = this.duration; // #WDD 2026-01-16: Keep sync
        this.originalFrames = originalFrames;
        this.lastParsedData = parsed;

        // #WDD-gpt 2026-08-04 - 每次按当前解析结果重建可选数据银行，缺失的银行不得沿用上一模型
        this.is4DGS = false;
        this.trajectoryData = null;
        this.trajectoryTexture = null;
        this.keyframes = 0;
        this.xyzStride = 1;
        this.rotTrajectoryData = null;
        this.rotKeyframes = 0;
        this.rotStride = 1;
        this.dcTrajectoryData = null;
        this.dcKeyframes = 0;
        this.dcStride = 1;
        this.lifeTexData = null;
        this.scalesTexData = null;

        const splatData = (asset.resource as pc.GSplatResource).splatData;
        const overlay = document.getElementById('loading-overlay');

        console.log(`[Finalize] Splats: ${numSplats}, GSplatData Num: ${splatData.numSplats}`);

        const res = asset.resource as any;
        let width = Math.ceil(Math.sqrt(numSplats));
        if (res?.colorTexture) width = res.colorTexture.width;
        else if (res?.transformATexture) width = res.transformATexture.width;
        const height = Math.ceil(numSplats / width);

        // #WDD-gpt 2026-07-31 - 为静态路径生成最小 scale 轴法线纹理；动态路径在 shader 中使用当前旋转关键帧覆盖
        const relightingNormalTexture = this.ply4Relighting.createNormalTexture(splatData, width, height);

        if (parsed?.trajectory || parsed?.rotTrajectory || parsed?.dcTrajectory) {
            this.fileLoader.ensure4DTextureBudget(numSplats, width, parsed);
        }

        // --- Cache Positions for Selection ---
        const x = splatData.getProp('x'), y = splatData.getProp('y'), z = splatData.getProp('z');
        if (x && y && z) {
            console.log(`[Debug] First 3 positions: (${x[0].toFixed(3)}, ${y[0].toFixed(3)}, ${z[0].toFixed(3)}), (${x[1].toFixed(3)}, ${y[1].toFixed(3)}, ${z[1].toFixed(3)}), (${x[2].toFixed(3)}, ${y[2].toFixed(3)}, ${z[2].toFixed(3)})`);
            const num = Math.min(splatData.numSplats, x.length, y.length, z.length);

            // #WDD 2026-01-17: Cache for Dynamic Sorting
            this.posArrays = { x: x as Float32Array, y: y as Float32Array, z: z as Float32Array };

            this.cachedPositions = new Float32Array(num * 3);
            for (let i = 0; i < num; i++) {
                this.cachedPositions[i * 3 + 0] = x[i];
                this.cachedPositions[i * 3 + 1] = y[i];
                this.cachedPositions[i * 3 + 2] = z[i];
            }
        }
        if (this.cachedPositions && !(options.suppressUI && this.isSog4SequenceMode)) {
            // #WDD 2026-03-31: Use initWithSize to ensure selectionTexture matches GSplat textures dimension.
            // This is critical for correct UV mapping in the shader (using splatId).
            this.selectionTool.initWithSize(this.cachedPositions.length / 3, width, height);
        }

        // --- #WDD 2026-03-31: Restore Transformation Metadata (仅用于非 loadFile 路径) ---
        // 注意：对于 PLY4 文件，变换已在 loadFile 中应用，这里只需更新 UI
        if (parsed?.meta && this.splatEntity && !options.suppressUI) {
            console.log("[Finalize] PLY4 meta found, syncing UI. modelPos:", parsed.meta.modelPos);
            // 只更新 UI，不重新应用变换（已在 loadFile 中应用）
            this.updateTransformUIFromEntity();
        }

        const origIndices = splatData.getProp('original_index');
        this.originalIndices = origIndices ? (origIndices as Float32Array) : null; // #WDD 2026-01-17

        if (origIndices) {
            console.log(`[Finalize] Reordering Check: First Index=${origIndices[0]}, Last Index=${origIndices[numSplats - 1]}`);
            if (origIndices[0] !== 0) {
                console.log(`[Finalize] ALERT: Reordering Detected! Aligning trajectories...`);
            }
        }

        // --- Camera Presets ---
        if (parsed.cameras && parsed.cameras.length > 0) {
            this.presetManager.cameraPresets = parsed.cameras.map((c: any) => ({
                name: c.name, pos: new pc.Vec3(c.pos[0], c.pos[1], c.pos[2]),
                pitch: c.pitch, yaw: c.yaw, textObjects: c.textObjects
            }));
            this.presetManager.renderPresets();
            this.presetManager.renderPresets();
            this.presetManager.syncTextOverlays();
        }

        // #WDD-kimi 2026-04-20 - 序列切段时不要重复套用初始 deleted_indices，避免覆盖 undo/redo 恢复结果
        const shouldRestoreParsedDeletedIndices = !(options.suppressUI && this.isSog4SequenceMode);
        // #WDD 2026-01-18: Restore Deleted Splats
        if (shouldRestoreParsedDeletedIndices && parsed.deleted_indices && parsed.deleted_indices.length > 0) {
            console.log(`[Finalize] Restoring ${parsed.deleted_indices.length} deleted splats...`);
            this.selectionTool.restoreDeletedIndices(parsed.deleted_indices);
        }

        // --- Lifetime Texture ---
        // #WDD 2026-01-17 Restore LifeTexData population
        const mu = splatData.getProp('lifetime_mu');
        const w = splatData.getProp('lifetime_w');
        const kArr = splatData.getProp('lifetime_k');

        if (mu && w) {
            this.lifeTexData = new Float32Array(width * height * 4);
            for (let i = 0; i < numSplats; i++) {
                this.lifeTexData[i * 4 + 0] = mu[i];
                this.lifeTexData[i * 4 + 1] = w[i];
                this.lifeTexData[i * 4 + 2] = kArr ? kArr[i] : 10.0;
                this.lifeTexData[i * 4 + 3] = 0.0;
            }
        }

        let lifeTexture: pc.Texture | null = null;
        if (this.lifeTexData) {
            lifeTexture = new pc.Texture(this.app.graphicsDevice, {
                width, height, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'lifetimeTexture'
            });
            const dst = lifeTexture.lock();
            new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4).set(this.lifeTexData);
            lifeTexture.unlock();
        }

        // --- Trajectory Texture ---
        let trajectoryTexture: pc.Texture | null = null;

        // --- 4DGS Trajectory Texture ---
        if (parsed.trajectory) {
            this.is4DGS = true;
            this.trajectoryData = parsed.trajectory as Float32Array;
            this.keyframes = parsed.keyframes || 0;
            this.xyzStride = parsed.xyzStride || 1;

            const trajData = parsed.trajectory as Float32Array;
            const K = parsed.keyframes || 0;
            const texWidth = 4096;
            const totalPixels = numSplats * K;
            const texHeight = Math.ceil(totalPixels / texWidth);
            
            // #WDD 2026-04-28 修复多段文件拖入导致的OOM内存溢出: 直接写入材质lock缓冲，避免分配重复的Float32Array
            trajectoryTexture = new pc.Texture(this.app.graphicsDevice, {
                width: texWidth, height: texHeight, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'trajectoryTexture'
            });
            const dst = trajectoryTexture.lock();
            const texData = new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4);

            // #WDD 2026-01-16: Fix - Data is ALREADY SORTED in data.bin
            // #WDD 2026-01-17: Restore Reordering Logic if original_index exists
            const origIndices = splatData.getProp('original_index');

            for (let i = 0; i < numSplats; i++) {
                const oidx = origIndices ? Math.round(origIndices[i]) : i;
                const base = oidx * K * 3; // Base index in the original trajectory data
                for (let k = 0; k < K; k++) {
                    const srcOff = base + k * 3; // Source from Original Index (BIN)
                    const dstOff = (i * K + k) * 4;    // Destination to Sorted Index (Texture)

                    texData[dstOff + 0] = trajData[srcOff + 0];
                    texData[dstOff + 1] = trajData[srcOff + 1];
                    texData[dstOff + 2] = trajData[srcOff + 2];
                    texData[dstOff + 3] = 1.0;
                }
            }

            trajectoryTexture.unlock();
            this.trajectoryTexture = trajectoryTexture;
        }


        // --- 4DGS Rotation Texture ---
        let rotationTexture: pc.Texture | null = null;
        if (parsed.rotTrajectory) {
            this.rotTrajectoryData = parsed.rotTrajectory as Float32Array;
            this.rotKeyframes = parsed.rotKeyframes || 0;
            this.rotStride = parsed.rotStride || 1;

            const rotData = parsed.rotTrajectory as Float32Array;
            const rotationSemantic = parsed.rotationSemantic === 'xyzw' ? 'xyzw' : 'wxyz';
            const Kvar = parsed.rotKeyframes || 0;
            const texWidth = 4096;
            const totalPixels = numSplats * Kvar;
            const texHeight = Math.ceil(totalPixels / texWidth);
            
            // #WDD 2026-04-28 修复多段文件拖入导致的OOM内存溢出: 直接写入材质lock缓冲，避免分配重复的Float32Array
            rotationTexture = new pc.Texture(this.app.graphicsDevice, {
                width: texWidth, height: texHeight, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'rotationTexture'
            });
            const dst = rotationTexture.lock();
            const texData = new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4);

            // The shader samples quaternions as [x, y, z, w]. Older payloads store
            // banks as [w, x, y, z], while newer saved PLY4 files annotate XYZW.
            const origIndices = splatData.getProp('original_index');
            if (origIndices) {
                console.log(`[Debug] 'original_index' detected. First 5: ${origIndices.slice(0, 5).join(', ')}`);
            } else {
                console.log("[Debug] No 'original_index' property found. Assuming data is linear/pre-sorted.");
            }

            for (let i = 0; i < numSplats; i++) {
                // If original_index exists, use it to lookup trajectory from the RAW/Unsorted BIN
                // If BIN was sorted same as PLY, this would not be needed.
                // But typically 4DGS BINs are often unsorted.
                const oidx = origIndices ? Math.round(origIndices[i]) : i;

                for (let k = 0; k < Kvar; k++) {
                    const srcOff = (oidx * Kvar + k) * 4; // Source from Original Index (BIN)
                    const dstOff = (i * Kvar + k) * 4;    // Destination to Sorted Index (Texture)

                    if (rotationSemantic === 'xyzw') {
                        texData[dstOff + 0] = rotData[srcOff + 0]; // x
                        texData[dstOff + 1] = rotData[srcOff + 1]; // y
                        texData[dstOff + 2] = rotData[srcOff + 2]; // z
                        texData[dstOff + 3] = rotData[srcOff + 3]; // w
                    } else {
                        texData[dstOff + 0] = rotData[srcOff + 1]; // x
                        texData[dstOff + 1] = rotData[srcOff + 2]; // y
                        texData[dstOff + 2] = rotData[srcOff + 3]; // z
                        texData[dstOff + 3] = rotData[srcOff + 0]; // w
                    }
                }
            }

            // DEBUG: Compare Static vs Dynamic Rotation for Point 0
            const r0 = splatData.getProp('rot_0');
            const r1 = splatData.getProp('rot_1');
            const r2 = splatData.getProp('rot_2');
            const r3 = splatData.getProp('rot_3');
            if (r0 && r1 && r2 && r3 && this.rotTrajectoryData) {
                const i = 0;
                const staticRot = [r0[i], r1[i], r2[i], r3[i]];
                const dynRot = [this.rotTrajectoryData[0], this.rotTrajectoryData[1], this.rotTrajectoryData[2], this.rotTrajectoryData[3]];
                const texRot = [texData[0], texData[1], texData[2], texData[3]];
                console.log(`[Debug] Point 0 Rotation Comparison:`);
                console.log(`  Static (PLY): [${staticRot.map(v => v.toFixed(3))}]`);
                console.log(`  Dynamic (BIN): [${dynRot.map(v => v.toFixed(3))}]`);
                console.log(`  Texture (XYZW): [${texRot.map(v => v.toFixed(3))}]`);
            }

            rotationTexture.unlock();
        }


        // --- 4DGS Color Trajectory Texture ---
        let dcTrajectoryTexture: pc.Texture | null = null;
        if (parsed.dcTrajectory) {
            this.dcTrajectoryData = parsed.dcTrajectory as Float32Array;
            this.dcKeyframes = parsed.dcKeyframes || 0;
            this.dcStride = parsed.dcStride || 1;

            const dcData = parsed.dcTrajectory as Float32Array;
            const Kdc = this.dcKeyframes;
            const texWidth = 4096;
            const totalPixels = numSplats * Kdc;
            const texHeight = Math.ceil(totalPixels / texWidth);
            
            // #WDD 2026-04-28 修复多段文件拖入导致的OOM内存溢出: 直接写入材质lock缓冲，避免分配重复的Float32Array
            dcTrajectoryTexture = new pc.Texture(this.app.graphicsDevice, {
                width: texWidth, height: texHeight, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'dcTrajectoryTexture'
            });
            const dst = dcTrajectoryTexture.lock();
            const texData = new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4);

            const origIndices = splatData.getProp('original_index');

            for (let i = 0; i < numSplats; i++) {
                const oidx = origIndices ? Math.round(origIndices[i]) : i;
                for (let k = 0; k < Kdc; k++) {
                    const srcOff = (oidx * Kdc + k) * 3;
                    const dstOff = (i * Kdc + k) * 4;

                    // #WDD 2026-01-30 Apply SH0 -> RGB conversion (0.5 + SH * 0.282...)
                    const SH_C0 = 0.28209479177387814;
                    texData[dstOff + 0] = dcData[srcOff + 0] * SH_C0 + 0.5;
                    texData[dstOff + 1] = dcData[srcOff + 1] * SH_C0 + 0.5;
                    texData[dstOff + 2] = dcData[srcOff + 2] * SH_C0 + 0.5;
                    texData[dstOff + 3] = 1.0;
                }
            }

            dcTrajectoryTexture.unlock();
        }


        // --- Scales Texture (for dynamic rotation reconstruction) ---
        let scalesTexture: pc.Texture | null = null;
        const s0 = splatData.getProp('scale_0');
        const s1 = splatData.getProp('scale_1');
        const s2 = splatData.getProp('scale_2');
        if (s0 && s1 && s2) {
            scalesTexture = new pc.Texture(this.app.graphicsDevice, {
                width, height, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, name: 'scalesTexture'
            });
            const dst = scalesTexture.lock();
            const texData = new Float32Array(dst.buffer, dst.byteOffset, dst.byteLength / 4);
            
            for (let i = 0; i < splatData.numSplats; i++) {
                texData[i * 4 + 0] = s0[i];
                texData[i * 4 + 1] = s1[i];
                texData[i * 4 + 2] = s2[i];
                texData[i * 4 + 3] = 0.0;
            }
            
            // #WDD 2026-04-28 We don't save a duplicate scalesTexData if not needed, 
            // but for UI selection we might. Keep creating a cheap copy if absolutely requested,
            // or just use texData slice if they need it. Actually scalesTexData is kept in memory.
            this.scalesTexData = new Float32Array(texData);
            
            scalesTexture.unlock();
        }

        if (this.splatEntity?.gsplat) {
            const instance = (this.splatEntity.gsplat as any).instance;
            if (instance?.sorter?.worker && this.is4DGS && this.trajectoryData && this.keyframes > 0) {
                const opacity = splatData.getProp('opacity') as Float32Array | null;
                const baseAlpha = opacity ? new Float32Array(numSplats) : null;
                if (opacity && baseAlpha) {
                    for (let index = 0; index < numSplats; index++) {
                        baseAlpha[index] = getRenderedBaseAlpha(opacity[index], parsed.opacitySemantic);
                    }
                }
                this.disposeDynamicSorter();
                const sorterEpoch = this.dynamicSorterEpoch;
                const sorterInstance = instance;
                // #WDD-gpt 2026-08-04 - 动态 Worker 直接返回排序纹理顺序和活动数量，主线程不再生成或传输中心副本
                this.dynamicSorter = new DynamicGsplatSorter(instance, {
                    trajectory: this.trajectoryData,
                    originalIndices: this.originalIndices,
                    lifeData: this.lifeTexData,
                    baseAlpha,
                    numSplats,
                    keyframes: this.keyframes,
                    stride: this.xyzStride,
                    totalFrames: Math.max(1, Math.ceil(this.duration)),
                    alphaDiscard: NORMAL_RENDER_ALPHA_DISCARD,
                    onSorted: (result) => {
                        // #WDD-gpt 2026-08-04 - 丢弃已销毁 Worker 或旧 GSplat 实例迟到的排序结果
                        const activeInstance = (this.splatEntity?.gsplat as any)?.instance;
                        if (sorterEpoch !== this.dynamicSorterEpoch || activeInstance !== sorterInstance) return;
                        this.active4DSplatCount = result.visibleCount;
                        if (this.isWaitingForSort && result.requestId === this.sortingTaskID) {
                            this.isWaitingForSort = false;
                            this.lastCompletedSortTaskID = result.requestId;
                            if (this.pendingSortedFrame !== null && Math.floor(this.pendingSortedFrame) === Math.floor(result.frame)) {
                                this.applyVisible4DFrame(this.pendingSortedFrame);
                                this.pendingSortedFrame = null;
                            }
                        }
                        this.requestRender(80);
                    }
                });
                this.lastUpdatedFrame = -1;
            }

            this.setupLifetimeShader(
                instance,
                lifeTexture,
                trajectoryTexture, parsed.keyframes,
                rotationTexture, parsed.rotKeyframes,
                this.duration, // #WDD 2026-01-16 Use calculated duration
                scalesTexture,
                parsed.bands || 3, // #WDD 2026-01-16
                dcTrajectoryTexture,
                parsed.dcKeyframes || 0,
                relightingNormalTexture
            );
        }

        // #WDD 2026-01-19: Robustly persist parsed data for export
        if (parsed) {
            console.log("[Viewer] Persisting parsed data for export (finalize). isSOG4:", parsed.isSOG4);
            this.lastParsedData = parsed;
            this.rememberLoadedModelTransform(parsed);
        }

        // #WDD-gpt 2026-04-20 - 将 finalize 生成的纹理/缓存绑定回队列元素，保证“读入元素 <-> 运行时资源”一一对应
        const boundElement = this.getSplatSequenceElementByAsset(asset);
        if (boundElement) {
            boundElement.runtime = {
                is4DGS: this.is4DGS,
                totalFrames: this.duration,
                keyframes: this.keyframes,
                xyzStride: this.xyzStride,
                rotKeyframes: this.rotKeyframes,
                rotStride: this.rotStride,
                dcKeyframes: this.dcKeyframes,
                dcStride: this.dcStride,
                lifeTexData: this.lifeTexData,
                scalesTexData: this.scalesTexData,
                trajectoryData: this.trajectoryData,
                rotTrajectoryData: this.rotTrajectoryData,
                dcTrajectoryData: this.dcTrajectoryData,
                originalIndices: this.originalIndices,
                posArrays: this.posArrays,
                cachedPositions: this.cachedPositions,
                lifeTexture,
                trajectoryTexture,
                rotationTexture,
                dcTrajectoryTexture,
                scalesTexture,
                relightingNormalTexture,
                selectionData: this.selectionTool?.selectionData || null,
                allTimeSelectionData: this.selectionTool?.allTimeSelectionData || null,
                selectionTexture: this.selectionTool?.selectionTexture || null
            };
            this.splatSequence!.totalFrames = this.sog4SequenceTotalFrames || this.duration;
        }

        this.updateToggleButton(document.getElementById('mode-default') as HTMLElement, true);
        this.updateToggleButton(document.getElementById('mode-selection') as HTMLElement, false);

        // #WDD 2026-01-17 Restore Slider Logic
        const maxIdx = Math.max(0, Math.ceil(this.duration) - 1);
        if (!options.suppressUI) {
            this.resetTimelineTools();
            this.updateTimelineTicks(this.duration);
            this.syncTimelineUI(0, maxIdx);

            setTimeout(() => { if (overlay) overlay.classList.add('hidden'); }, 600);
            this.fileLoader.updateStats(asset);
            this.fileInfoPanel.refresh();
        }

        const hasPly4TransformMeta = !!(parsed?.meta && (
            parsed.meta.modelPos ||
            parsed.meta.modelRot ||
            parsed.meta.modelScale
        ));

        if (!options.suppressUI && (parsed.model_transform || hasPly4TransformMeta)) {
            // #WDD 2026-01-19: Embedded transform takes precedence over cache
            console.log("[Viewer] Finalize: Respecting embedded transform metadata, skipping cache.");
            this.updateTransformUIFromEntity();
        } else if (!options.suppressUI && parsed.pose) {
            if (this.splatEntity) {
                this.splatEntity.setPosition(parseFloat(parsed.pose.px), parseFloat(parsed.pose.py), parseFloat(parsed.pose.pz));
                this.splatEntity.setEulerAngles(parseFloat(parsed.pose.rx), parseFloat(parsed.pose.ry), parseFloat(parsed.pose.rz));
                ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z'].forEach(id => {
                    const el = (document.getElementById(id) as HTMLInputElement);
                    if (el) el.value = parsed.pose[id.replace('-', '')];
                });
            }
        } else if (!options.suppressUI) {
            this.resetObjectTransformUI();
        }

    }




    private async setupLifetimeShader(
        instance: any,
        lifetimeTexture: pc.Texture | null,
        trajectoryTexture: pc.Texture | null = null,
        keyframes: number = 0,
        rotationTexture: pc.Texture | null = null,
        rotKeyframes: number = 0,
        totalFrames: number = 0,
        scalesTexture: pc.Texture | null = null,
        bands: number = 0, // #WDD 2026-01-16
        dcTrajectoryTexture: pc.Texture | null = null,
        dcKeyframes: number = 0,
        relightingNormalTexture: pc.Texture | null = null
    ) {
        console.log(`[Shader] Setting up Lifetime Shader with duration: ${totalFrames}`, { lifetimeTexture, trajectoryTexture, rotationTexture, scalesTexture, bands });

        const material = instance.material;
        material.setParameter('uTime', 0.0);
        material.setParameter('uTransitionFactor', 0.0);
        material.setParameter('uRotationFactor', 0.0);
        material.setParameter('uSwizzleMode', this.swizzleMode); // #WDD 2026-01-15 Init
        material.setParameter('uOpacityScale', 1.0);
        material.setParameter('uRenderMode', this.gaussianRenderMode);
        material.setParameter('uSHLevel', this.shLevel);

        if (lifetimeTexture) {
            material.setParameter('lifetimeTexture', lifetimeTexture);
        }

        if (totalFrames > 0) {
            material.setParameter('uGlobalTotalFrames', totalFrames);
        }

        if (trajectoryTexture) {
            material.setParameter('uTrajectoryTexture', trajectoryTexture);
            material.setParameter('uKeyframes', keyframes);
            material.setParameter('uGlobalTotalFrames', totalFrames); // #WDD 2026-01-16 Use passed totalFrames
            material.setParameter('uXYZStride', this.xyzStride);
            material.setParameter('uRotKeyframes', this.rotKeyframes);
            material.setParameter('uRotStride', this.rotStride);
        }

        if (rotationTexture) {
            material.setParameter('uRotationTexture', rotationTexture);
            material.setParameter('uRotKeyframes', rotKeyframes);
        }

        if (scalesTexture) {
            material.setParameter('uScalesTexture', scalesTexture);
        }

        if (dcTrajectoryTexture) {
            material.setParameter('uColorTrajectoryTexture', dcTrajectoryTexture);
            material.setParameter('uColorKeyframes', dcKeyframes);
            material.setParameter('uColorStride', this.dcStride);
        }

        if (relightingNormalTexture) {
            this.ply4Relighting.bindMaterial(material, relightingNormalTexture);
        }

        if (totalFrames > 0) material.setParameter('uGlobalTotalFrames', totalFrames);

        // --- ROBUST SHADER INJECTION ---

        const originalGetShaderVariant = material.getShaderVariant;

        material.getShaderVariant = function (device: any, scene: any, defs: any, unused: any, pass: any, sortedLights: any, viewUniformFormat: any, viewBindGroupFormat: any) {

            const library = device.getProgramLibrary();
            const originalGetProgram = library.getProgram;

            library.getProgram = function (name: string, options: any, processingOptions: any) {
                if (name === 'splat') {
                    console.log("[ShaderInject] Intercepted 'splat' shader generation.");

                    // We must bypass the original generator's concatenation because it uses a broken splatCoreVS.
                    // Instead, we construct the full shader here using our FIXED core and mains.

                    // 1. Prepare Defines
                    if (!options.defines) options.defines = [];
                    if (lifetimeTexture) {
                        console.log("[ShaderInject] Defining USE_LIFETIME_TEXTURE");
                        if (!options.defines.includes('USE_LIFETIME_TEXTURE')) options.defines.push('USE_LIFETIME_TEXTURE');
                    }
                    if (trajectoryTexture) {
                        if (!options.defines.includes('USE_TRAJECTORY')) options.defines.push('USE_TRAJECTORY');
                    }
                    if (rotationTexture) {
                        if (!options.defines.includes('USE_ROTATION')) options.defines.push('USE_ROTATION');
                    }
                    if (dcTrajectoryTexture) {
                        if (!options.defines.includes('USE_COLOR_TRAJECTORY')) options.defines.push('USE_COLOR_TRAJECTORY');
                    }
                    if (relightingNormalTexture) {
                        if (!options.defines.includes('USE_PLY4_RELIGHTING')) options.defines.push('USE_PLY4_RELIGHTING');
                    }

                    // #WDD 2026-01-16 Dynamically set SH bands
                    if (bands >= 1) {
                        if (!options.defines.includes('USE_SH1')) options.defines.push('USE_SH1');
                    }
                    if (bands >= 2) {
                        if (!options.defines.includes('USE_SH2')) options.defines.push('USE_SH2');
                    }
                    if (bands >= 3) {
                        if (!options.defines.includes('USE_SH3')) options.defines.push('USE_SH3');
                    }

                    // Check for other standard options usually passed
                    // e.g. DITHER_NONE, TONEMAP...
                    // For simplicity, we assume standard defines are handled or we append standard chunks if needed.
                    // But 'splatMainPS' is self-contained for now. 
                    // If we want dithering/tonemapping, we'd need to import chunks or add them to splatMainPS.
                    // Let's assume the user wants the raw splatMainPS provided.


                    const shaderPassInfo = (pc as any).ShaderPass?.get(device)?.getByIndex?.(options.pass);
                    let passDefines = shaderPassInfo?.shaderDefines ? `${shaderPassInfo.shaderDefines}\n` : '';
                    // Ensure PICK_PASS is defined for pick passes (some versions may not set shaderDefines correctly)
                    if (options.pass === 2 /* pc.PASS_PICK */) { // #WDD 2026-04-03 修复 PlayCanvas 1.77 缺少 PASS_PICK 导出问题
                        if (!passDefines.includes('PICK_PASS')) {
                            passDefines += '#define PICK_PASS\n';
                        }
                    }
                    const optionDefines = options.defines.map((d: string) => `#define ${d}`).join('\n');
                    const defines = passDefines + optionDefines + '\n';

                    const version = "#version 300 es\n";

                    // 2. Construct Codes
                    // splatCoreVS is the FIXED core with helper functions
                    // splatMainVS is the main() function
                    const vsCode = version + defines + splatCoreVS + ply4RelightingVS + splatMainVS;

                    // PS: For now, strict splatMainPS. 
                    // PS needs precision for GLSL 300 es unless provided by chunks, but we act standalone.
                    const fsCode = version + defines + "precision mediump float;\n" + splatMainPS;

                    // 3. Create Definition directly (Bypassing generator)
                    const shaderDefinition = {
                        attributes: {
                            vertex_position: pc.SEMANTIC_POSITION,
                            vertex_id_attrib: pc.SEMANTIC_ATTR13
                        },
                        vshader: vsCode,
                        fshader: fsCode
                    };
                    return new pc.Shader(device, shaderDefinition);
                }
                return originalGetProgram.call(this, name, options, processingOptions);
            };

            const result = originalGetShaderVariant.apply(this, arguments);
            library.getProgram = originalGetProgram;
            return result;
        };

        // Force update
        if ((material as any).clearVariants) {
            (material as any).clearVariants();
        }
        material.update();
    }




    private updateTimelineTicks(duration: number) { return this.timelineManager.updateTimelineTicks(duration); }
    private getTimelineTotalFrames(): number { return this.timelineManager.getTimelineTotalFrames(); }
    private getTimelineMaxFrame(): number { return this.timelineManager.getTimelineMaxFrame(); }
    private clampTimelineFrame(frame: number): number { return this.timelineManager.clampTimelineFrame(frame); }
    private normalizeLoopRange() { return this.timelineManager.normalizeLoopRange(); }
    private resetTimelineTools() { return this.timelineManager.resetTimelineTools(); }
    private syncTimelineUI(displayFrame?: number, total?: number) { return this.timelineManager.syncTimelineUI(displayFrame, total); }
    private renderTimelineDecorations() { return this.timelineManager.renderTimelineDecorations(); }
    private seekToFrame(frame: number, options?: { pause?: boolean }) { return this.timelineManager.seekToFrame(frame, options); }
    private stepFrame(delta: number) { return this.timelineManager.stepFrame(delta); }

    private syncTimelineUIForPlayback(displayFrame: number, total: number, force = false) {
        if (!this.isPlaying || force) {
            this.timelinePlaybackLastSyncMs = performance.now();
            this.syncTimelineUI(displayFrame, total);
            return;
        }
        const now = performance.now();
        if (now - this.timelinePlaybackLastSyncMs < this.playbackTimelineSyncIntervalMs) return;
        this.timelinePlaybackLastSyncMs = now;
        this.syncTimelineUI(displayFrame, total);
    }

    private resetObjectTransformUI() {
        ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z'].forEach(id => {
            const input = document.getElementById(id) as HTMLInputElement;
            if (input) input.value = "0";
        });
        const s = document.getElementById('scale-uniform') as HTMLInputElement | null;
        if (s) s.value = "1.0";
    }

    // Updated loadPointCloud to accept entity parent if needed, but signature changed above.
    // We'll fix call site.
    // private createPointCloud... Removed


    public updateSelectionUniform(tex: pc.Texture) {
        const apply = (ent: pc.Entity | null) => {
            if (!ent?.gsplat) return;
            const instance = (ent.gsplat as any).instance;
            if (instance && instance.material) {
                instance.material.setParameter('selectionTexture', tex);
                instance.material.update();
            }
        };
        if (this.isSequenceMode) {
            this.sequenceEntityPool.forEach((e) => apply(e));
        } else {
            apply(this.splatEntity);
        }
    }

    public updateSelectionModeParams(isSelecting: boolean) {
        const apply = (ent: pc.Entity | null) => {
            if (!ent?.gsplat) return;
            const instance = (ent.gsplat as any).instance;
            if (instance && instance.material) {
                instance.material.setParameter('isSelectionMode', isSelecting ? 1.0 : 0.0);
                instance.material.update();
            }
        };
        if (this.isSequenceMode) {
            this.sequenceEntityPool.forEach((e) => apply(e));
        } else {
            apply(this.splatEntity);
        }
    }





    private resetCamera() { return this.sceneManager.resetCamera(); }
    private orbitCameraUpdates() { return this.sceneManager.orbitCameraUpdates(); }

    // #WDD 2026-01-21 Skybox Support
    private skyboxes = [
        "abandoned_tank_farm_01_2k", "adams_place_bridge_2k", "artist_workshop_2k",
        "ballroom_2k", "circus_arena_2k", "colorful_studio", "golf_course_sunrise_2k",
        "kloppenheim_02_2k", "lebombo_2k", "outdoor_umbrellas_2k", "paul_lobe_haus_2k",
        "reinforced_concrete_01_2k", "rural_asphalt_road_2k", "spruit_sunrise_2k",
        "studio_small_03_2k", "venice_sunset_1k", "vignaioli_night_2k", "wooden_motel_2k",
        "Helipad_equi"
    ];
    private selectedSkyboxName: string = 'paul_lobe_haus_2k'; // Default

    private initSkyboxSelector() {
        const select = document.getElementById('skybox-select') as HTMLSelectElement;


        if (!select) return;

        // Clear existing (except first)
        while (select.options.length > 1) select.remove(1);

        this.skyboxes.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.text = name.replace(/_/g, ' ').replace('2k', '').trim();
            if (name === this.selectedSkyboxName) opt.selected = true;
            select.appendChild(opt);
        });

        select.addEventListener('change', () => {
            this.selectedSkyboxName = select.value;
            if (this.isOrbitMode) {
                this.setSkybox(select.value);
            }
        });

        // #WDD 2026-01-21 Blur Slider Logic
    }

    private setSkybox(name: string) {
        if (name === 'none') {
            this.skyboxManager.clearSkybox();
            return;
        }

        const applySettings = () => {
            this.skyboxManager.setBlur(1); // Default low blur
        };

        const existing = this.app.assets.find(name);
        if (existing) {
            this.skyboxManager.setSkyboxAsset(existing);
            if (existing.resource) {
                applySettings();
            } else {
                existing.ready((asset: pc.Asset) => {
                    if (!asset.resource) return;
                    applySettings();
                });
            }
            return;
        }

        const ext = name.includes('Helipad') ? '.png' : '.hdr';
        const url = `./skybox/${name}${ext}`;

        const asset = new pc.Asset(name, 'texture', { url: url });
        this.app.assets.add(asset);
        this.skyboxManager.setSkyboxAsset(asset);
        asset.ready((readyAsset: pc.Asset) => {
            if (!readyAsset.resource) return;
            applySettings();
        });
    }




    private onUpdate(dt: number) {
        if (this.arHandler) this.arHandler.update();

        // #WDD 2026-02-03 Face Tracking Camera Update
        this.faceTrackingManager.update();

        // Sequence playback is driven by the main update loop in the constructor; avoid double-advancing time here.
        // #WDD-gpt 2026-06-22 - 多段 4D 序列必须用段内局部帧更新 sorter，避免暂停时这里再用全局帧覆盖中心导致第二段以后闪烁
        if (this.isSequenceMode || this.isSog4SequenceMode) {
            return;
        }

        // Keep CPU-side centers aligned for paused scrubbing, but during playback
        // we switch frames only after the sorter confirms completion.
        if (this.is4DGS && this.trajectoryData && !this.isPlaying && !this.isWaitingForSort) {
            this.updateDynamicPositions(Math.floor(this.currentTime));
        }
    }

    // #WDD-gpt 2026-08-04 - 静止场景只在相机、UI、资源或异步排序变化时申请下一帧
    private setupRenderOnDemand() {
        this.renderOnDemandReady = true;
        const invalidate = () => this.requestRender(180);
        for (const eventName of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'input', 'change']) {
            document.addEventListener(eventName, invalidate, { capture: true, passive: true });
        }
        this.app.assets.on('load', () => this.requestRender(500));
    }

    public requestRender(keepAliveMs = 0) {
        if (!this.renderOnDemandReady) return;
        this.renderActivityUntil = Math.max(this.renderActivityUntil, performance.now() + Math.max(0, keepAliveMs));
        this.app.renderNextFrame = true;
    }

    private hasCameraTransformChanged() {
        if (!this.camera) return false;
        const current = this.camera.getWorldTransform().data;
        let changed = false;
        for (let index = 0; index < 16; index++) {
            const value = current[index];
            if (Math.abs(value - this.lastRenderedCameraMatrix[index]) > 1e-6) changed = true;
            this.lastRenderedCameraMatrix[index] = value;
        }
        return changed;
    }

    private updateRenderScheduling() {
        const cameraChanged = this.hasCameraTransformChanged();
        if (cameraChanged) this.requestRender(120);
        const continuous = this.isPlaying
            || this.isWaitingForSort
            || this.presetManager.isCameraAnimating
            || this.presetManager.isRecordingPresetVideo
            || this.presetManager.isPreviewingPresetPath
            || Boolean(this.arHandler?.isARRunning)
            || Boolean(this.faceTrackingManager?.isFaceTracking)
            || performance.now() < this.renderActivityUntil;
        this.app.autoRender = continuous;
        if (continuous) this.app.renderNextFrame = true;
    }

    public isContinuousRenderingActive() {
        return this.app.autoRender || this.isPlaying || this.isWaitingForSort;
    }

    // #WDD-gpt 2026-08-04 - 使用四档像素比替代原生 DPR/1.0 二元切换，立体模式额外限制双眼填充量
    private applyRenderPixelRatio() {
        const devicePixelRatio = Math.max(0.5, window.devicePixelRatio || 1);
        const ratios = [Math.min(devicePixelRatio, 2), Math.min(devicePixelRatio, 1), Math.min(devicePixelRatio, 0.85), Math.min(devicePixelRatio, 0.7)];
        let nextRatio = ratios[Math.max(0, Math.min(3, this.adaptiveQualityLevel))];
        if (this.stereoView?.isActive()) nextRatio = Math.min(nextRatio, 1);
        if (Math.abs(this.app.graphicsDevice.maxPixelRatio - nextRatio) < 1e-3) return;
        this.app.graphicsDevice.maxPixelRatio = nextRatio;
        this.app.resizeCanvas();
        this.requestRender(300);
        console.log(`[Viewer] Render pixel ratio: ${nextRatio.toFixed(2)} (quality level ${this.adaptiveQualityLevel})`);
    }

    public setAdaptiveQualityLevel(level: number) {
        const clamped = Math.max(0, Math.min(3, Math.floor(level)));
        if (this.adaptiveQualityLevel === clamped) return;
        this.adaptiveQualityLevel = clamped;
        this.isHighQuality = clamped === 0;
        this.applyRenderPixelRatio();
    }

    public setHighQuality(enabled: boolean) {
        this.setAdaptiveQualityLevel(enabled ? 0 : 2);
    }


    // #WDD 2026-01-18: Helper to sync UI inputs with current Entity state
    private updateTransformUIFromEntity() {
        if (!this.splatEntity) {
            console.log("[updateTransformUIFromEntity] No splatEntity!");
            return;
        }

        const pos = this.splatEntity.getLocalPosition();
        const rot = this.splatEntity.getLocalEulerAngles();
        const scale = this.splatEntity.getLocalScale();
        
        console.log("[updateTransformUIFromEntity] pos:", pos?.toString(), "rot:", rot?.toString(), "scale:", scale?.toString());

        const posX = document.getElementById('pos-x') as HTMLInputElement;
        const posY = document.getElementById('pos-y') as HTMLInputElement;
        const posZ = document.getElementById('pos-z') as HTMLInputElement;
        const rotX = document.getElementById('rot-x') as HTMLInputElement;
        const rotY = document.getElementById('rot-y') as HTMLInputElement;
        const rotZ = document.getElementById('rot-z') as HTMLInputElement;
        const scaleU = document.getElementById('scale-uniform') as HTMLInputElement | null;

        if (posX) posX.value = pos.x.toFixed(2);
        if (posY) posY.value = pos.y.toFixed(2);
        if (posZ) posZ.value = pos.z.toFixed(2);
        if (rotX) rotX.value = rot.x.toFixed(1);
        if (rotY) rotY.value = rot.y.toFixed(1);
        if (rotZ) rotZ.value = rot.z.toFixed(1);
        if (scaleU) scaleU.value = scale.x.toFixed(3);
    }

    // #WDD 2026-01-18: Expose current positions for SelectionTool
    public getCurrentPositions(): Float32Array | null {
        // Important: selection logic expects positions in the same splat-data order
        // as scale / rotation / selection texture indexing. sorter.centers is not a
        // reliable source for that because it is owned by the depth sorter path.
        if (this.is4DGS && this.posArrays) {
            const { x, y, z } = this.posArrays;
            const count = Math.min(x.length, y.length, z.length);
            if (!this.cachedPositions || this.cachedPositions.length !== count * 3) {
                this.cachedPositions = new Float32Array(count * 3);
            }
            for (let i = 0; i < count; i++) {
                this.cachedPositions[i * 3 + 0] = x[i];
                this.cachedPositions[i * 3 + 1] = y[i];
                this.cachedPositions[i * 3 + 2] = z[i];
            }
            return this.cachedPositions;
        }
        // Fallback or Non-4DGS
        return this.cachedPositions;
    }

    // #WDD-gpt 2026-05-15 - 给智能选择工具提供当前模型的静态/动态分析数据
    public getSmartSelectionAnalysisSource() {
        const splatData = (this.splatEntity?.gsplat as any)?.asset?.resource?.splatData || (this.splatEntity?.gsplat as any)?.splatData || null;
        const readProp = (name: string) => {
            if (this.lastParsedData?.[name] instanceof Float32Array) return this.lastParsedData[name] as Float32Array;
            if (typeof splatData?.getProp === 'function') return (splatData.getProp(name) as Float32Array | null) || null;
            return null;
        };
        const entity = this.splatEntity;
        const basePosition = entity?.getLocalPosition().clone() || new pc.Vec3();
        const baseRotation = entity?.getLocalRotation().clone() || new pc.Quat();
        const baseScale = entity?.getLocalScale().clone() || new pc.Vec3(1, 1, 1);

        return {
            positions: this.getCurrentPositions(),
            trajectoryData: this.trajectoryData,
            keyframes: this.keyframes,
            xyzStride: this.xyzStride,
            originalIndices: this.originalIndices,
            lifetimeMu: readProp('lifetime_mu'),
            lifetimeW: readProp('lifetime_w'),
            totalFrames: Math.max(1, Math.floor(this.getTimelineTotalFrames?.() || this.totalFrames || this.duration || 1)),
            transformPoint: (point: [number, number, number]) => {
                const local = new pc.Vec3(point[0] * baseScale.x, point[1] * baseScale.y, point[2] * baseScale.z);
                const rotated = baseRotation.transformVector(local);
                return [
                    rotated.x + basePosition.x,
                    rotated.y + basePosition.y,
                    rotated.z + basePosition.z
                ] as [number, number, number];
            }
        };
    }

    // #WDD-gpt 2026-05-16 - 给智能选择批处理提供每个 PLY4 段的分析数据，首段用于求对齐矩阵
    public getSmartSelectionBatchAnalysisSources() {
        const elements = (this.splatSequence?.elements || []).filter((element: any) => element?.type === 'ply4');
        if (!(this.isSog4SequenceMode && elements.length > 1)) {
            return [this.getSmartSelectionAnalysisSource()];
        }

        const readParsedProp = (parsed: any, name: string): Float32Array | null => {
            if (parsed?.[name] instanceof Float32Array) return parsed[name] as Float32Array;
            const props = parsed?.plyData?.elements?.[0]?.properties || [];
            const hit = props.find((p: any) => p?.name === name);
            return (hit?.storage as Float32Array) || null;
        };
        const buildPositions = (parsed: any, runtime: any): Float32Array | null => {
            if (runtime?.cachedPositions instanceof Float32Array) return runtime.cachedPositions as Float32Array;
            const x = readParsedProp(parsed, 'x');
            const y = readParsedProp(parsed, 'y');
            const z = readParsedProp(parsed, 'z');
            if (!x || !y || !z) return null;
            const count = Math.min(x.length, y.length, z.length);
            const positions = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                positions[i * 3 + 0] = x[i];
                positions[i * 3 + 1] = y[i];
                positions[i * 3 + 2] = z[i];
            }
            return positions;
        };
        const readLifeFromRuntime = (runtime: any, channel: 0 | 1): Float32Array | null => {
            const life = runtime?.lifeTexData as Float32Array | null | undefined;
            const positions = runtime?.cachedPositions as Float32Array | null | undefined;
            if (!life || !positions) return null;
            const count = Math.min(Math.floor(positions.length / 3), Math.floor(life.length / 4));
            const out = new Float32Array(count);
            for (let i = 0; i < count; i++) out[i] = life[i * 4 + channel];
            return out;
        };
        const transformForEntity = (entity: pc.Entity | null) => {
            const basePosition = entity?.getLocalPosition().clone() || new pc.Vec3();
            const baseRotation = entity?.getLocalRotation().clone() || new pc.Quat();
            const baseScale = entity?.getLocalScale().clone() || new pc.Vec3(1, 1, 1);
            return (point: [number, number, number]) => {
                const local = new pc.Vec3(point[0] * baseScale.x, point[1] * baseScale.y, point[2] * baseScale.z);
                const rotated = baseRotation.transformVector(local);
                return [
                    rotated.x + basePosition.x,
                    rotated.y + basePosition.y,
                    rotated.z + basePosition.z
                ] as [number, number, number];
            };
        };

        return elements.map((element: any) => {
            const runtime = element.runtime || {};
            const parsed = element.parsed || {};
            const positions = buildPositions(parsed, runtime);
            return {
                name: element.name,
                selectionElement: element,
                positions,
                trajectoryData: runtime.trajectoryData || parsed.trajectory || null,
                keyframes: runtime.keyframes || parsed.keyframes || 0,
                xyzStride: runtime.xyzStride || parsed.xyzStride || 1,
                originalIndices: runtime.originalIndices || readParsedProp(parsed, 'original_index'),
                lifetimeMu: readParsedProp(parsed, 'lifetime_mu') || readLifeFromRuntime(runtime, 0),
                lifetimeW: readParsedProp(parsed, 'lifetime_w') || readLifeFromRuntime(runtime, 1),
                totalFrames: Math.max(1, Math.floor(runtime.totalFrames || parsed.frames || parsed.maxMu || element.duration || 1)),
                transformPoint: transformForEntity(element.entity || this.splatEntity)
            };
        }).filter((source: any) => source.positions);
    }

    // #WDD-gpt 2026-05-16 - 智能对齐在 PLY4 序列中始终只使用第一个 PLY4 文件
    public async getSmartSelectionFirstPly4AnalysisSource() {
        const elements = (this.splatSequence?.elements || []).filter((element: any) => element?.type === 'ply4');
        if (!(this.isSog4SequenceMode && elements.length > 1)) {
            return this.getSmartSelectionAnalysisSource();
        }
        const firstElement = elements[0] as any;
        const firstIndex = this.splatSequence?.elements.indexOf(firstElement) ?? 0;
        const firstSegment = this.sog4SequenceSegments[firstIndex];
        const wasLoaded = !!firstSegment?.parsed;
        const parsed = firstSegment?.parsed || (firstSegment?.file ? await new PLY4Loader().load(firstSegment.file, () => { }) : firstElement?.parsed);
        if (!parsed) return null;

        const readProp = (name: string): Float32Array | null => {
            if (parsed?.[name] instanceof Float32Array) return parsed[name] as Float32Array;
            const props = parsed?.plyData?.elements?.[0]?.properties || [];
            const hit = props.find((p: any) => p?.name === name);
            return (hit?.storage as Float32Array) || null;
        };
        const x = readProp('x');
        const y = readProp('y');
        const z = readProp('z');
        if (!x || !y || !z) return null;
        const count = Math.min(parsed.count || x.length, x.length, y.length, z.length);
        const positions = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            positions[i * 3 + 0] = x[i];
            positions[i * 3 + 1] = y[i];
            positions[i * 3 + 2] = z[i];
        }
        const source = {
            name: firstElement?.name || firstSegment?.name || 'first.ply4',
            selectionElement: firstElement,
            positions,
            trajectoryData: parsed.trajectory || null,
            keyframes: parsed.keyframes || 0,
            xyzStride: parsed.xyzStride || 1,
            originalIndices: readProp('original_index'),
            lifetimeMu: readProp('lifetime_mu'),
            lifetimeW: readProp('lifetime_w'),
            totalFrames: Math.max(1, Math.floor(parsed.frames || parsed.maxMu || firstElement?.duration || firstSegment?.duration || 1)),
            transformPoint: this.createSharedPly4SequenceTransformPoint()
        };
        if (!wasLoaded && this.ply4SequenceLoadMode === 'segmented' && firstIndex !== this.sog4SequenceIndex && firstSegment) {
            firstSegment.parsed = null;
            if (firstElement) firstElement.parsed = null;
        }
        return source;
    }

    // #WDD-gpt 2026-05-16 - PLY4 序列的自动对齐和圆柱选择统一使用第一个文件/序列共享的位移旋转缩放
    private createSharedPly4SequenceTransformPoint() {
        const shared = this.sog4SequenceSharedTransform || { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
        const pos = shared.pos || [0, 0, 0];
        const rot = shared.rot || [0, 0, 0, 1];
        const scale = shared.scale || [1, 1, 1];
        const rotation = new pc.Quat(rot[0], rot[1], rot[2], rot[3]);
        return (point: [number, number, number]) => {
            const local = new pc.Vec3(point[0] * scale[0], point[1] * scale[1], point[2] * scale[2]);
            const rotated = rotation.transformVector(local);
            return [
                rotated.x + pos[0],
                rotated.y + pos[1],
                rotated.z + pos[2]
            ] as [number, number, number];
        };
    }

    // #WDD-gpt 2026-05-16 - 圆柱选择对所有 PLY4 段逐段检测，Full/Lazy 都共享首段 transform
    public async selectCylinderForAllPly4Segments(
        region: { centerX: number; centerZ: number; radius: number; height: number; groundPad: number },
        onProgress?: (progress: { percent: number; stage: string; detail: string; segmentIndex?: number; segmentCount?: number }) => void
    ) {
        const hasPly4Sequence = this.isSog4SequenceMode
            && this.sog4SequenceSegments.length > 1
            && this.sog4SequenceSegments.some((segment) => segment?.name?.toLowerCase().endsWith('.ply4'));
        if (!hasPly4Sequence) {
            return null;
        }
        const readProp = (parsed: any, name: string): Float32Array | null => {
            if (parsed?.[name] instanceof Float32Array) return parsed[name] as Float32Array;
            const props = parsed?.plyData?.elements?.[0]?.properties || [];
            const hit = props.find((p: any) => p?.name === name);
            return (hit?.storage as Float32Array) || null;
        };
        const transformPoint = this.createSharedPly4SequenceTransformPoint();
        const inside = (point: [number, number, number]) => {
            const r = Math.hypot(point[0] - region.centerX, point[2] - region.centerZ);
            return r <= region.radius && point[1] >= -region.groundPad && point[1] <= region.height;
        };
        const loader = new PLY4Loader();
        let totalSelected = 0;
        let processedSegments = 0;
        const ply4Segments = this.sog4SequenceSegments
            .map((segment, index) => ({ segment, index }))
            .filter((entry) => entry.segment?.name?.toLowerCase().endsWith('.ply4'));
        const segmentCount = Math.max(1, ply4Segments.length);
        const reportProgress = (percent: number, stage: string, detail: string, segmentIndex?: number) => {
            const p = Math.max(0, Math.min(100, percent));
            onProgress?.({ percent: p, stage, detail, segmentIndex, segmentCount });
            if (this.ply4SequenceLoadMode === 'segmented') {
                this.showLazySegmentProgress(p, stage, detail);
            }
        };
        // #WDD-gpt 2026-05-16 - 大 PLY4 圆柱扫描期间定期让出主线程，避免浏览器被同步循环卡死
        const yieldToBrowser = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        reportProgress(1, 'Cylinder Selection', `Preparing ${segmentCount} PLY4 segments`);
        for (let segmentIndex = 0; segmentIndex < this.sog4SequenceSegments.length; segmentIndex++) {
            const segment = this.sog4SequenceSegments[segmentIndex];
            if (!segment) continue;
            if (!segment.name.toLowerCase().endsWith('.ply4')) continue;
            processedSegments++;
            const wasLoaded = !!segment.parsed;
            const segmentBase = ((processedSegments - 1) / segmentCount) * 100;
            const segmentSpan = 100 / segmentCount;
            reportProgress(segmentBase, `Cylinder ${processedSegments}/${segmentCount}`, `Opening ${segment.name}`, segmentIndex);
            const parsed = segment.parsed || (segment.file ? await loader.load(segment.file, (progress, message, meta) => {
                const local = Math.max(0, Math.min(65, progress * 0.65));
                const chunk = meta?.chunkIndex && meta?.chunkCount ? ` • chunk ${meta.chunkIndex}/${meta.chunkCount}` : '';
                const rows = meta?.rowsRead && meta?.rowCount ? ` • ${meta.rowsRead.toLocaleString()}/${meta.rowCount.toLocaleString()}` : '';
                reportProgress(segmentBase + segmentSpan * (local / 100), `Cylinder ${processedSegments}/${segmentCount}`, `${segment.name} • ${message}${chunk}${rows}`, segmentIndex);
            }) : null);
            if (!parsed) continue;
            const x = readProp(parsed, 'x');
            const y = readProp(parsed, 'y');
            const z = readProp(parsed, 'z');
            if (!x || !y || !z) {
                if (!wasLoaded && segmentIndex !== this.sog4SequenceIndex) segment.parsed = null;
                continue;
            }
            const count = Math.min(parsed.count || x.length, x.length, y.length, z.length);
            const trajectory = parsed.trajectory as Float32Array | null;
            const keyframes = Math.max(0, Math.floor(parsed.keyframes || 0));
            const xyzStride = Math.max(1, Math.floor(parsed.xyzStride || Math.max(1, Math.round(((parsed.frames || parsed.maxMu || segment.duration || keyframes || 1) - 1) / Math.max(1, keyframes - 1)))));
            const originalIndices = readProp(parsed, 'original_index');
            const lifetimeMu = readProp(parsed, 'lifetime_mu');
            const lifetimeW = readProp(parsed, 'lifetime_w');
            const totalFrames = Math.max(1, Math.floor(parsed.frames || parsed.maxMu || segment.duration || 1));
            const lifetimeRange = (index: number) => {
                if (!lifetimeMu || !lifetimeW) return null;
                const mu = lifetimeMu[index];
                const w = lifetimeW[index];
                if (!Number.isFinite(mu) || !Number.isFinite(w)) return null;
                return { start: mu - Math.max(0, w), end: mu + Math.max(0, w) };
            };
            const lifetimeFrameRange = (index: number): { start: number; end: number } | null => {
                const range = lifetimeRange(index);
                const start = Math.max(0, Math.ceil(range?.start ?? 0));
                const end = Math.min(totalFrames - 1, Math.floor(range?.end ?? totalFrames - 1));
                return end >= start ? { start, end } : null;
            };
            // #WDD-gpt 2026-05-16 - 圆柱 all-time 选择按生命周期有效帧采样插值轨迹，生命周期外命中不算选中
            const trajectoryPointAtFrame = (originalIndex: number, frame: number): [number, number, number] | null => {
                if (!trajectory || keyframes <= 0) return null;
                const keyframeMax = Math.max(0, (keyframes - 1) * xyzStride);
                const tClamped = Math.max(0, Math.min(frame, keyframeMax));
                const k0 = Math.min(Math.max(0, Math.floor(tClamped / xyzStride)), keyframes - 1);
                const k1 = Math.min(k0 + 1, keyframes - 1);
                const t0 = k0 * xyzStride;
                const t1 = k1 * xyzStride;
                const ratio = (k0 === k1 || t1 === t0) ? 0 : Math.max(0, Math.min(1, (tClamped - t0) / (t1 - t0)));
                const base = originalIndex * keyframes * 3;
                const o0 = base + k0 * 3;
                const o1 = base + k1 * 3;
                if (o0 < 0 || o1 < 0 || o0 + 2 >= trajectory.length || o1 + 2 >= trajectory.length) return null;
                const x0 = trajectory[o0 + 0], y0 = trajectory[o0 + 1], z0 = trajectory[o0 + 2];
                const x1 = trajectory[o1 + 0], y1 = trajectory[o1 + 1], z1 = trajectory[o1 + 2];
                return [
                    x0 + (x1 - x0) * ratio,
                    y0 + (y1 - y0) * ratio,
                    z0 + (z1 - z0) * ratio
                ];
            };
            reportProgress(segmentBase + segmentSpan * 0.68, `Cylinder ${processedSegments}/${segmentCount}`, `Testing ${count.toLocaleString()} splats in ${segment.name}`, segmentIndex);
            const existingSelection = this.getSequenceEditSelectionData(segmentIndex) as Uint8Array | null;
            const existingAllTime = this.getSequenceEditAllTimeSelectionData(segmentIndex) as Uint8Array | null;
            const selectionData = new Uint8Array(Math.max(count * 4, existingSelection?.length || 0));
            const allTimeSelectionData = new Uint8Array(Math.max(count * 4, existingAllTime?.length || existingSelection?.length || 0));
            if (existingSelection) selectionData.set(existingSelection.subarray(0, Math.min(existingSelection.length, selectionData.length)));
            if (existingAllTime) allTimeSelectionData.set(existingAllTime.subarray(0, Math.min(existingAllTime.length, allTimeSelectionData.length)));
            for (let i = 0; i < selectionData.length; i += 4) selectionData[i] = 0;
            for (let i = 0; i < allTimeSelectionData.length; i += 4) allTimeSelectionData[i] = 0;

            let selected = 0;
            let currentSelected = 0;
            const segmentStart = this.sog4SequenceOffsets[segmentIndex] || 0;
            const currentLocalFrame = this.currentTime >= segmentStart && this.currentTime < segmentStart + segment.duration
                ? Math.max(0, Math.min(totalFrames - 1, Math.floor(this.currentTime - segmentStart)))
                : null;
            let lastYield = performance.now();
            for (let i = 0; i < count; i++) {
                const validFrames = lifetimeFrameRange(i);
                if (!validFrames) continue;
                const basePoint = transformPoint([x[i], y[i], z[i]]);
                let hit = false;
                let currentHit = currentLocalFrame !== null
                    && currentLocalFrame >= validFrames.start
                    && currentLocalFrame <= validFrames.end
                    && inside(basePoint);
                if (trajectory && keyframes > 1) {
                    const originalIndex = originalIndices ? Math.max(0, Math.round(originalIndices[i] || 0)) : i;
                    for (let frame = validFrames.start; frame <= validFrames.end; frame++) {
                        const p = trajectoryPointAtFrame(originalIndex, frame);
                        if (!p) continue;
                        if (inside(transformPoint(p))) {
                            hit = true;
                            break;
                        }
                    }
                    if (currentLocalFrame !== null && currentLocalFrame >= validFrames.start && currentLocalFrame <= validFrames.end) {
                        const p = trajectoryPointAtFrame(originalIndex, currentLocalFrame);
                        currentHit = !!p && inside(transformPoint(p));
                    }
                } else {
                    hit = inside(basePoint);
                }
                if (hit) {
                    const off = i * 4;
                    if (selectionData[off + 1] <= 0) {
                        allTimeSelectionData[off] = 255;
                        if (currentHit) {
                            selectionData[off] = 255;
                            currentSelected++;
                        }
                        selected++;
                    }
                }
                if ((i & 511) === 0) {
                    const now = performance.now();
                    if (now - lastYield > 12) {
                        const scanPct = 0.68 + 0.22 * (i / Math.max(1, count));
                        reportProgress(
                            segmentBase + segmentSpan * scanPct,
                            `Cylinder ${processedSegments}/${segmentCount}`,
                            `Testing ${i.toLocaleString()}/${count.toLocaleString()} splats in ${segment.name}`,
                            segmentIndex
                        );
                        await yieldToBrowser();
                        lastYield = performance.now();
                    }
                }
            }
            totalSelected += selected;
            reportProgress(segmentBase + segmentSpan * 0.92, `Cylinder ${processedSegments}/${segmentCount}`, `Writing ${selected.toLocaleString()} all-time / ${currentSelected.toLocaleString()} current splats for ${segment.name}`, segmentIndex);
            this.setSequenceEditSelectionData(segmentIndex, selectionData, allTimeSelectionData);
            if (!wasLoaded && segmentIndex !== this.sog4SequenceIndex) {
                segment.parsed = null;
                const element = this.splatSequence?.elements?.[segmentIndex] as any;
                if (element) element.parsed = null;
            }
            reportProgress(segmentBase + segmentSpan, `Cylinder ${processedSegments}/${segmentCount}`, `Finished ${segment.name}`, segmentIndex);
        }
        reportProgress(100, 'Cylinder Selection', `Selected ${totalSelected.toLocaleString()} splats across ${processedSegments} segments`);
        if (this.ply4SequenceLoadMode === 'segmented') this.hideLazySegmentProgress(900);
        return { total: totalSelected, segments: processedSegments };
    }

    // #WDD 2026-07-04: 圆柱「保留」操作——一步删除圆柱内/外的点。遍历生命期内关键帧本身。
    // mode='inside'（保留圆柱内→删圆柱外的点）；mode='outside'（保留圆柱外→删圆柱内的点）。
    // 仅测 K 个关键帧（不测插值帧），落点 lifetime 窗口外的关键帧不参与检测。
    public async cylinderKeepPoints(
        region: { centerX: number; centerZ: number; radius: number; height: number; groundPad: number },
        mode: 'inside' | 'outside',
        onProgress?: (progress: { percent: number; stage: string; detail: string; segmentIndex?: number; segmentCount?: number }) => void
    ): Promise<{ deleted: number; segments: number } | null> {
        const hasPly4Sequence = this.isSog4SequenceMode
            && this.sog4SequenceSegments.length > 1
            && this.sog4SequenceSegments.some((segment) => segment?.name?.toLowerCase().endsWith('.ply4'));
        if (!hasPly4Sequence) {
            return null;
        }
        const readProp = (parsed: any, name: string): Float32Array | null => {
            if (parsed?.[name] instanceof Float32Array) return parsed[name] as Float32Array;
            const props = parsed?.plyData?.elements?.[0]?.properties || [];
            const hit = props.find((p: any) => p?.name === name);
            return (hit?.storage as Float32Array) || null;
        };
        const transformPoint = this.createSharedPly4SequenceTransformPoint();
        const inside = (point: [number, number, number]) => {
            const r = Math.hypot(point[0] - region.centerX, point[2] - region.centerZ);
            return r <= region.radius && point[1] >= -region.groundPad && point[1] <= region.height;
        };
        const loader = new PLY4Loader();
        const modeLabel = mode === 'inside' ? 'Keep Inside' : 'Keep Outside';
        let totalDeleted = 0;
        let processedSegments = 0;
        const ply4Segments = this.sog4SequenceSegments
            .map((segment, index) => ({ segment, index }))
            .filter((entry) => entry.segment?.name?.toLowerCase().endsWith('.ply4'));
        const segmentCount = Math.max(1, ply4Segments.length);
        const reportProgress = (percent: number, stage: string, detail: string, segmentIndex?: number) => {
            const p = Math.max(0, Math.min(100, percent));
            onProgress?.({ percent: p, stage, detail, segmentIndex, segmentCount });
            if (this.ply4SequenceLoadMode === 'segmented') {
                this.showLazySegmentProgress(p, stage, detail);
            }
        };
        const yieldToBrowser = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        // 删除前捕获全局选择状态以便撤销（与 deleteSelected 一致）
        const before = this.selectionTool?.captureSelectionStateForExternalOp?.() ?? null;
        reportProgress(1, modeLabel, `Preparing ${segmentCount} PLY4 segments`);
        for (let segmentIndex = 0; segmentIndex < this.sog4SequenceSegments.length; segmentIndex++) {
            const segment = this.sog4SequenceSegments[segmentIndex];
            if (!segment) continue;
            if (!segment.name.toLowerCase().endsWith('.ply4')) continue;
            processedSegments++;
            const wasLoaded = !!segment.parsed;
            const segmentBase = ((processedSegments - 1) / segmentCount) * 100;
            const segmentSpan = 100 / segmentCount;
            reportProgress(segmentBase, `${modeLabel} ${processedSegments}/${segmentCount}`, `Opening ${segment.name}`, segmentIndex);
            const parsed = segment.parsed || (segment.file ? await loader.load(segment.file, (progress, message, meta) => {
                const local = Math.max(0, Math.min(65, progress * 0.65));
                const chunk = meta?.chunkIndex && meta?.chunkCount ? ` • chunk ${meta.chunkIndex}/${meta.chunkCount}` : '';
                const rows = meta?.rowsRead && meta?.rowCount ? ` • ${meta.rowsRead.toLocaleString()}/${meta.rowCount.toLocaleString()}` : '';
                reportProgress(segmentBase + segmentSpan * (local / 100), `${modeLabel} ${processedSegments}/${segmentCount}`, `${segment.name} • ${message}${chunk}${rows}`, segmentIndex);
            }) : null);
            if (!parsed) continue;
            const x = readProp(parsed, 'x');
            const y = readProp(parsed, 'y');
            const z = readProp(parsed, 'z');
            if (!x || !y || !z) {
                if (!wasLoaded && segmentIndex !== this.sog4SequenceIndex) segment.parsed = null;
                continue;
            }
            const count = Math.min(parsed.count || x.length, x.length, y.length, z.length);
            const trajectory = parsed.trajectory as Float32Array | null;
            const keyframes = Math.max(0, Math.floor(parsed.keyframes || 0));
            const xyzStride = Math.max(1, Math.floor(parsed.xyzStride || Math.max(1, Math.round(((parsed.frames || parsed.maxMu || segment.duration || keyframes || 1) - 1) / Math.max(1, keyframes - 1)))));
            const originalIndices = readProp(parsed, 'original_index');
            const lifetimeMu = readProp(parsed, 'lifetime_mu');
            const lifetimeW = readProp(parsed, 'lifetime_w');
            const totalFrames = Math.max(1, Math.floor(parsed.frames || parsed.maxMu || segment.duration || 1));
            const lifetimeFrameRange = (index: number): { start: number; end: number } | null => {
                if (!lifetimeMu || !lifetimeW) return null;
                const mu = lifetimeMu[index];
                const w = lifetimeW[index];
                if (!Number.isFinite(mu) || !Number.isFinite(w)) return null;
                const start = Math.max(0, Math.ceil(mu - Math.max(0, w)));
                const end = Math.min(totalFrames - 1, Math.floor(mu + Math.max(0, w)));
                return end >= start ? { start, end } : null;
            };
            reportProgress(segmentBase + segmentSpan * 0.68, `${modeLabel} ${processedSegments}/${segmentCount}`, `Testing ${count.toLocaleString()} splats in ${segment.name}`, segmentIndex);
            const existingSelection = this.getSequenceEditSelectionData(segmentIndex) as Uint8Array | null;
            const existingAllTime = this.getSequenceEditAllTimeSelectionData(segmentIndex) as Uint8Array | null;
            const selectionData = new Uint8Array(Math.max(count * 4, existingSelection?.length || 0));
            const allTimeSelectionData = new Uint8Array(Math.max(count * 4, existingAllTime?.length || existingSelection?.length || 0));
            if (existingSelection) selectionData.set(existingSelection.subarray(0, Math.min(existingSelection.length, selectionData.length)));
            if (existingAllTime) allTimeSelectionData.set(existingAllTime.subarray(0, Math.min(existingAllTime.length, allTimeSelectionData.length)));
            // 注意：删除场景不清 byte0，只追加 byte1（已删点保留），与 deleteSelected 一致

            let deleted = 0;
            let lastYield = performance.now();
            for (let i = 0; i < count; i++) {
                const off = i * 4;
                if (off + 1 >= selectionData.length) break;
                if (selectionData[off + 1] > 0) continue; // 已删除的点跳过，幂等
                const validFrames = lifetimeFrameRange(i);
                // 判定生命期内任一关键帧是否命中圆柱
                let enters = false;
                if (!validFrames) {
                    enters = false; // 生命期外：按「不在圆柱内」处理
                } else if (!trajectory || keyframes <= 0) {
                    enters = inside(transformPoint([x[i], y[i], z[i]])); // 无轨迹：测当前位置
                } else {
                    const originalIndex = originalIndices ? Math.max(0, Math.round(originalIndices[i] || 0)) : i;
                    const base = originalIndex * keyframes * 3;
                    for (let k = 0; k < keyframes; k++) {
                        const frame = k * xyzStride;
                        if (frame < validFrames.start || frame > validFrames.end) continue; // 生命期外关键帧跳过
                        const o = base + k * 3;
                        if (o + 2 >= trajectory.length) break;
                        if (inside(transformPoint([trajectory[o], trajectory[o + 1], trajectory[o + 2]]))) {
                            enters = true;
                            break;
                        }
                    }
                }
                // mode='inside' 保留内 → 删外（!enters）；mode='outside' 保留外 → 删内（enters）
                const shouldDelete = mode === 'inside' ? !enters : enters;
                if (shouldDelete) {
                    selectionData[off] = 0;
                    selectionData[off + 1] = 255;
                    if (off + 1 < allTimeSelectionData.length) {
                        allTimeSelectionData[off] = 0;
                        allTimeSelectionData[off + 1] = 255;
                    }
                    deleted++;
                }
                if ((i & 511) === 0) {
                    const now = performance.now();
                    if (now - lastYield > 12) {
                        const scanPct = 0.68 + 0.22 * (i / Math.max(1, count));
                        reportProgress(
                            segmentBase + segmentSpan * scanPct,
                            `${modeLabel} ${processedSegments}/${segmentCount}`,
                            `Testing ${i.toLocaleString()}/${count.toLocaleString()} splats in ${segment.name}`,
                            segmentIndex
                        );
                        await yieldToBrowser();
                        lastYield = performance.now();
                    }
                }
            }
            totalDeleted += deleted;
            reportProgress(segmentBase + segmentSpan * 0.92, `${modeLabel} ${processedSegments}/${segmentCount}`, `Deleting ${deleted.toLocaleString()} splats for ${segment.name}`, segmentIndex);
            this.setSequenceEditSelectionData(segmentIndex, selectionData, allTimeSelectionData);
            if (!wasLoaded && segmentIndex !== this.sog4SequenceIndex) {
                segment.parsed = null;
                const element = this.splatSequence?.elements?.[segmentIndex] as any;
                if (element) element.parsed = null;
            }
            reportProgress(segmentBase + segmentSpan, `${modeLabel} ${processedSegments}/${segmentCount}`, `Finished ${segment.name}`, segmentIndex);
        }
        // 撤销快照 + 纹理刷新
        if (before) {
            this.selectionTool?.pushSelectionUndo?.(before);
        }
        this.selectionTool?.updateTexture?.();
        reportProgress(100, modeLabel, `Deleted ${totalDeleted.toLocaleString()} splats across ${processedSegments} segments`);
        if (this.ply4SequenceLoadMode === 'segmented') this.hideLazySegmentProgress(900);
        return { deleted: totalDeleted, segments: processedSegments };
    }

    // #WDD 2026-07-04: 重新加载 PLY4 序列（圆柱删除保存后自动重载用），跳过 lazy 模式确认对话框
    public async reloadPly4Sequence(files: File[]): Promise<void> {
        return this.loadPly4Sequence(files, true);
    }

    // #WDD 2026-07-04: 圆柱删除 Lazy 模式专用——批量处理所有段文件、写入用户选定文件夹、自动重载
    // 流程：选目录 → 逐段读取+命中检测+写删除标记+编码保存 → 全部完成后统一重载
    public async cylinderKeepPointsAndSaveReload(
        region: { centerX: number; centerZ: number; radius: number; height: number; groundPad: number },
        mode: 'inside' | 'outside',
        onProgress?: (progress: { percent: number; stage: string; detail: string; segmentIndex?: number; segmentCount?: number }) => void
    ): Promise<{ deleted: number; segments: number; saved: number } | null> {
        const hasPly4Sequence = this.isSog4SequenceMode
            && this.sog4SequenceSegments.length > 1
            && this.sog4SequenceSegments.some((segment) => segment?.name?.toLowerCase().endsWith('.ply4'));
        if (!hasPly4Sequence) return null;

        // 1. 选目录（File System Access API）——先选目录，取消则不浪费处理
        const showDirectoryPicker = (window as any).showDirectoryPicker;
        if (typeof showDirectoryPicker !== 'function') {
            alert(t('smart.cylinderNoFsApi'));
            return null;
        }
        let dirHandle: any;
        try {
            dirHandle = await showDirectoryPicker({ mode: 'readwrite', id: 'ply4-cylinder-export' });
        } catch (pickErr) {
            // 用户取消选目录
            return null;
        }

        // 2. 逐段：读取 + 命中检测 + 写删除标记 + 编码保存到所选目录 + 收集新 File
        const readProp = (parsed: any, name: string): Float32Array | null => {
            if (parsed?.[name] instanceof Float32Array) return parsed[name] as Float32Array;
            const props = parsed?.plyData?.elements?.[0]?.properties || [];
            const hit = props.find((p: any) => p?.name === name);
            return (hit?.storage as Float32Array) || null;
        };
        const transformPoint = this.createSharedPly4SequenceTransformPoint();
        const transform = this.sog4SequenceSharedTransform;
        const inside = (point: [number, number, number]) => {
            const r = Math.hypot(point[0] - region.centerX, point[2] - region.centerZ);
            return r <= region.radius && point[1] >= -region.groundPad && point[1] <= region.height;
        };
        const modeLabel = mode === 'inside' ? 'Keep Inside' : 'Keep Outside';
        const loader = new PLY4Loader();
        const newFiles: File[] = [];
        const segCount = Math.max(1, this.sog4SequenceSegments.length);
        const yieldToBrowser = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        let totalDeleted = 0;
        let processedSegments = 0;
        let savedCount = 0;
        // 删除前捕获全局选择状态以便撤销
        const before = this.selectionTool?.captureSelectionStateForExternalOp?.() ?? null;
        onProgress?.({ percent: 1, stage: modeLabel, detail: `Saving to ${dirHandle?.name || 'folder'}` });

        for (let segmentIndex = 0; segmentIndex < this.sog4SequenceSegments.length; segmentIndex++) {
            const segment = this.sog4SequenceSegments[segmentIndex];
            if (!segment || !segment.name.toLowerCase().endsWith('.ply4')) continue;
            processedSegments++;
            const wasLoaded = !!segment.parsed;
            const segmentBase = ((processedSegments - 1) / segCount) * 90; // 处理+保存占 0~90%
            const segmentSpan = 90 / segCount;
            onProgress?.({ percent: segmentBase, stage: `${modeLabel} ${processedSegments}/${segCount}`, detail: `Opening ${segment.name}`, segmentIndex, segmentCount: segCount });
            // 读取段（已加载则复用，否则从 File 临时解码）
            const parsed = segment.parsed || (segment.file ? await loader.load(segment.file, (progress, message, meta) => {
                const local = Math.max(0, Math.min(65, progress * 0.65));
                const rows = meta?.rowsRead && meta?.rowCount ? ` • ${meta.rowsRead.toLocaleString()}/${meta.rowCount.toLocaleString()}` : '';
                onProgress?.({ percent: segmentBase + segmentSpan * (local / 100), stage: `${modeLabel} ${processedSegments}/${segCount}`, detail: `${segment.name} • ${message}${rows}`, segmentIndex, segmentCount: segCount });
            }) : null);
            if (!parsed) continue;
            const x = readProp(parsed, 'x');
            const y = readProp(parsed, 'y');
            const z = readProp(parsed, 'z');
            if (!x || !y || !z) {
                if (!wasLoaded && segmentIndex !== this.sog4SequenceIndex) segment.parsed = null;
                continue;
            }
            const count = Math.min(parsed.count || x.length, x.length, y.length, z.length);
            const trajectory = parsed.trajectory as Float32Array | null;
            const keyframes = Math.max(0, Math.floor(parsed.keyframes || 0));
            const xyzStride = Math.max(1, Math.floor(parsed.xyzStride || Math.max(1, Math.round(((parsed.frames || parsed.maxMu || segment.duration || keyframes || 1) - 1) / Math.max(1, keyframes - 1)))));
            const originalIndices = readProp(parsed, 'original_index');
            const lifetimeMu = readProp(parsed, 'lifetime_mu');
            const lifetimeW = readProp(parsed, 'lifetime_w');
            const totalFrames = Math.max(1, Math.floor(parsed.frames || parsed.maxMu || segment.duration || 1));
            const lifetimeFrameRange = (index: number): { start: number; end: number } | null => {
                if (!lifetimeMu || !lifetimeW) return null;
                const mu = lifetimeMu[index];
                const w = lifetimeW[index];
                if (!Number.isFinite(mu) || !Number.isFinite(w)) return null;
                const start = Math.max(0, Math.ceil(mu - Math.max(0, w)));
                const end = Math.min(totalFrames - 1, Math.floor(mu + Math.max(0, w)));
                return end >= start ? { start, end } : null;
            };
            onProgress?.({ percent: segmentBase + segmentSpan * 0.5, stage: `${modeLabel} ${processedSegments}/${segCount}`, detail: `Testing ${count.toLocaleString()} splats in ${segment.name}`, segmentIndex, segmentCount: segCount });
            // 读已有删除状态，构建缓冲（不清 byte0，只追加 byte1）
            const existingSelection = this.getSequenceEditSelectionData(segmentIndex) as Uint8Array | null;
            const existingAllTime = this.getSequenceEditAllTimeSelectionData(segmentIndex) as Uint8Array | null;
            const selectionData = new Uint8Array(Math.max(count * 4, existingSelection?.length || 0));
            const allTimeSelectionData = new Uint8Array(Math.max(count * 4, existingAllTime?.length || existingSelection?.length || 0));
            if (existingSelection) selectionData.set(existingSelection.subarray(0, Math.min(existingSelection.length, selectionData.length)));
            if (existingAllTime) allTimeSelectionData.set(existingAllTime.subarray(0, Math.min(existingAllTime.length, allTimeSelectionData.length)));

            // 逐点命中检测（关键帧 + lifetime 窗口）→ 写删除标记
            let deleted = 0;
            let lastYield = performance.now();
            for (let i = 0; i < count; i++) {
                const off = i * 4;
                if (off + 1 >= selectionData.length) break;
                if (selectionData[off + 1] > 0) continue; // 已删除跳过，幂等
                const validFrames = lifetimeFrameRange(i);
                let enters = false;
                if (!validFrames) {
                    enters = false;
                } else if (!trajectory || keyframes <= 0) {
                    enters = inside(transformPoint([x[i], y[i], z[i]]));
                } else {
                    const originalIndex = originalIndices ? Math.max(0, Math.round(originalIndices[i] || 0)) : i;
                    const base = originalIndex * keyframes * 3;
                    for (let k = 0; k < keyframes; k++) {
                        const frame = k * xyzStride;
                        if (frame < validFrames.start || frame > validFrames.end) continue;
                        const o = base + k * 3;
                        if (o + 2 >= trajectory.length) break;
                        if (inside(transformPoint([trajectory[o], trajectory[o + 1], trajectory[o + 2]]))) {
                            enters = true;
                            break;
                        }
                    }
                }
                const shouldDelete = mode === 'inside' ? !enters : enters;
                if (shouldDelete) {
                    selectionData[off] = 0;
                    selectionData[off + 1] = 255;
                    if (off + 1 < allTimeSelectionData.length) {
                        allTimeSelectionData[off] = 0;
                        allTimeSelectionData[off + 1] = 255;
                    }
                    deleted++;
                }
                if ((i & 511) === 0) {
                    const now = performance.now();
                    if (now - lastYield > 12) {
                        onProgress?.({ percent: segmentBase + segmentSpan * (0.5 + 0.25 * (i / Math.max(1, count))), stage: `${modeLabel} ${processedSegments}/${segCount}`, detail: `Testing ${i.toLocaleString()}/${count.toLocaleString()} in ${segment.name}`, segmentIndex, segmentCount: segCount });
                        await yieldToBrowser();
                        lastYield = performance.now();
                    }
                }
            }
            totalDeleted += deleted;
            // 提交删除状态（内存 + 持久化）
            this.setSequenceEditSelectionData(segmentIndex, selectionData, allTimeSelectionData);
            // 编码保存（encode 自动剔除 byte1>0 的点）
            onProgress?.({ percent: segmentBase + segmentSpan * 0.85, stage: `${modeLabel} ${processedSegments}/${segCount}`, detail: `Saving ${segment.name} (deleted ${deleted.toLocaleString()})`, segmentIndex, segmentCount: segCount });
            try {
                const buffer = await PLY4Encoder.encode(parsed, {
                    selectionData,
                    model_transform: transform
                }, (pct, msg) => {
                    onProgress?.({ percent: segmentBase + segmentSpan * (0.85 + (pct / 100) * 0.13), stage: `${modeLabel} ${processedSegments}/${segCount}`, detail: `${segment.name} • ${msg}`, segmentIndex, segmentCount: segCount });
                });
                const fileHandle = await dirHandle.getFileHandle(segment.name, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(buffer);
                await writable.close();
                newFiles.push(new File([buffer], segment.name, { type: 'application/octet-stream' }));
                savedCount++;
            } catch (writeErr) {
                console.error(`[Cylinder Save] Failed to write ${segment.name}`, writeErr);
                alert(`Failed to write ${segment.name}: ` + (writeErr instanceof Error ? writeErr.message : String(writeErr)));
            }
            // 回收临时 parsed
            if (!wasLoaded && segmentIndex !== this.sog4SequenceIndex) {
                segment.parsed = null;
                const element = this.splatSequence?.elements?.[segmentIndex] as any;
                if (element) element.parsed = null;
            }
            await yieldToBrowser();
        }

        // 3. 全部段处理完后再统一重载
        if (before) this.selectionTool?.pushSelectionUndo?.(before);
        if (newFiles.length === 0) {
            onProgress?.({ percent: 100, stage: 'DONE', detail: 'No files saved' });
            return { deleted: totalDeleted, segments: processedSegments, saved: 0 };
        }
        onProgress?.({ percent: 92, stage: 'RELOADING', detail: `Reloading ${newFiles.length} processed files` });
        await this.reloadPly4Sequence(newFiles);
        onProgress?.({ percent: 100, stage: 'DONE', detail: `Deleted ${totalDeleted.toLocaleString()} • Saved ${savedCount} • Reloaded` });
        if (this.ply4SequenceLoadMode === 'segmented') this.hideLazySegmentProgress(900);
        return { deleted: totalDeleted, segments: processedSegments, saved: savedCount };
    }

    // #WDD-gpt 2026-05-15 - 智能选择工具应用地面对齐结果，并同步多段序列与导出状态
    public applySmartSelectionTransform(position: pc.Vec3, rotation: pc.Quat) {
        if (!this.splatEntity) return;

        const currentScale = this.splatEntity.getLocalScale().clone();
        this.splatEntity.setLocalPosition(position);
        this.splatEntity.setLocalRotation(rotation);
        this.splatEntity.setLocalScale(currentScale);
        this.modelTransformEdited = true;

        if (this.isSog4SequenceMode && this.sog4SequenceSegments.length) {
            this.sog4SequenceSharedTransform = {
                pos: [position.x, position.y, position.z],
                rot: [rotation.x, rotation.y, rotation.z, rotation.w],
                scale: [currentScale.x, currentScale.y, currentScale.z]
            };
            for (const seg of this.sog4SequenceSegments) {
                if (!seg.entity) continue;
                seg.entity.setLocalPosition(position);
                seg.entity.setLocalRotation(rotation);
                seg.entity.setLocalScale(currentScale);
            }
        }

        if (this.isSequenceMode && this.sequenceEntityPool.length) {
            for (const ent of this.sequenceEntityPool) {
                ent.setLocalPosition(position);
                ent.setLocalRotation(rotation);
                ent.setLocalScale(currentScale);
            }
        }

        this.updateTransformUIFromEntity();
    }

    // #WDD-gpt 2026-05-16 - 应用 AutoGroundAlignment 输出的世界空间标准化矩阵到当前模型实体
    public applyAutoGroundAlignmentTransform(rotationMatrix: number[][], translation: [number, number, number]) {
        if (!this.splatEntity) return;
        const deltaRotation = this.quatFromRotationMatrix(rotationMatrix);
        const currentPosition = this.splatEntity.getLocalPosition().clone();
        const currentRotation = this.splatEntity.getLocalRotation().clone();
        const currentScale = this.splatEntity.getLocalScale().clone();
        const rotatedPosition = deltaRotation.transformVector(currentPosition);
        const nextPosition = new pc.Vec3(
            rotatedPosition.x + translation[0],
            rotatedPosition.y + translation[1],
            rotatedPosition.z + translation[2]
        );
        const nextRotation = new pc.Quat();
        nextRotation.mul2(deltaRotation, currentRotation);
        nextRotation.normalize();
        this.applySmartSelectionTransform(nextPosition, nextRotation);
        this.splatEntity.setLocalScale(currentScale);
        this.updateTransformUIFromEntity();
    }

    private quatFromRotationMatrix(m: number[][]) {
        const trace = m[0][0] + m[1][1] + m[2][2];
        const q = new pc.Quat();
        if (trace > 0) {
            const s = Math.sqrt(trace + 1) * 2;
            q.w = 0.25 * s;
            q.x = (m[2][1] - m[1][2]) / s;
            q.y = (m[0][2] - m[2][0]) / s;
            q.z = (m[1][0] - m[0][1]) / s;
        } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
            const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
            q.w = (m[2][1] - m[1][2]) / s;
            q.x = 0.25 * s;
            q.y = (m[0][1] + m[1][0]) / s;
            q.z = (m[0][2] + m[2][0]) / s;
        } else if (m[1][1] > m[2][2]) {
            const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
            q.w = (m[0][2] - m[2][0]) / s;
            q.x = (m[0][1] + m[1][0]) / s;
            q.y = 0.25 * s;
            q.z = (m[1][2] + m[2][1]) / s;
        } else {
            const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
            q.w = (m[1][0] - m[0][1]) / s;
            q.x = (m[0][2] + m[2][0]) / s;
            q.y = (m[1][2] + m[2][1]) / s;
            q.z = 0.25 * s;
        }
        q.normalize();
        return q;
    }

    // #WDD-gpt 2026-04-20 - 提供给 SelectionTool：遍历序列全部段的运行时数据
    public getSplatSequenceSelectionElements() {
        const elements = this.splatSequence?.elements || [];
        // #WDD-gpt 2026-05-16 - 分段缓冲下给选择/删除工具暴露已卸载段的轻量编辑状态
        for (let i = 0; i < elements.length; i++) {
            const saved = this.sequenceEditStates.get(i);
            const segment = this.sog4SequenceSegments[i] as any;
            const element = elements[i] as any;
            element.pointCount = segment?.parsed?.count || segment?.header?.count || Math.floor((saved?.selectionData?.length || 0) / 4) || element.pointCount || 0;
            if (saved) {
                element.runtime = element.runtime || {};
                element.runtime.selectionData = element.runtime.selectionData || (saved.selectionData ? new Uint8Array(saved.selectionData) : new Uint8Array(0));
                element.runtime.allTimeSelectionData = element.runtime.allTimeSelectionData || (saved.allTimeSelectionData
                    ? new Uint8Array(saved.allTimeSelectionData)
                    : (saved.selectionData ? new Uint8Array(saved.selectionData.length) : new Uint8Array(0)));
                if (saved.selectionData && element.runtime.selectionData instanceof Uint8Array) {
                    element.runtime.selectionData.set(saved.selectionData.subarray(0, Math.min(saved.selectionData.length, element.runtime.selectionData.length)));
                }
                if (saved.allTimeSelectionData && element.runtime.allTimeSelectionData instanceof Uint8Array) {
                    element.runtime.allTimeSelectionData.set(saved.allTimeSelectionData.subarray(0, Math.min(saved.allTimeSelectionData.length, element.runtime.allTimeSelectionData.length)));
                }
            }
        }
        return elements;
    }

    // #WDD-gpt 2026-05-16 - 导出和批量选择读取分段缓冲保存的选择/删除状态
    public getSequenceEditSelectionData(index: number) {
        this.saveSog4SegmentEditState(index);
        const saved = this.sequenceEditStates.get(index);
        const runtime = (this.splatSequence?.elements?.[index] as any)?.runtime;
        return saved?.selectionData || runtime?.selectionData || null;
    }

    public getSequenceEditAllTimeSelectionData(index: number) {
        this.saveSog4SegmentEditState(index);
        const saved = this.sequenceEditStates.get(index);
        const runtime = (this.splatSequence?.elements?.[index] as any)?.runtime;
        return saved?.allTimeSelectionData || runtime?.allTimeSelectionData || null;
    }

    public setSequenceEditSelectionData(index: number, selectionData: Uint8Array, allTimeSelectionData?: Uint8Array | null) {
        const savedSelection = new Uint8Array(selectionData);
        const savedAllTime = allTimeSelectionData ? new Uint8Array(allTimeSelectionData) : new Uint8Array(selectionData);
        this.sequenceEditStates.set(index, {
            selectionData: savedSelection,
            allTimeSelectionData: savedAllTime
        });
        const element = (this.splatSequence?.elements?.[index] as any) || null;
        if (element) {
            element.runtime = element.runtime || {};
            element.runtime.selectionData = savedSelection;
            element.runtime.allTimeSelectionData = savedAllTime;
            if (index === this.sog4SequenceIndex && element.runtime.selectionTexture) {
                const lock = element.runtime.selectionTexture.lock();
                lock.set(savedSelection);
                element.runtime.selectionTexture.unlock();
                this.updateSelectionUniform(element.runtime.selectionTexture);
                if (this.selectionTool) {
                    this.selectionTool.selectionData = savedSelection;
                    this.selectionTool.allTimeSelectionData = savedAllTime;
                    this.selectionTool.selectionTexture = element.runtime.selectionTexture;
                }
            }
        }
    }

    // #WDD-kimi 2026-04-20 - 提供给 SelectionTool：捕获 undo 需要的视图上下文（段落/时间）
    // 注：位置/旋转/缩放 变换不再纳入 undo/redo 序列
    public captureSelectionUndoViewContext() {
        return {
            isSequence: !!this.isSog4SequenceMode,
            activeSegmentIndex: this.isSog4SequenceMode ? this.sog4SequenceIndex : 0,
            currentTime: this.currentTime ?? 0
        };
    }

    // #WDD-kimi 2026-04-20 - 提供给 SelectionTool：恢复 undo 视图上下文，确保切段时顺序一致
    // 注：位置/旋转/缩放 变换不再纳入 undo/redo 序列，恢复时跳过 transform
    public restoreSelectionUndoViewContext(ctx: any) {
        if (!ctx || typeof ctx !== 'object') return;

        if (this.isSog4SequenceMode && this.sog4SequenceSegments.length > 0) {
            const idxRaw = Number(ctx.activeSegmentIndex);
            const idx = Number.isFinite(idxRaw)
                ? Math.max(0, Math.min(this.sog4SequenceSegments.length - 1, Math.floor(idxRaw)))
                : this.sog4SequenceIndex;
            void this.activateSog4SequenceSegment(idx);
        }

        const total = Math.max(1, this.getTimelineTotalFrames());
        const tRaw = Number(ctx.currentTime);
        const t = Number.isFinite(tRaw) ? Math.max(0, Math.min(tRaw, total - 1)) : (this.currentTime ?? 0);
        this.currentTime = t;
        this.playbackTime = t;

        if (this.isSog4SequenceMode) {
            this.updateSog4SequenceTime();
        } else if (this.is4DGS && this.trajectoryData && !this.isWaitingForSort) {
            this.updateDynamicPositions(Math.floor(t));
        }

        this.syncTimelineUI(this.currentTime, Math.max(0, Math.ceil(total) - 1));
        this.updateTransformUIFromEntity();
    }

    // Public method for window binding
    private exportManager = new ViewerExportManager(this);
    private timelineManager = new ViewerTimelineManager(this);
    private sceneManager = new ViewerSceneManager(this);
    private presetManager = new ViewerPresetManager(this);
    private faceTrackingManager = new ViewerFaceTrackingManager(this);
    private fileLoader = new ViewerFileLoader(this);
    private fileInfoPanel = new ViewerFileInfoPanel(this);

    public async exportPlySequence() {
        return this.exportManager.exportPlySequence();
    }

    // #WDD 2026-04-20 Delegation to export manager
    private rememberLoadedModelTransform(parsed: any) {
        return this.exportManager.rememberLoadedModelTransform(parsed);
    }

    async saveAsTrueSplats() { return this.exportManager.saveAsTrueSplats(); }
    async saveAsPLY4() { return this.exportManager.saveAsPLY4(); }
    async saveAsSOG4() { return this.exportManager.saveAsSOG4(); }
    async saveAsPLY4Sequence() { return this.exportManager.saveAsPLY4Sequence(); }

}

// Global scoped app for access in callbacks
let app: pc.Application;
declare global {
    interface Window {
        exportPlySequence: () => void;
        testSog4Delete: (url: string, deleteRatio?: number) => Promise<void>;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    bindLanguageToggle(document.getElementById('language-toggle'));
    const viewer = new Viewer();
    applyI18n();
    app = viewer.app;
    window.exportPlySequence = () => viewer.exportPlySequence();
    window.testSog4Delete = async (url: string, deleteRatio: number = 0.5) => {
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        const loader = new SOG4Loader();
        const parsed = await loader.load(buffer);
        const count = parsed.count || 0;
        const deleteCount = Math.max(0, Math.min(count, Math.floor(count * deleteRatio)));
        const deleted: number[] = [];
        for (let i = 0; i < deleteCount; i++) deleted.push(i);
        const origIndices = parsed.original_index ? Array.from(parsed.original_index as Float32Array) : undefined;

        const out = await SOG4Loader.save(parsed, {
            deleted_indices: deleted,
            apply_deleted: true,
            original_indices: origIndices
        });

        const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(2)} MB`;
        console.log("[Test] SOG4 delete", {
            url,
            originalCount: count,
            deleted: deleteCount,
            originalSize: mb(buffer.byteLength),
            newSize: mb(out.byteLength)
        });
    };
});
