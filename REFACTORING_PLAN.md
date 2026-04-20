# Viewer Refactoring Plan: 5 Subtasks

**Goal:** Reduce `src/main.ts` from ~5,065 lines to under ~1,000 lines by extracting domain-specific managers, while preserving all functionality.

**Current State:**
- `src/main.ts`: ~5,065 lines
- `src/ui/selection-tool.ts`: ~1,868 lines (separate concern, out of scope for this plan)
- Already extracted:
  - `src/viewer/viewer-export-manager.ts` (~556 lines)
  - `src/viewer/viewer-timeline-manager.ts` (~174 lines)
  - `src/viewer/viewer-scene-manager.ts` (~136 lines)
  - `src/types/viewer.ts` (~40 lines)

**Access Pattern:** Managers access `Viewer` private fields via `(viewer as any)` casts. This is a pragmatic intermediate step to enable file splitting without massive API rewrites. Cleaner encapsulation can be addressed later.

---

## Subtask 1: Extract UI Event Binding & DOM Interaction System

**Scope:** All DOM event wiring and UI state helpers.

**Methods to extract:**
- `setupEventListeners()` — ~1,001 lines (the largest single method)
- `bindSidebarTabs()`
- `bindGaussianRenderModeControls()`
- `toggleUIVisibility()`, `isUIHidden()`
- `resetObjectTransformUI()`, `updateTransformUIFromEntity()`
- `initSkyboxSelector()`, `setSkybox()`
- `syncOrbitFromCamera()`
- `applyGaussianRenderMode()`

**New file:** `src/viewer/viewer-ui-manager.ts`

**Estimated reduction:** ~1,200 lines from `main.ts`

**Key considerations:**
- `setupEventListeners` touches nearly every other subsystem. The manager will need to call back into `Viewer` for actions like `loadFile`, `togglePlay`, `resetCamera`, etc.
- Some event handlers are inline lambdas that reference `Viewer` private state directly — these will need to be refactored into manager methods or delegate to `Viewer` public methods.

---

## Subtask 2: Extract File Loading & Drop Handler Pipeline

**Scope:** All file input handling, network download, drag-and-drop, and format routing.

**Methods to extract:**
- `handleFileSelect()`, `loadSampleFile()`, `checkConnectivity()`
- `loadFile()` — main entry point for all file loading (~300 lines)
- `downloadFileConcurrent()`
- `handleDroppedFiles()`, `collectDroppedFiles()`, `walkDroppedEntry()`
- Format detection: `isPlySequenceCandidate()`, `isSogSequenceCandidate()`, `isSog4SequenceCandidate()`, `isPly4SequenceCandidate()`
- `updateStats()`, `formatMemoryMB()`
- `ensure4DTextureBudget()`

**New file:** `src/viewer/viewer-file-loader.ts`

**Estimated reduction:** ~700 lines from `main.ts`

**Key considerations:**
- `loadFile()` is the router that decides which sequence loader to call. The manager needs access to sequence loader methods on `Viewer`.
- `ensure4DTextureBudget` is a validation step during loading — it fits naturally here.
- `updateStats` is a UI side-effect of loading — it could stay in the file loader or be delegated to a UI manager. For now, keep it with loading.

---

## Subtask 3: Extract GSplat Initialization & 4DGS Core System

**Scope:** Entity setup after file parsing, 4DGS texture/shader management, dynamic position updates.

**Methods to extract:**
- `finalizeGSplatLoad()` — ~450 lines (bridges loading completion to entity setup)
- `setupLifetimeShader()` — ~180 lines
- `applyVisible4DFrame()`, `requestSortedFrame()`
- `updateDynamicPositions()`, `getPositionsAtTime()`
- `ensure4DTextureBudget()` (if not moved to Subtask 2)

**State to extract:**
- `is4DGS`, `trajectoryData`, `keyframes`, `xyzStride`
- `rotTrajectoryData`, `rotKeyframes`, `rotStride`
- `totalFrames`, `scalesTexData`, `originalIndices`
- `lastParsedData`, `hasLoggedSorterKeys`
- `isWaitingForSort`, `sortingTaskID`, `lastCompletedSortTaskID`
- `sorterUpdateInterval`, `pendingSortedFrame`, `sorterUpdateFrame`

