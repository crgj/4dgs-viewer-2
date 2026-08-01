# 把单文件原始 PLY/SOG 包装成伪 4D（2 关键帧 + 3 帧时长）

## 目标

单文件原始 `.ply`/`.sog` 导入后，不走"无法编辑的序列路径"，而是**包装成与真实 `.ply4` 完全同构的 4D 数据**：
- 把每个 splat 的**位置 / 旋转 / 颜色**各复制成 **2 个相同关键帧**
- `frames = 3`（时间轴显示 3 帧）
- 走 `finalizeGSplatLoad` 4D 渲染+编辑流程

由于两帧数据相同，渲染表现为静止；但因 `is4DGS=true`，**全部 4D 编辑工具可用**（用户可在时间轴不同帧上编辑出动态效果）。同时颜色走 `finalizeGSplatLoad` 的标准路径（与 `.ply4` 一致），**解决序列路径的黑屏问题**。

## 数据流依据（已逐行核实）

- `finalizeGSplatLoad`（main.ts:5142）对三类 trajectory 独立处理，任一存在即启用对应 shader define。
- 一旦 `parsed.trajectory` 非空 → `is4DGS=true` + `USE_TRAJECTORY`（main.ts:5268-5660）；**此时 shader 用 trajectory 关键帧，静态 x/y/z 被忽略**。故必须把静态值复制进 trajectory。
- 字节布局（splat-major）：
  - **xyz**：`trajectory[(splat*K + kf) * 3 + {0,1,2}]`（main.ts:5293-5305）
  - **rot**：`rotTrajectory[(splat*K + kf) * 4 + {0,1,2,3}]`，**存 WXYZ**（默认 `rotationSemantic:'wxyz'`，main.ts:5359-5363 把 wxyz 转成 xyzw 写入纹理）
  - **dc**：`dcTrajectory[(splat*K + kf) * 3 + {0,1,2}]`，**存原始 SH0**（纹理构建时做 `0.5+SH*SH_C0`，main.ts:5418-5423）
- `duration` 由 `parsed.frames` 决定（main.ts:5143-5157）；K=2、stride=1 → keyframeMax=2 ≤ 3，时长稳定为 3。

## 实施步骤

### 步骤 1：新增包装函数 `wrapParsedAsFake4D`

在 `main.ts` 新增一个私有方法，把单帧 `parsed`（PLY 或 SOGv2 解析结果）转换成伪 4D 结构：

```ts
private wrapParsedAsFake4D(parsed: any): any
```

逻辑：
- 读 `count = parsed.count`，`K = 2`
- **xyz trajectory**：分配 `Float32Array(count * K * 3)`；对每个 splat，把 `x[i],y[i],z[i]` 复制到两个关键帧（kf0 和 kf1 内容相同）
- **rot trajectory**：分配 `Float32Array(count * K * 4)`；把 `rot_0,rot_1,rot_2,rot_3`（即 w,x,y,z）复制到两个关键帧
- **dc trajectory**：分配 `Float32Array(count * K * 3)`；把 `f_dc_0,f_dc_1,f_dc_2` 复制到两个关键帧
- 设置：
  - `parsed.trajectory / keyframes=2 / xyzStride=1`
  - `parsed.rotTrajectory / rotKeyframes=2 / rotStride=1 / rotationSemantic='wxyz'`
  - `parsed.dcTrajectory / dcKeyframes=2 / dcStride=1`
  - `parsed.frames = 3`
  - `parsed.is4DGS = true`
- 返回修改后的 `parsed`（保持 `plyData`/`count`/`opacity`/`scale_*`/`f_rest_*`/`bands` 等静态字段不变）

**降级容错**：若 PLY 缺某类属性（如无 rot 或无 f_dc），则对应 trajectory 留空不设置（走静态路径），不阻断。

### 步骤 2：单文件分发改为走 `loadFile`（4D 路径）

当前 `handleDroppedFiles` 把单文件 `.ply`/`.sog` 路由到 `loadPlySequence`/`loadSogSequence`（序列路径）。改为：

