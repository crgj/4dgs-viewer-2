import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# 1. Fix kmeansNd summation loop freeze
text = text.replace(
    'for (let row = 0; row < n; row++) {\n      if (row % 20000 === 0 && ((scheduler as any)?.signal?.aborted)) throw new Error("Export cancelled");',
    'for (let row = 0; row < n; row++) {\n      if (row % 20000 === 0 && ((scheduler as any)?.signal?.aborted)) throw new Error("Export cancelled");\n      if (row % 10000 === 0 && scheduler) await scheduler(false, (iter + 0.5 + (row / n * 0.5)) / iterations, `Palette Iter ${iter+1}/${iterations} - Summing ${Math.floor(row/1000)}k/${Math.floor(n/1000)}k`);'
)

# 2. Fix kmeans1d labels ordering loop (often overlooked)
text = text.replace(
    'for (let row = 0; row < data.length; row++) {\n    if (row % 50000 === 0 && (signal?.aborted || options?.signal?.aborted)) throw new Error("Export cancelled");',
    'for (let row = 0; row < data.length; row++) {\n    if (row % 50000 === 0 && (signal?.aborted || options?.signal?.aborted)) throw new Error("Export cancelled");\n    if (row % 50000 === 0 && scheduler) await scheduler(false, 0.99, `Finalizing Labels: ${Math.floor(row/1000)}k/${Math.floor(data.length/1000)}k`);'
)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)

# 3. Fix ViewerExportManager display logic
with open('src/viewer/viewer-export-manager.ts', 'r') as f:
    text = f.read()

# Update initializeSubsteps HTML with classes
text = text.replace(
    '<div class="text-[9px] font-mono uppercase ui-text-secondary opacity-80">0%</div>',
    '<div class="substep-pct text-[9px] font-mono uppercase ui-text-secondary opacity-80">0%</div>'
)
text = text.replace(
    '<div class="text-[8px] font-mono uppercase tracking-tight ui-text-secondary opacity-60">Pending</div>',
    '<div class="substep-detail text-[8px] font-mono uppercase tracking-tight ui-text-secondary opacity-60">Pending</div>'
)

# Update setExportProgress to use class-based selection
old_update_logic = """                        const fill = row.querySelector('.loading-substep-fill') as HTMLElement;
                        const pctTxt = row.querySelector('.font-mono') as HTMLElement;
                        const detTxt = row.querySelectorAll('div')[2] as HTMLElement;
                        if (fill) fill.style.width = `${meta.stagePct}%`;
                        if (pctTxt) pctTxt.innerText = `${Math.round(meta.stagePct || 0)}%`;
                        if (detTxt) detTxt.innerText = meta.detail || detail;"""

new_update_logic = """                        const fill = row.querySelector('.loading-substep-fill') as HTMLElement;
                        const pctTxt = row.querySelector('.substep-pct') as HTMLElement;
                        const detTxt = row.querySelector('.substep-detail') as HTMLElement;
                        if (fill) fill.style.width = `${meta.stagePct}%`;
                        if (pctTxt) pctTxt.innerText = `${Math.round(meta.stagePct || 0)}%`;
                        if (detTxt) detTxt.innerText = meta.detail || detail;"""

text = text.replace(old_update_logic, new_update_logic)

with open('src/viewer/viewer-export-manager.ts', 'w') as f:
    f.write(text)