**New file:** `src/viewer/viewer-4dgs-manager.ts`

**Estimated reduction:** ~800 lines from `main.ts`

**Key considerations:**
- `finalizeGSplatLoad` is called from `loadFile` (Subtask 2) and from some sequence loaders (Subtask 4). The manager must expose a clean public method.
- `setupLifetimeShader` creates WebGPU/WebGL shader materials — this is tightly coupled to `app.graphicsDevice`.
- `updateDynamicPositions` and `applyVisible4DFrame` are called from `onUpdate` (Subtask 5).

---

## Subtask 4: Extract Sequence Playback Managers

**Scope:** All sequence loading and playback logic across 4 formats (PLY, SOG, PLY4, SOG4).

**Methods to extract:**

**Common infrastructure:**
- `createSequenceProgressUpdater()`, `activeLoadingSequenceCleanup()`
- `getSequenceParentEntity()`, `onARStartedForSequence()`, `onARStoppingForSequence()`
- `shouldPreloadAllSequenceFrames()`
- `waitForGsplatMaterial()`, `waitForSequenceGsplatMaterial()`, `waitRafs()`
- `rebuildSplatSequenceFromTemporalSegments()`, `configureSingleElementTemporalSequence()`
- `getSplatSequenceElementByAsset()`

**PLY sequence:**
- `parsePlyFrame()`, `createGsplatAssetFromVertexElement()`
- `setupSequenceShader()`, `ensureSequenceSelectionTextureForAsset()`
- `createSequenceSelectionStateForAsset()`
- `getSequenceFrameRangeToPrefetch()`, `evictSequenceCacheIfNeeded()`
- `buildSequenceEntityForFrame()`, `prefetchSequenceAround()`
- `setSequenceOpacity()`, `swapSequenceActiveEntity()`
- `requestSequenceFrame()`, `applySequenceFrame()`
- `startSequencePlayback()`, `loadPlySequence()`

**SOG sequence:** `loadSogSequence()`

**PLY4 sequence:** `loadPly4Sequence()`

**SOG4 sequence:**
- `loadSog4Sequence()`, `applyParsedSog4Segment()`, `advanceSog4Sequence()`
- `getSog4SegmentIndex()`, `applySog4LocalTime()`
- `setSog4SequenceVisibleSegment()`, `attachSog4SequenceEntity()`
- `createSog4SegmentAsset()`, `prepareSog4SequenceSegment()`
- `clearActiveSog4SequenceRenderState()`, `updateSog4SequenceTime()`
- `activateSog4SequenceSegment()`

**State to extract:**
- `isSequenceMode`, `sequenceAssets`, `sequenceFrameIndex`
- `sequenceBands`, `sequenceApplyTimer`, `sequenceRequestId`
- `sequenceDesiredFrameIndex`, `sequencePrefetchCount`
- `sequencePreloadAllMaxFrames`, `sequenceSwapWarmupRafCount`
- `sequenceEntityPool`, `sequenceFrameToEntity`, `sequenceEntityToFrame`
- `sequencePrefetchInFlight`, `sequenceReservedEntities`
- `sequenceEntityBuildTarget`, `sequenceActiveEntity`
- `sequenceSwapRaf`, `sequencePendingSwapFrame`, `sequencePendingSwapEntity`

**New files:**
- `src/viewer/viewer-sequence-manager.ts` — common infrastructure
- `src/viewer/viewer-ply-sequence-manager.ts`
- `src/viewer/viewer-sog-sequence-manager.ts`
- `src/viewer/viewer-sog4-sequence-manager.ts`
- `src/viewer/viewer-ply4-sequence-manager.ts`

**Estimated reduction:** ~1,800 lines from `main.ts`

