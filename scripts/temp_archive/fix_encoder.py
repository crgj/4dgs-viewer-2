import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# Fix parsing artifacts (remove parsePly, readScalar, worker data usage)
text = re.sub(r'if \(!isMainThread.*?\}\n', '', text, flags=re.DOTALL)
text = re.sub(r'function readScalar.*?\}\n(?=\nfunction makeFloat32)', '', text, flags=re.DOTALL)
text = re.sub(r'function parsePly.*?\}\n(?=\nfunction makeFloat32)', '', text, flags=re.DOTALL)

# Fix Uint8Array type conflict at line 791 (re.sub on columns.set)
text = re.sub(r'columns\.set\(key, data\[key\]\);', r'columns.set(key, data[key] as Float32Array);', text)

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
