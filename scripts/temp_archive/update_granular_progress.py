import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# 1. Update addWebpFiles to report pct
text = text.replace(
    'async function addWebpFiles(zip: JSZip, state: ConversionState, concurrency?: number, yieldScheduler?: (force?: boolean) => Promise<void>): Promise<void>',
    'async function addWebpFiles(zip: JSZip, state: ConversionState, concurrency?: number, yieldScheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<void>'
)
text = text.replace('if (yieldScheduler) await yieldScheduler();', 'if (yieldScheduler) await yieldScheduler(false, i / entries.length);')

# 2. Update kmeans1d to report pct
text = text.replace(
    'async function kmeans1d(data: Float32Array, kRequested: number, iterations: number, scheduler?: () => Promise<void>): Promise<[Float32Array, Uint32Array]>',
    'async function kmeans1d(data: Float32Array, kRequested: number, iterations: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<[Float32Array, Uint32Array]>'
)
text = text.replace('if (scheduler) await scheduler();', 'if (scheduler) await scheduler(false, iter / iterations);')

# 3. Update compressMeans to report pct
text = text.replace(
    'async function compressMeans(x: Float32Array, y: Float32Array, z: Float32Array, filenameBase: string, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>',
    'async function compressMeans(x: Float32Array, y: Float32Array, z: Float32Array, filenameBase: string, state: ConversionState, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<Record<string, unknown>>'
)
text = text.replace('if (i % 50000 === 0 && scheduler) await scheduler();', 'if (i % 50000 === 0 && scheduler) await scheduler(false, i / paddedSize);')

# 4. Update compressQuats to report pct
text = text.replace(
    'async function compressQuats(r0In: Float32Array, r1In: Float32Array, r2In: Float32Array, r3In: Float32Array, filename: string, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>',
    'async function compressQuats(r0In: Float32Array, r1In: Float32Array, r2In: Float32Array, r3In: Float32Array, filename: string, state: ConversionState, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<Record<string, unknown>>'
)
text = text.replace('if (i % 50000 === 0 && scheduler) await scheduler();', 'if (i % 50000 === 0 && scheduler) await scheduler(false, i / n);')

# 5. Update clusterSharedCodebook to report pct
text = text.replace(
    'async function clusterSharedCodebook(columns: Float32Array[], k: number, iterations: number, scheduler?: () => Promise<void>): Promise<[Float32Array, Uint32Array[]]>',
    'async function clusterSharedCodebook(columns: Float32Array[], k: number, iterations: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<[Float32Array, Uint32Array[]]>'
)

# 6. Update compressScales/compressSh0Op type signatures in calls too if needed
text = text.replace(
    'async function compressScales(s0: Float32Array, s1: Float32Array, s2: Float32Array, filename: string, iterations: number, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>',
    'async function compressScales(s0: Float32Array, s1: Float32Array, s2: Float32Array, filename: string, iterations: number, state: ConversionState, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<Record<string, unknown>>'
)
text = text.replace(
    'async function compressSh0Op(f0: Float32Array, f1: Float32Array, f2: Float32Array, op: Float32Array, filename: string, iterations: number, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>',
    'async function compressSh0Op(f0: Float32Array, f1: Float32Array, f2: Float32Array, op: Float32Array, filename: string, iterations: number, state: ConversionState, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<Record<string, unknown>>'
)
text = text.replace(
    'async function compressParams(mu: Float32Array, w: Float32Array, isParam: Float32Array, iterations: number, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>',
    'async function compressParams(mu: Float32Array, w: Float32Array, isParam: Float32Array, iterations: number, state: ConversionState, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<Record<string, unknown>>'
)

# Fix some scheduler calls that became `async () => await subProgress(false, 0.5)` to just pass `subProgress` where appropriate
# Actually, since I want it to be "detailed", I should pass the subProgress directly.

text = text.replace(', async () => await meansProgress(false, 0.5)', ', meansProgress')
text = text.replace(', async () => await quatsProgress(false, 0.5)', ', quatsProgress')
text = text.replace(', async () => await scalesProgress(false, 0.3)', ', scalesProgress')
text = text.replace(', async () => await scalesProgress(false, 0.7)', ', scalesProgress')
text = text.replace(', async () => await webpProgress(false, 0.5)', ', webpProgress')

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
