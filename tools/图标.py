# -*- coding: utf-8 -*-
"""做「小李」的桌面图标（.ico）。

两种用法：
    1) 不带参数 —— 画默认那个图标：液态玻璃的圆角方块 + 白色的「李」。
       每个尺寸都是从几何重新渲染一遍（在 4~8 倍大的画布上画好再缩回去，
       等于自带抗锯齿），小尺寸那几档还会关掉细描边和投影，免得糊成灰团。
       256 的图直接缩小到 24px 一定糊，所以不能偷懒只做一张。

    2) 用一张自己的图片 —— 比如想拿某张照片/图当图标：

    python tools\\图标.py --图片 "C:\\某张图.jpg" --输出 "D:\\小李\\小李.ico"

    ico 每一档都得是正方形，竖图/横图得先裁：这里不机械地取正中，而是按
    「哪一块画面信息多」挑窗口（细节 + 肤色像素的打分，再往中间偏一点），
    尽量别把人或主体裁掉。裁掉的部分有多少会打印出来。

其它参数：
    --预览 某个目录     顺手把预览图写进去（三种底色，看对比用）
"""

from __future__ import annotations

import os
import struct
import sys
import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ICO = os.path.join(ROOT, "小李.ico")

# 256 那份一定要有：Windows 的「大图标 / 超大图标」视图直接用它
SIZES = [16, 20, 24, 28, 32, 40, 48, 64, 96, 128, 256]

GLYPH = "李"
FONT_FILES = [
    r"C:\Windows\Fonts\msyhbd.ttc",   # 微软雅黑 Bold
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\Deng.ttf",
]

# 液态玻璃的配色：顶上被光打白，往下逐渐沉到品牌蓝，最底下压深。
# 中间那一段不能太亮，白字要压在上面，亮过头字就糊进高光里了。
STOPS = [
    (0.00, (118, 156, 245)),
    (0.30, (78, 118, 226)),
    (0.62, (48, 84, 190)),
    (1.00, (26, 48, 130)),
]


def squircle_mask(n: int, radius: int) -> Image.Image:
    """圆角方块。比例照 Apple / Windows 11 那套来：圆角约等于边长的 23%。"""
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=radius, fill=255)
    return mask


def gradient(n: int) -> np.ndarray:
    """竖向的玻璃底色，再叠一层从左上到右下的斜向提亮。"""
    t = np.clip(np.linspace(0.0, 1.0, n) * 1.04 - 0.02, 0.0, 1.0)
    xs = np.array([stop[0] for stop in STOPS])
    col = np.zeros((n, 3))
    for channel in range(3):
        values = np.array([stop[1][channel] for stop in STOPS])
        col[:, channel] = np.interp(t, xs, values)

    axis = np.linspace(0.0, 1.0, n)
    diag = (axis[:, None] + axis[None, :]) / 2.0      # 0 = 左上，1 = 右下
    light = 1.0 + 0.13 * (0.5 - diag)                 # 左上角亮一点点
    rgb = np.clip(col[:, None, :] * light[:, :, None], 0, 255)
    return rgb


def soft_shape(size: tuple[int, int], draw_fn, blur: float) -> Image.Image:
    """在透明层上画个形状，再模糊——高光、边缘光都靠这个伪造。"""
    layer = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(layer))
    if blur:
        layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return layer


