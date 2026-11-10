# -*- coding: utf-8 -*-
"""生成人格占位头像：纯色圆底 + 名字首字。之后用人自己的图覆盖即可。"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.environ['USERPROFILE'], '.dsh', 'personas')

SPECS = [
    ('noa',   '诺', (127, 179, 213)),
    ('arona', '阿', (245, 183, 177)),
    ('plana', '普', (169, 169, 245)),
]

SIZE = 256
FONT_CANDIDATES = [
    r'C:\Windows\Fonts\msyhbd.ttc',
    r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\simhei.ttf',
]

def load_font(px):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px)
            except Exception:
                continue
    return ImageFont.load_default()

font = load_font(120)

for pid, ch, rgb in SPECS:
    img = Image.new('RGB', (SIZE, SIZE), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, SIZE - 1, SIZE - 1], fill=rgb)
    box = d.textbbox((0, 0), ch, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((SIZE - w) / 2 - box[0], (SIZE - h) / 2 - box[1]), ch, font=font, fill=(255, 255, 255))
    out = os.path.join(OUT, pid, 'avatar.png')
    img.save(out, 'PNG')
    print(pid, os.path.getsize(out), 'bytes ->', out)
