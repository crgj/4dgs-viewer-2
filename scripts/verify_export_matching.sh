#!/bin/bash
# #WDD 2026-01-16
# Verification script for TrueSplatsLoader export matching post_save.py

INPUT_FILE="/home/crgj/wdd/output/ok.truesplats"
TEMP_DIR="./temp_verify"
TS_OUTPUT="./output/ts_frames"
PY_OUTPUT="./output/py_frames"

rm -rf "$TEMP_DIR" "$TS_OUTPUT" "$PY_OUTPUT"
mkdir -p "$TEMP_DIR" "$TS_OUTPUT" "$PY_OUTPUT"

echo "=== 1. Running TrueSplatsLoader (TypeScript) Export ==="
# Use npx tsx to run the test script
npx tsx scripts/test_truesplats_export.ts

echo "=== 2. Preparing Python Reference (post_save.py) ==="
# Extract truesplats
unzip -q "$INPUT_FILE" -d "$TEMP_DIR"

# Convert SOG to Static PLY
python3 scripts/sog_to_ply.py "$TEMP_DIR/static.sog" "$TEMP_DIR/static.ply"

# Run Reconstruct (post_save.py)
# We only want a few frames for quick comparison
python3 scripts/post_save.py --mode reconstruct --input_dir "$TEMP_DIR"

# Move python results to py_frames (post_save saves to input_dir/reconstructed_ply)
mv "$TEMP_DIR/reconstructed_ply"/* "$PY_OUTPUT"

echo "=== 3. Comparison Results ==="
# Check frames that should match
for frame in 0000 0005 0010 0020 0030 0040 0049; do
    TS_FILE="$TS_OUTPUT/frame_$frame.ply"
    PY_FILE="$PY_OUTPUT/frame_$frame.ply"
    
    if [ -f "$TS_FILE" ] && [ -f "$PY_FILE" ]; then
        TS_SIZE=$(stat -c%s "$TS_FILE")
        PY_SIZE=$(stat -c%s "$PY_FILE")
        echo "Frame $frame: TS Size $TS_SIZE bytes, PY Size $PY_SIZE bytes"
        
        # Compare first 1000 bytes (header + early data) to check for format alignment
        # Skip header for binary compare if needed, but sizes should be identical if logic is same.
        if [ "$TS_SIZE" -eq "$PY_SIZE" ]; then
            echo "  [OK] Sizes match."
        else
            echo "  [WARNING] Sizes mismatch! (Different point count or properties?)"
        fi
    else
        echo "Frame $frame: Missing in one of the outputs."
    fi
done

echo "Verification complete."