def draw_glyph(n: int, mask: Image.Image) -> Image.Image:
    """白「李」+ 一点投影，投影只为了让字在浅色玻璃上也立得住。"""
    font_path = next((p for p in FONT_FILES if os.path.exists(p)), None)
    if font_path is None:
        raise SystemExit("找不到中文字体（微软雅黑 / 黑体），没法画那个「李」字。")

    target = n * 0.56
    font_size = max(8, int(target))
    font = ImageFont.truetype(font_path, font_size)
    # 字号往上涨一点就够粗，先量一遍实际高度再定字号
    for _ in range(24):
        box = font.getbbox(GLYPH)
        height = box[3] - box[1]
        if height >= target or font_size > n:
            break
        font_size += max(1, int(target * 0.02))
        font = ImageFont.truetype(font_path, font_size)

    box = font.getbbox(GLYPH)
    x = (n - (box[2] - box[0])) / 2 - box[0]
    y = (n - (box[3] - box[1])) / 2 - box[1]

    shadow = soft_shape(
        (n, n),
        lambda d: d.text((x, y + max(1, n * 0.018)), GLYPH, font=font, fill=255),
        blur=max(0.5, n * 0.020),
    )
    shadow = shadow.point(lambda v: int(v * 0.55))

    glyph = soft_shape(
        (n, n),
        lambda d: d.text((x, y), GLYPH, font=font, fill=255),
        blur=max(0.4, n * 0.006),
    )

    out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    shadow_layer = Image.new("RGBA", (n, n), (14, 32, 82, 0))
    shadow_layer.putalpha(Image.composite(shadow, Image.new("L", (n, n), 0), mask))
    out = Image.alpha_composite(out, shadow_layer)
    glyph_layer = Image.new("RGBA", (n, n), (255, 255, 255, 0))
    glyph_layer.putalpha(glyph)
    return Image.alpha_composite(out, glyph_layer)


def render(size: int) -> Image.Image:
    # 小尺寸用更高的倍率画，缩回来才干净
    ss = 8 if size <= 32 else 4
    n = size * ss
    radius = int(round(0.230 * n))
    mask = squircle_mask(n, radius)

    rgb = gradient(n)
    alpha = np.clip(0.90 + 0.06 * np.linspace(0.0, 1.0, n)[:, None], 0, 1) * 255
    body = np.dstack([rgb, np.repeat(alpha[:, :, None], n, axis=1)])
    tile = Image.fromarray(body.astype(np.uint8), "RGBA")
    tile.putalpha(Image.composite(tile.getchannel("A"), Image.new("L", (n, n), 0), mask))

    gloss = soft_shape(
        (n, n),
        lambda d: d.ellipse([n * 0.05, -n * 0.26, n * 0.95, n * 0.30], fill=255),
        blur=n * 0.040,
    ).point(lambda v: int(v * 0.34))
    gloss_layer = Image.new("RGBA", (n, n), (255, 255, 255, 0))
    gloss_layer.putalpha(Image.composite(gloss, Image.new("L", (n, n), 0), mask))
    tile = Image.alpha_composite(tile, gloss_layer)

    # 斜着的一道高光，玻璃那种「湿」的质感主要靠它
    streak = Image.new("L", (n, n), 0)
    sd = ImageDraw.Draw(streak)
    sd.polygon(
        [(0, n * 0.46), (0, n * 0.26), (n * 0.86, -n * 0.10), (n * 1.02, n * 0.02)],
        fill=58,
    )
    streak = streak.filter(ImageFilter.GaussianBlur(n * 0.045))
    streak_layer = Image.new("RGBA", (n, n), (255, 255, 255, 0))
    streak_layer.putalpha(Image.composite(streak, Image.new("L", (n, n), 0), mask))
    tile = Image.alpha_composite(tile, streak_layer)

    # 底部一点点回光，玻璃才像有厚度
    bottom = soft_shape(
        (n, n),
        lambda d: d.ellipse([n * 0.10, n * 0.74, n * 0.90, n * 1.10], fill=255),
        blur=n * 0.05,
    ).point(lambda v: int(v * 0.34))
    bottom_layer = Image.new("RGBA", (n, n), (196, 220, 255, 0))
    bottom_layer.putalpha(Image.composite(bottom, Image.new("L", (n, n), 0), mask))
    tile = Image.alpha_composite(tile, bottom_layer)

    # 边缘那圈光：上面亮、下面几乎看不见，尺寸太小就不画了（会糊）
    if size >= 24:
        width = max(1, int(round(n * 0.012)))
        rim = Image.new("L", (n, n), 0)
        ImageDraw.Draw(rim).rounded_rectangle(
            [width / 2, width / 2, n - 1 - width / 2, n - 1 - width / 2],
            radius=radius,
            outline=255,
            width=width,
        )
        ramp = np.clip(1.0 - np.linspace(0.0, 1.0, n) * 1.5, 0.06, 1.0)
        rim = Image.fromarray(
            np.asarray(rim, dtype=np.float64) * np.repeat(ramp[:, None], n, axis=1)
        ).convert("L")
        rim_layer = Image.new("RGBA", (n, n), (255, 255, 255, 0))
        rim_layer.putalpha(Image.composite(rim, Image.new("L", (n, n), 0), mask))
        tile = Image.alpha_composite(tile, rim_layer)

    return Image.alpha_composite(tile, draw_glyph(n, mask)).resize(
        (size, size), Image.LANCZOS
    )


