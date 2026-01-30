
#!/bin/bash

set -e

# Change to script directory to find python files
cd "$(dirname "$0")"

# Default values
MODEL_PATH=${1:-"/home/gs/gs/data/ErHu/test2_output_frames_180_210/"}
ITERATION=${2:-150000}
WORK_DIR="$MODEL_PATH/compression_test_v2"
mkdir -p "$WORK_DIR"

MASTER_PLY="$WORK_DIR/master.ply"
SOG_FILE="$WORK_DIR/compressed.sog"
MASTER_RECON_PLY="$WORK_DIR/master_recon.ply"
FRAMES_DIR="$WORK_DIR/recon_frames"
mkdir -p "$FRAMES_DIR"

# 1. Run Extraction (Checkpoint -> Master PLY)
echo "Step 1: Running Extraction (Checkpoint -> Master PLY)..."
python extract_checkpoint_ply.py extract \
    --model_path "$MODEL_PATH" \
    --iteration "$ITERATION" \
    --output_path "$MASTER_PLY"

# 2. Master PLY to SOG
echo "Step 2: Converting Master PLY to SOG..."
python master_ply_to_sog.py "$MASTER_PLY" "$SOG_FILE" --iterations 5

# 3. SOG to Master PLY
echo "Step 3: Converting SOG back to Master PLY..."
python sog_to_master_ply.py "$SOG_FILE" "$MASTER_RECON_PLY"

# 4. Run Reconstruction (Master PLY -> Per-Frame PLYs)
echo "Step 4: Running Reconstruction (Master PLY -> Frames)..."
python extract_checkpoint_ply.py reconstruct \
    --master_ply "$MASTER_RECON_PLY" \
    --output_dir "$FRAMES_DIR"

echo "Pipeline completed successfully!"
echo "Outputs are in $WORK_DIR"
