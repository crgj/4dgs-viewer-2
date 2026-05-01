import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# Fix clusterSharedCodebook signature
text = text.replace(
    'async function clusterSharedCodebook(columns: Float32Array[], k: number, iterations: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<[Float32Array, Uint32Array[]]> {',
    'async function clusterSharedCodebook(columns: Float32Array[], k: number, iterations: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>, signal?: AbortSignal): Promise<[Float32Array, Uint32Array[]]> {'
)

# Fix call inside clusterSharedCodebook
text = text.replace(
    'await kmeans1d(flattened, k, iterations, scheduler, undefined, { signal: options?.signal || (scheduler as any)?.signal })',
    'await kmeans1d(flattened, k, iterations, scheduler, signal)'
)

# Update calls to clusterSharedCodebook
text = text.replace(
    'await clusterSharedCodebook([f0, f1, f2], 256, iterations, scheduler)',
    'await clusterSharedCodebook([f0, f1, f2], 256, iterations, scheduler, (scheduler as any)?.signal)'
)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
