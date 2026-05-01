import JSZip from "jszip";

type NumericArray = Float32Array | Uint8Array | Uint32Array;

interface PlyProperty {
  type: string;
  name: string;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

interface PlyData {
  format: "ascii" | "binary_little_endian";
  comments: string[];
  elements: PlyElement[];
  vertex: {
    count: number;
    properties: PlyProperty[];
    columns: Map<string, Float32Array>;
  };
}

interface RawTexture {
  data: Uint8Array;
  width: number;
  height: number;
}

interface ConversionState {
  width: number;
  height: number;
  count: number;
  textures: Map<string, RawTexture>;
}

interface ConversionOptions {
  iterations?: number;
  seed?: number | undefined;
  webpConcurrency?: number | undefined;
  shnWorkers?: number | undefined;
}

interface CliOptions {
  inputPly: string;
  outputSog: string;
  iterations: number;
  seed?: number | undefined;
  webpConcurrency?: number | undefined;
  shnWorkers?: number | undefined;
}

interface KmeansLabelWorkerData {
  kind: "kmeansNdLabels";
  dataBuffer: ArrayBufferLike;
  centroidsBuffer: ArrayBufferLike;
  normsBuffer: ArrayBufferLike;
  labelsBuffer: ArrayBufferLike;
  n: number;
  d: number;
  k: number;
  start: number;
  end: number;
}

interface KmeansLabelWorkerResult {
  id: number;
  start: number;
  end: number;
  row?: number;
  done?: boolean;
}

const EPS = 1e-9;
const SQRT2 = Math.sqrt(2);
const TYPE_SIZE: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

function computeKmeansNdLabelsRange(input: KmeansLabelWorkerData): void {
  const data = new Float32Array(input.dataBuffer);
  const centroids = new Float32Array(input.centroidsBuffer);
  const norms = new Float64Array(input.normsBuffer);
  const labels = new Uint32Array(input.labelsBuffer);
  const { d, k, start, end } = input;
  for (let row = start; row < end; row++) {
    let best = 0;
    let bestMetric = Number.POSITIVE_INFINITY;
    const pointOffset = row * d;
    for (let c = 0; c < k; c++) {
      const centroidOffset = c * d;
      let dot = 0;
      for (let j = 0; j < d; j++) dot += data[pointOffset + j]! * centroids[centroidOffset + j]!;
      const metric = norms[c]! - 2 * dot;
      if (metric < bestMetric) {
        bestMetric = metric;
        best = c;
      }
    }
    labels[row] = best;
  }
}

// #WDD-gpt 2026-04-30 - 大 palette 下在单个点的 centroid 扫描内部让出主线程，仅改善监控和交互，不改变距离计算逻辑
async function computeKmeansNdLabelsRangeResponsive(
  input: KmeansLabelWorkerData,
  scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>,
  pctStart = 0,
  pctEnd = 1,
  detailPrefix = "Palette"
): Promise<void> {
  const data = new Float32Array(input.dataBuffer);
  const centroids = new Float32Array(input.centroidsBuffer);
  const norms = new Float64Array(input.normsBuffer);
  const labels = new Uint32Array(input.labelsBuffer);
  const { d, k, start, end } = input;
  const centroidChunk = Math.max(256, Math.min(4096, Math.floor(120000 / Math.max(d, 1))));
  const rowSpan = Math.max(end - start, 1);
  let lastYieldAt = typeof performance !== "undefined" ? performance.now() : Date.now();

  for (let row = start; row < end; row++) {
    let best = 0;
    let bestMetric = Number.POSITIVE_INFINITY;
    const pointOffset = row * d;
    for (let cStart = 0; cStart < k; cStart += centroidChunk) {
      if ((scheduler as any)?.signal?.aborted) throw new Error("Export cancelled");
      const cEnd = Math.min(cStart + centroidChunk, k);
      for (let c = cStart; c < cEnd; c++) {
        const centroidOffset = c * d;
        let dot = 0;
        for (let j = 0; j < d; j++) dot += data[pointOffset + j]! * centroids[centroidOffset + j]!;
        const metric = norms[c]! - 2 * dot;
        if (metric < bestMetric) {
          bestMetric = metric;
          best = c;
        }
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (scheduler && cEnd < k && now - lastYieldAt >= 120) {
        const rowPct = (row - start + cEnd / Math.max(k, 1)) / rowSpan;
        await scheduler(false, pctStart + rowPct * (pctEnd - pctStart), `${detailPrefix} - Row ${row + 1} - Centroid ${cEnd}/${k}`);
        lastYieldAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      }
    }
    labels[row] = best;
  }
}


// #WDD-gpt 2026-04-28 - 完整移植 Python 转换器的数值压缩、PLY 解析和 SOG4 打包逻辑
function requireColumn(ply: PlyData, name: string): Float32Array {
  const value = ply.vertex.columns.get(name);
  if (!value) {
    throw new Error(`Missing required PLY vertex property: ${name}`);
  }
  return value;
}

function hasColumn(ply: PlyData, name: string): boolean {
  return ply.vertex.columns.has(name);
}


function makeFloat32(length: number, fill = 0): Float32Array {
  const out = new Float32Array(length);
  if (fill !== 0) out.fill(Math.fround(fill));
  return out;
}

function uniqueCount(data: Float32Array, stopAfter = Number.POSITIVE_INFINITY): number {
  if (data.length === 0) return 0;
  // #WDD-gpt 2026-05-01 - kmeans1d 只需要知道唯一值是否超过请求的 k，超过后停止避免大数组排序
  if (Number.isFinite(stopAfter)) {
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i++) {
      seen.add(data[i]!);
      if (seen.size > stopAfter) return seen.size;
    }
    return seen.size;
  }
  const sorted = Array.from(data).sort((a, b) => a - b);
  let count = 1;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1]) count++;
  return count;
}

function initializeCentroids1d(data: Float32Array, k: number): Float32Array {
  const n = data.length;
  const sorted = Array.from(data).sort((a, b) => a - b);
  const centroids = new Float32Array(k);
  for (let i = 0; i < k; i++) {
    const quantile = (2 * i + 1) / (2 * k);
    const index = Math.min(Math.floor(quantile * n), n - 1);
    centroids[i] = Math.fround(sorted[index] ?? 0);
  }
  return centroids;
}

