
To 所有 AI coder 撰写日志的时候，请留下你的名字-时间 和修改原因




# 更新日志

本文档按时间倒序记录 TrueSplats Viewer 的主要功能更新、交互调整和性能优化。

## 2026-06-14

### Render ALL 隐藏点语义修正
- `Render ALL` 中红色点改为只表示“真实存在，但所有帧 normal 渲染都不可见”的点。
- 当前帧暂时不可见、但其他帧会正常出现的生命周期点不再标红。
- `Delete Hidden` 只删除全时段 normal 都不可见的点，不再删除当前帧不可见的正常动态点。
- 全时段不可见判定加入缓存，避免 Render ALL 刷新时重复扫描生命周期和 opacity。

### Rings 选择性能优化
- `Rings` 命中模式增加当前视角 footprint 缓存，避免笔刷拖动时反复投影并重算所有高斯边界。
- 增加屏幕网格索引，笔刷和矩形选择只检查选择区域附近的候选高斯点。
- 缓存会在切换工具、切换命中模式、开始新选择、相机/模型/时间/画布尺寸变化时自动失效。
- 保持 `Centers / Rings` 的选择语义不变：
  - `Centers`：按高斯中心投影命中。
  - `Rings`：按当前屏幕可见 Gaussian footprint / 轮廓命中。

### 功能演示视频
- 新增中文功能演示视频：`artifacts/feature-demo-2026-06-13/truesplats-new-features-cn.mp4`。
- 演示内容覆盖语言切换、样例加载、信息面板、Render ALL、Delete Hidden、Centers / Rings、All-Time、Help 和批处理页。
- 新增临时录制与合成脚本：
  - `scripts/record-feature-demo.mjs`
  - `scripts/build-feature-demo-video.py`

## 2026-06-13

### UI 中英文切换
- 顶部品牌栏新增语言切换按钮，可在 English / 中文之间切换。
- 主界面、左侧选择工具、智能面板、Help 弹窗和批量转换页接入统一 i18n 文案系统。
- 主查看器与 `batch-convert.html` 共用浏览器 `localStorage` 中的语言状态。
- UI / Help 文案集中维护在 `src/i18n.ts`，新增界面文案应优先通过 `data-i18n` 或 `t(key)` 引用。

### 左侧选择工具重排
- 左侧工具区改为 `Smart / Edit` 两个面板级 tab。
- `Smart` 面板集中自动对齐、统计和圆柱选择。
- `Edit` 面板集中普通选择、反选、清空、删除和 `Delete Hidden`。
- `Current / All-Time` 合并为选择范围切换，不再重复显示两套工具按钮。
- 顶部栏右侧放置 Undo / Redo / Help，减少左侧面板高度。
- Render ALL 模式下自动切到 `Edit`，普通选择工具禁用，仅保留 `Delete Hidden`。

### Centers / Rings 命中模式
- 选择命中方式改为 `Centers / Rings`，对齐 SuperSplat 的中心点选择与轮廓 footprint 选择语义。
- `Centers`：只判断高斯中心点投影是否落入笔刷、矩形或多边形区域。
- `Rings`：按当前屏幕可见 Gaussian footprint / 轮廓与选择区域相交判断。
- Help 和 README 同步更新命中方式说明。

### 右侧信息面板
- 右侧切换面板新增 `Info` tab，使用独立 `ViewerFileInfoPanel` UI 类渲染当前文件/序列信息。
- 信息面板显示文件名、大小、格式、来源模式、高斯点数量、帧数、关键帧/stride、生命周期统计、包围盒和主要数组内存占用。
- 信息面板顶部用指标卡和条形图可视化当前帧位置、当前帧实际渲染高斯点数、隐藏点数、关键帧和内存占用。
- 大型数组按采样统计，避免加载超大点云后切换面板造成 UI 卡顿。
- 简化控制条同步显示 `MEM / GPU` 摘要；悬停可查看 JS Heap、模型 CPU 数据、WebGL 显存、纹理估算和 GPU 信息。

### Render ALL 调试点云
- `RENDER` 面板新增 `ALL` 模式，使用独立 `DebugAllGaussianPoints` entity 绘制点云，不改主 GSplat shader。
- `ALL` 模式显示当前激活模型/段中所有未删除点，忽略当前帧生命周期和 opacity，便于检查数据中真实存在但所有帧 normal 都不可见的点。
- 颜色约定：
  - 青色：normal 模式下至少有一帧可见的点。
  - 红色：真实存在但所有帧 normal 都不可见且尚未删除的点。
  - 已删除点：不绘制。
- `Delete Hidden` 会先弹出确认，再将真实存在但所有帧 normal 都不可见且尚未删除的点写入 deleted 标记。
- 删除完成后 `ALL` 点云立即刷新，被删除点不再显示。