- **单文件 `.ply`** → 用 `PLY4Loader` 解析（它对标准 PLY 已兼容：缺失字段填 0），然后 `wrapParsedAsFake4D` 包装，再走 `loadFile` 的 `finalizeGSplatLoad`。

  但 `PLY4Loader` 是为 4D header 设计的，标准 PLY 经它解析后 `trajectory=null`（无 `xyz_bank_*` 属性），正好被包装函数补上。需验证 `PLY4Loader` 对标准 PLY 的字段提取（f_dc/f_rest/opacity/scale/rot）是否完整——若不完整则改用通用解析后再构造 plyData。

  **决策**：为最稳妥，单文件 `.ply` 仍用通用解析（复用 `parsePlyFrame` 的稳健 header 扫描逻辑），但产出的 `SequenceFrameData` 转成 `finalizeGSplatLoad` 期望的 `parsed` 结构（含 `plyData.elements`），再包装。**具体做法**：抽取一个 `parsedFromSequenceFrame(frame, fileName)` 辅助函数。

- **单文件 `.sog`** → 按 `SOGv2Loader.detectVersion` 分流：v2 走 `SOGv2Loader.parse`（已实现），再包装；其他走原 `SOG4Loader`。

### 步骤 3：在 `loadFile` 内对包装后的数据应用 4D finalize

`loadFile`（viewer-file-loader.ts:162）解析得到 `parsed` 后，在调用 `finalizeGSplatLoad` 前，若识别为"原始单文件被包装"则确保 `parsed` 已含 trajectory 字段。

最干净的实现：**在 `main.ts` 暴露一个 `loadSingleRawAs4D(file)` 方法**，内部完成"解析 → 包装 → 复用 loadFile 的 4D finalize 逻辑"。`handleDroppedFiles` 的单文件 `.ply`/`.sog` 分支改为调用它。

### 步骤 4：回退序列路径的多文件判断

`handleDroppedFiles` 的多文件 `.ply`/`.sog`（序列）仍走 `loadPlySequence`/`loadSogSequence`（保持原有行为），只改单文件分支。

## 关键改动文件

| 文件 | 改动 |
|------|------|
| `src/main.ts` | 新增 `wrapParsedAsFake4D`；新增单文件原始格式 → 4D 的加载入口；复用 `finalizeGSplatLoad` |
| `src/viewer/viewer-file-loader.ts` | 单文件 `.ply`/`.sog` 分支改路由到新的 4D 加载入口（多文件序列路径不变） |

## 不改动

- ❌ `PLY4Loader`/`SOG4Loader`/`SOGv2Loader`/`TrueSplatsLoader` 本身
- ❌ shader / 渲染层（4D 渲染已验证可正常工作，与 `.ply4` 同构）
- ❌ 多文件序列加载（`loadPlySequence`/`loadSogSequence`）逻辑

## 验证方法

1. **单文件 PLY**：拖入标准 3DGS PLY → 应正确显色（非黑屏），时间轴显示 3 帧，拖动时间轴画面静止（两帧相同），4D 编辑工具可用。
2. **单文件官方 SOG v2**：拖入 → 同上。
3. **回归**：单文件 `.ply4`/`.sog4`/`.truesplats`（4D）行为不变；多文件 `.ply`/`.sog` 序列行为不变。
4. **编辑验证**：在帧 0 删除/移动一个点，切到帧 1 该点应保持原状（两帧独立可编辑）。

## 风险

- **内存**：trajectory 是原始数据的 2 倍（位置+旋转+颜色各 2 关键帧）。对 10 万点的 PLY 约 +5MB，可接受；超大数据集需关注（已有 10GB 预算护栏）。
- **PLY4Loader 兼容性**：若直接用 `PLY4Loader` 解析标准 PLY，需确认它对无 4D header 的 PLY 提取 f_dc/f_rest 完整。计划中采用"通用解析 + 构造 parsed"规避此风险。
- **opacity 语义**：标准 PLY 的 opacity 是 logit（与 `.ply4` 一致），`finalizeGSplatLoad` 走静态 splatColor 打包会正确 sigmoid。包装不涉及 opacity trajectory，故无双重 sigmoid 风险。