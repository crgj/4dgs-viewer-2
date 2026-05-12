import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# 1. Add yield to collectShData
text = text.replace(
    'for (let j = 0; j < n; j++) out[j * d + i] = col[j];',
    'for (let j = 0; j < n; j++) {\n         if (j % 50000 === 0 && (j > 0)) await new Promise(r => setTimeout(r, 0));\n         out[j * d + i] = col[j];\n     }'
)
# Add async to collectShData
text = text.replace('function collectShData(ply: any, shKeys: string[]): Float32Array {', 'async function collectShData(ply: any, shKeys: string[]): Promise<Float32Array> {')

# 2. Drastically reduce batch size and increase yield frequency in kmeansNd
# Old: for (let start = 0; start < n; start += batchSize) {
# New: const adjustedBatchSize = Math.max(1, Math.floor(1000000 / (k * d))); // Target ~1M ops per yield
text = text.replace(
    'for (let start = 0; start < n; start += batchSize) {\n      if (start % (batchSize * 20) === 0 && scheduler) await scheduler(false, (iter + (start / n)) / iterations, `Palette Iter ${iter+1}/${iterations} - Batch ${Math.floor(start/batchSize)}/${Math.floor(n/batchSize)}`);',
    'const adjustedBatchSize = Math.max(1, Math.floor(10000000 / (k * d || 1)));\n      for (let start = 0; start < n; start += adjustedBatchSize) {\n        if (scheduler) await scheduler(false, (iter + (start / n)) / iterations, `Palette Iter ${iter+1}/${iterations} - Point ${Math.floor(start/1000)}k/${Math.floor(n/1000)}k`);'
)

# 3. Harden kmeans1d summation loop
text = text.replace(
    'for (let row = 0; row < data.length; row++) {\n      const label = labels[row]!;',
    'for (let row = 0; row < data.length; row++) {\n      if (row % 100000 === 0 && (signal?.aborted || options?.signal?.aborted)) throw new Error("Export cancelled");\n      if (row % 200000 === 0 && scheduler) await scheduler(false, (iter + 0.5 + (row / data.length * 0.5)) / iterations, `Codebook Iter ${iter+1}/${iterations} - Summing ${Math.floor(row/1000)}k/${Math.floor(data.length/1000)}k`);\n      const label = labels[row]!;'
)

# 4. Fix call site of collectShData (it's now async)
text = text.replace('const shData = collectShData(ply, shKeys);', 'const shData = await collectShData(ply, shKeys);')

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
