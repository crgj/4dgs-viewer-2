---
name: truesplats-rendering
description: Work on 3DGS/4DGS rendering performance and playback. Use for PlayCanvas GSplat setup, custom splat shader code, lifetime and trajectory textures, SH render modes, sorting, recording/preview playback, pixel ratio, and performance profiling.
---

# TrueSplats Rendering

Optimize the renderer without damaging 4D motion fidelity.

## Focus

- 4DGS playback path in `src/main.ts`.
- Splat shader code in `src/shaders/gsplat-shader.ts`.
- Sort scheduling, dynamic centers, trajectory textures, lifetime textures, SH mode switching.
- Playback, preview, and recording behavior.
- Runtime performance switches that preserve visual intent.

## Rules

- Do not use static scene chunk LOD as the default answer for dynamic 4D assets.
- Prefer temporal/lifecycle-aware optimization over spatial simplification.
- Keep `uTime` playback smooth even when sorting is throttled.
- Avoid changing visual output unless the user chooses a performance mode.
- Keep selection/debug code out of hot playback paths when possible.
- Validate shader and TypeScript changes with `npm run build`.

## Preferred Optimizations

- Sort throttling based on playback mode and camera motion.
- Playback-only UI/debug refresh throttling.
- Optional dynamic pixel ratio while playing, restored when paused.
- Lifecycle-driven active set for 4D assets.
- Shader variants for playback, editing, and debug.

