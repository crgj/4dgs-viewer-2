import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# Increase yield frequency in compressMeans
text = text.replace('i % 50000 === 0', 'i % 10000 === 0')

# Increase yield frequency in compressQuats
text = text.replace('i % 50000 === 0', 'i % 10000 === 0')

# Add internal yield to kmeansNd batch loop
text = re.sub(
    r'for \(let start = 0; start < n; start \+= batchSize\) \{',
    r'for (let start = 0; start < n; start += batchSize) {\n        if (start % (batchSize * 20) === 0 && scheduler) await scheduler(false, (iter + (start / n)) / iterations);',
    text
)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