async function kmeans1d(data: Float32Array, kRequested: number, iterations: number, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>, signal?: AbortSignal, options?: any): Promise<[Float32Array, Uint32Array]> {
  const k = Math.min(kRequested, uniqueCount(data, kRequested));
  if (k === 0) {
    return [new Float32Array(0), new Uint32Array(0)];
  }
  let centroids = initializeCentroids1d(data, k);
  const labels = new Uint32Array(data.length);

  for (let iter = 0; iter < iterations; iter++) {
    if ((scheduler as any)?.signal?.aborted) throw new Error("Export cancelled");
    if (scheduler) await scheduler(false, iter / iterations);
    for (let row = 0; row < data.length; row++) {
      if (row % 20000 === 0 && (signal?.aborted || options?.signal?.aborted)) throw new Error("Export cancelled");
      if (row % 50000 === 0 && scheduler) await scheduler(false, (iter + (row / data.length)) / iterations, `Codebook Iter ${iter+1}/${iterations} - Point ${Math.floor(row/1000)}k/${Math.floor(data.length/1000)}k`);
      let best = 0;
      let bestDist = Math.abs(data[row]! - centroids[0]!);
      for (let c = 1; c < k; c++) {
        const dist = Math.abs(data[row]! - centroids[c]!);
        if (dist < bestDist) {
          best = c;
          bestDist = dist;
        }
      }
      labels[row] = best;
    }

    const sums = new Float64Array(k);
    const counts = new Uint32Array(k);
    for (let row = 0; row < data.length; row++) {
      if (row % 100000 === 0 && (signal?.aborted || options?.signal?.aborted)) throw new Error("Export cancelled");
      if (row % 200000 === 0 && scheduler) await scheduler(false, (iter + 0.5 + (row / data.length * 0.5)) / iterations, `Codebook Iter ${iter+1}/${iterations} - Summing ${Math.floor(row/1000)}k/${Math.floor(data.length/1000)}k`);
      const label = labels[row]!;
      sums[label] = (sums[label] ?? 0) + data[row]!;
      counts[label] = (counts[label] ?? 0) + 1;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] !== 0) {
        centroids[c] = Math.fround(sums[c]! / counts[c]!);
      } else {
        centroids[c] = data[0] ?? 0;
      }
    }
  }

  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => centroids[a]! - centroids[b]!);
  const sortedCentroids = new Float32Array(k);
  for (let i = 0; i < k; i++) {
    sortedCentroids[i] = centroids[order[i]!]!;
  }
  centroids = sortedCentroids;

  for (let row = 0; row < data.length; row++) {
    if (row % 50000 === 0 && (signal?.aborted || options?.signal?.aborted)) throw new Error("Export cancelled");
    if (row % 50000 === 0 && scheduler) await scheduler(false, 0.99, `Finalizing Labels: ${Math.floor(row/1000)}k/${Math.floor(data.length/1000)}k`);
    let best = 0;
    let bestDist = Math.abs(data[row]! - centroids[0]!);
    for (let c = 1; c < k; c++) {
      const dist = Math.abs(data[row]! - centroids[c]!);
      if (dist < bestDist) {
        best = c;
        bestDist = dist;
      }
    }
    labels[row] = best;
  }

  return [centroids, labels];
}

// #WDD-gpt 2026-04-28 - 保持纯 TS 转换路径，不依赖 Python；seed 仅用于让 Web 应用中的 SHN 初始化可复现
function deterministicSample(n: number, k: number, seedValue = 0x12345678): Uint32Array {
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  let seed = seedValue >>> 0;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = tmp;
  }
  return Uint32Array.from(indices.slice(0, k));
}

function sharedCopyFloat32(source: Float32Array): Float32Array {
  const shared = new SharedArrayBuffer(source.byteLength);
  const out = new Float32Array(shared);
  out.set(source);
  return out;
}

function sharedCopyFloat64(source: Float64Array): Float64Array {
  const shared = new SharedArrayBuffer(source.byteLength);
  const out = new Float64Array(shared);
  out.set(source);
  return out;
}

function canUseKmeansWorkers(): boolean {
  return typeof Worker !== "undefined" &&
    typeof SharedArrayBuffer !== "undefined" &&
    (typeof crossOriginIsolated === "undefined" || crossOriginIsolated);
}

function getDefaultKmeansWorkerCount(): number {
  if (!canUseKmeansWorkers()) return 1;
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 1 : 1;
  // #WDD-gpt 2026-05-01 - 只并行 SHN label assignment，保留一个核心给 UI 和浏览器调度
  return Math.max(1, Math.min(8, cores > 2 ? cores - 1 : cores));
}

function createKmeansWorker(): Worker {
  return new Worker(new URL("./sog4-kmeans-worker.ts", import.meta.url), { type: "module" });
}

async function runKmeansLabelWorkers(
  workers: Worker[],
  data: Float32Array,
  centroids: Float32Array,
  norms: Float64Array,
  labels: Uint32Array,
  partialSums: Float64Array | null,
  partialCounts: Uint32Array | null,
  n: number,
  d: number,
  k: number,
  scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>,
  pctStart = 0,
  pctEnd = 1,
  detailPrefix = "Palette"
): Promise<void> {
  const jobCount = Math.min(workers.length, n);
  if (jobCount <= 0) return;
  let completed = 0;
  let nextJobId = 1;
  const latestRows = new Uint32Array(jobCount);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      workers.forEach((worker) => {
        worker.onmessage = null;
        worker.onerror = null;
      });
    };
    workers.slice(0, jobCount).forEach((worker, workerIndex) => {
      const start = Math.floor((workerIndex / jobCount) * n);
      const end = Math.floor(((workerIndex + 1) / jobCount) * n);
      const id = nextJobId++;
      worker.onmessage = (event: MessageEvent<KmeansLabelWorkerResult>) => {
        if (event.data.id !== id) return;
        latestRows[workerIndex] = Math.max(0, Math.min(event.data.end - event.data.start, (event.data.row ?? event.data.end) - event.data.start));
        const rowsDone = latestRows.reduce((sum, row) => sum + row, 0);
        const pct = pctStart + (rowsDone / Math.max(n, 1)) * (pctEnd - pctStart);
        if (!event.data.done) {
          scheduler?.(false, pct, `${detailPrefix} - Active ${jobCount}/${jobCount} - Done ${completed}/${jobCount} - Rows ${rowsDone}/${n}`).catch(reject);
          return;
        }
        completed++;
        scheduler?.(false, pct, `${detailPrefix} - Active ${jobCount}/${jobCount} - Done ${completed}/${jobCount} - Rows ${rowsDone}/${n}`).catch(reject);
        if (completed === jobCount) {
          cleanup();
          resolve();
        }
      };
      worker.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || "SOG4 kmeans worker failed"));
      };
      scheduler?.(false, pctStart, `${detailPrefix} - Starting worker ${workerIndex + 1}/${jobCount}`).catch(reject);
      worker.postMessage({
        id,
        dataBuffer: data.buffer,
        centroidsBuffer: centroids.buffer,
        normsBuffer: norms.buffer,
        labelsBuffer: labels.buffer,
        partialSumsBuffer: partialSums?.buffer,
        partialCountsBuffer: partialCounts?.buffer,
        workerIndex,
        n,
        d,
        k,
        start,
        end,
      });
    });
  });
}


