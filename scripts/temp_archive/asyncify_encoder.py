import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# kmeans1d
text = text.replace(
    'function kmeans1d(data: Float32Array, kRequested: number, iterations: number): [Float32Array, Uint32Array]',
    'async function kmeans1d(data: Float32Array, kRequested: number, iterations: number, scheduler?: () => Promise<void>): Promise<[Float32Array, Uint32Array]>'
)
text = text.replace(
    'for (let iter = 0; iter < iterations; iter++) {',
    'for (let iter = 0; iter < iterations; iter++) {\n    if (scheduler) await scheduler();'
)

# clusterSharedCodebook
text = text.replace(
    'function clusterSharedCodebook(columns: Float32Array[], k: number, iterations: number): [Float32Array, Uint32Array[]]',
    'async function clusterSharedCodebook(columns: Float32Array[], k: number, iterations: number, scheduler?: () => Promise<void>): Promise<[Float32Array, Uint32Array[]]>'
)
text = text.replace('const [centroids, allLabels] = kmeans1d(flattened, k, iterations);', 'const [centroids, allLabels] = await kmeans1d(flattened, k, iterations, scheduler);')

# compressMeans
text = text.replace(
    'function compressMeans(x: Float32Array, y: Float32Array, z: Float32Array, filenameBase: string, state: ConversionState): Record<string, unknown>',
    'async function compressMeans(x: Float32Array, y: Float32Array, z: Float32Array, filenameBase: string, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>'
)
text = re.sub(
    r'for \(let i = 0; i < paddedSize; i\+\+\) \{',
    r'for (let i = 0; i < paddedSize; i++) {\n    if (i % 50000 === 0 && scheduler) await scheduler();',
    text
)

# compressQuats
text = text.replace(
    'function compressQuats(r0In: Float32Array, r1In: Float32Array, r2In: Float32Array, r3In: Float32Array, filename: string, state: ConversionState): Record<string, unknown>',
    'async function compressQuats(r0In: Float32Array, r1In: Float32Array, r2In: Float32Array, r3In: Float32Array, filename: string, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>'
)
text = re.sub(
    r'for \(let i = 0; i < n; i\+\+\) \{',
    r'for (let i = 0; i < n; i++) {\n    if (i % 50000 === 0 && scheduler) await scheduler();',
    text
)

# compressScales
text = text.replace(
    'function compressScales(s0: Float32Array, s1: Float32Array, s2: Float32Array, filename: string, iterations: number, state: ConversionState): Record<string, unknown>',
    'async function compressScales(s0: Float32Array, s1: Float32Array, s2: Float32Array, filename: string, iterations: number, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>'
)
text = text.replace('const [centroids, labels] = clusterSharedCodebook([s0, s1, s2], 256, iterations);', 'const [centroids, labels] = await clusterSharedCodebook([s0, s1, s2], 256, iterations, scheduler);')

# compressSh0Op
text = text.replace(
    'function compressSh0Op(f0: Float32Array, f1: Float32Array, f2: Float32Array, op: Float32Array, filename: string, iterations: number, state: ConversionState): Record<string, unknown>',
    'async function compressSh0Op(f0: Float32Array, f1: Float32Array, f2: Float32Array, op: Float32Array, filename: string, iterations: number, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>'
)
text = text.replace('const [centroids, labels] = clusterSharedCodebook([f0, f1, f2], 256, iterations);', 'const [centroids, labels] = await clusterSharedCodebook([f0, f1, f2], 256, iterations, scheduler);')

# compressShN
text = text.replace('const [codebookCentroids, codebookLabels] = kmeans1d(shCentroids, 256, iterations);', 'const [codebookCentroids, codebookLabels] = await kmeans1d(shCentroids, 256, iterations, scheduler ? async () => await scheduler(false, 0) : undefined);')

