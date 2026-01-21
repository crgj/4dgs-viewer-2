#!/bin/bash

# Configuration
# Path to the model directory (containing chkpnt{ITERATION}.pth)
MODEL_PATH="/home/gs/gs/data/TaoRed/frame30_out0115_04_keyframe"
OUTPUT_DIR="${MODEL_PATH}/compress"
ITERATION=50000

# File Paths
MASTER_PLY_ORIG="${OUTPUT_DIR}/master_checkpoint_orig.ply"
SOG_FILE="${OUTPUT_DIR}/compressed.sog"
MASTER_PLY_RECON="${OUTPUT_DIR}/master_checkpoint_recon.ply"
OUTPUT_DIR_PLY="${OUTPUT_DIR}/reconstructed_frames_from_sog"

# Python interpreter (using fastgs environment)
PYTHON_BIN="/home/gs/miniconda3/envs/fastgs/bin/python"

# Script Paths
EXTRACT_SCRIPT="extract_checkpoint_ply.py"
PLY2SOG_SCRIPT="master_ply_to_sog.py"
SOG2PLY_SCRIPT="sog_to_master_ply.py"

# Error handling
set -e

echo "========================================"
echo "Step 1: Extract Checkpoint to Master PLY"
echo "========================================"
$PYTHON_BIN $EXTRACT_SCRIPT extract \
    --model_path "$MODEL_PATH" \
    --iteration $ITERATION \
    --output_path "$MASTER_PLY_ORIG"

echo ""
echo "========================================"
echo "Step 2: Compress Master PLY to SOG"
echo "========================================"
# Using 5 iterations for speed in this demo, increase to 10-20 for production quality
$PYTHON_BIN $PLY2SOG_SCRIPT "$MASTER_PLY_ORIG" "$SOG_FILE" --iterations 5

echo "SOG File Size: $(du -h $SOG_FILE | cut -f1)"

echo ""
echo "========================================"
echo "Step 3: Decompress SOG to Master PLY"
echo "========================================"
$PYTHON_BIN $SOG2PLY_SCRIPT "$SOG_FILE" "$MASTER_PLY_RECON"

echo ""
echo "========================================"
echo "Step 4: Reconstruct Per-Frame PLYs from Decompressed Master PLY"
echo "========================================"

# Clean output dir if exists
if [ -d "$OUTPUT_DIR_PLY" ]; then
    echo "Cleaning existing output directory: $OUTPUT_DIR_PLY"
    rm -rf "$OUTPUT_DIR_PLY"
fi

$PYTHON_BIN $EXTRACT_SCRIPT reconstruct \
    --master_ply "$MASTER_PLY_RECON" \
    --output_dir "$OUTPUT_DIR_PLY"

echo ""
echo "========================================"
echo "Full Pipeline Completed Successfully!"
echo "Original Master PLY: $MASTER_PLY_ORIG"
echo "Compressed SOG:      $SOG_FILE"
echo "Reconstructed PLY:   $MASTER_PLY_RECON"
echo "Final Frames:        $OUTPUT_DIR_PLY"
echo "========================================"
