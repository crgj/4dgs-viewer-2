# Master PLY 格式说明 (.ply4)

Master PLY (文件后缀名: `.ply4`) 是一种扩展的 PLY 格式，用于存储带有时序动画的 3D Gaussian Splatting 数据。

## 元数据 (PLY Comments)

| 字段 | 说明 |
|------|------|
| `total_frames` | 总帧数 |
| `xyz_bank_keyframe_stride` | 位置关键帧间隔 |
| `rot_bank_keyframe_stride` | 旋转关键帧间隔 |
| `features_dc_bank_keyframe_stride` | DC特征关键帧间隔 |

## 顶点属性 (按顺序)

### 1. 基础位置 (Frame 0)

| 属性 | 类型 | 说明 |
|------|------|------|
| `x`, `y`, `z` | float32 | 第0帧的3D坐标 |
| `nx`, `ny`, `nz` | float32 | 法向量 (固定为0) |

### 2. 球谐系数 - DC分量

| 属性 | 类型 | 说明 |
|------|------|------|
| `f_dc_0`, `f_dc_1`, `f_dc_2` | float32 | 基础颜色DC分量 (3通道) |

### 3. 球谐系数 - 高阶分量

| 属性 | 类型 | 说明 |
|------|------|------|
| `f_rest_0` ... `f_rest_N` | float32 | 高阶球谐系数 (数量可变) |

### 4. 不透明度

| 属性 | 类型 | 说明 |
|------|------|------|
| `opacity` | float32 | 不透明度 (logit空间) |

### 5. 缩放

| 属性 | 类型 | 说明 |
|------|------|------|
| `scale_0`, `scale_1`, `scale_2` | float32 | 3D缩放因子 |

### 6. 生命周期参数

| 属性 | 类型 | 说明 |
|------|------|------|
| `lifetime_mu` | float32 | 生命周期中心时间 |
| `lifetime_w` | float32 | 生命周期半宽度 (有效范围: [mu-w, mu+w]) |

### 7. XYZ Bank (位置关键帧)

| 属性 | 类型 | 说明 |
|------|------|------|
| `xyz_bank_{k}_x` | float32 | 第k个关键帧的X坐标 |
| `xyz_bank_{k}_y` | float32 | 第k个关键帧的Y坐标 |
| `xyz_bank_{k}_z` | float32 | 第k个关键帧的Z坐标 |

其中 `k = 0, 1, ..., K_xyz-1`

### 8. ROT Bank (旋转关键帧) - 可选

| 属性 | 类型 | 说明 |
|------|------|------|
| `rot_bank_{k}_w` | float32 | 四元数 w 分量 (实部) |
| `rot_bank_{k}_x` | float32 | 四元数 x 分量 |
| `rot_bank_{k}_y` | float32 | 四元数 y 分量 |
| `rot_bank_{k}_z` | float32 | 四元数 z 分量 |

其中 `k = 0, 1, ..., K_rot-1`

> **注意**: 四元数采用 **WXYZ** 顺序存储，与 Gaussian Model 内部表示一致。单位四元数为 `(w=1, x=0, y=0, z=0)`。

### 9. DC Bank (颜色关键帧) - 可选

| 属性 | 类型 | 说明 |
|------|------|------|
| `f_dc_bank_{k}_0` | float32 | 第k帧的DC通道0 |
| `f_dc_bank_{k}_1` | float32 | 第k帧的DC通道1 |
| `f_dc_bank_{k}_2` | float32 | 第k帧的DC通道2 |

其中 `k = 0, 1, ..., K_dc-1`

## 数据排序

所有点按 **Morton Code** 排序（基于第0帧的xyz坐标），以提高空间局部性和压缩效率。

## 时间插值规则

渲染时，对于帧 `t`：

- **位置**: 在 `xyz_bank` 的相邻关键帧之间线性插值
- **旋转**: 在 `rot_bank` 的相邻关键帧之间使用 SLERP 插值
- **颜色DC**: 在 `f_dc_bank` 的相邻关键帧之间线性插值
- **不透明度**: 基础不透明度乘以生命周期门控函数：
  ```
  gate = sigmoid(k * (t - mu + w)) * sigmoid(k * (mu + w - t))
  opacity_t = sigmoid(opacity_logit) * gate
  ```
  其中 `k = 10.0` 为门控锐度参数
