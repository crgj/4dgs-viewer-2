# Web Player Migration Guide: SOG (Format A) -> Native SOG (Format B)

This guide outlines the changes required to upgrade a web player from "Format A" (Split SOG + `data.bin`) to "Format B" (Native SOG with embedded banks).

## Overview

| Feature | Format A (Old) | Format B (New) |
| :--- | :--- | :--- |
| **Static Data** | `compressed.sog` (WebP) | `compressed.sog` (WebP) |
| **Temporal Data** | `data.bin` (Binary, Zlib+DPCM) | Embedded in `compressed.sog` as WebP textures |
| **Extraction** | Two HTTP requests (`.sog`, `.bin`) | One HTTP request (`.sog`) |
| **Decoding** | DPCM decoding for banks | Texture decoding (same as Means/Quats) |

## 1. Metadata Changes (`meta.json`)

**Format A** `meta.json` typically has a `keyframe` field pointing to `keyframe.bin` (which is extracted to `data.bin`).

**Format B** removes `keyframe` and adds `xyz_bank` and `rot_bank` arrays.

```json
// Format B meta.json structure
{
  "count": 12345,
  "means": { ... }, 
  "quats": { ... },
  // ... standard fields ...
  
  // NEW: List of standard 'means'-style objects
  "xyz_bank": [
    { "mins": [...], "maxs": [...], "files": ["xyz_bank_0_l.webp", "xyz_bank_0_u.webp"] },
    { "mins": [...], "maxs": [...], "files": ["xyz_bank_1_l.webp", "xyz_bank_1_u.webp"] }
  ],
  
  // NEW: List of standard 'quats'-style objects
  "rot_bank": [
    { "files": ["rot_bank_0.webp"] },
    { "files": ["rot_bank_1.webp"] }
  ]
}
```

## 2. Implementation Steps

### Step 1: Remove `data.bin` Logic
-   Stop requesting/downloading `data.bin`.
-   Remove the custom binary parser (header parsing, Magic check, DPCM decompression).
-   Remove the Zlib decompression step for the binary blob.

### Step 2: Implement Bank Decoding
The banks in Format B use the **identical** encoding schemes as the static attributes. You can reuse your existing texture decoding functions.

#### XYZ Bank
Iterate over `meta.xyz_bank` array. For each entry (representing keyframe `k`):
1.  Parse `mins`, `maxs`, and `files` (Low/High textures).
2.  **Reuse `reconstruct_means` logic**:
    -   Load Low/High textures.
    -   Combine to 16-bit normalized integer.
    -   Denormalize using `mins`/`maxs`.
    -   Apply **Inverse Log Transform**: `sign(v) * (exp(abs(v)) - 1)`.
3.  Store result as `xyz_bank_k`.

#### ROT Bank
Iterate over `meta.rot_bank` array. For each entry (representing keyframe `k`):
1.  Parse `files` (Quat texture).
2.  **Reuse `reconstruct_quats` logic**:
    -   Load texture.
    -   Recover 3 components (norm/scale/offset).
    -   Recover missing component using `sqrt(1 - sum_sq)`.
    -   Apply permutation based on the stored index (alpha channel).
3.  Store result as `rot_bank_k`.

### Step 3: Data Layout
Ensure the decoded bank data is flattened or uploaded to the GPU in the same layout expected by your vertex shader.

-   If your shader expects `xyz_bank_0`, `xyz_bank_1`... as attributes, simply bind the decoded arrays from Step 2 to these locations.
-   The physical units and coordinate systems remain identical (World Space).

### Pseudocode (JavaScript/TypeScript)

```javascript
// OLD: Loading data.bin
// const binData = await fetchBinary("data.bin");
// const banks = parseDataBin(binData); 

// NEW: Loading embedded banks
if (meta.xyz_bank) {
  for (let k = 0; k < meta.xyz_bank.length; k++) {
    const bankMeta = meta.xyz_bank[k];
    // REUSE existing Means decoder
    const xyz_k = await reconstructMeans(zip, bankMeta, meta.count);
    gpu.uploadAttribute(`xyz_bank_${k}`, xyz_k);
  }
}

if (meta.rot_bank) {
  for (let k = 0; k < meta.rot_bank.length; k++) {
    const bankMeta = meta.rot_bank[k];
    // REUSE existing Quats decoder
    const rot_k = await reconstructQuats(zip, bankMeta, meta.count);
    gpu.uploadAttribute(`rot_bank_${k}`, rot_k);
  }
}
```

## 3. Advantages
-   **Unified Compression**: Better compression ratios typical of WebP vs raw DPCM.
-   **Simplicity**: Uses one decoding path for all 3D data.
-   **Streaming**: Banks can be lazy-loaded as textures if needed (though typically loaded upfront).