async function kmeansNd(data: Float32Array, n: number, d: number, kRequested: number, iterations: number, batchSize = 1024, seed?: number, workerCount = 1, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>): Promise<[Float32Array, Uint32Array]> {
  const k = Math.min(kRequested, n);
  if (k === 0) return [new Float32Array(0), new Uint32Array(0)];
  // #WDD-gpt 2026-04-30 - 只调整主线程切片和监控频率，避免进度上报重复 await 拖慢 kmeans
  const labelBatchSize = Math.max(16, Math.min(batchSize, Math.floor(800000 / Math.max(k * d, 1))));
  const requestedWorkers = Math.max(1, Math.floor(workerCount || 1));
  const actualWorkerCount = canUseKmeansWorkers() && requestedWorkers > 1
    ? Math.min(requestedWorkers, n)
    : 1;
  const useWorkers = actualWorkerCount > 1;
  const workers = useWorkers ? Array.from({ length: actualWorkerCount }, () => createKmeansWorker()) : [];

  const chosen = deterministicSample(n, k, seed);
  let centroids = new Float32Array(k * d);
  for (let i = 0; i < k; i++) {
    centroids.set(data.subarray(chosen[i]! * d, chosen[i]! * d + d), i * d);
  }
  const labels = new Uint32Array(n);
  const sharedData = useWorkers ? sharedCopyFloat32(data) : data;
  const sharedLabels = useWorkers ? new Uint32Array(new SharedArrayBuffer(labels.byteLength)) : labels;
  let next = new Float32Array(k * d);
  const sums = new Float64Array(k * d);
  const counts = new Uint32Array(k);

  try {
    if (useWorkers) {
      await scheduler?.(false, 0, `Palette Workers: ${actualWorkerCount}`);
    }
    for (let iter = 0; iter < iterations; iter++) {
      if ((scheduler as any)?.signal?.aborted) throw new Error("Export cancelled");
      if (scheduler) await scheduler(false, iter / iterations);
      const norms = new Float64Array(k);
      for (let c = 0; c < k; c++) {
        let norm = 0;
        const centroidOffset = c * d;
        for (let j = 0; j < d; j++) norm += centroids[centroidOffset + j]! * centroids[centroidOffset + j]!;
        norms[c] = norm;
      }

      {
        if (useWorkers) {
          const sharedCentroids = sharedCopyFloat32(centroids);
          const sharedNorms = sharedCopyFloat64(norms);
          // #WDD-gpt 2026-05-01 - 保持 centroid 更新阶段与原导出完全一致；worker 只并行 label assignment，避免局部归约改变结果
          const useWorkerReduction = false;
          const partialSums = null;
          const partialCounts = null;
          await runKmeansLabelWorkers(
            workers,
            sharedData,
            sharedCentroids,
            sharedNorms,
            sharedLabels,
            partialSums,
            partialCounts,
            n,
            d,
            k,
            scheduler,
            iter / iterations,
            (iter + 0.5) / iterations,
            `Palette Iter ${iter + 1}/${iterations} - Labels${useWorkerReduction ? "+Sums" : ""}`
          );
          if (useWorkerReduction && partialSums && partialCounts) {
            const sums = new Float64Array(k * d);
            const counts = new Uint32Array(k);
            for (let w = 0; w < actualWorkerCount; w++) {
              const countBase = w * k;
              const sumBase = countBase * d;
              for (let c = 0; c < k; c++) {
                const partialCount = partialCounts[countBase + c]!;
                if (partialCount === 0) continue;
                counts[c] += partialCount;
                const dst = c * d;
                const src = sumBase + c * d;
                for (let j = 0; j < d; j++) sums[dst + j] += partialSums[src + j]!;
              }
              await scheduler?.(false, (iter + 0.5 + ((w + 1) / actualWorkerCount) * 0.1) / iterations, `Palette Iter ${iter + 1}/${iterations} - Merging worker sums ${w + 1}/${actualWorkerCount}`);
            }
            const next = new Float32Array(k * d);
            for (let c = 0; c < k; c++) {
              const offset = c * d;
              if (counts[c] === 0) {
                next.set(centroids.subarray(offset, offset + d), offset);
              } else {
                for (let j = 0; j < d; j++) next[offset + j] = Math.fround(sums[offset + j]! / counts[c]!);
              }
            }
            centroids = next;
            continue;
          }
        } else {
          for (let start = 0; start < n; start += labelBatchSize) {
            const labelStartPct = (iter + (start / n)) / iterations;
            const labelEndPct = (iter + (Math.min(start + labelBatchSize, n) / n)) / iterations;
            if (scheduler) await scheduler(false, labelStartPct, `Palette Iter ${iter+1}/${iterations} - Label ${start + 1}/${n}`);
            const end = Math.min(start + labelBatchSize, n);
            const labelInput = {
              kind: "kmeansNdLabels",
              dataBuffer: sharedData.buffer,
              centroidsBuffer: centroids.buffer,
              normsBuffer: norms.buffer,
              labelsBuffer: sharedLabels.buffer,
              n,
              d,
              k,
              start,
              end,
            } as KmeansLabelWorkerData;
            if (k * d >= 500000) {
              await computeKmeansNdLabelsRangeResponsive(
                labelInput,
                scheduler,
                labelStartPct,
                labelEndPct,
                `Palette Iter ${iter+1}/${iterations} - Label ${start + 1}/${n}`
              );
            } else {
              computeKmeansNdLabelsRange(labelInput);
            }
            if (scheduler) await scheduler(false, labelEndPct, `Palette Iter ${iter+1}/${iterations} - Label ${end}/${n}`);
          }
        }
        if (scheduler) await scheduler(false, (iter + 0.5) / iterations);
      }

      sums.fill(0);
      counts.fill(0);
      for (let row = 0; row < n; row++) {
        if (row % 20000 === 0 && ((scheduler as any)?.signal?.aborted)) throw new Error("Export cancelled");
        if (row % 10000 === 0 && scheduler) await scheduler(false, (iter + 0.5 + (row / n * 0.5)) / iterations, `Palette Iter ${iter+1}/${iterations} - Summing ${Math.floor(row/1000)}k/${Math.floor(n/1000)}k`);
        const label = sharedLabels[row]!;
        counts[label]++;
        const pointOffset = row * d;
        const sumOffset = label * d;
        for (let j = 0; j < d; j++) sums[sumOffset + j] += sharedData[pointOffset + j]!;
      }

      for (let c = 0; c < k; c++) {
        const offset = c * d;
        if (counts[c] === 0) {
          next.set(centroids.subarray(offset, offset + d), offset);
        } else {
          for (let j = 0; j < d; j++) next[offset + j] = Math.fround(sums[offset + j]! / counts[c]!);
        }
      }
      const previous = centroids;
      centroids = next;
      next = previous;
    }
  } finally {
    workers.forEach((worker) => worker.terminate());
  }

  if (useWorkers) labels.set(sharedLabels);
  return [centroids, labels];
}