**Key considerations:**
- This is the largest and most complex subtask. The 4 sequence formats share common infrastructure (entity pooling, prefetching, AR lifecycle).
- SOG4 sequence logic is especially complex with segment activation/deactivation.
- Some sequence loaders call `finalizeGSplatLoad` — need clear cross-manager interface.

---

## Subtask 5: Extract Camera Presets, Face Tracking & Selection Tool Bridge

**Scope:** Camera preset UI/animation, face tracking, orbit mode, and selection tool integration helpers.

**Methods to extract:**

**Camera presets:**
- `renderPresets()` — ~164 lines
- `addTextToPreset()`, `openTextEdit()`, `closeTextEdit()`
- `syncTextOverlays()`, `updateTextVisibility()`
- `jumpToPreset()` — includes camera animation logic

**Face tracking & orbit:**
- Face tracking fields and update logic (currently in `onUpdate`)
- `syncOrbitFromCamera()`

**Selection tool bridge:**
- `updateSelectionUniform()`, `updateSelectionModeParams()`
- `captureSelectionUndoViewContext()`, `restoreSelectionUndoViewContext()`
- `getCurrentPositions()`, `getSplatSequenceSelectionElements()`

**Misc:**
- `onUpdate()` — main loop (retain in `Viewer`, but delegate sub-parts)
- `setHighQuality()`

**State to extract:**
- `cameraPresets`, `currentPresetIndex`
- `isCameraAnimating`, `wasPlayingBeforeAnim`
- `animTargetPos`, `animTargetPitch`, `animTargetYaw`
- `animStartPos`, `animStartPitch`, `animStartYaw`, `animProgress`
- `activeTextId`, `textOverlays`
- `isOrbitMode`, `orbitDistance`
- `pitch`, `yaw`
- `isFaceTracking`, `faceTrackingBasePos`, `faceTrackingBaseRight`
- `faceTrackingBaseUp`, `faceTrackingTarget`, `faceTrackingOffset`
- `faceTrackingScale`, `faceTrackingInvertX`, `faceTrackingInvertY`

**New files:**
- `src/viewer/viewer-preset-manager.ts`
- `src/viewer/viewer-face-tracking-manager.ts`

**Estimated reduction:** ~600 lines from `main.ts`

**Key considerations:**
- Camera preset animation uses `requestAnimationFrame` and modifies `camera` position/rotation directly.
- `onUpdate` is the main loop — it should stay in `Viewer` but delegate to managers (face tracking, 4DGS update, orbit updates).
- Selection tool bridge methods are public APIs called from `SelectionTool` — they need to remain accessible.

---

## Expected Final State

| File | Lines (approx) |
|------|---------------|
| `src/main.ts` | ~800–1,000 (constructor, property declarations, `onUpdate` loop, simple delegate methods) |
| `src/viewer/viewer-ui-manager.ts` | ~1,200 |
| `src/viewer/viewer-file-loader.ts` | ~700 |
| `src/viewer/viewer-4dgs-manager.ts` | ~800 |
| `src/viewer/viewer-sequence-*.ts` | ~1,800 (across 5 files) |
| `src/viewer/viewer-preset-manager.ts` | ~400 |
| `src/viewer/viewer-face-tracking-manager.ts` | ~200 |
| `src/viewer/viewer-export-manager.ts` | ~556 (existing) |
| `src/viewer/viewer-timeline-manager.ts` | ~174 (existing) |
| `src/viewer/viewer-scene-manager.ts` | ~136 (existing) |

**Total extracted:** ~4,200 lines from `main.ts`

---

## Execution Order Recommendation

1. **Subtask 5 first** (Camera Presets / Face Tracking) — smallest, low risk, builds confidence.
2. **Subtask 2** (File Loading) — well-isolated domain with clear inputs/outputs.
3. **Subtask 3** (4DGS Core) — builds on Subtask 2's `finalizeGSplatLoad` work.
4. **Subtask 4** (Sequence Playback) — largest; do it after file loading and 4DGS are stable.
5. **Subtask 1 last** (UI Event Binding) — touches everything; safest to do when other domains are already extracted.
