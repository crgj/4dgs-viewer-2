import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# Update createSubProgress to check signal and attach it
text = text.replace(
    'return async (force?: boolean, subPct?: number) => {\n                const p = subPct ?? 0;',
    'const pfn = async (force?: boolean, subPct?: number) => {\n                if (signal?.aborted) throw new Error("Export cancelled");\n                const p = subPct ?? 0;'
)

text = text.replace(
    'options.progress?.(overall, `${label} ${Math.round(p * 100)}%`, { stageId, stageLabel: label, stagePct: p * 100, overallPct: overall });\n                await new Promise(r => setTimeout(r, 0));\n            };\n        };',
    'options.progress?.(overall, `${label} ${Math.round(p * 100)}%`, { stageId, stageLabel: label, stagePct: p * 100, overallPct: overall });\n                await new Promise(r => setTimeout(r, 0));\n            };\n            return Object.assign(pfn, { signal });\n        };'
)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
