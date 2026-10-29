"""Generate the ScoreX toolbar/notification icons (run: python3 tools/make-icons.py)."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
os.makedirs(OUT, exist_ok=True)

def icon(size):
    s = size * 4  # supersample
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(s * 0.22)
    # rounded square, indigo -> violet feel with a flat fill
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=(79, 70, 229, 255))
    # rising bars (score) + an X-ish spark
    pad = s * 0.2
    bw = s * 0.14
    gap = s * 0.06
    base = s - pad
    heights = [0.28, 0.44, 0.62]
    x = pad
    for h in heights:
        d.rounded_rectangle([x, base - s * h, x + bw, base], radius=int(bw * 0.35), fill=(255, 255, 255, 255))
        x += bw + gap
    # spark dot top-right
    cx, cy, rr = s * 0.74, s * 0.28, s * 0.09
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(250, 204, 21, 255))
    return img.resize((size, size), Image.LANCZOS)

for n in (16, 32, 48, 128):
    icon(n).save(os.path.join(OUT, f"icon{n}.png"))
print("icons written to", os.path.abspath(OUT))
