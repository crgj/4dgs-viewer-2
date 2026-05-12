# 临时归档脚本 / Temporary Archive Scripts

> **⚠️ 警告：这些脚本仅用于开发/调试阶段的临时补丁，不应在生产环境或 CI 中使用。**
>
> **WARNING: These scripts are temporary development/debugging patches only. Do NOT use in production or CI.**

## 背景

这些 `.py` 文件是在开发 `SOG4` 编码器与导出管理器过程中，用于**逐步修复、重构和增强** `src/utils/sog4-encoder.ts` 与 `src/viewer/viewer-export-manager.ts` 的**一次性补丁脚本**。它们通过正则替换或直接文本操作修改源码，属于**中间测试产物**。

## 文件说明

| 文件名 | 目标文件 | 作用说明 |
|--------|----------|----------|
| `adapt_encoder.py` | `src/utils/sog4-encoder.ts` | 引入 `scheduler` 参数到 `compressShN`，并注入 encoder wrapper |
| `add_cancellation.py` | `src/utils/sog4-encoder.ts` | 在 SHN 逻辑中添加取消检查与进度调度 |
| `align_ui_progress.py` | `src/utils/sog4-encoder.ts` | 调整 `createSubProgress` 的进度粒度与 ZIP 生成进度对齐 |
| `asyncify_encoder.py` | `src/utils/sog4-encoder.ts` | 将 encoder 中的同步调用改为异步，修复 `scheduler` 变量冲突 |
| `detailed_shn_progress.py` | `src/utils/sog4-encoder.ts` | 为 SHN codebook 生成添加详细的进度文本（`detail` 参数） |
| `final_viewer_fix.py` | `src/viewer/viewer-export-manager.ts` | 对 viewer 导出管理器的最终修复（重置子步骤、超时处理等） |
| `fix_create_sub_progress.py` | `src/utils/sog4-encoder.ts` | 修复 `createSubProgress` 的匿名函数与 `signal` 绑定 |
| `fix_encoder_options.py` | `src/utils/sog4-encoder.ts` | 修正 `clusterSharedCodebook` 调用时的选项与 `signal` 传递 |
| `fix_encoder.py` | `src/utils/sog4-encoder.ts` | 清理解析产物（`parsePly`、`readScalar`）与类型冲突 |
| `fix_freeze_and_display.py` | `src/viewer/viewer-export-manager.ts` | 修复 UI 冻结问题，更新子步骤进度条与详情文本显示 |
| `fix_shn_anon_funcs.py` | `src/utils/sog4-encoder.ts` | 修复 SHN 中匿名函数的参数传递（`d` 参数） |
| `fix_shn_infinite_freeze.py` | `src/utils/sog4-encoder.ts` | 在 SHN 循环中添加取消检查与进度调度，防止无限冻结 |
| `fix_viewer_export.py` | `src/viewer/viewer-export-manager.ts` | 为 viewer 导出添加 `AbortSignal` 支持与取消错误处理 |
| `harden_all_loops.py` | `src/utils/sog4-encoder.ts` | 在所有循环（包括 `kmeansNd`）中显式检查 `signal.aborted` |
| `harden_cancellation.py` | `src/utils/sog4-encoder.ts` | 强化取消机制：在 `compressParams` 内部传递 `signal` |
| `refine_progress.py` | `src/utils/sog4-encoder.ts` | 重构 `scheduler` 与 `createSubProgress` 的进度报告逻辑 |
| `refine_yield_frequency.py` | `src/utils/sog4-encoder.ts` | 调整 `kmeansNd` 批处理循环的 `yield` 频率 |
| `sweep_scheduler_details.py` | `src/utils/sog4-encoder.ts` | 为文件压缩循环添加调度器详情文本（文件名） |
| `update_granular_progress.py` | `src/utils/sog4-encoder.ts` | 将硬编码的进度回调替换为直接的 `subProgress` 传递 |

## 使用建议

- **不要直接运行**：这些脚本基于开发过程中特定时间点的源码快照编写，当前源码结构可能已变化，直接运行可能导致不可预期的破坏。
- **仅供参考**：如需了解某次改动的具体实现，可阅读对应脚本作为历史参考。
- **安全清理**：确认当前 `src/utils/sog4-encoder.ts` 与 `src/viewer/viewer-export-manager.ts` 已包含所有补丁的最终效果后，可安全删除本目录。
