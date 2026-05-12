import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# kmeans1d label fixup loop
text = text.replace(
    'for (let row = 0; row < data.length; row++) {\n    let best = 0;',
    'for (let row = 0; row < data.length; row++) {\n    if (row % 50000 === 0 && (signal?.aborted || options?.signal?.aborted)) throw new Error("Export cancelled");\n    let best = 0;'
)

# kmeansNd labels summation loop
text = text.replace(
    'for (let row = 0; row < n; row++) {\n      const label = sharedLabels[row]!;',
    'for (let row = 0; row < n; row++) {\n      if (row % 20000 === 0 && ((scheduler as any)?.signal?.aborted)) throw new Error("Export cancelled");\n      const label = sharedLabels[row]!;'
)

# Explicitly check signal in kmeansNd iterations
text = text.replace(
    'for (let iter = 0; iter < iterations; iter++) {',
    'for (let iter = 0; iter < iterations; iter++) {\n    if ((scheduler as any)?.signal?.aborted) throw new Error("Export cancelled");'
)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
