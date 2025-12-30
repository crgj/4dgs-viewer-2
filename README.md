# 4DGS Web Viewer (PlayCanvas + Vite)

一个基于 **PlayCanvas** 和 **TypeScript** 构建的高性能 **4D Gaussian Splatting (4DGS)** Web 查看器。该项目在标准 3D 高斯泼溅渲染的基础上进行了扩展，支持时间动态（随时间变化的不透明度/生命周期）。

---

## 🚀 功能特性

### 1. 4D 渲染 (时间动态)
- **时变不透明度**：支持渲染随时间淡入淡出的 4D 高斯体。
- **生命周期逻辑**：基于 `lifetime_mu`（中心时间）、`lifetime_w`（持续时间）和 `lifetime_k`（衰减敏锐度）实现双 Sigmoid 不透明度函数逻辑。
- **播放控制**：完整的时间轴控制，支持播放/暂停、拖放进度条、逐帧步进以及可变 FPS 速度。

### 2. 高级渲染引擎
- **自定义 Shader 注入**：向 PlayCanvas 的 splat 系统注入完全自定义的 GLSL 300 ES (WebGL 2) 顶点和片元着色器。
- **正确的椭球体渲染**：修正了 3D 协方差投影的数学实现，确保 splats 渲染为正确的椭球体 (Ellipsoids)，解决了经典渲染中可能出现的形状畸变。
- **SH (球谐函数) 支持**：全面支持实时的球谐光照计算（最高 3 阶）。

### 3. 压缩与传输优化
- **.gszip 格式支持**：引入高效的点云压缩格式，大幅降低文件体积（通常可压缩 5-10 倍）。
- **浏览器端解压管线**：内置全自动解压流程，包含 `JSZip` 归档提取、WASM HEVC 解码及属性重建。
- **HEVC 解码集成**：集成 `libde265.js` 解码器，利用浏览器 WebAssembly 高效处理高度压缩的属性位流。

### 4. 编辑与导出系统
- **选择与清理**：提供 **笔刷 (Brush)** 和 **矩形 (Rect)** 选择模式，支持实时删除噪点和无效点。
- **智能导出**：支持将清理后的场景导出为新的标准 PLY 文件，自动过滤已删除的点。

### 5. 专业级 UI/UX
- **实时变换工具**：提供针对模型位置、旋转的精确数值控制，支持鼠标滚轴拖动数值（Scrubbing）。
- **多格式加载**：支持拖拽加载 `.ply`、`.splat`、`.zip` 以及专有的 `.gszip` 文件。
- **可视化进度反馈**：细化加载阶段（提取 -> 解码 -> 重建 -> 变换），并提供动态进度条。
- **主题切换**：内置深色模式（Matte Charcoal）与浅色模式，适配不同审美需求。

---

## 📂 项目结构

```text
4dgs-viewer-2/
├── docs/               # 自动生成的静态发布目录 (GitHub Pages 根目录)
├── public/              # 静态资源 (打包后原样复制)
│   ├── HM/             # Linux 预编译解码工具 (离线/工具链使用)
│   ├── gszip/          # 示例 .gszip 模型文件
│   └── libde265.js     # WASM HEVC 解码库
├── src/
│   ├── shaders/        # 自定义 GLSL 着色器代码
│   ├── ui/             # UI 组件与交互逻辑 (SelectionTool 等)
│   ├── utils/          # 核心工具 (解压管线、Node 脚本)
│   └── main.ts         # 应用程序入口，控制 PlayCanvas 渲染循环
├── vite.config.ts      # Vite 构建配置
└── tsconfig.json       # TypeScript 配置
```

---

## 🛠 开发与构建

### 安装依赖
```bash
npm install
```

### 本地开发
```bash
npm run dev
```

### 打包发布 (GitHub Pages)
编译后的文件将生成在 `docs/` 目录中，可直接上传至 GitHub 并将 Pages 根目录设置为 `/docs`。
```bash
npm run build
```

---

## 🔧 工具链 (CLI)

项目在 `src/utils/unzip_ply.ts` 提供了一个 Node.js 脚本，用于在本地环境进行批量解压和调试。
使用方法：
```bash
npx tsx src/utils/unzip_ply.ts <gszip_file_path> --out <output_dir>
```
*该脚本会自动调用 `public/HM/TAppDecoderStatic` 进行 HEVC 位流还原。*

---

## 🧠 技术原理

### 4D 生命周期函数
为了在不增加冗余几何体的情况下实现动画，我们随时间 $t$ 调制点的不透明度 $\alpha$。
着色器为每个高斯点计算一个乘数 $M(t) \in [0, 1]$：
$$ M(t) = \sigma(k \cdot (t - (\mu_t - \delta_t))) \cdot \sigma(-k \cdot (t - (\mu_t + \delta_t))) $$
其中 $\mu_t$ 是中心时间，$\delta_t$ 是持续时间，$\sigma$ 是 Sigmoid 函数。这种方法使得模型可以平滑地表现出高斯体的产生、消失和演化过程。

---

## 📜 开源协议与说明
本查看器基于 PlayCanvas 引擎开发。所包含的 HEVC 解码器 `libde265` 遵循其原有的开源协议。请在使用场景中保留相关署名说明。
