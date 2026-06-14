from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import json
import subprocess

root = Path.cwd()
out_dir = root / "artifacts" / "feature-demo-2026-06-13"
frames_dir = out_dir / "screens"
render_dir = out_dir / "rendered"
render_dir.mkdir(parents=True, exist_ok=True)

slides = json.loads((out_dir / "slides.json").read_text(encoding="utf-8"))
font_regular = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
font_bold = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
title_font = ImageFont.truetype(font_bold, 30)
body_font = ImageFont.truetype(font_regular, 24)
small_font = ImageFont.truetype(font_regular, 18)

fps = 24
width, height = 1280, 720

def wrap_text(draw, text, font, max_width):
    lines = []
    current = ""
    for ch in text:
        candidate = current + ch
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = ch
    if current:
        lines.append(current)
    return lines

def draw_caption(img, caption, index, total):
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    box_h = 118
    y0 = height - box_h
    draw.rounded_rectangle((28, y0 + 10, width - 28, height - 22), radius=18, fill=(4, 10, 18, 214), outline=(16, 185, 129, 130), width=2)
    draw.text((54, y0 + 28), f"近 3 天新功能演示  {index:02d}/{total:02d}", font=small_font, fill=(167, 243, 208, 255))
    lines = wrap_text(draw, caption, body_font, width - 120)
    for i, line in enumerate(lines[:2]):
        draw.text((54, y0 + 56 + i * 30), line, font=body_font, fill=(245, 247, 250, 255))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

frame_index = 0
total = len(slides)
for idx, slide in enumerate(slides, 1):
    source = Image.open(slide["file"]).convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
    source = draw_caption(source, slide["caption"], idx, total)
    frame_count = max(1, int(float(slide.get("duration", 3.0)) * fps))
    for _ in range(frame_count):
        frame_index += 1
        source.save(render_dir / f"frame_{frame_index:05d}.png", quality=95)

video = out_dir / "truesplats-new-features-cn.mp4"
subprocess.run([
    "ffmpeg", "-y",
    "-framerate", str(fps),
    "-i", str(render_dir / "frame_%05d.png"),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    str(video)
], check=True)

print(video)
