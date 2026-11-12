# -*- coding: utf-8 -*-
"""Иконки приложения «Входящие»: бумажный конверт на терракотовом фоне (стиль Пулта)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

ACCENT = "#b3652f"
PAPER = "#faf7f2"
PAPER_SHADE = "#f1e2d2"

SS = 4  # суперсэмплинг


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def envelope(draw, cx, cy, w, h, radius_scale=1.0):
    """Конверт: белый прямоугольник с клапаном."""
    l, t = cx - w / 2, cy - h / 2
    r = int(w * 0.07)
    rounded(draw, (l, t, l + w, t + h), r, PAPER)
    # полоски-письмо внутри
    pad = w * 0.14
    bar_h = h * 0.075
    for i, (yy, ww, color) in enumerate(
        [(0.30, 0.72, PAPER_SHADE), (0.52, 0.72, PAPER_SHADE), (0.74, 0.46, PAPER_SHADE)]
    ):
        y = t + h * yy
        draw.rounded_rectangle(
            (l + pad, y, l + pad + (w - 2 * pad) * ww, y + bar_h),
            radius=bar_h / 2, fill=color)
    # клапан
    lw = int(w * 0.055 * radius_scale)
    draw.line([(l + lw, t + lw), (cx, t + h * 0.52), (l + w - lw, t + lw)],
              fill=ACCENT, width=lw, joint="curve")


def make(size, maskable=False):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle((0, 0, s, s), fill=ACCENT)
        ew = s * 0.52
    else:
        rounded(d, (0, 0, s - 1, s - 1), int(s * 0.22), ACCENT)
        ew = s * 0.56
    envelope(d, s / 2, s / 2, ew, ew * 0.74)
    return img.resize((size, size), Image.LANCZOS)


for name, size, mask in [
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
    ("apple-touch-icon.png", 180, False),
    ("favicon-32.png", 32, False),
]:
    img = make(size, maskable=mask)
    img.save(OUT / name, "PNG", optimize=True)
    print("ok", name, img.size, (OUT / name).stat().st_size, "b")
