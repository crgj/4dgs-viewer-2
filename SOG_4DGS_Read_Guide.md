# 4DGS SOG & BIN 数据读取与重建指南

本指南详细说明了如何解析 4DGS 压缩格式（`.sog` 和 `.bin`）并恢复出完整的时序 PLY 数据。该格式旨在通过 WebP 纹理和 DPCM 差分编码实现高压缩比的同时保持快速渲染能力。

---

## 1. 文件概述

重建一帧 4DGS 数据通常需要以下两个核心文件：

1.  **`compressed.sog` (Static Object Group)**:
    - **格式**: ZIP 压缩包，内部包含 WebP 纹理和 `meta.json`。
    - **内容**: 存储所有高斯的**静态属性**（颜色、縮放、基础透明度、SH 系数）以及**时间门控参数**（mu, w）。
2.  **`data.bin`**:
    - **格式**: 自定义二进制文件（Zlib 压缩）。
    - **内容**: 存储所有高斯的**动态轨迹**（XYZ 位置和 Rotation 旋转）。使用关键帧 + DPCM 编码。

---

## 2. SOG 格式详解

`.sog` 文件是一个 ZIP 包，其核心逻辑是将浮点型属性映射到 WebP 图像的一个或多个 8-bit 通道中。

### 2.1 `meta.json`
包含了重建所需的元数据：
- `count`: 高斯点总数。
- `mins`, `maxs`: 用于归一化数据的极值。
- `codebook`: 用于索引压缩的码本（如 Scale 和 Color）。
- `files`: 每个属性对应的 WebP 文件名。

### 2.2 核心属性重建公式

#### 坐标 (Means)
坐标经过 Log Transform 处理以增强低频精度，并存储为 16-bit（U+L 两个纹理）：
```python
# U 对应 Upper 8-bit, L 对应 Lower 8-bit
val_16bit = (U << 8) | L
# 归一化恢复
lx = val_16bit / 65535.0 * (max - min) + min
# 逆 Log 变换
x = sign(lx) * (exp(abs(lx)) - 1)
```

#### 四元数 (Quaternions)
使用 `Smallest Three` 方法，只存储 4 个分量中绝对值最小的 3 个，第 4 个分量的索引存储在 Alpha 通道的低位（252+k）：
```python
# 从 [0, 255] 恢复到 [-1/sqrt(2), 1/sqrt(2)]
q_scaled = (pixel_val / 255.0 * 2.0 - 1.0) / sqrt(2)
# 重建丢失的分量
missing = sqrt(1.0 - (q0^2 + q1^2 + q2^2))
```

#### 透明度 (Opacity)
存储为 `sigmoid` 激活后的值：
```python
opacity = logit(pixel_alpha / 255.0)
```

---

## 3. Data.bin 轨迹格式

`data.bin` 存储随时间变化的轨迹坐标 $XYZ(t)$ 和旋转 $Rot(t)$。

### 3.1 关键帧采样
轨迹按 `stride` 进行采样。例如 `T=300`, `stride=10` 则存储 30 帧关键帧。

### 3.2 DPCM 编码
关键帧之间存储的是增量（Residuals），并根据精度需求选择 `int8`, `int16` 或 `float32` 存储。
```python
# 重建轨迹点
traj[t] = anchor + cumsum(residuals[:t]) / scale
```

---

## 4. 4D 重建算法 (Reconstruction)

要获得时间 $t$ 的 PLY 帧，需要执行以下步骤：

### 步骤 A：时空插值
根据 `data.bin` 中的关键帧，对 $t$ 时刻的 XYZ 和 Rotation 进行插值：
- **XYZ**: 线性插值（Linear Interpolation）。
- **Rotation**: 球面线性插值（SLERP）。

### 步骤 B：时间门控 (Temporal Gating)
4DGS 使用 `mu`（中心时间）和 `w`（半径/半宽）来控制高斯点的存活周期。
计算门控因子 `gate`：
$$gate(t) = \sigma(10.0 \cdot (t - (mu - w))) \cdot \sigma(10.0 \cdot ((mu + w) - t))$$
其中 $\sigma$ 是 `sigmoid` 函数。

### 步骤 C：最终透明度
$$Opacity_{final}(t) = Opacity_{static} \cdot gate(t)$$

### 步骤 D：过滤与导出
只保留 $Opacity_{final}(t) > 0.01$ 的点，将其余静态属性（Color, Scale, SH）组合成 PLY 文件导出。

---

## 5. 快速使用脚本

本项目提供了 Python 脚本供参考或直接集成：

1.  **从 SOG 恢复 Static PLY**:
    ```bash
    python sog_to_ply.py compressed.sog static.ply
    ```
2.  **执行完整 4D 重建**:
    将 `static.ply` 和 `data.bin` 放在同一目录下，运行：
    ```bash
    python post_save.py --mode reconstruct --input_dir [YOUR_DIR]
    ```

---
> [!NOTE]
> #WDD 2026-01-15 生成 4dgs sog 文件读取指导文档
