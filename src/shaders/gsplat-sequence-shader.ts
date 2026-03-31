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
        .replace(/\n\s*\/\/ --- Selection Highlight ---[\s\S]*?\n\s*\/\/ --- Deletion check ---[\s\S]*?\n\s*if \(deletedVal > 0\.0\) \{[\s\S]*?\n\s*\}\n/g, '\n');

export const sequenceSplatCoreVS = splatCoreVS;
export const sequenceSplatMainVS = stripSelectionUniforms(splatMainVS);
export const sequenceSplatMainPS = splatMainPS;
