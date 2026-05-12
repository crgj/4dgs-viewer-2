import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# Fix wrappedScheduler in compressShN
text = text.replace(
    'const wrappedScheduler = scheduler ? async (force?: boolean, p?: number) => {',
    'const wrappedScheduler = scheduler ? async (force?: boolean, p?: number, detail?: string) => {'
)

# Fix kmeans1d call in compressShN
text = text.replace(
    'await kmeans1d(shCentroids, 256, iterations, scheduler ? async (f, p) => await scheduler(false, 0.85 + (p ?? 0) * 0.1, detail || "SHN Codebook Generation") : undefined, signal)',
    'await kmeans1d(shCentroids, 256, iterations, scheduler ? async (f, p, d) => await scheduler(false, 0.85 + (p ?? 0) * 0.1, d || "SHN Codebook Generation") : undefined, signal)'
)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