function concatColumns(columns: Float32Array[]): Float32Array {
  const total = columns.reduce((sum, col) => sum + col.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const col of columns) {
    out.set(col, offset);
    offset += col.length;
  }
  return out;
}

async function clusterSharedCodebook(columns: Float32Array[], k: number, iterations: number, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>, signal?: AbortSignal): Promise<[Float32Array, Uint32Array[]]> {
  const flattened = concatColumns(columns);
  const [centroids, allLabels] = await kmeans1d(flattened, k, iterations, scheduler, signal);
  const rows = columns[0]?.length ?? 0;
  const labelsList: Uint32Array[] = [];
  for (let i = 0; i < columns.length; i++) {
    labelsList.push(allLabels.slice(i * rows, (i + 1) * rows));
  }
  return [centroids, labelsList];
}

function logTransform(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    out[i] = Math.fround(Math.sign(v) * Math.log(Math.fround(Math.abs(v) + 1)));
  }
  return out;
}

function minMax(values: Float32Array): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

function normalizeU16(values: Float32Array, minV: number, maxV: number): Uint16Array {
  const out = new Uint16Array(values.length);
  const invRange = Math.fround(1 / (maxV - minV + EPS));
  for (let i = 0; i < values.length; i++) {
    const norm = Math.fround(Math.fround(values[i]! - minV) * invRange);
    const scaled = Math.min(65535, Math.max(0, Math.fround(norm * 65535)));
    out[i] = Math.trunc(scaled);
  }
  return out;
}

function addRawTexture(state: ConversionState, filename: string, data: Uint8Array, width = state.width, height = state.height): void {
  state.textures.set(filename, { data, width, height });
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}


async function addWebpFiles(zip: JSZip, state: ConversionState, concurrency?: number, yieldScheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>): Promise<void> {
  const entries = Array.from(state.textures.entries());
  for (let i = 0; i < entries.length; i++) {
    const [filename, texture] = entries[i];
    const startPct = i / Math.max(entries.length, 1);
    const endPct = (i + 1) / Math.max(entries.length, 1);
    await yieldScheduler?.(false, startPct, `Preparing ${filename} (${i + 1}/${entries.length})`);
    const canvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(texture.width, texture.height) : document.createElement('canvas') as any;
    canvas.width = texture.width;
    canvas.height = texture.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // #WDD-gpt 2026-04-30 - WebP 阶段在每个纹理转换前后刷新明细，避免压缩时看起来卡住
    const imgData = new ImageData(new Uint8ClampedArray(texture.data.buffer as ArrayBuffer, texture.data.byteOffset, texture.data.byteLength), texture.width, texture.height);
    ctx.putImageData(imgData, 0, 0);
    await yieldScheduler?.(false, startPct + (endPct - startPct) * 0.25, `Rasterizing ${filename}`);
    
    let blob: Blob;
    if (typeof OffscreenCanvas !== 'undefined') {
        blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/webp', quality: 1 });
    } else {
        blob = await new Promise<Blob>((resolve) => (canvas as HTMLCanvasElement).toBlob(b => resolve(b!), 'image/webp', 1));
    }
    
    await yieldScheduler?.(false, startPct + (endPct - startPct) * 0.8, `Storing ${filename}`);
    zip.file(filename, await blob.arrayBuffer(), { compression: "STORE" });
    await yieldScheduler?.(false, endPct, `Compressed ${filename} (${i + 1}/${entries.length})`);
  }
}

function arrayToJson(values: NumericArray): number[] {
  return Array.from(values, (v) => Number(v));
}

async function compressMeans(x: Float32Array, y: Float32Array, z: Float32Array, filenameBase: string, state: ConversionState, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>): Promise<Record<string, unknown>> {
  const lx = logTransform(x);
  const ly = logTransform(y);
  const lz = logTransform(z);
  const [minX, maxX] = minMax(lx);
  const [minY, maxY] = minMax(ly);
  const [minZ, maxZ] = minMax(lz);
  const nx = normalizeU16(lx, minX, maxX);
  const ny = normalizeU16(ly, minY, maxY);
  const nz = normalizeU16(lz, minZ, maxZ);
  const paddedSize = state.width * state.height;
  const low = new Uint8Array(paddedSize * 4);
  const high = new Uint8Array(paddedSize * 4);

  for (let i = 0; i < paddedSize; i++) {
    if (i % 10000 === 0 && scheduler) await scheduler(false, i / paddedSize, `Packing Means: ${Math.floor(i/1000)}k/${Math.floor(paddedSize/1000)}k`);
    const xv = i < state.count ? nx[i]! : 0;
    const yv = i < state.count ? ny[i]! : 0;
    const zv = i < state.count ? nz[i]! : 0;
    const p = i * 4;
    low[p] = xv & 0xff;
    low[p + 1] = yv & 0xff;
    low[p + 2] = zv & 0xff;
    low[p + 3] = 255;
    high[p] = (xv >> 8) & 0xff;
    high[p + 1] = (yv >> 8) & 0xff;
    high[p + 2] = (zv >> 8) & 0xff;
    high[p + 3] = 255;
  }

  const fl = `${filenameBase}_l.webp`;
  const fu = `${filenameBase}_u.webp`;
  addRawTexture(state, fl, low);
  addRawTexture(state, fu, high);
  return { mins: [minX, minY, minZ], maxs: [maxX, maxY, maxZ], files: [fl, fu] };
}

async function compressQuats(r0In: Float32Array, r1In: Float32Array, r2In: Float32Array, r3In: Float32Array, filename: string, state: ConversionState, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>): Promise<Record<string, unknown>> {
  const n = state.count;
  const paddedSize = state.width * state.height;
  const tex = new Uint8Array(paddedSize * 4);
  const dropMap = [
    [1, 2, 3],
    [0, 2, 3],
    [0, 1, 3],
    [0, 1, 2],
  ];

  for (let i = 0; i < n; i++) {
    if (i % 10000 === 0 && scheduler) await scheduler(false, i / paddedSize, `Packing Means: ${Math.floor(i/1000)}k/${Math.floor(paddedSize/1000)}k`);
    const len = Math.sqrt(r0In[i]! ** 2 + r1In[i]! ** 2 + r2In[i]! ** 2 + r3In[i]! ** 2) + EPS;
    const q = [
      Math.fround(r0In[i]! / len),
      Math.fround(r1In[i]! / len),
      Math.fround(r2In[i]! / len),
      Math.fround(r3In[i]! / len),
    ];
    let maxIndex = 0;
    let maxAbs = Math.abs(q[0]!);
    for (let c = 1; c < 4; c++) {
      const abs = Math.abs(q[c]!);
      if (abs > maxAbs) {
        maxAbs = abs;
        maxIndex = c;
      }
    }
    const sign = q[maxIndex]! < 0 ? -1 : 1;
    const p = i * 4;
    const others = dropMap[maxIndex]!;
    tex[p] = Math.trunc(255 * (Math.fround(q[others[0]!]! * sign * SQRT2) * 0.5 + 0.5));
    tex[p + 1] = Math.trunc(255 * (Math.fround(q[others[1]!]! * sign * SQRT2) * 0.5 + 0.5));
    tex[p + 2] = Math.trunc(255 * (Math.fround(q[others[2]!]! * sign * SQRT2) * 0.5 + 0.5));
    tex[p + 3] = 252 + maxIndex;
  }

  addRawTexture(state, filename, tex);
  return { files: [filename] };
}