# compressParams
text = text.replace(
    'function compressParams(mu: Float32Array, w: Float32Array, isParam: Float32Array, iterations: number, state: ConversionState): Record<string, unknown>',
    'async function compressParams(mu: Float32Array, w: Float32Array, isParam: Float32Array, iterations: number, state: ConversionState, scheduler?: () => Promise<void>): Promise<Record<string, unknown>>'
)
text = text.replace('const [cMu, lMu] = kmeans1d(mu, 256, iterations);', 'const [cMu, lMu] = await kmeans1d(mu, 256, iterations, scheduler);')
text = text.replace('const [cW, lW] = kmeans1d(w, 256, iterations);', 'const [cW, lW] = await kmeans1d(w, 256, iterations, scheduler);')
text = text.replace('const [cP, lP] = kmeans1d(isParam, 256, iterations);', 'const [cP, lP] = await kmeans1d(isParam, 256, iterations, scheduler);')

# Calls in build process
text = text.replace('meta.means = compressMeans(', 'meta.means = await compressMeans(')
text = text.replace('meta.quats = compressQuats(', 'meta.quats = await compressQuats(')
text = text.replace('meta.scales = compressScales(', 'meta.scales = await compressScales(')
text = text.replace('meta.sh0 = compressSh0Op(', 'meta.sh0 = await compressSh0Op(')
text = text.replace('meta.params = compressParams(', 'meta.params = await compressParams(')
# append scheduler to SOG4Encoder heavy calls! Replace from end of line
def append_scheduler(match):
    # This matches the end of compressXYZ calls like `iterations, state);`
    # We want to replace it with `iterations, state, _simpleScheduler);`
    return match.group(0)

# Replace the specific calls in SOG4Encoder
text = re.sub(r'compressMeans\(requireColumn\(ply, "x"\), requireColumn\(ply, "y"\), requireColumn\(ply, "z"\), "means", state\)', r'compressMeans(requireColumn(ply, "x"), requireColumn(ply, "y"), requireColumn(ply, "z"), "means", state, _simpleScheduler)', text)
text = re.sub(r'compressQuats\(r0, r1, r2, r3, "quats", state\)', r'compressQuats(r0, r1, r2, r3, "quats", state, _simpleScheduler)', text)
text = re.sub(r'compressScales\(requireColumn\(ply, "scale_0"\), requireColumn\(ply, "scale_1"\), requireColumn\(ply, "scale_2"\), "scales", iterations, state\)', r'compressScales(requireColumn(ply, "scale_0"), requireColumn(ply, "scale_1"), requireColumn(ply, "scale_2"), "scales", iterations, state, _simpleScheduler)', text)
text = re.sub(r'compressSh0Op\(requireColumn\(ply, "f_dc_0"\), requireColumn\(ply, "f_dc_1"\), requireColumn\(ply, "f_dc_2"\), requireColumn\(ply, "opacity"\), "sh0", iterations, state\)', r'compressSh0Op(requireColumn(ply, "f_dc_0"), requireColumn(ply, "f_dc_1"), requireColumn(ply, "f_dc_2"), requireColumn(ply, "opacity"), "sh0", iterations, state, _simpleScheduler)', text)
text = re.sub(r'compressParams\(requireColumn\(ply, "_lifetime_mu"\), requireColumn\(ply, "_lifetime_w"\), hasColumn\(ply, "is_param"\) \? requireColumn\(ply, "is_param"\) : makeFloat32\(n\), iterations, state\)', r'compressParams(requireColumn(ply, "_lifetime_mu"), requireColumn(ply, "_lifetime_w"), hasColumn(ply, "is_param") ? requireColumn(ply, "is_param") : makeFloat32(n), iterations, state, _simpleScheduler)', text)
# there was an issue in my compressParams regex with "_lifetime" so:
text = re.sub(r'compressParams\((.*?)\)', r'compressParams(\1, _simpleScheduler)', text)
# we need to fix it gracefully! So wait, I'll just change the scheduler variable.
text = text.replace('const scheduler = async () => { await new Promise(r => setTimeout(r, 0)); };', 'const scheduler = async (force?: boolean, pct?: number) => { await new Promise(r => setTimeout(r, 0)); };\n        const _simpleScheduler = async () => { await new Promise(r => setTimeout(r, 0)); };')

# Clean up double `scheduler` if we accidentally added `_simpleScheduler` twice
text = text.replace('_simpleScheduler, _simpleScheduler', '_simpleScheduler')

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