### 右侧面板图标与布局
- 右侧 `COMMON / PRESETS / INFO / SPECIAL` 切换改为更清晰的面板样式。
- 视图按钮图标更新为更直观的 Top / Front / Side 方向图示。
- `COMMON / PRESETS / SPECIAL` 的切换样式与左侧 `Smart / Edit` 形成统一层级。

## 2026-05-16

### Lazy 分段缓冲模式
- 当 PLY4 序列总体积超过 **4.0 GB** 时，自动切换为 **Lazy Segmented Buffering** 模式。
- **Full 模式**（小于 4GB）：全序列一次性加载到 GPU，所有手工选择工具完全可用。
- **Lazy 模式**（大于等于 4GB）：
  - 仅读取每段 header 建立完整时间轴。
  - 当前显示段才会解码并上传 GPU。
  - 手工区域/笔刷工具自动隐藏，保留反选、清空、删除、撤销和重做。
  - 选择和删除状态按段保存，切换段时自动恢复。
  - 播放推进到未缓存段时自动暂停并显示读取进度，加载完成后自动恢复。
- UI 右上角显示当前读取模式：`PLY4 FULL` 或 `PLY4 LAZY`。

### Playbar 与 Timeline 多段序列指示
- 多段 PLY4 / SOG4 序列播放时，Playbar 显示当前段编号、文件名、段内帧和加载模式。
- Timeline 轨道上方用段标记显示每段起始边界。
- 当前播放段高亮为绿色，未激活段使用青色标记。
- 单文件模式下段标记自动隐藏。

### 智能对齐
- 新增左侧 Smart Selection Panel，集成自动地面检测与场景对齐。
- 使用 RANSAC + PCA 估计地面平面，并结合动静点聚类识别主体。
- 自动计算旋转和平移，将地面法线对齐到世界 Y 轴，并将主体中心对齐到原点。
- 算法优先在 Web Worker 中运行，失败时降级到主线程执行。

### 圆柱选择
- 对齐完成后自动生成可调圆柱区域，并以网格线框显示。
- 支持调整半径、高度、中心 X/Z 和地面余量。
- `Select In Cylinder` 执行全时段选择：
  - 扫描所有 PLY4 序列段。
  - 支持 4D 轨迹插值和生命周期过滤。
  - 当前帧可见点写入高亮通道，全时段命中点写入 all-time 通道。

### 选择系统增强
- all-time 选择通道与当前帧高亮通道分离。
- 多段序列中每段独立保存 `selectionData`、`allTimeSelectionData` 和 `selectionTexture`。
- Undo / Redo 支持跨段状态快照，恢复时同步还原段索引和时间上下文。

## 2026-04-19

### 批量转换工具
- 新增独立 `batch-convert.html` 批量转换页面。
- 支持拖拽上传多个 `.ply4` 文件或整个文件夹。
- 队列显示 Prepare / Load PLY4 / Encode SOG4 / Download 四阶段进度。
- 支持导出为 SOG4 或 PLY 序列。
- 多个文件导出 PLY 序列时，会按第一个文件名连续编号并打包为 zip。
- 任务失败后可单独重试。

### WebP 无损纹理编码
- 引入 `@jsquash/webp` 编码器，SOG4 纹理数据改用无损 WebP 压缩。
- 相比原有 canvas blob 导出，显著减小 SOG4 文件体积。
- 编码器同时应用于标准模式和快速模式。

### 模型变换系统重构
- 新增 `src/utils/model-transform.ts`，统一模型变换类型与读写逻辑。
- SOG4 编码器将 `model_pos`、`model_rot` 和 `model_scale` 写入 `meta.json`。
- 修复 `.sog4` 保存后再次读取时模型整体变换未正确恢复的问题。

### 全时段选择工具
- 左侧选择面板顶部提供 `Current / All-Time` 范围切换。
- 切到 `All-Time` 后，笔刷、矩形和多边形会以全时间范围执行选择。
- 反选操作支持全时段范围。
- 笔刷路径采用简化算法，优化大规模全时段选择性能。

## 2026-04-11

### UI 整理
- 左上角旧帮助入口移除。
- tooltip 文案统一。
- 右侧面板整理为 `COMMON / PRESETS / SPECIAL / MONITOR`。
- 监控浮窗合并到右侧 Monitor 面板。
- 悬浮性能告警 toast 移除，告警仅在 Monitor 面板中显示。

### 时间线增强
- 新增逐帧前进和后退按钮。
- 支持键盘左右方向键逐帧步进。
- 新增 `A / B / Loop` 区间循环。
- 去掉事件点与关键帧标签显示，保留更简洁的时间线。

### 导出与读取修复
- 默认 `.sog4` 导出保持原始压缩格式。
- 修复 `.sog4` 保存后再次读取时模型整体变换和相机预设未正确恢复的问题。
- 修复 `.sog4` 保存后总帧数异常变长的问题。
- 优化 `SHN palette` 阶段以降低标准压缩导出耗时。
