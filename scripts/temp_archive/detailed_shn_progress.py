import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# 1. Update createSubProgress signature and logic
text = text.replace(
    'const pfn = async (force?: boolean, subPct?: number) => {',
    'const pfn = async (force?: boolean, subPct?: number, detail?: string) => {'
)
text = text.replace(
    'options.progress?.(overall, `${label} ${Math.round(p * 100)}%`, { stageId, stageLabel: label, stagePct: p * 100, overallPct: overall });',
    'options.progress?.(overall, `${label} ${Math.round(p * 100)}%`, { stageId, stageLabel: label, stagePct: p * 100, overallPct: overall, detail });'
)

# 2. Update kmeans1d to report iterations and row count
text = text.replace(
    'async function kmeans1d(data: Float32Array, kRequested: number, iterations: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>, signal?: AbortSignal, options?: any): Promise<[Float32Array, Uint32Array]> {',
    'async function kmeans1d(data: Float32Array, kRequested: number, iterations: number, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>, signal?: AbortSignal, options?: any): Promise<[Float32Array, Uint32Array]> {'
)

# In kmeans1d loop
text = text.replace(
    'if (row % 50000 === 0 && scheduler) await scheduler(false, (iter + (row / data.length)) / iterations);',
    'if (row % 50000 === 0 && scheduler) await scheduler(false, (iter + (row / data.length)) / iterations, `Codebook Iter ${iter+1}/${iterations} - Point ${Math.floor(row/1000)}k/${Math.floor(data.length/1000)}k`);'
)

# 3. Update kmeansNd to report iterations and batches
text = text.replace(
    'async function kmeansNd(data: Float32Array, n: number, d: number, kRequested: number, iterations: number, batchSize = 1024, seed?: number, workerCount = 1, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<[Float32Array, Uint32Array]> {',
    'async function kmeansNd(data: Float32Array, n: number, d: number, kRequested: number, iterations: number, batchSize = 1024, seed?: number, workerCount = 1, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>): Promise<[Float32Array, Uint32Array]> {'
)

text = text.replace(
    'if (start % (batchSize * 20) === 0 && scheduler) await scheduler(false, (iter + (start / n)) / iterations);',
    'if (start % (batchSize * 20) === 0 && scheduler) await scheduler(false, (iter + (start / n)) / iterations, `Palette Iter ${iter+1}/${iterations} - Batch ${Math.floor(start/batchSize)}/${Math.floor(n/batchSize)}`);'
)

# 4. Update compressShN sub-labels
text = text.replace(
    'await scheduler(force, 0.1 + (p ?? 0) * 0.7);',
    'await scheduler(force, 0.1 + (p ?? 0) * 0.7, detail || "SHN Palette Clustering");'
)

text = text.replace(
    'await scheduler(false, 0.85 + (p ?? 0) * 0.1)',
    'await scheduler(false, 0.85 + (p ?? 0) * 0.1, detail || "SHN Codebook Generation")'
)

# Update other module signatures just to be safe
text = text.replace('scheduler?: (force?: boolean, pct?: number) => Promise<void>', 'scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>')

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
