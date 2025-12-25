# 4DGS Web Viewer (PlayCanvas + Vite)

一个基于 **PlayCanvas** 和 **TypeScript** 构建的高性能 **4D Gaussian Splatting (4DGS)** Web 查看器。该项目在标准 3D 高斯泼溅渲染的基础上进行了扩展，支持时间动态（随时间变化的不透明度/生命周期）。

## 🚀 功能特性

### 1. 4D 渲染 (时间动态)
- **时变不透明度**：支持渲染随时间淡入淡出的 4D 高斯体。
- **生命周期逻辑**：基于 `lifetime_mu`（中心时间）、`lifetime_w`（持续时间）和 `lifetime_k`（衰减敏锐度）实现双 Sigmoid 不透明度函数逻辑。
- **播放控制**：完整的时间轴控制，支持播放/暂停、拖动进度条、逐帧步进以及可变 FPS 速度。

### 2. 高级渲染引擎
- **自定义 Shader 注入**：向 PlayCanvas 的 splat 系统注入完全自定义的 GLSL 300 ES (WebGL 2) 顶点和片元着色器。
- **正确的椭球体渲染**：修正了 3D 协方差投影的数学实现，确保 splats 渲染为正确的椭球体（Ellipsoids），彻底解决了渲染成球体的问题。
- **SH (球谐函数) 支持**：全面支持实时的球谐光照计算（最高 3 阶）。

### 3. 专业级 UI/UX
- **交互式变换工具**：提供针对模型位置和旋转的精确数值控制。
- **拖拽加载**：支持直接拖拽 `.ply` 和 `.splat` 文件进行加载。
- **视角预设**：快速切换摄像机视角（顶视、前视、侧视）。
- **主题系统**：可自定义背景颜色和 UI 主题（亮色/暗色模式）。
- **性能统计**：实时监控 FPS 和帧生成时间。

### 4. 编辑与导出系统
- **高自由度选择**：提供笔刷 (Brush) 和矩形 (Rect) 两种选择模式，支持反选和清除。
- **删除功能**：可直观地删除场景中的噪点。
- **智能导出**：将清理后的场景导出为新的 PLY 文件，自动过滤删除点，并完整保留所有生命周期和 SH 属性。

### 5. 技术改进
- **状态持久化**：自动缓存每个模型文件的位移/旋转参数。
- **网格与坐标轴**：可视化的空间参考辅助。
- **GLSL 300 ES**：完全兼容现代 WebGL 2.0 着色器标准。
- **纹理打包**：将生命周期参数优化打包进浮点纹理 (`RGBA32F`)，以实现高效的 GPU 访问。

---

## 🛠 技术栈

- **核心引擎**: [PlayCanvas Engine](https://github.com/playcanvas/engine) (v1.77+)
- **构建系统**: [Vite](https://vitejs.dev/)
- **开发语言**: TypeScript
- **样式方案**: Tailwind CSS
- **UI 组件**: 原生 HTML/CSS 配合 Lucide Icons 图标库

---

## 🔧 修改内容与实现细节

与标准的 PlayCanvas 示例或基础 3DGS 查看器相比，本项目包含以下重大修改：

### 1. 着色器架构 (`src/shaders/gsplat-shader.ts`)
我们使用自定义实现替换了通过 PlayCanvas 生成的默认点渲染逻辑：
- **修正协方差**：修正了 `calcV1V2` 中的数学计算，正确地将 3D 协方差投影到 2D 屏幕空间，实现了 splats 的正确"压扁"和旋转。
- **时间注入**：添加了 `uniform float uTime` 和 `uniform sampler2D lifetimeTexture`。
- **不透明度计算**：
  ```glsl
  // 顶点着色器逻辑
  float getLifetimeOpacityTexture(ivec2 uv, float t) {
      // 从纹理中获取 mu, w, k
      // 计算 Sigmoid 交集:
      // sigmoid(k * (t - (mu - w))) * sigmoid(-k * (t - (mu + w)))
  }
  ```

### 2. 数据解析与注入 (`src/main.ts`)
- **组合解析**：自定义 PLY 解析器，在读取标准 3D 属性（位置、缩放、旋转、颜色）的同时，读取 4D 属性（`lifetime_mu`, `lifetime_w`, `lifetime_k`）。
- **纹理生成**：自动生成第二个 Float32 纹理来存储生命周期数据，确保与 splat 顺序 1:1 映射。

### 3. 播放系统
- 实现了一个精确的帧循环系统，同步 UI 滑块、内部时间状态和 GPU 着色器 uniform `uTime`。

---

## 📖 使用指南

### 安装
```bash
# 安装依赖
npm install
```

### 开发
```bash
# 启动本地开发服务器
npm run dev
```

### 加载模型
1. 打开 Web 界面（默认地址：`http://localhost:5173`）。
2. 将 **4D PLY** 文件（包含 `lifetime_*` 属性）拖入窗口。
   - *注意：标准的 3D PLY 文件也可以加载，但将显示为静态。*
3. 使用底部的播放条来拖动查看动画。

---

## 🧠 原理 (4DGS 可视化)

### 3D Gaussian Splatting
标准 3DGS 将场景表示为 3D 高斯云。每个高斯体包含：
- $\mu$: 位置 (XYZ)
- $\Sigma$: 协方差 (缩放 + 旋转)
- $c$: 颜色 (球谐函数)
- $\alpha$: 不透明度

### 4D 时间扩展
为了在不移动点本身的情况下表示运动/变化，我们随时间 ($t$) 调制 **不透明度 ($\alpha$)**。
每个点都分配了一个时间窗口，由以下参数定义：
- **$\mu_t$ (`lifetime_mu`)**: 点可见的中心时刻。
- **$\delta_t$ (`lifetime_w`)**: 可见时长的一半。
- **$k$ (`lifetime_k`)**: 淡入淡出的陡峭程度。

着色器为每个像素计算一个乘数 $M(t) \in [0, 1]$：
$$ M(t) = \sigma(k \cdot (t - (\mu_t - \delta_t))) \cdot \sigma(-k \cdot (t - (\mu_t + \delta_t))) $$
最终渲染不透明度 = $\alpha_{base} \cdot M(t)$。
