# TrueSplats Viewer - 4D Gaussian Splatting Web Viewer

基于 **PlayCanvas** 和 **TypeScript** 构建的专业级 **4D Gaussian Splatting** 在线查看器,支持动态 4DGS 渲染、AR 增强现实、实时编辑等高级功能。

---

## ✨ 核心功能

### 🎬 4D 动态渲染
- **关键帧插值系统**
  - 位置 (XYZ) 关键帧线性插值
  - 旋转 (Quaternion) 球面线性插值 (SLERP)
  - 缩放 (Scale) 关键帧插值
  - 不透明度生命周期控制
  
- **实时播放控制**
  - 播放/暂停切换
  - 可拖拽时间轴进度条
  - 多档 FPS 控制 (10/30/60 fps)
  - 实时帧数显示

- **生命周期函数**
  - 基于双 Sigmoid 函数的平滑淡入淡出
  - 支持 `lifetime_mu` (中心时间) 和 `lifetime_w` (半宽) 参数

### 📱 AR 增强现实
- **摄像头管理**
  - 自动检测可用摄像头设备
  - 支持前置/后置摄像头切换
  - 实时视频流处理

- **图像跟踪**
  - 基于 MindAR 的 ArUco 标记识别
  - 实时 6DoF 追踪
  - 精确坐标系对齐

- **摄像头控制**
  - 亮度调节
  - 对比度调节
  - 曝光补偿

### 🎨 点云编辑工具
- **多模式选择**
  - 🖌️ **笔刷模式**: 自由绘制选择区域
  - ⬜ **矩形模式**: 拖拽框选
  - 🔄 **反选功能**: 一键反转选择

- **实时编辑**
  - 删除选中的高斯点
  - GPU 加速渲染更新
  - 编辑状态保存到导出文件

- **变换控制**
  - 数值输入控制位置 (X/Y/Z)
  - 数值输入控制旋转 (Pitch/Yaw/Roll)
  - 鼠标拖拽调节 (Scrubbing)

### 📷 相机系统
- **预设管理**
  - 保存当前相机位置和角度
  - 快速切换已保存的视角
  - 批量管理相机预设
  - 平滑动画过渡

- **快捷视角**
  - 顶视图 (Top View)
  - 正视图 (Front View)
  - 侧视图 (Side View)

- **相机动画**
  - 预设切换时的平滑插值
  - 支持自动播放暂停控制

### 📝 文本标注
- **2D 文本叠加**
  - 在 3D 场景上添加文本标注
  - 支持中英文和各种字符
  
- **丰富样式**
  - 字体大小: 12px - 120px
  - 自定义颜色
  - 多种字体家族 (Inter, 系统字体, 等宽字体等)
  - 粗体/斜体样式

- **智能关联**
  - 文本标注与相机预设自动绑定
  - 切换预设时自动显示/隐藏对应标注

### 🎭 视觉增强
- **粒子特效**
  - 预设切换时的动态粒子动画
  - 可开关的过渡效果

- **场景辅助**
  - 网格 (Grid) 显示/隐藏
  - 三轴坐标 (Axes) 显示/隐藏
  - 支持自定义颜色和透明度

- **主题切换**
  - 深色模式 (默认)
  - 浅色模式
  - 一键切换

### 💾 文件格式
- **TrueSplats (.truesplats)**
  - 专有 4DGS 二进制格式
  - 支持完整的时间动态数据
  - 包含元数据和扩展信息
  
- **SOG4 (.sog4)**
  - 优化的压缩格式
  - 支持完整导入导出
  - 保留所有编辑状态

### 📤 导出功能
- **一键导出**
  - 点击直接导出为 `.sog4` 格式
  - 所有编辑状态自动保存

- **状态保存**
  - 模型变换 (位置/旋转/缩放)
  - 相机预设列表
  - 文本标注内容和样式
  - 已删除点的索引

---

## 📝 版本修改记录

### 2026-04-02

#### SOG4 读取与保存修复
- 修复 `raw_float_payload` 类型 `.sog4` 在删除或修改后再次保存时, `meta.count` 与 `raw_static.bin`、`raw_xyz_bank.bin`、`raw_rot_bank.bin`、`raw_dc_bank.bin` 长度不一致的问题。
- 支持尽量容错读取历史错误 `.sog4` 文件, 包括 `meta.count` 与实际 payload 数量不一致、旧 raw 行布局不一致等情况。
- 对通过容错模式打开的 `.sog4` 文件, 再次保存时会自动重写为结构正确的新文件。

#### 大文件支持
- 将 PLY4 浏览器解码内存预算提高到 `5000 MB`。
- 将 4D 纹理浏览器/GPU 内存预算提高到 `5000 MB`。

#### 生命周期与透明度修复
- 修复第 `0` 帧透明度异常跳变问题。
- 生命周期计算保持平滑 Sigmoid 进出, 同时限制在当前段时间范围内生效。

#### SOG4 多段播放修复
- 多段 `.sog4` 播放时, 每一段按独立段处理, 不再复用上一段的删除/隐藏 mask。
- 切换到下一段时会重新绑定当前段自己的 `selectionTexture`、时间参数和总帧数参数。
- 修复多段播放时第二段 `xyz` 与第一段串扰的问题。
- 修复多段播放时第二段透明度偶发受上一段影响、出现黑点的问题。
- 为多段 `.sog4` 播放补充动态 sorter 更新, 保证当前段的透明混合排序与本段局部帧一致。
- 将切段逻辑改为预先准备各段实体并在边界帧直接硬切, 降低 `90` 帧附近黑帧/闪烁概率。

