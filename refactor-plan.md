# 代码重构计划

## 目标
- 将过长文件整理为更多独立文件
- 按照面向对象原则进行模块拆分
- 确保现有功能不受影响

---

## 子任务 1：修复当前编译错误并完成 Export 模块拆分

**状态**：进行中（已提取但存在编译错误）

**问题**：
- `src/main.ts(5318)` 存在多余的 `}` 导致 `TS1128: Declaration or statement expected`
- `viewer-export-manager.ts` 中部分参数类型推断为 `any`

**工作内容**：
1. 修复 main.ts 尾部多余的 `}`
2. 为 viewer-export-manager.ts 中的 `.map(c => ...)` 参数补充显式类型注解
3. 运行 `tsc --noEmit` 验证编译通过
4. 确认 `window.exportPlySequence` 等全局绑定仍正常工作

**涉及文件**：
- `src/main.ts`
- `src/viewer/viewer-export-manager.ts`

---

## 子任务 2：提取 Timeline 与 Playback 管理模块

**目标文件**：`src/viewer/viewer-timeline-manager.ts`

**需提取的方法/属性**（约 200-300 行）：
- `currentTime`, `playbackTime`, `isPlaying`, `loopEnabled`, `loopStartFrame`, `loopEndFrame`
- `togglePlay()`, `stepFrame()`, `seekToFrame()`, `jumpToPreset()`
- `updateTimelineTicks()`, `syncTimelineUI()`, `renderTimelineDecorations()`
- `getTimelineTotalFrames()`, `getTimelineMaxFrame()`, `clampTimelineFrame()`
- `normalizeLoopRange()`, `resetTimelineTools()`

**委托方式**：
- 在 `Viewer` 类中保留方法签名，委托给 `this.timelineManager.xxx()`

**涉及文件**：
- `src/viewer/viewer-timeline-manager.ts`（新建）
- `src/main.ts`

---

## 子任务 3：提取 Camera 与 Scene 管理模块

**目标文件**：`src/viewer/viewer-camera-manager.ts`

**需提取的方法/属性**（约 300-400 行）：
- `pitch`, `yaw`, `orbitDistance`, `isOrbitMode`
- `cameraPresets`, `isCameraAnimating`, `currentPresetIndex`
- `resetCamera()`, `orbitCameraUpdates()`, `jumpToPreset()`
- `initGrid()`, `initAxes()`, `setupScene()`
- `renderPresets()`, `addTextToPreset()`, `syncTextOverlays()`
- `updateTextVisibility()`, `toggleUIVisibility()`, `isUIHidden()`
- `skyboxes`, `selectedSkyboxName`, `initSkyboxSelector()`, `setSkybox()`

**委托方式**：
- `Viewer` 类持有 `private cameraManager: ViewerCameraManager`
- 保留公开接口，内部委托

**涉及文件**：
- `src/viewer/viewer-camera-manager.ts`（新建）
- `src/main.ts`

---

## 子任务 4：提取序列播放管理模块（Static + SOG4 + PLY4）

**目标文件**：
- `src/viewer/viewer-sequence-manager.ts`（静态帧序列）
- `src/viewer/viewer-sog4-manager.ts`（SOG4 temporal 序列）

**需提取的方法**（约 800-1000 行）：
- 静态序列：`loadPlySequence()`, `startSequencePlayback()`, `requestSequenceFrame()`, `applySequenceFrame()`, `prefetchSequenceAround()`, `buildSequenceEntityForFrame()`, `swapSequenceActiveEntity()` 等
- SOG4 序列：`loadSog4Sequence()`, `advanceSog4Sequence()`, `applySog4LocalTime()`, `updateSog4SequenceTime()`, `activateSog4SequenceSegment()`, `prepareSog4SequenceSegment()` 等
- PLY4 序列：`loadPly4Sequence()` 及相关辅助方法

**注意事项**：
- 序列模块与 Timeline 模块有交叉引用（如 `seekToFrame` 会触发序列切换）
- 需要保持 `Viewer` 中 `onUpdate()` 对序列更新的调用链不变

**涉及文件**：
- `src/viewer/viewer-sequence-manager.ts`（新建）
- `src/viewer/viewer-sog4-manager.ts`（新建）
- `src/main.ts`

---

## 子任务 5：拆分 selection-tool.ts（1891 行）

**目标文件**：
- `src/ui/selection-tool-icons.ts` — SVG 图标常量（约 30 行）
- `src/ui/selection-tool-help.ts` — HelpModal 相关逻辑（约 120 行）
- `src/ui/selection-tool-algorithms.ts` — 选择算法（brush/rect/poly/ellipse/all-time，约 800 行）
- `src/ui/selection-tool.ts` — 核心类保留 UI 绑定、事件监听、undo/redo（约 900 行）

**拆分策略**：
- 图标常量：纯数据，零依赖，直接提取为独立导出
- HelpModal：`createHelpModal()`, `toggleHelpModal()`, `hideHelpModal()` 提取为独立函数或小型类
- 选择算法：`performBrush()`, `performRect()`, `performPolygon()`, `performBrushEllipse()`, `selectAllTimePoints()` 等提取为独立模块，接收 `SelectionTool` 实例作为参数
- 核心类保留：工具状态管理、鼠标事件监听、undo/redo 栈、`setupUI()`

**涉及文件**：
- `src/ui/selection-tool-icons.ts`（新建）
- `src/ui/selection-tool-help.ts`（新建）
- `src/ui/selection-tool-algorithms.ts`（新建）
- `src/ui/selection-tool.ts`（大幅精简）

---

## 验收标准

每项子任务完成后必须：
1. `npx tsc --noEmit` 编译通过，无类型错误
2. `npx vite build` 构建成功
3. 现有功能不受影响（不改变任何外部调用接口）
4. 被拆分的原文件行数显著减少

## 当前已完成的准备工作

- [x] 分析项目结构和构建系统
- [x] 识别无用文件并移动到 `back/` 目录
- [x] 删除空目录 `src/ui/components/`
- [x] 提取类型定义到 `src/types/viewer.ts`
- [x] 创建 `src/viewer/viewer-export-manager.ts`（待修复编译错误）