async function compressScales(s0: Float32Array, s1: Float32Array, s2: Float32Array, filename: string, iterations: number, state: ConversionState, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>): Promise<Record<string, unknown>> {
  const [centroids, labels] = await clusterSharedCodebook([s0, s1, s2], 256, iterations, scheduler);
  const tex = new Uint8Array(state.width * state.height * 4);
  for (let i = 0; i < state.count; i++) {
    const p = i * 4;
    tex[p] = labels[0]![i]!;
    tex[p + 1] = labels[1]![i]!;
    tex[p + 2] = labels[2]![i]!;
  }
  for (let i = 0; i < state.width * state.height; i++) tex[i * 4 + 3] = 255;
  addRawTexture(state, filename, tex);
  return { codebook: arrayToJson(centroids), files: [filename] };
}

async function compressSh0Op(f0: Float32Array, f1: Float32Array, f2: Float32Array, op: Float32Array, filename: string, iterations: number, state: ConversionState, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>): Promise<Record<string, unknown>> {
  const [centroids, labels] = await clusterSharedCodebook([f0, f1, f2], 256, iterations, scheduler, (scheduler as any)?.signal);
  const tex = new Uint8Array(state.width * state.height * 4);
  for (let i = 0; i < state.count; i++) {
    const p = i * 4;
    tex[p] = labels[0]![i]!;
    tex[p + 1] = labels[1]![i]!;
    tex[p + 2] = labels[2]![i]!;
    tex[p + 3] = Math.trunc((1 / (1 + Math.exp(-op[i]!))) * 255);
  }
  addRawTexture(state, filename, tex);
  return { codebook: arrayToJson(centroids), files: [filename] };
}

async function compressShN(shData: Float32Array, n: number, numCoeffs: number, iterations: number, state: ConversionState, seed: number | undefined, shnWorkers: number, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const pow = Math.floor(Math.log2(n / 1024));
  const paletteSize = Math.max(Math.min(64, 2 ** pow) * 1024, 16);
  if (scheduler) await scheduler(false, 0.05);
  console.log(`  Clustering SH into ${paletteSize} clusters...`);
  if (scheduler) await scheduler(false, 0.1);

  const wrappedScheduler = scheduler ? async (force?: boolean, p?: number, detail?: string) => {
      await scheduler(force, 0.1 + (p ?? 0) * 0.7, detail || "SHN Palette Clustering");
  } : undefined;
  const [shCentroids, shLabels] = await kmeansNd(shData, n, numCoeffs, paletteSize, iterations, 1024, seed, shnWorkers, wrappedScheduler);
  
  if (scheduler) await scheduler(false, 0.85);
  // #WDD-gpt 2026-05-01 - 标注 SHN codebook 的进度区间，不改变 codebook 生成算法
  const [codebookCentroids, codebookLabels] = await kmeans1d(shCentroids, 256, iterations, scheduler ? async (f, p, d) => await scheduler(false, 0.85 + (p ?? 0) * 0.1, d || "SHN Codebook Generation") : undefined, signal);
  if (scheduler) await scheduler(false, 0.95);

  const coeffsPerColor = Math.floor(numCoeffs / 3);
  const cWidth = 64 * coeffsPerColor;
  const cHeight = Math.ceil(paletteSize / 64);
  const cTex = new Uint8Array(cWidth * cHeight * 4);
  for (let i = 0; i < paletteSize; i++) {
    if ((i & 255) === 0) {
      if (signal?.aborted) throw new Error("Export cancelled");
      await scheduler?.(false, 0.95 + (i / Math.max(paletteSize, 1)) * 0.025, `Packing SHN centroids ${i}/${paletteSize}`);
    }
    for (let j = 0; j < coeffsPerColor; j++) {
      const idxR = codebookLabels[i * numCoeffs + coeffsPerColor * 0 + j]!;
      const idxG = codebookLabels[i * numCoeffs + coeffsPerColor * 1 + j]!;
      const idxB = codebookLabels[i * numCoeffs + coeffsPerColor * 2 + j]!;
      const pixel = (Math.floor(i / 64) * cWidth + (i % 64) * coeffsPerColor + j) * 4;
      cTex[pixel] = idxR;
      cTex[pixel + 1] = idxG;
      cTex[pixel + 2] = idxB;
      cTex[pixel + 3] = 255;
    }
  }
  addRawTexture(state, "shN_centroids.webp", cTex, cWidth, cHeight);

  const lTex = new Uint8Array(state.width * state.height * 4);
  for (let i = 0; i < state.width * state.height; i++) {
    if ((i & 8191) === 0) {
      if (signal?.aborted) throw new Error("Export cancelled");
      await scheduler?.(false, 0.975 + (i / Math.max(state.width * state.height, 1)) * 0.025, `Packing SHN labels ${Math.min(i, n)}/${n}`);
    }
    const label = i < n ? shLabels[i]! : 0;
    const p = i * 4;
    lTex[p] = label & 0xff;
    lTex[p + 1] = (label >> 8) & 0xff;
    lTex[p + 3] = 255;
  }
  await scheduler?.(false, 1, "SHN palette textures ready");
  addRawTexture(state, "shN_labels.webp", lTex);

  const bandsMap: Record<number, number> = { 9: 1, 24: 2, 45: 3 };
  return {
    count: paletteSize,
    bands: bandsMap[numCoeffs] ?? 0,
    codebook: arrayToJson(codebookCentroids),
    files: ["shN_centroids.webp", "shN_labels.webp"],
  };
}

