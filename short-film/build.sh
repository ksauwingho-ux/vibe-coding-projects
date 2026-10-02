#!/usr/bin/env bash
# 一键生成：./build.sh [frames_dir]
#   1) python3 audio.py          → genesis.wav（纯合成配乐）
#   2) node render.cjs <dir>     → 900 帧 PNG（1920x1080 @30fps）
#   3) ffmpeg                    → genesis.mp4（H.264 + AAC）
# 依赖：node + playwright(chromium)、python3 + numpy + scipy、ffmpeg、字体 Noto Sans CJK
set -euo pipefail
cd "$(dirname "$0")"
FRAMES="${1:-/tmp/genesis_frames}"

python3 audio.py
if [ ! -f "$FRAMES/f_0899.png" ]; then node render.cjs "$FRAMES" 30 30 4; fi

ffmpeg -y -loglevel error -framerate 30 -i "$FRAMES/f_%04d.png" -i genesis.wav \
  -vf "format=yuv420p" \
  -c:v libx264 -preset slow -crf 23 -x264-params aq-mode=3:aq-strength=1.1 -profile:v high -movflags +faststart \
  -c:a aac -b:a 192k -shortest genesis.mp4
ls -lh genesis.mp4
