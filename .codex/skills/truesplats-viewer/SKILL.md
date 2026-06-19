---
name: truesplats-viewer
description: Coordinate repo-level TrueSplats.ai viewer work. Use for tasks that cross rendering, loaders/exporters, selection/editing, Lab tools, playback, UI panels, validation routing, or architectural planning.
---

# TrueSplats Viewer

Use this skill when a task spans multiple parts of the viewer or needs careful routing.

## Route

- `truesplats-rendering`: PlayCanvas GSplat runtime, 4D playback, shader variants, sorting, pixel ratio, performance profiling.
- `truesplats-formats`: PLY4, SOG4, TrueSplats, PLY loaders/exporters, compression, health-aware export, metadata compatibility.
- `truesplats-editing`: selection, delete/restore, Current vs All-Time behavior, SAM-assisted selection, model health checks, Lab tools.
- `truesplats-frontend`: existing UI panel polish, responsive behavior, tooltip layering, button states, interaction ergonomics.
- `truesplats-docs`: architecture notes, release notes, user-facing explanations, bilingual copy, AI collaboration guidance.

## Boundaries

- Preserve the current product UI style unless the user explicitly asks for redesign.
- Prefer incremental performance controls over replacing the renderer.
- Dynamic 4D display has priority over static large-scene optimizations.
- Do not break editing state, undo state, selection state, export metadata, or sequence segment switching.
- Avoid unrelated refactors in `src/main.ts`; touch only the needed runtime path.
- Validate code changes with `npm run build`.

