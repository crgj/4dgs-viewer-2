import * as pc from 'playcanvas';
import type { Viewer } from '../main';
import { TrueSplatsLoader } from '../utils/truesplats-loader';
import { SOG4Loader } from '../utils/sog4-loader';
import { PLY4Loader } from '../utils/ply4-loader';

/**
 * #WDD 2026-04-20: Extracted from Viewer to reduce main.ts size.
 * Handles file loading, drag-and-drop, format detection, and loading utilities.
 */
export class ViewerFileLoader {
    constructor(private viewer: Viewer) {}

    private async downloadFileConcurrent(url: string, onProgress: (loaded: number, total: number) => void): Promise<Blob> {
        const v = this.viewer as any;
        console.log("[SmartLoader] Starting Direct Download...");

        // 1. Start Fetch
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to download: ${res.status}`);

        const contentLength = res.headers.get('content-length');
        const totalSize = contentLength ? parseInt(contentLength, 10) : 0;

        const reader = res.body!.getReader();
        let loaded = 0;
        const chunks: Uint8Array[] = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            onProgress(loaded, totalSize || loaded);
        }

        return new Blob(chunks as any[]);
    }
    public async loadSampleFile(url: string) {
        const v = this.viewer as any;
        // #WDD 2026-01-22: Sanitize filename (remove query params and decode)
        let filename = url.split('/').pop() || 'sample.truesplats';
        filename = decodeURIComponent(filename.split('?')[0]);

        // Get New Download UI Elements
        const dlOverlay = document.getElementById('download-overlay');
        const dlPercent = document.getElementById('download-percent');
        const dlBar = document.getElementById('download-progress-bar');
        const dlFilename = document.getElementById('download-filename');
        const dlSize = document.getElementById('download-size');

        // Get Old Loading UI Elements (for parsing phase)
        const loadOverlay = document.getElementById('loading-overlay');
        const loadStatus = document.getElementById('loading-status');
        const stepSquares = document.querySelectorAll('.step-square');

        const updateDownloadUI = (percent: number, loadedObj: { loaded: number, total: number }) => {
            if (dlOverlay && dlOverlay.classList.contains('hidden')) dlOverlay.classList.remove('hidden');

            if (dlPercent) dlPercent.innerText = `${Math.round(percent)}%`;
            if (dlBar) dlBar.style.width = `${percent}%`;

            if (dlFilename) dlFilename.innerText = filename;
            if (dlSize) {
                const sizeMB = (loadedObj.loaded / (1024 * 1024)).toFixed(1);
                const totalMB = (loadedObj.total / (1024 * 1024)).toFixed(1);
                dlSize.innerText = `${sizeMB} MB / ${totalMB} MB`;
            }
        };

        try {
            // SHOW UI IMMEDIATELY
            if (dlOverlay) dlOverlay.classList.remove('hidden');
            if (dlFilename) dlFilename.innerText = filename;
            if (dlPercent) dlPercent.innerText = "0%";
            if (dlSize) dlSize.innerText = "Initializing...";

            // Ensure old overlay is hidden
            if (loadOverlay) loadOverlay.classList.add('hidden');

            // Fetch Blob using Concurrent Downloader
            const blob = await this.downloadFileConcurrent(url, (loaded, total) => {
                const percent = total > 0 ? (loaded / total) * 100 : 0;
                updateDownloadUI(percent, { loaded, total });
            });

            // #WDD 2026-01-22: Validate content is not HTML
            const headerHelper = new Uint8Array(await blob.slice(0, 100).arrayBuffer());
            const headerStr = new TextDecoder().decode(headerHelper);
            if (headerStr.trim().startsWith('<') || headerStr.includes('<!DOCTYPE html') || headerStr.includes('<html')) {
                throw new Error("The downloaded file appears to be an HTML page (likely a 404 or Proxy Error), not a valid model file.");
            }

            // Switch to Parsing UI (Download Complete)
            if (dlOverlay) dlOverlay.classList.add('hidden');
            if (loadOverlay) {
                loadOverlay.classList.remove('hidden');
                if (loadStatus) loadStatus.innerText = "PARSING";
                // Reset step progress for parsing
                stepSquares.forEach((sq, idx) => {
                    if (idx === 0) (sq as HTMLElement).classList.add('reached');
                    else (sq as HTMLElement).classList.remove('reached');
                });
            }

            const file = new File([blob], filename, { type: 'application/octet-stream' });
            this.loadFile(file);

        } catch (error) {
            console.error('Error loading sample file:', error);
            alert('Failed to load sample file.');
            if (dlOverlay) dlOverlay.classList.add('hidden');
            if (loadOverlay) loadOverlay.classList.add('hidden');
        }
    }
    public handleFileSelect(e: Event) {
        const v = this.viewer as any;
        const input = e.target as HTMLInputElement;
        if (input.files && input.files.length > 0) this.loadFile(input.files[0]);
    }

    // #WDD 2026-01-22: Connectivity Check Helper
    private async checkConnectivity(url: string, timeout: number = 2000): Promise<boolean> {
        const v = this.viewer as any;
        return new Promise(resolve => {
            const controller = new AbortController();
            const signal = controller.signal;
            const timer = setTimeout(() => controller.abort(), timeout);

            fetch(url, { method: 'HEAD', mode: 'no-cors', signal })
                .then(() => {
                    clearTimeout(timer);
                    resolve(true); // Connected (even opaque response means reachable)
                })
                .catch(() => {
                    clearTimeout(timer);
                    resolve(false); // Failed or Timed out
                });
        });
    }
    private async loadFile(file: File, options: { keepSog4Sequence?: boolean } = {}) {
        const v = this.viewer as any;
        // If on small screen (phone/tablet), auto-hide UI to simplified mode
        if (window.innerWidth < 1024) {
            v.toggleUIVisibility(true);
        }

        if (!options.keepSog4Sequence) {
            v.isSog4SequenceMode = false;
            v.sog4SequenceFiles = [];
            v.sog4SequenceSegments = [];
            v.sog4SequenceTotalFrames = 0;
            v.sog4SequenceOffsets = [];
            v.sog4SequenceName = null;
            v.sog4SequenceSharedTransform = null;
            v.sog4SequenceIndex = 0;
            v.sog4SequenceLoading = false;
            v.sog4SequenceRequestId++;
            v.splatSequence = null;
            v.resetTimelineTools();
        }

        const name = file.name.toLowerCase();
        if (!name.endsWith('.truesplats') && !name.endsWith('.sog4') && !name.endsWith('.ply4') && !name.endsWith('.ply')) {
            alert('Please drop a .truesplats, .sog4, or .ply4 file');
            return;
        }

        console.log(`[Viewer] Loading file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

        const overlay = document.getElementById('loading-overlay');
        const status = document.getElementById('loading-status');
        const detail = document.getElementById('loading-detail');
        const stepProgress = document.getElementById('loading-step-progress');
        const stepSquares = document.querySelectorAll('.step-square');

        const setProgress = (stepIndex: number, s: string, d?: string) => {
            if (overlay) overlay.classList.remove('hidden');
            if (status) status.innerText = s;
            if (detail && d) detail.innerText = d || "";

            // 1. Update Line Progress immediately to the current point
            if (stepProgress) {
                // #WDD-gpt 2026-04-20 - 防御：当 UI 缺少 step-square 时避免除以 0/-1
                const maxIndex = Math.max(stepSquares.length - 1, 1);
                const percentage = (stepIndex / maxIndex) * 100;
                stepProgress.style.width = `${percentage}%`;
            }

            // 2. Highlight only squares that are reached by the line
            stepSquares.forEach((sq, idx) => {
                const element = sq as HTMLElement;
                if (idx <= stepIndex) {
                    element.classList.add('reached');
                } else {
                    element.classList.remove('reached');
                }
            });
        };

        setProgress(0, "PREPARING", file.name);

        // Update filename for caching
        v.currentFileName = file.name;
        v.currentTransformCacheKey = file.name;

        if (!options.keepSog4Sequence) {
            if (v.splatEntity) v.splatEntity.destroy();
            v.presetManager.cameraPresets = [];
            v.presetManager.renderPresets();
            v.isSequenceMode = false;
            v.sequenceAssets = [];
            v.sequenceFrameIndex = -1;
            v.sequenceBands = 0;
        }

        const scElem = document.getElementById('splat-count');
        if (scElem) scElem.innerText = "--";

        try {
            setProgress(9, "READY", "Processing Asset...");

            // #WDD 2026-04-11 Performance: Start load phase tracking
            v.performanceMonitor.startLoadPhase('file-load', `Loading ${file.name}`);

            let parsed;
            let loader: any;
            const lowerName = file.name.toLowerCase();

            // #WDD 2026-01-19 Fix: Support both .sog and .sog4
            if (lowerName.endsWith('.sog4') || lowerName.endsWith('.sog')) {
                console.log("[Viewer] Using SOG4Loader for", file.name);
                loader = new SOG4Loader(v.app);
                v.performanceMonitor.startLoadPhase('sog4-parse', 'Parsing SOG4 format');
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress(Math.floor(p / 10), "LOADING", msg);
                });
                v.performanceMonitor.endLoadPhase('sog4-parse');
            } else if (lowerName.endsWith('.ply4') || lowerName.endsWith('.ply')) {
                console.log("[Viewer] Using PLY4Loader for", file.name);
                loader = new PLY4Loader(); // #WDD 2026-01-21 Use PLY4Loader
                v.performanceMonitor.startLoadPhase('ply4-parse', 'Parsing PLY4 format');
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress(Math.floor(p / 10), "LOADING", msg);
                });
            } else if (lowerName.endsWith('.truesplats')) {
                console.log("[Viewer] Using TrueSplatsLoader for", file.name);
                loader = new TrueSplatsLoader(v.app);
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress(Math.floor(p / 10), "LOADING", msg);
                });
            } else {
                console.warn("[Viewer] Unknown extension, defaulting to TrueSplatsLoader:", file.name);
                loader = new TrueSplatsLoader(v.app);
                parsed = await loader.load(file, (p: number, msg: string) => {
                    setProgress(Math.floor(p / 10), "LOADING", msg);
                });
            }

            // #WDD 2026-01-16 DEBUG: Sort by Frame 20 - REMOVED
            // We rely on updateDynamicPositions now.


            if (parsed) {
                v.lastParsedData = parsed; // #WDD 2026-01-18 Fix: Persist loaded data
                const count = parsed.count;

                // #WDD 2026-01-16: Force Static Frame 0 for debugging
                const forceStatic = false;
                // #WDD-gpt 2026-04-20 - 防御：给出更明确错误，避免后续出现 undefined.length 类异常
                const parsedElements = parsed?.plyData?.elements;
                if (!Array.isArray(parsedElements) || parsedElements.length === 0) {
                    throw new Error('Invalid parsed data: missing plyData.elements[0]');
                }
                let elements = parsedElements;
                if (forceStatic) {
                    console.log(`[Debug] Forcing Static Frame 0 Reconstruction (Verified getFrameElements Path)...`);
                    elements = loader.getFrameElements(0);
                }

                // TrueSplatsLoader returns a ready-to-use vertexElement in plyData
                let vertexElement = elements[0];

                // Instantiating GSplatData with the elements option correctly
                v.performanceMonitor.startLoadPhase('gsplat-create', 'Creating GSplat data');
                const splatData = new (pc.GSplatData as any)([vertexElement]);

                const resource = new pc.GSplatResource(v.app.graphicsDevice, splatData);

                const url = URL.createObjectURL(file);
                const asset = new pc.Asset(file.name, 'gsplat', { url: url });
                asset.resource = resource;
                asset.loaded = true;

                v.app.assets.add(asset);

                const entity = new pc.Entity('GSplat');
                entity.addComponent('gsplat', { asset: asset });
                v.performanceMonitor.endLoadPhase('gsplat-create');

                // #WDD 2026-01-18 AR Compatibility: Robust Parenting
                let arScaleFactor = 1.0;

                // 1. Always add to Root first (World Origin)
                v.app.root.addChild(entity);

                // 2. If AR is running, move to Anchor
                if (v.arHandler && v.arHandler.isARRunning && v.arHandler.arAnchor) {
                    console.log("[Viewer] AR Active: Reparenting new Splat to AR Anchor");

                    // Reparent to Anchor.
                    // IMPORTANT: We want it to SNAP to the Anchor's position (the Marker), 
                    // not keep its world position (which is 0,0,0 / the Camera).
                    // So we use addChild (keeps local transform) if we were creating fresh, 
                    // but since we added to root, we `reparent`.
                    // Wait, `reparent` KEEPS World Position. If World was 0, it stays 0.
                    // We WANT it to go to the Marker. The Marker is at Anchor Pos.
                    // So we want Local Position to be (0,0,0).

                    v.arHandler.arAnchor.addChild(entity); // Start as child

                    // Reset Local Transform to Snap to Marker
                    entity.setLocalPosition(0, 0, 0);
                    entity.setLocalRotation(new pc.Quat().setFromEulerAngles(0, 0, 0));

                    // Normalize Scale Logic
                    const pScale = v.arHandler.arAnchor.getLocalScale().x;
                    console.log(`[Viewer] AR Anchor Scale: ${pScale}`);
                    if (pScale !== 0) {
                        arScaleFactor = 1.0 / pScale;
                        // #WDD 2026-01-18 Fix: Do NOT compensate Entity Scale. 
                        // We WANT it to inherit the 5x magnification. 
                        // Only compensate Position so it doesn't fly away.
                        // entity.setLocalScale(arScaleFactor, arScaleFactor, arScaleFactor); 
                    }
                }

                v.splatEntity = entity;

                // #WDD 2026-01-18: Restore Model Transform if present (SOG4/TrueSplats format)
                if (parsed.model_transform) {
                    const t = parsed.model_transform;
                    console.log("[TrueSplats] applying model_transform with arFactor for Pos:", arScaleFactor, t);

                    // Apply AR Compensation to Loaded Transform
                    // Compensate POS (multiply by 0.2) because Parent is scaled 5x. 5 * 0.2 = 1.0 (World Units maintained)
                    if (t.pos) entity.setLocalPosition(t.pos[0] * arScaleFactor, t.pos[1] * arScaleFactor, t.pos[2] * arScaleFactor);

                    if (t.rot) entity.setLocalRotation(new pc.Quat(t.rot[0], t.rot[1], t.rot[2], t.rot[3]));

                    // Do NOT compensate Scale. Let it inherit AR Scale (Magnified).
                    if (t.scale) entity.setLocalScale(t.scale[0], t.scale[1], t.scale[2]);
                } 
                // #WDD 2026-03-31: Restore Model Transform from PLY4 format (parsed.meta)
                else if (parsed.meta) {
                    console.log("[PLY4] applying meta transform:", parsed.meta);
                    console.log("[PLY4] modelPos:", parsed.meta.modelPos, "modelRot:", parsed.meta.modelRot, "modelScale:", parsed.meta.modelScale);
                    if (parsed.meta.modelPos) {
                        entity.setLocalPosition(parsed.meta.modelPos);
                        console.log("[PLY4] Applied position:", parsed.meta.modelPos);
                    }
                    if (parsed.meta.modelRot) {
                        entity.setLocalRotation(parsed.meta.modelRot);
                        console.log("[PLY4] Applied rotation:", parsed.meta.modelRot);
                    }
                    if (parsed.meta.modelScale) {
                        entity.setLocalScale(parsed.meta.modelScale);
                        console.log("[PLY4] Applied scale:", parsed.meta.modelScale);
                    }
                } else {
                    console.log("[PLY4] No parsed.meta found! parsed keys:", Object.keys(parsed));
                    console.log("[TrueSplats] No model_transform found. Using default 0,0,0 local.");
                }

                console.log("[Viewer] Final Entity World Pos:", entity.getPosition().toString());
                console.log("[Viewer] Final Entity World Scale:", entity.getLocalScale().toString());

                // #WDD 2026-01-18: Restore Camera Presets if present
                if (parsed.cameras && Array.isArray(parsed.cameras)) {
                    v.presetManager.cameraPresets = parsed.cameras.map((c: any) => ({
                        name: c.name,
                        pos: new pc.Vec3(c.pos[0], c.pos[1], c.pos[2]),
                        pitch: c.pitch,
                        yaw: c.yaw,
                        textObjects: c.textObjects
                    }));
                    v.presetManager.renderPresets(); // Ensure UI updates
                    console.log(`[TrueSplats] Restored \${v.presetManager.cameraPresets.length} Camera Presets`);
                }

                setProgress(9, "READY", "System Update Complete");
                setTimeout(() => { if (overlay) overlay.classList.add('hidden'); }, 600);

                // #WDD 2026-04-11 Performance: End load phase tracking
                v.performanceMonitor.endLoadPhase('file-load');

                // Finalize
                this.updateStats(asset);
                this.updateStats(asset);
                // #WDD 2026-03-31: 同步 entity 变换到 UI（PLY4 meta 已在上面的代码中应用）
                console.log("[Load] About to call updateTransformUIFromEntity. Entity pos:", v.splatEntity?.getLocalPosition()?.toString());
                v.updateTransformUIFromEntity();
                console.log("[Load] UI should be updated now");
                v.resetCamera();
                v.resetCamera();
                const container = document.getElementById('timeline-ticks');
                if (container) container.innerHTML = '';

                // Call legacy finalize to setup shaders
                // #WDD 2026-01-16
                
const duration = parsed.frames || parsed.maxMu || 100;
                // #WDD-gpt 2026-04-20 - 修复单文件 sog4/ply4 拖拽时报 undefined.length：单文件走普通加载，不进入序列模式
                v.finalizeGSplatLoad(asset, count, null, duration, parsed);

                // #WDD 2026-01-30 Apply postProcessing parameters from file parameters from file
                if (parsed.postProcessing) {
                    console.log('[Viewer] Applying postProcessing from file:', parsed.postProcessing);
                    v.postProcessingTool.exposure = parsed.postProcessing.exposure || 1.0;
                    v.postProcessingTool.brightness = parsed.postProcessing.brightness || 0.0;
                    v.postProcessingTool.contrast = parsed.postProcessing.contrast || 0.0;
                    v.postProcessingTool.applySettings();
                    // Update UI to reflect loaded values
                    const expInput = document.getElementById('pp-exposure') as HTMLInputElement;
                    const briInput = document.getElementById('pp-brightness') as HTMLInputElement;
                    const conInput = document.getElementById('pp-contrast') as HTMLInputElement;
                    if (expInput) {
                        expInput.value = v.postProcessingTool.exposure.toString();
                        const expVal = document.getElementById('val-exposure');
                        if (expVal) expVal.innerText = v.postProcessingTool.exposure.toFixed(1);
                    }
                    if (briInput) {
                        briInput.value = v.postProcessingTool.brightness.toString();
                        const briVal = document.getElementById('val-brightness');
                        if (briVal) briVal.innerText = v.postProcessingTool.brightness > 0 ? '+' + v.postProcessingTool.brightness.toFixed(2) : v.postProcessingTool.brightness.toFixed(2);
                    }
                    if (conInput) {
                        conInput.value = v.postProcessingTool.contrast.toString();
                        const conVal = document.getElementById('val-contrast');
                        if (conVal) conVal.innerText = v.postProcessingTool.contrast > 0 ? '+' + v.postProcessingTool.contrast.toFixed(2) : v.postProcessingTool.contrast.toFixed(2);
                    }
                }

                // #WDD 2026-01-22: Auto-Play and Switch to Play Mode
                console.log("[Viewer] Auto-starting playback and switching to Play Mode");
                v.toggleUIVisibility(true); // Switch to Simplified UI
                if (!v.isPlaying) v.togglePlay(); // Start Animation

                return;
            }
        } catch (e) {
            console.error("Load Error:", e);
            // #WDD-gpt 2026-04-20 - 增强报错信息，方便直接定位触发行
            const msg = e instanceof Error ? e.message : String(e);
            const stackLine = e instanceof Error && e.stack ? `\n${e.stack.split('\n')[1] || ''}` : '';
            alert("Error loading file: " + msg + stackLine);
            if (overlay) overlay.classList.add('hidden');
        }
    }
    public async collectDroppedFiles(e: DragEvent): Promise<File[]> {
        const v = this.viewer as any;
        const collected: File[] = [];
        const items = e.dataTransfer?.items;
        if (items && items.length > 0) {
            const tasks: Promise<void>[] = [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.kind !== 'file') continue;
                const entry = item.webkitGetAsEntry?.();
                if (entry) {
                    tasks.push(this.walkDroppedEntry(entry, collected));
                } else {
                    const file = item.getAsFile();
                    if (file) collected.push(file);
                }
            }
            await Promise.all(tasks);
        } else if (e.dataTransfer?.files) {
            collected.push(...Array.from(e.dataTransfer.files));
        }
        return collected;
    }
    private async walkDroppedEntry(entry: FileSystemEntry, collector: File[]): Promise<void> {
        const v = this.viewer as any;
        if (entry.isFile) {
            return new Promise((resolve, reject) => {
                (entry as FileSystemFileEntry).file((file) => {
                    collector.push(file);
                    resolve();
                }, reject);
            });
        }
        if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            return new Promise((resolve, reject) => {
                const readNext = () => {
                    reader.readEntries(async (entries) => {
                        if (!entries || !entries.length) {
                            resolve();
                            return;
                        }
                        await Promise.all(entries.map((child) => this.walkDroppedEntry(child, collector)));
                        readNext();
                    }, reject);
                };
                readNext();
            });
        }
        return Promise.resolve();
    }
    public async handleDroppedFiles(files: File[]): Promise<void> {
        const v = this.viewer as any;
        const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
        const ply4Seq = sorted.filter((f) => this.isPly4SequenceCandidate(f));
        if (ply4Seq.length > 1) {
            await v.loadPly4Sequence(ply4Seq);
            return;
        }
        const plySeq = sorted.filter((f) => this.isPlySequenceCandidate(f));
        if (plySeq.length > 1) {
            await v.loadPlySequence(plySeq);
            return;
        }
        const sog4Seq = sorted.filter((f) => this.isSog4SequenceCandidate(f));
        if (sog4Seq.length > 1) {
            await v.loadSog4Sequence(sog4Seq);
            return;
        }
        const sogSeq = sorted.filter((f) => this.isSogSequenceCandidate(f));
        if (sogSeq.length > 1) {
            await v.loadSogSequence(sogSeq);
            return;
        }
        if (sorted.length > 0) {
            await this.loadFile(sorted[0]);
        }
    }
    private isPlySequenceCandidate(file: File): boolean {
        const v = this.viewer as any;
        const name = file.name.toLowerCase();
        return name.endsWith('.ply') && !name.endsWith('.ply4');
    }
    private isSogSequenceCandidate(file: File): boolean {
        const v = this.viewer as any;
        const name = file.name.toLowerCase();
        return name.endsWith('.sog') && !name.endsWith('.sog4');
    }
    private isSog4SequenceCandidate(file: File): boolean {
        const v = this.viewer as any;
        const name = file.name.toLowerCase();
        return name.endsWith('.sog4');
    }
    private isPly4SequenceCandidate(file: File): boolean {
        const v = this.viewer as any;
        const name = file.name.toLowerCase();
        return name.endsWith('.ply4');
    }
    public updateStats(asset: pc.Asset) {
        const v = this.viewer as any;
        if (!asset || !asset.resource) return;
        const resource = asset.resource as pc.GSplatResource;
        const splatData = resource.splatData;
        if (!splatData) return;

        const splatCountElem = document.getElementById('splat-count');
        if (splatCountElem) {
            // Use local format for better readability (e.g., 1,234,567)
            splatCountElem.innerText = splatData.numSplats.toLocaleString();
        }
    }
    private formatMemoryMB(bytes: number): string {
        const v = this.viewer as any;
        return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
    }
    public ensure4DTextureBudget(numSplats: number, width: number, parsed: any) {
        const v = this.viewer as any;
        const maxTextureSize = v.app.graphicsDevice.maxTextureSize || 4096;
        const rgba32fBytesPerPixel = 16;
        let estimatedBytes = width * Math.ceil(numSplats / width) * rgba32fBytesPerPixel * 2; // lifetime + scales

        const checks: { label: string; height: number }[] = [];
        if (parsed?.keyframes > 0) {
            const trajHeight = Math.ceil((numSplats * parsed.keyframes) / 4096);
            checks.push({ label: 'trajectoryTexture', height: trajHeight });
            estimatedBytes += 4096 * trajHeight * rgba32fBytesPerPixel;
        }
        if (parsed?.rotKeyframes > 0) {
            const rotHeight = Math.ceil((numSplats * parsed.rotKeyframes) / 4096);
            checks.push({ label: 'rotationTexture', height: rotHeight });
            estimatedBytes += 4096 * rotHeight * rgba32fBytesPerPixel;
        }
        if (parsed?.dcKeyframes > 0) {
            const dcHeight = Math.ceil((numSplats * parsed.dcKeyframes) / 4096);
            checks.push({ label: 'dcTrajectoryTexture', height: dcHeight });
            estimatedBytes += 4096 * dcHeight * rgba32fBytesPerPixel;
        }

        const oversize = checks.find((entry) => entry.height > maxTextureSize);
        if (oversize) {
            throw new Error(
                `4D texture '${oversize.label}' would be ${4096}x${oversize.height}, ` +
                `exceeding this GPU's max texture size ${maxTextureSize}.`
            );
        }

        // Browser-side RGBA32F allocations are heavy, but a fixed 1 GB cap turned out
        // to be too conservative for valid 4D PLY workloads on this viewer.
        // Keep the texture-size guard above, and allow larger datasets to attempt loading
        // up to a more practical soft budget.
        const gpuBudgetBytes = 5000 * 1024 * 1024;
        if (estimatedBytes > gpuBudgetBytes) {
            throw new Error(
                `4D textures are too large for browser/GPU memory. ` +
                `Estimated RGBA32F texture allocation: ${this.formatMemoryMB(estimatedBytes)} ` +
                `(limit ${this.formatMemoryMB(gpuBudgetBytes)}).`
            );
        }
    }

}
