---
name: truesplats-editing
description: Work on selection, deletion, repair, Lab tools, model health, SAM-assisted selection, and Current vs All-Time editing semantics.
---

# TrueSplats Editing

Own editing behavior and user-facing tools.

## Focus

- `src/ui/selection-tool.ts`.
- Lab panel features in `src/main.ts` and related algorithm files.
- Model health checks and automatic repair.
- SAM-assisted selection, mask previews, report click-to-select behavior.
- Current vs All-Time selection and delete semantics.

## Rules

- Current selection must only affect the intended current-frame/current-segment scope.
- All-Time selection must be visually and behaviorally distinct.
- Deletion and repair must preserve undo/redo expectations.
- Reports should be repeatable, clickable where useful, and reset on new files.
- Keep algorithm files independent when a feature is complex.
- Validate with `npm run build`.

## Preferred Optimizations

- Faster report generation with cached analysis inputs.
- Click-to-select consistency across health, SAM, and hidden-point tools.
- Clear reset boundaries when switching files or sequence segments.
- Robust UI states for failed/partial async operations.

