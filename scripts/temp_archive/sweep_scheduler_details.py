import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# compressMeans
text = text.replace(
    'if (i % 10000 === 0 && scheduler) await scheduler(false, i / paddedSize);',
    'if (i % 10000 === 0 && scheduler) await scheduler(false, i / paddedSize, `Packing Means: ${Math.floor(i/1000)}k/${Math.floor(paddedSize/1000)}k`);'
)

# addWebpFiles
text = text.replace(
    'if (yieldScheduler) await yieldScheduler(false, i / entries.length);',
    'if (yieldScheduler) await yieldScheduler(false, i / entries.length, `Compressing: ${filename}`);'
)

# kmeans1d ordering loop hardening check (added previously) - update its scheduler call if any
# (I already updated one of them)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
