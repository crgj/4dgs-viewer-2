import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# Add signal to encode options
text = text.replace(
    'static async encode(data: any, overrides: any = {}, options: any = {}): Promise<Uint8Array> {',
    'static async encode(data: any, overrides: any = {}, options: any = {}): Promise<Uint8Array> {\n        const signal = options.signal as AbortSignal | undefined;'
)

# Helper for cancellation check
check_cancel = 'if (signal?.aborted) throw new Error("Export cancelled");'
check_cancel_opt = 'if (options?.signal?.aborted) throw new Error("Export cancelled");'

# Inject check_cancel into scheduler
text = text.replace(
    'const scheduler = async (force?: boolean, pct?: number) => { await new Promise(r => setTimeout(r, 0)); };',
    'const scheduler = async (force?: boolean, pct?: number) => {\n            if (signal?.aborted) throw new Error("Export cancelled");\n            await new Promise(r => setTimeout(r, 0));\n        };'
)
text = text.replace(
    'const _simpleScheduler = async () => { await new Promise(r => setTimeout(r, 0)); };',
    'const _simpleScheduler = async () => {\n            if (signal?.aborted) throw new Error("Export cancelled");\n            await new Promise(r => setTimeout(r, 0));\n        };'
)

# Update SHN details
text = text.replace(
    'meta.shN = await compressShN(collectShData(ply, shKeys), n, shKeys.length, iterations, state, seed, 1, shnProgress);',
    'const shData = collectShData(ply, shKeys);\n            meta.shN = await compressShN(shData, n, shKeys.length, iterations, state, seed, 1, shnProgress, signal);'
)

# Update compressShN signature and internals
text = text.replace(
    'async function compressShN(shData: Float32Array, n: number, numCoeffs: number, iterations: number, state: ConversionState, seed: number | undefined, shnWorkers: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>): Promise<Record<string, unknown>> {',
    'async function compressShN(shData: Float32Array, n: number, numCoeffs: number, iterations: number, state: ConversionState, seed: number | undefined, shnWorkers: number, scheduler?: (force?: boolean, pct?: number) => Promise<void>, signal?: AbortSignal): Promise<Record<string, unknown>> {'
)

# In compressShN, add more detailed sub-progress
old_shn_logic = """  console.log(`  Clustering SH into ${paletteSize} clusters...`);

  const wrappedScheduler = scheduler ? async (force?: boolean, pct?: number) => await scheduler(force, pct) : undefined; const [shCentroids, shLabels] = await kmeansNd(shData, n, numCoeffs, paletteSize, iterations, 1024, seed, shnWorkers, wrappedScheduler);
  const [codebookCentroids, codebookLabels] = await kmeans1d(shCentroids, 256, iterations, scheduler ? async () => await scheduler(false, 0) : undefined);"""

new_shn_logic = """  if (scheduler) await scheduler(false, 0.05);
  console.log(`  Clustering SH into ${paletteSize} clusters...`);
  if (scheduler) await scheduler(false, 0.1);

  const wrappedScheduler = scheduler ? async (force?: boolean, p?: number) => {
      // kmeansNd is 0.1 -> 0.8
      await scheduler(force, 0.1 + (p ?? 0) * 0.7);
  } : undefined;
  const [shCentroids, shLabels] = await kmeansNd(shData, n, numCoeffs, paletteSize, iterations, 1024, seed, shnWorkers, wrappedScheduler);
  
  if (scheduler) await scheduler(false, 0.85);
  // codebook is 0.85 -> 0.95
  const [codebookCentroids, codebookLabels] = await kmeans1d(shCentroids, 256, iterations, scheduler ? async (f, p) => await scheduler(false, 0.85 + (p ?? 0) * 0.1) : undefined);
  if (scheduler) await scheduler(false, 0.95);"""

text = text.replace(old_shn_logic, new_shn_logic)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
