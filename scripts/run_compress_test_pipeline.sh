
#!/bin/bash

set -e

# Default values
MODEL_PATH=${1:-"/home/crgj/wdd/output/test_depress/"}
ITERATION=${2:-50000}
SAVE_DIR="optimized_package"

# # 1. Run Extraction
# echo "Step 1: Running Extraction..."
# python post_save.py --mode extract --model_path "$MODEL_PATH" --iteration "$ITERATION" --save_dir "$SAVE_DIR"

OUTPUT_DIR="$MODEL_PATH/$SAVE_DIR"
STATIC_PLY="$OUTPUT_DIR/static.ply"
SOG_FILE="$OUTPUT_DIR/compressed.sog"

# # 2. PLY to SOG
# echo "Step 2: Converting PLY to SOG..."
# python ply_to_sog.py "$STATIC_PLY" "$SOG_FILE" -w

# 3. SOG to PLY
# Backup original static.ply
echo "Step 3: Converting SOG back to PLY..."
# mv "$STATIC_PLY" "${STATIC_PLY}.bak"
python scripts/sog_to_ply.py "$SOG_FILE" "$STATIC_PLY"

# 4. Run Reconstruction
echo "Step 4: Running Reconstruction..."
python scripts/post_save.py --mode reconstruct --input_dir "$OUTPUT_DIR"

echo "Pipeline completed successfully!"
