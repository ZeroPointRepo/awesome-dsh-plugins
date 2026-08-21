#!/usr/bin/env python3
"""Composite the wordmark onto the DSH nebula art (no text baked into the art itself).
Same type rules as the rest of the DSH portfolio: Liberation Sans, periwinkle accent (#6799FE),
no em dashes. Produces the banner (1920x480, renders at width=800) and the social card (1280x640).
"""
import sys
from PIL import Image, ImageDraw, ImageFont

SRC = "/opt/projects/crhq-satellite/images/dsh-design/final/dsh-nebula-art-source.png"
FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
PERIWINKLE = (103, 153, 254)
WHITE = (245, 247, 250)
SUBTITLE_GRAY = (176, 190, 214)

TITLE = "Awesome DSH Plugins"
SUBTITLE = "16 verified plugins. One command each."


def make_banner(out_path, size, title_size, subtitle_size, pad_left, pad_top, rule_w):
    art = Image.open(SRC).convert("RGB")
    # Scale art to cover the target canvas, cropping from the right-weighted source.
    tw, th = size
    sw, sh = art.size
    scale = max(tw / sw, th / sh)
    art = art.resize((int(sw * scale), int(sh * scale)), Image.LANCZOS)
    # Crop to target, anchored so the nebula (right side of source) stays visible.
    left = art.width - tw
    top = (art.height - th) // 2
    canvas = art.crop((left, top, left + tw, top + th))

    draw = ImageDraw.Draw(canvas)
    title_font = ImageFont.truetype(FONT_BOLD, title_size)
    subtitle_font = ImageFont.truetype(FONT_REG, subtitle_size)

    y = pad_top
    # Periwinkle rule above the headline.
    draw.rectangle([pad_left, y, pad_left + rule_w, y + 4], fill=PERIWINKLE)
    y += 4 + int(title_size * 0.45)

    draw.text((pad_left, y), TITLE, font=title_font, fill=WHITE)
    y += int(title_size * 1.15)
    draw.text((pad_left, y), SUBTITLE, font=subtitle_font, fill=SUBTITLE_GRAY)

    canvas.save(out_path)
    print(f"wrote {out_path} {canvas.size}")


if __name__ == "__main__":
    make_banner("/opt/projects/crhq-satellite/.scratch/awesome-dsh-plugins/banner.png",
                (1920, 480), 74, 30, 96, 140, 170)
    make_banner("/opt/projects/crhq-satellite/.scratch/awesome-dsh-plugins/social-preview.png",
                (1280, 640), 62, 26, 80, 220, 150)
