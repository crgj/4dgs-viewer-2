// Sequence rendering uses a separate shader entry-point so it can evolve independently
// from the 4DGS (trajectory/lifetime) pipeline. For now it reuses the same fixed core
// and main shaders, but sequence mode injects it via a different setup path.

import { splatCoreVS, splatMainVS, splatMainPS } from './gsplat-shader';

// Sequence mode renders fully-static per-frame data and should not depend on
// 4D/lifetime/selection textures. In particular, selectionTexture indexing
// depends on internal gsplat texture dimensions; for sequences where point
// counts vary per frame, that can cause undefined texelFetch and flicker.

const stripSelectionUniforms = (vs: string) =>
    vs
        .replace(/\n\s*uniform sampler2D selectionTexture;\s*\n\s*uniform float isSelectionMode;[^\n]*\n/g, '\n')
        // #wdd-claude 2026-06-11 修复序列模式编译崩溃: 2026-03-31 新增的"提前丢弃已删除点"块也引用了
        // selectionTexture，但原 strip 未移除它。声明被删而引用残留 -> 序列 shader GLSL 编译失败。补充移除该块。
        .replace(/\n\s*\/\/ --- #WDD 2026-03-31: Early Discard for Deleted Points ---[\s\S]*?if \(selData\.g > 0\.5\) \{[\s\S]*?\n\s*\}\n/g, '\n')
        .replace(/\n\s*\/\/ --- Selection Highlight ---[\s\S]*?\n\s*\/\/ --- Deletion check ---[\s\S]*?\n\s*if \(deletedVal > 0\.0\) \{[\s\S]*?\n\s*\}\n/g, '\n');

export const sequenceSplatCoreVS = splatCoreVS;
export const sequenceSplatMainVS = stripSelectionUniforms(splatMainVS);
export const sequenceSplatMainPS = splatMainPS;
