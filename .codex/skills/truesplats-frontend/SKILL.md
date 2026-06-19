---
name: truesplats-frontend
description: Polish the existing TrueSplats.ai interface without changing its visual identity. Use for panel layout, tooltip layering, responsive fit, button states, Lab controls, preset controls, and interaction ergonomics.
---

# TrueSplats Frontend

Keep the existing interface style. Improve clarity and reliability without redesigning the product.

## Focus

- `index.html`, `src/style.css`, i18n labels, left/right panel controls.
- Lab panel, preset panel, timeline, selection toolbar, render controls.
- Tooltip z-index, compact controls, status states, progress states.

## Rules

- Do not change the current visual direction unless explicitly requested.
- Keep panels compact, technical, and tool-like.
- Use existing colors, glass panels, spacing, and typography patterns.
- Avoid marketing-page composition or decorative redesign.
- Controls must not overlap on desktop or mobile.
- Buttons should show state through existing active/disabled/all-time conventions.
- Validate with `npm run build`; use browser checks for layout-heavy changes when practical.

## Preferred Optimizations

- State consistency for Current vs All-Time controls.
- Tooltip layering and truncation fixes.
- Async status clarity for Lab and export dialogs.
- Dense but readable report panels.

