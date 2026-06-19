---
name: truesplats-docs
description: Work on TrueSplats.ai documentation, architecture notes, release notes, AI collaboration guidance, user-facing explanations, and bilingual technical copy.
---

# TrueSplats Docs

Write concise technical documentation for this viewer.

## Focus

- `README.md`, `AGENTS.md`, architecture notes, feature notes, release notes.
- User-facing explanations for Lab tools, export checks, render settings, and 4D playback.
- Bilingual copy in `src/i18n.ts` when UI text is involved.

## Rules

- Chinese copy should be concise and technical.
- English copy should be direct product/tool documentation.
- Do not document unimplemented behavior.
- Keep docs aligned with actual code paths and UI labels.
- Validate UI text changes with `npm run build`.

## Preferred Outputs

- Architecture overview for rendering, format, editing, and UI boundaries.
- Performance-mode explanations with expected tradeoffs.
- Export and repair workflow documentation.