async function compressParams(mu: Float32Array, w: Float32Array, isParam: Float32Array, iterations: number, state: ConversionState, scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const [cMu, lMu] = await kmeans1d(mu, 256, iterations, scheduler, signal);
  const [cW, lW] = await kmeans1d(w, 256, iterations, scheduler, signal);
  const [cP, lP] = await kmeans1d(isParam, 256, iterations, scheduler);
  const tex = new Uint8Array(state.width * state.height * 4);
  for (let i = 0; i < mu.length; i++) {
    const p = i * 4;
    tex[p] = lMu[i]!;
    tex[p + 1] = lW[i]!;
    tex[p + 2] = lP[i]!;
  }
  for (let i = 0; i < state.width * state.height; i++) tex[i * 4 + 3] = 255;
  addRawTexture(state, "params.webp", tex);
  return {
    codebook_mu: arrayToJson(cMu),
    codebook_w: arrayToJson(cW),
    codebook_is_param: arrayToJson(cP),
    files: ["params.webp"],
  };
}

// #WDD-gpt 2026-05-01 - 按 /005 参考实现补回 SOG4 temporal bank 导出，使用相同 compressMeans/compressQuats 格式
async function compressVectorBankFrames(
  bankData: Float32Array,
  count: number,
  frameCount: number,
  filenameBase: string,
  state: ConversionState,
  scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>
): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let i = 0; i < count; i++) {
      const src = (i * frameCount + frame) * 3;
      x[i] = bankData[src + 0] ?? 0;
      y[i] = bankData[src + 1] ?? 0;
      z[i] = bankData[src + 2] ?? 0;
      if ((i & 8191) === 0) {
        await scheduler?.(false, (frame + i / Math.max(count, 1)) / Math.max(frameCount, 1), `${filenameBase} frame ${frame + 1}/${frameCount} rows ${i}/${count}`);
      }
    }
    frames.push(await compressMeans(x, y, z, `${filenameBase}_${frame}`, state, scheduler));
  }
  return frames;
}

async function compressRotationBankFrames(
  bankData: Float32Array,
  count: number,
  frameCount: number,
  filenameBase: string,
  state: ConversionState,
  scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>
): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  const w = new Float32Array(count);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let i = 0; i < count; i++) {
      const src = (i * frameCount + frame) * 4;
      w[i] = bankData[src + 0] ?? 1;
      x[i] = bankData[src + 1] ?? 0;
      y[i] = bankData[src + 2] ?? 0;
      z[i] = bankData[src + 3] ?? 0;
      if ((i & 8191) === 0) {
        await scheduler?.(false, (frame + i / Math.max(count, 1)) / Math.max(frameCount, 1), `${filenameBase} frame ${frame + 1}/${frameCount} rows ${i}/${count}`);
      }
    }
    frames.push(await compressQuats(w, x, y, z, `${filenameBase}_${frame}`, state, scheduler));
  }
  return frames;
}

function propertyNames(ply: PlyData): string[] {
  return ply.vertex.properties.map((p) => p.name);
}

function extractTrailingIndex(name: string): number {
  const match = name.match(/_(\d+)(?:_[a-z])?$/i);
  return match ? Number.parseInt(match[1]!, 10) : -1;
}

function resolveTotalFrames(data: any): number {
  const explicit = Number(data?.frames ?? data?.total_frames ?? data?.custom?.total_frames);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.round(explicit));
  const calcFrames = (keyframes: number, stride: number) => {
    const k = Number.isFinite(keyframes) ? Math.max(0, Math.round(keyframes)) : 0;
    const s = Number.isFinite(stride) && stride > 0 ? stride : 1;
    return k > 1 ? (k - 1) * s + 1 : (k === 1 ? 1 : 0);
  };
  return Math.max(
    1,
    calcFrames(data?.keyframes || 0, data?.xyzStride || 1),
    calcFrames(data?.rotKeyframes || 0, data?.rotStride || 1),
    calcFrames(data?.dcKeyframes || 0, data?.dcStride || 1)
  );
}

// #WDD-gpt 2026-04-30 - SHN 数据收集改为异步分块上报，避免进入 palette 前 UI 无反馈
async function collectShData(
  ply: PlyData,
  shKeys: string[],
  scheduler?: (force?: boolean, pct?: number, detail?: string) => Promise<void>,
  signal?: AbortSignal
): Promise<Float32Array> {
  const data = new Float32Array(ply.vertex.count * shKeys.length);
  const columns = shKeys.map((key) => requireColumn(ply, key));
  const totalRows = Math.max(ply.vertex.count, 1);
  for (let row = 0; row < ply.vertex.count; row++) {
    if ((row & 4095) === 0) {
      if (signal?.aborted) throw new Error("Export cancelled");
      await scheduler?.(false, row / totalRows, `Collecting SHN rows ${Math.floor(row / 1000)}k/${Math.floor(ply.vertex.count / 1000)}k (${shKeys.length} coeffs)`);
    }
    const offset = row * shKeys.length;
    for (let col = 0; col < shKeys.length; col++) {
      data[offset + col] = columns[col]![row]!;
    }
  }
  await scheduler?.(false, 1, `Collected ${ply.vertex.count} SHN rows (${shKeys.length} coeffs)`);
  return data;
}

function collectCommentMeta(comments: string[]): Record<string, string> {
  const custom: Record<string, string> = {};
  for (const comment of comments) {
    const parts = comment.split(/\s+/);
    if (parts.length >= 2 && parts[0]) {
      custom[parts[0]] = parts[1]!;
    }
  }
  return custom;
}

export type SOG4EncodeProgressMeta = { stageId?: string; stageLabel?: string; stagePct?: number; overallPct?: number; detail?: string; targetPoints?: number; sourcePoints?: number; };

