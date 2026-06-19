---
name: truesplats-formats
description: Work on loader/exporter and asset format logic. Use for PLY4, SOG4, TrueSplats, PLY, SH compression, sequence export, metadata, health-aware export, and compatibility-safe format changes.
---

# TrueSplats Formats

Own asset IO and conversion behavior.

## Focus

- `src/utils/*loader.ts`, `src/utils/*encoder.ts`, `src/utils/*exporter.ts`.
- PLY4/SOG4 sequence load modes, lazy segment loading, export preflight, and metadata.
- SH compression and render-mode compatibility.
- Deleted indices, original index mapping, trajectory banks, rotation/color trajectory banks.

## Rules

- Preserve round-trip metadata and original index mapping.
- Format changes must not break existing saved assets.
- Export repairs must be explicit, undo-safe where applicable, and reported to the user.
- Avoid hidden destructive changes to geometry, opacity, trajectory, SH, or deleted state.
- Validate with `npm run build`; add targeted self-checks for risky encoder changes.

## Preferred Optimizations

- Health-aware export and preflight.
- Format-level dynamic compression presets.
- Trajectory/color/rotation bank quantization controls.
- Sequence lazy-loading memory reduction.
- Compatibility reports for assets with missing or ambiguous fields.