def previews(out_dir: str, make) -> None:
    """把图标贴到桌面壁纸、浅色、深色三种底上，眼睛过一遍。"""
    os.makedirs(out_dir, exist_ok=True)
    tile = make(256).convert("RGBA")

    def strip(background: Image.Image, name: str) -> None:
        canvas = Image.new("RGB", (256 + 60 + 200, 300), (245, 246, 250))
        canvas.paste(background.resize(canvas.size), (0, 0))
        canvas.paste(tile, (30, 22), tile)
        x = 316
        for size in (128, 64, 48, 32, 24, 16):
            icon = make(size).convert("RGBA")
            canvas.paste(icon, (x, 150 - size // 2), icon)
            x += size + 10
        canvas.save(os.path.join(out_dir, name))

    wall_path = (
        r"C:\Users\HW\AppData\Local\Packages\MicrosoftWindows.Client.CBS_cw5n1h2txyewy"
        r"\LocalCache\Microsoft\IrisService\9629130457206473931\134358525436640955.jpg"
    )
    if os.path.exists(wall_path):
        strip(Image.open(wall_path).convert("RGB"), "预览-壁纸.png")
    strip(Image.new("RGB", (600, 300), (250, 250, 252)), "预览-浅色.png")
    strip(Image.new("RGB", (600, 300), (22, 24, 30)), "预览-深色.png")


def square_crop(image: Image.Image) -> tuple[Image.Image, str]:
    """把横图/竖图裁成正方形，裁剪窗口挑「信息最多」的那一块。

    做法很土但有效：把图缩到 64 像素宽算两样东西——竖向的边缘强度（细节多
    的地方）和肤色像素比例（多半是人的地方），归一化后加权求和，再往正中间
    轻轻偏一点，然后滑窗找最高分的位置。
    """
    width, height = image.size
    side = min(width, height)
    if width == height:
        return image, "本来就是正方形，没裁"

    probe_w = 64
    probe_h = max(1, int(round(probe_w * height / width)))
    small = np.asarray(
        image.convert("RGB").resize((probe_w, probe_h), Image.LANCZOS), dtype=np.float64
    )
    gray = small @ np.array([0.299, 0.587, 0.114])
    edges = np.abs(np.diff(gray, axis=0, prepend=gray[:1]))
    r, g, b = small[:, :, 0], small[:, :, 1], small[:, :, 2]
    skin = (
        (r > 95) & (g > 40) & (b > 20)
        & (np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b]) > 15)
        & (np.abs(r - g) > 15) & (r > g) & (r > b)
    )
    line = 0.62 * (edges.mean(axis=1) / (edges.mean() + 1e-6)) + 0.38 * (
        skin.mean(axis=1) / (skin.mean() + 1e-6)
    )
    # 滑窗（窗口长度按缩放后的边长折算）找分数最高的位置
    win = max(1, int(round(side * probe_h / height)))
    best_start, best_score = 0, -1e9
    for start in range(0, max(1, probe_h - win + 1)):
        chunk = line[start:start + win]
        middle = start + win / 2
        bias = abs(middle - probe_h / 2) / probe_h
        score = chunk.mean() - 0.35 * bias
        if score > best_score:
            best_start, best_score = start, score

    top = int(round(best_start * height / probe_h))
    top = max(0, min(height - side, top))
    if width > height:
        left = top
        cropped = image.crop((left, 0, left + side, side))
        note = "横图：左右各裁掉 %d / %d 像素" % (left, width - side - left)
    else:
        cropped = image.crop((0, top, side, top + side))
        note = "竖图：上边裁掉 %d、下边裁掉 %d 像素" % (top, height - side - top)
    return cropped, note