export class SOG4Encoder {
    static async encode(data: any, overrides: any = {}, options: any = {}): Promise<Uint8Array> {
        const signal = options.signal as AbortSignal | undefined;
        const count = data.count || data.plyData?.elements[0]?.count || 0;
        if (count === 0) throw new Error("No data to encode.");
        
        let p: any = {};
        const columns = new Map<string, Float32Array>();
        if (data.plyData?.elements?.[0]?.properties) {
            const props = data.plyData.elements[0].properties;
            for (let i = 0; i < props.length; i++) {
                p[props[i].name] = props[i].storage;
                columns.set(props[i].name, props[i].storage);
            }
        } else {
            p = data;
            for (const key of Object.keys(data)) {
                if (data[key] instanceof Float32Array || data[key] instanceof Uint8Array) {
                    columns.set(key, data[key] as Float32Array);
                }
            }
        }
        
        // Provide defaults
        if (!columns.has('x') && p.x) columns.set('x', p.x);
        if (!columns.has('y') && p.y) columns.set('y', p.y);
        if (!columns.has('z') && p.z) columns.set('z', p.z);
        if (!columns.has('rot_0') && p.rot_0) columns.set('rot_0', p.rot_0);
        if (!columns.has('rot_1') && p.rot_1) columns.set('rot_1', p.rot_1);
        if (!columns.has('rot_2') && p.rot_2) columns.set('rot_2', p.rot_2);
        if (!columns.has('rot_3') && p.rot_3) columns.set('rot_3', p.rot_3);
        if (!columns.has('scale_0') && p.scale_0) columns.set('scale_0', p.scale_0);
        if (!columns.has('scale_1') && p.scale_1) columns.set('scale_1', p.scale_1);
        if (!columns.has('scale_2') && p.scale_2) columns.set('scale_2', p.scale_2);
        if (!columns.has('f_dc_0') && p.f_dc_0) columns.set('f_dc_0', p.f_dc_0);
        if (!columns.has('f_dc_1') && p.f_dc_1) columns.set('f_dc_1', p.f_dc_1);
        if (!columns.has('f_dc_2') && p.f_dc_2) columns.set('f_dc_2', p.f_dc_2);
        if (!columns.has('opacity') && p.opacity) columns.set('opacity', p.opacity);
        for (const k of Object.keys(p)) {
            if (k.startsWith('f_rest_') && !columns.has(k)) columns.set(k, p[k]);
        }
        
        const ply: PlyData = {
           format: 'binary_little_endian',
           comments: [],
           elements: [{ name: 'vertex', count, properties: Array.from(columns.keys()).map(name => ({name, type: 'float32'})) }],
           vertex: { count, properties: Array.from(columns.keys()).map(name => ({name, type: 'float32'})), columns }
        };
        
        const iterations = overrides.iterations ?? 10;
        const seed = overrides.seed ?? 12345678;
        const n = count;
        const width = Math.ceil(Math.sqrt(n) / 4) * 4;
        const height = Math.ceil(n / width / 4) * 4;
        const state: ConversionState = { width, height, count: n, textures: new Map() };
        
        const totalFrames = resolveTotalFrames(data);
        let customOut: any = { total_frames: totalFrames };
        const exportTransform = overrides.model_transform || (data && data.model_transform) || null;
        if (exportTransform) {
            const mt = exportTransform;
            if (mt.pos && mt.pos.length >= 3) customOut['model_pos'] = `${mt.pos[0]} ${mt.pos[1]} ${mt.pos[2]}`;
            if (mt.rot && mt.rot.length >= 4) customOut['model_rot'] = `${mt.rot[0]} ${mt.rot[1]} ${mt.rot[2]} ${mt.rot[3]}`;
            if (mt.scale && mt.scale.length >= 3) customOut['model_scale'] = `${mt.scale[0]} ${mt.scale[1]} ${mt.scale[2]}`;
        }
        const custom = Object.assign({}, data.custom || {}, overrides.custom || {}, customOut);
        
        const meta: Record<string, unknown> = {
            version: 2,
            asset: { generator: "master_ply_to_sog_native" },
            count: n,
            total_frames: totalFrames,
            custom
        };
        if (exportTransform) meta.model_transform = exportTransform;
        if (overrides.cameras || data.cameras) meta.cameras = overrides.cameras || data.cameras;
        if (overrides.postProcessing || data.postProcessing) meta.postProcessing = overrides.postProcessing || data.postProcessing;
        
        
        
        const createSubProgress = (start: number, end: number, label: string, stageId: string) => {
            const pfn = async (force?: boolean, subPct?: number, detail?: string) => {
                if (signal?.aborted) throw new Error("Export cancelled");
                const p = subPct ?? 0;
                const overall = start + p * (end - start);
                options.progress?.(overall, `${label} ${Math.round(p * 100)}%`, { stageId, stageLabel: label, stagePct: p * 100, overallPct: overall, detail });
                await new Promise(r => setTimeout(r, 0));
            };
            return Object.assign(pfn, { signal });
        };

        const meansProgress = createSubProgress(0, 10, "Means (XYZ)", "means");
        meta.means = await compressMeans(requireColumn(ply, "x"), requireColumn(ply, "y"), requireColumn(ply, "z"), "means", state, meansProgress);
        await meansProgress(false, 1.0);

        const quatsProgress = createSubProgress(10, 20, "Rotations", "rotations");
        let r0, r1, r2, r3;
        if (hasColumn(ply, "rot_0")) {
            r0 = requireColumn(ply, "rot_0"); r1 = requireColumn(ply, "rot_1"); r2 = requireColumn(ply, "rot_2"); r3 = requireColumn(ply, "rot_3");
        } else {
            r0 = makeFloat32(n, 1); r1 = makeFloat32(n); r2 = makeFloat32(n); r3 = makeFloat32(n);
        }
        meta.quats = await compressQuats(r0, r1, r2, r3, "quats", state, quatsProgress);
        await quatsProgress(false, 1.0);
        
        const scalesProgress = createSubProgress(20, 40, "Scales & Opacity", "scales_opacity");
        meta.scales = await compressScales(requireColumn(ply, "scale_0"), requireColumn(ply, "scale_1"), requireColumn(ply, "scale_2"), "scales", iterations, state, scalesProgress);
        meta.sh0 = await compressSh0Op(requireColumn(ply, "f_dc_0"), requireColumn(ply, "f_dc_1"), requireColumn(ply, "f_dc_2"), requireColumn(ply, "opacity"), "sh0", iterations, state, scalesProgress);
        await scalesProgress(false, 1.0);
        
        const names = Array.from(columns.keys());
        const shKeys = names.filter((name) => name.startsWith("f_rest_"));
        if (shKeys.length > 0) {
            const shnProgress = createSubProgress(40, 75, "SHN Palette", "shn");
            // #WDD-gpt 2026-05-01 - 默认只并行 label assignment，centroid 求和仍按原顺序执行，避免改变导出算法语义
            const defaultShnWorkers = getDefaultKmeansWorkerCount();
            const shnWorkers = Math.max(1, Math.floor(overrides.shnWorkers ?? defaultShnWorkers));
            await shnProgress(false, 0.01, canUseKmeansWorkers() ? `SHN workers ${shnWorkers}` : "SHN workers unavailable - SharedArrayBuffer requires COOP/COEP");
            const shData = await collectShData(
                ply,
                shKeys,
                async (force?: boolean, p?: number, detail?: string) => await shnProgress(force, (p ?? 0) * 0.08, detail || "Collecting SHN data"),
                signal
            );
            meta.shN = await compressShN(shData, n, shKeys.length, iterations, state, seed, shnWorkers, shnProgress, signal);
            await shnProgress(false, 1.0);
        }

        if (hasColumn(ply, "lifetime_mu")) {
            const paramsProgress = createSubProgress(75, 80, "Params", "params");
            meta.params = await compressParams(requireColumn(ply, "lifetime_mu"), requireColumn(ply, "lifetime_w"), hasColumn(ply, "is_param") ? requireColumn(ply, "is_param") : makeFloat32(n), iterations, state, paramsProgress, signal);
            await paramsProgress(false, 1.0);
        }

        const temporalProgress = createSubProgress(80, 90, "Temporal Banks", "xyz_bank");
        const xyzBankKeys = names.filter((name) => name.startsWith("xyz_bank_"));
        if (xyzBankKeys.length > 0) {
            const maxK = Math.max(...xyzBankKeys.map((key) => Number.parseInt(key.split("_")[2]!, 10)).filter(Number.isFinite));
            const bank: Record<string, unknown>[] = [];
            for (let k = 0; k <= maxK; k++) {
                const bx = `xyz_bank_${k}_x`;
                const by = `xyz_bank_${k}_y`;
                const bz = `xyz_bank_${k}_z`;
                if (hasColumn(ply, bx) && hasColumn(ply, by) && hasColumn(ply, bz)) {
                    bank.push(await compressMeans(requireColumn(ply, bx), requireColumn(ply, by), requireColumn(ply, bz), `xyz_bank_${k}`, state, temporalProgress));
                }
            }
            if (bank.length > 0) meta.xyz_bank = bank;
        } else if (data.keyframes > 0 && data.trajectory instanceof Float32Array && data.trajectory.length >= n * data.keyframes * 3) {
            meta.xyz_bank = await compressVectorBankFrames(data.trajectory, n, data.keyframes, "xyz_bank", state, temporalProgress);
            meta.xyz_bank_stride = data.xyzStride || 1;
            (custom as any).xyz_bank_keyframe_stride = data.xyzStride || 1;
        } else if (data.xyzBank instanceof Float32Array) {
            const keyframes = data.keyframes || Math.floor(data.xyzBank.length / Math.max(n * 3, 1));
            if (keyframes > 0) {
                meta.xyz_bank = await compressVectorBankFrames(data.xyzBank, n, keyframes, "xyz_bank", state, temporalProgress);
                meta.xyz_bank_stride = data.xyzStride || 1;
                (custom as any).xyz_bank_keyframe_stride = data.xyzStride || 1;
            }
        }

        const colorProgress = createSubProgress(80, 90, "Color Bank", "color_bank");
        const fDcBankKeys = names.filter((name) => name.startsWith("f_dc_bank_"));
        if (fDcBankKeys.length > 0) {
            const maxK = Math.max(...fDcBankKeys.map((key) => Number.parseInt(key.split("_")[3]!, 10)).filter(Number.isFinite));
            const bank: Record<string, unknown>[] = [];
            for (let k = 0; k <= maxK; k++) {
                const b0 = `f_dc_bank_${k}_0`;
                const b1 = `f_dc_bank_${k}_1`;
                const b2 = `f_dc_bank_${k}_2`;
                if (hasColumn(ply, b0) && hasColumn(ply, b1) && hasColumn(ply, b2)) {
                    bank.push(await compressMeans(requireColumn(ply, b0), requireColumn(ply, b1), requireColumn(ply, b2), `f_dc_bank_${k}`, state, colorProgress));
                }
            }
            if (bank.length > 0) meta.f_dc_bank = bank;
        } else if (data.dcKeyframes > 0 && data.dcTrajectory instanceof Float32Array && data.dcTrajectory.length >= n * data.dcKeyframes * 3) {
            meta.f_dc_bank = await compressVectorBankFrames(data.dcTrajectory, n, data.dcKeyframes, "f_dc_bank", state, colorProgress);
            meta.f_dc_bank_stride = data.dcStride || 1;
            (custom as any).features_dc_bank_keyframe_stride = data.dcStride || 1;
        } else if (data.dcBank instanceof Float32Array) {
            const keyframes = data.dcKeyframes || Math.floor(data.dcBank.length / Math.max(n * 3, 1));
            if (keyframes > 0) {
                meta.f_dc_bank = await compressVectorBankFrames(data.dcBank, n, keyframes, "f_dc_bank", state, colorProgress);
                meta.f_dc_bank_stride = data.dcStride || 1;
                (custom as any).features_dc_bank_keyframe_stride = data.dcStride || 1;
            }
        }

        const rotationBankProgress = createSubProgress(80, 90, "Rotation Bank", "rotation_bank");
        const rotBankKeys = names.filter((name) => name.startsWith("rot_bank_"));
        if (rotBankKeys.length > 0) {
            const maxK = Math.max(...rotBankKeys.map((key) => Number.parseInt(key.split("_")[2]!, 10)).filter(Number.isFinite));
            const bank: Record<string, unknown>[] = [];
            for (let k = 0; k <= maxK; k++) {
                const bw = `rot_bank_${k}_w`;
                const bx = `rot_bank_${k}_x`;
                const by = `rot_bank_${k}_y`;
                const bz = `rot_bank_${k}_z`;
                if (hasColumn(ply, bw) && hasColumn(ply, bx) && hasColumn(ply, by) && hasColumn(ply, bz)) {
                    bank.push(await compressQuats(requireColumn(ply, bw), requireColumn(ply, bx), requireColumn(ply, by), requireColumn(ply, bz), `rot_bank_${k}`, state, rotationBankProgress));
                }
            }
            if (bank.length > 0) meta.rot_bank = bank;
        } else if (data.rotKeyframes > 0 && (data.rotTrajectory instanceof Float32Array || data.rotBank instanceof Float32Array)) {
            const bankData = (data.rotTrajectory instanceof Float32Array ? data.rotTrajectory : data.rotBank) as Float32Array;
            if (bankData.length >= n * data.rotKeyframes * 4) {
                meta.rot_bank = await compressRotationBankFrames(bankData, n, data.rotKeyframes, "rot_bank", state, rotationBankProgress);
                meta.rot_bank_stride = data.rotStride || 1;
                (custom as any).rot_bank_keyframe_stride = data.rotStride || 1;
            }
        }
        
        const zip = new JSZip();
        // #WDD-gpt 2026-05-01 - WebP 和 ZIP 合并显示到 UI 的 zip 阶段，不改变打包内容
        const webpProgress = createSubProgress(90, 96, "WebP Compress", "zip");
        await addWebpFiles(zip, state, 1, webpProgress);
        await webpProgress(false, 1.0);
        
        zip.file("meta.json", JSON.stringify(meta, null, 2), { compression: "STORE" });
        const zipProgress = createSubProgress(96, 98, "Zip Generation", "zip");
        await zipProgress(false, 0.1);
        const content = await zip.generateAsync(
            { type: "uint8array", compression: "STORE" },
            (metadata) => {
                void zipProgress(false, 0.1 + (metadata.percent / 100) * 0.9, `Writing ZIP ${metadata.percent.toFixed(0)}%`).catch(() => undefined);
            }
        );
        await zipProgress(false, 1.0);
        return content;


    }
}
