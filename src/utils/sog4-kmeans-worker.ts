interface KmeansLabelJob {
  id: number;
  dataBuffer: SharedArrayBuffer;
  centroidsBuffer: SharedArrayBuffer;
  normsBuffer: SharedArrayBuffer;
  labelsBuffer: SharedArrayBuffer;
  partialSumsBuffer?: SharedArrayBuffer;
  partialCountsBuffer?: SharedArrayBuffer;
  workerIndex?: number;
  n: number;
  d: number;
  k: number;
  start: number;
  end: number;
}

// #WDD-gpt 2026-05-01 - SOG4 SHN kmeans 的 label assignment 并行执行，保持距离公式和输出完全一致
self.onmessage = (event: MessageEvent<KmeansLabelJob>) => {
  const input = event.data;
  const data = new Float32Array(input.dataBuffer);
  const centroids = new Float32Array(input.centroidsBuffer);
  const norms = new Float64Array(input.normsBuffer);
  const labels = new Uint32Array(input.labelsBuffer);
  const { d, k, start, end } = input;
  const partialSums = input.partialSumsBuffer ? new Float64Array(input.partialSumsBuffer) : null;
  const partialCounts = input.partialCountsBuffer ? new Uint32Array(input.partialCountsBuffer) : null;
  const partialBase = (input.workerIndex ?? 0) * k;
  let lastProgressAt = Date.now();

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
    if (partialSums && partialCounts) {
      const countIndex = partialBase + best;
      partialCounts[countIndex]++;
      const sumOffset = countIndex * d;
      for (let j = 0; j < d; j++) partialSums[sumOffset + j] += data[pointOffset + j]!;
    }
    const now = Date.now();
    if (now - lastProgressAt >= 250) {
      self.postMessage({ id: input.id, start, end, row, done: false });
      lastProgressAt = now;
    }
  }

  self.postMessage({ id: input.id, start, end, row: end, done: true });
};

export {};