def render_photo(source: Image.Image, size: int) -> Image.Image:
    """一张图缩到指定尺寸。

    一次从 1279 缩到 24 会丢掉高频细节（照片尤其明显），所以先一路折半缩到
    两倍大小以内，最后再 LANCZOS 一步到位；小尺寸再补一点锐化，不然糊成一团。
    """
    image = source
    while image.size[0] > size * 2:
        image = image.resize(
            (max(size, image.size[0] // 2), max(size, image.size[1] // 2)), Image.LANCZOS
        )
    image = image.resize((size, size), Image.LANCZOS)
    if size <= 48:
        image = image.filter(ImageFilter.UnsharpMask(radius=0.8, percent=70, threshold=2))
    return image


def bmp_entry(image: Image.Image) -> bytes:
    """一档图标的标准 BMP 写法（BITMAPINFOHEADER + 32 位像素 + 1 位掩码）。

    ico 里其实两种写法都合法：大的（256）按惯例存 PNG，小的传统上存 BMP。
    老的图标读取器（资源编辑器、老系统的壳）只认 BMP，所以 64 及以下都写成
    BMP，省得换个地方看就成空白。
    """
    width, height = image.size
    pixels = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    # 32 位像素是 BGRA 且自下而上
    xor = pixels[::-1][:, :, [2, 1, 0, 3]].tobytes()
    # 1 位掩码：1 = 透明；行按 4 字节对齐，同样自下而上
    stride = ((width + 31) // 32) * 4
    mask = bytearray(stride * height)
    clear = pixels[:, :, 3] < 128
    for y in range(height):
        base = (height - 1 - y) * stride
        for x in range(width):
            if clear[y, x]:
                mask[base + (x >> 3)] |= 0x80 >> (x & 7)
    header = struct.pack(
        "<IiiHHIIiiII",
        40,                # biSize
        width,
        height * 2,        # 高度写两倍：图像 + 掩码
        1,                 # biPlanes
        32,                # biBitCount
        0,                 # biCompression = BI_RGB
        len(xor) + len(mask),
        0, 0, 0, 0,
    )
    return header + xor + bytes(mask)


def png_entry(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def build_ico(tiles: dict[int, Image.Image]) -> bytes:
    blobs = []
    for size in SIZES:
        blob = bmp_entry(tiles[size]) if size <= 64 else png_entry(tiles[size])
        blobs.append((size, blob))

    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    directory = b""
    for size, blob in blobs:
        directory += struct.pack(
            "<BBBBHHII",
            0 if size == 256 else size,   # 256 在这一格只能写 0
            0 if size == 256 else size,
            0, 0, 1, 32,
            len(blob),
            offset,
        )
        offset += len(blob)
    return header + directory + b"".join(blob for _, blob in blobs)


def main() -> int:
    argv = sys.argv[1:]

    def value_of(flag: str) -> str | None:
        return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else None

    photo = value_of("--图片")
    out = value_of("--输出") or OUT_ICO
    preview_dir = value_of("--预览")
    for item in argv:
        if not item.startswith("--") and item not in (photo, out, preview_dir):
            preview_dir = preview_dir or item

    if photo:
        if not os.path.exists(photo):
            raise SystemExit("找不到这张图：%s" % photo)
        source = ImageOps.exif_transpose(Image.open(photo).convert("RGB"))
        cropped, note = square_crop(source)
        print("用图片做图标：%s（%dx%d）" % (photo, source.size[0], source.size[1]))
        print("  %s → %dx%d" % (note, cropped.size[0], cropped.size[1]))
        make = lambda size: render_photo(cropped, size)
    else:
        make = render
    tiles = {size: make(size) for size in SIZES}

    with open(out, "wb") as fh:
        fh.write(build_ico(tiles))
    print("已写入 %s（%d 字节，%d 档尺寸）" % (out, os.path.getsize(out), len(SIZES)))
    if preview_dir:
        previews(preview_dir, make)
        print("预览图写到 %s" % preview_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
