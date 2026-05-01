import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# Introduce Abort checks in kmeans1d
kmeans1d_inner_loop = """    for (let row = 0; row < data.length; row++) {
      let best = 0;
      let bestDist = Math.abs(data[row]! - centroids[0]!);"""

kmeans1d_harden = """    for (let row = 0; row < data.length; row++) {
      if (row % 20000 === 0 && (signal?.aborted || options?.signal?.aborted)) throw new Error("Export cancelled");
      if (row % 50000 === 0 && scheduler) await scheduler(false, (iter + (row / data.length)) / iterations);
      let best = 0;
      let bestDist = Math.abs(data[row]! - centroids[0]!);"""

# We need signal in kmeans1d signature
text = text.replace(
    'async function kmeans1d(data: Float32Array, kRequested: number, iterations: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<[Float32Array, Uint32Array]> {',
    'async function kmeans1d(data: Float32Array, kRequested: number, iterations: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>, signal?: AbortSignal, options?: any): Promise<[Float32Array, Uint32Array]> {'
)

text = text.replace(kmeans1d_inner_loop, kmeans1d_harden)

# Update calls to kmeans1d in sog4-encoder.ts
text = text.replace('await kmeans1d(shCentroids, 256, iterations, scheduler ? async (f, p) => await scheduler(false, 0.85 + (p ?? 0) * 0.1) : undefined)',
                   'await kmeans1d(shCentroids, 256, iterations, scheduler ? async (f, p) => await scheduler(false, 0.85 + (p ?? 0) * 0.1) : undefined, signal)')

text = text.replace('await kmeans1d(flattened, k, iterations, scheduler)', 'await kmeans1d(flattened, k, iterations, scheduler, undefined, { signal: options?.signal || (scheduler as any)?.signal })')

# In SOG4Encoder.encode, make the scheduler have access to signal
text = text.replace(
    'const scheduler = async (force?: boolean, pct?: number) => {',
    'const scheduler = Object.assign(async (force?: boolean, pct?: number) => {'
)
text = text.replace(
    'await new Promise(r => setTimeout(r, 0));\n        };',
    'await new Promise(r => setTimeout(r, 0));\n        }, { signal });'
)

# Fix compressParams calls to pass signal (implicit or explicit)
text = text.replace('async function compressParams(mu: Float32Array, w: Float32Array, isParam: Float32Array, iterations: number, state: ConversionState, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<Record<string, unknown>> {',
                   'async function compressParams(mu: Float32Array, w: Float32Array, isParam: Float32Array, iterations: number, state: ConversionState, scheduler?: (force?: boolean, pct?: number) => Promise<void>, signal?: AbortSignal): Promise<Record<string, unknown>> {')

# Pass signal in compressParams internals
text = text.replace('await kmeans1d(mu, 256, iterations, scheduler)', 'await kmeans1d(mu, 256, iterations, scheduler, signal)')
text = text.replace('await kmeans1d(w, 256, iterations, scheduler)', 'await kmeans1d(w, 256, iterations, scheduler, signal)')

# SOG4Encoder call
text = text.replace('meta.params = await compressParams(requireColumn(ply, "lifetime_mu"), requireColumn(ply, "lifetime_w"), hasColumn(ply, "is_param") ? requireColumn(ply, "is_param") : makeFloat32(n), iterations, state, paramsProgress);',
                   'meta.params = await compressParams(requireColumn(ply, "lifetime_mu"), requireColumn(ply, "lifetime_w"), hasColumn(ply, "is_param") ? requireColumn(ply, "is_param") : makeFloat32(n), iterations, state, paramsProgress, signal);')

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