---

## 📂 项目结构

```
4dgs-viewer-momo/
├── public/                     # 静态资源
│   ├── truesplats/            # 示例 .truesplats 文件
│   ├── sog4/                  # 示例 .sog4 文件
│   ├── marker/                # ArUco 标记图片
│   └── samples.json           # 示例文件列表
├── src/
│   ├── shaders/               # GLSL 着色器
│   │   └── gsplat-shader.ts   # 4DGS 自定义着色器
│   ├── ui/                    # UI 组件
│   │   └── selection-tool.ts  # 选择工具实现
│   ├── utils/                 # 核心工具
│   │   ├── truesplats-loader.ts  # TrueSplats 加载器
│   │   ├── sog4-loader.ts        # SOG4 加载器
│   │   ├── ar-handler.ts         # AR 处理器
│   │   └── ply-exporter.ts       # PLY 导出器
│   ├── particle-effects.ts    # 粒子特效系统
│   ├── main.ts                # 应用入口
│   └── style.css              # 主样式
├── scripts/                   # 构建脚本
│   └── update_samples.js      # 自动更新示例列表
├── index.html                 # 主页面
├── vite.config.ts             # Vite 配置
└── package.json               # 依赖配置
```

---

## 🚀 快速开始

### 环境要求
- Node.js 16+
- npm 或 yarn

### 安装
```bash
npm install
```

### 开发
```bash
npm run dev
```
访问 `http://localhost:5173`

### 构建
```bash
npm run build
```
产物输出到 `docs/` 目录

---

## 🎮 使用指南

### 加载模型
- **拖拽加载**: 直接拖入 `.truesplats` 或 `.sog4` 文件
- **按钮加载**: 点击右上角 📁 按钮
- **示例加载**: 点击左上角 "Samples" 下拉菜单

### 基本操作
| 操作 | 方式 |
|------|------|
| 旋转视角 | 左键拖拽 |
| 平移视角 | 右键拖拽 |
| 缩放视角 | 鼠标滚轮 |
| 播放/暂停 | 空格键 或 点击播放按钮 |
| 隐藏/显示 UI | **H** 键 或 双击画布 |

### 编辑模式
1. 点击右侧工具栏的选择工具图标
2. 选择笔刷或矩形模式
3. 在画布上绘制选择区域
4. 点击"删除选中"移除噪点
5. 导出时自动保存编辑状态

### AR 模式
1. 打印 ArUco 标记 (`public/marker/` 目录)
2. 点击右上角摄像头下拉菜单
3. 选择摄像头设备
4. 点击 AR 图标启动
5. 将标记对准摄像头

### 导出编辑结果
点击右上角导出按钮 ⬇️,自动保存为 `.sog4` 格式,包含所有编辑状态。

---

## 🧠 技术原理

### 4D 生命周期函数
使用双 Sigmoid 函数实现高斯点的平滑淡入淡出:

$$
M(t) = \sigma(k \cdot (t - (\mu_t - w_t))) \cdot \sigma(-k \cdot (t - (\mu_t + w_t)))
$$

其中:
- $\mu_t$ - 生命周期中心时间
- $w_t$ - 生命周期半宽
- $k = 10.0$ - 衰减敏锐度
- $\sigma(x) = \frac{1}{1 + e^{-x}}$ - Sigmoid 函数

### 关键帧插值
- **位置**: 线性插值 (LERP)
- **旋转**: 球面线性插值 (SLERP)
- **缩放**: 线性插值
- **不透明度**: 生命周期函数调制

着色器在 GPU 端实时计算,确保高性能。

### AR 坐标对齐
MindAR 基于 WebAssembly 实现高性能的 ArUco 标记识别:
1. 实时检测标记位置和姿态
2. 计算 4x4 变换矩阵
3. 将 PlayCanvas 世界坐标系对齐到标记中心
4. 应用后处理矩阵校正旋转和平移

---

## 🛠 技术栈

- **渲染引擎**: [PlayCanvas](https://playcanvas.com/) v1.77
- **语言**: TypeScript 5.3
- **构建工具**: Vite 5.4
- **AR 库**: MindAR (基于 WebAssembly)
- **UI 框架**: Tailwind CSS 3.4
- **压缩**: JSZip 3.10

---

## 📄 文件格式规范

### TrueSplats (.truesplats)

**文件结构**:
```
[Magic Number: "TRUESPLATS"]
[Version: uint32]
[Metadata JSON]
[Static Data]
[Dynamic Data]
[Extension Data]
```

**包含内容**:
- 静态属性: 颜色、球谐系数、基础缩放
- 动态数据: 位置轨迹、旋转轨迹、生命周期
- 扩展数据: 相机预设、文本标注、删除索引

### SOG4 (.sog4)

优化的压缩格式,完全兼容 TrueSplats 功能,提供更好的压缩率。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request!

---

## 📜 开源协议

本项目基于 PlayCanvas 引擎开发。第三方库遵循各自协议:
- PlayCanvas: MIT License
- MindAR: MIT License

---

## 🙏 致谢

- [PlayCanvas Engine](https://github.com/playcanvas/engine)
- [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)
- [4D Gaussian Splatting](https://guanjunwu.github.io/4dgs/)
- [MindAR](https://github.com/hiukim/mind-ar-js)

---

**Made with ❤️ for 4D Gaussian Splatting Community**
