#!/usr/bin/env python3
"""Draws the app's one glyph — lucide's `circle-dot-dashed` — at every size and
colour the app needs, then writes the tray PNGs, the app PNGs and the Windows
.ico.

The glyph is drawn from its geometry rather than parsed from an SVG file:
there is no rasteriser in this toolchain and adding one for four 32px icons
would cost more than it returns. The geometry below and the `status` glyph in
`src/components/Icon.tsx` are the same drawing and have to be kept in step.

Run from anywhere:  python3 scripts/make-icons.py
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

# --- the glyph --------------------------------------------------------------
# lucide draws on a 24 unit grid with a 2 unit stroke and round caps: eight
# arcs of ~22° spaced every 45° around a radius-10 ring, plus a dot at the
# centre. The dot is `<circle r="1">` *stroked* at width 2, so what it paints
# is a solid disc of radius 2.

GRID = 24.0
CENTRE = 12.0
RING_RADIUS = 10.0
STROKE_HALF = 1.0
DOT_RADIUS = 2.0
DASH_HALF_ANGLE = math.radians(10.96)
DASH_ANGLES = [math.radians(-90 + 45 * step) for step in range(8)]

# Precomputed cap positions: the round end of every dash. Recomputing these
# inside the pixel loop is the difference between seconds and minutes.
DASH_CAPS = [
    (
        centre,
        (CENTRE + RING_RADIUS * math.cos(centre - DASH_HALF_ANGLE),
         CENTRE + RING_RADIUS * math.sin(centre - DASH_HALF_ANGLE)),
        (CENTRE + RING_RADIUS * math.cos(centre + DASH_HALF_ANGLE),
         CENTRE + RING_RADIUS * math.sin(centre + DASH_HALF_ANGLE)),
    )
    for centre in DASH_ANGLES
]

TAU = math.tau


def _wrap(angle: float) -> float:
    """Folds an angle difference into [-pi, pi]."""
    return (angle + math.pi) % TAU - math.pi


def glyph_distance(x: float, y: float, margin: float) -> float:
    """Signed distance from a point to the glyph, in grid units.

    Negative inside the ink. `margin` is how far outside the ink still matters
    for antialiasing; anything beyond it returns a large number so the caller
    can skip the trigonometry for the empty middle and the empty corners.
    """
    dx = x - CENTRE
    dy = y - CENTRE
    radius = math.hypot(dx, dy)

    dot = radius - DOT_RADIUS
    ring = abs(radius - RING_RADIUS) - STROKE_HALF

    # Most pixels are in neither the dot nor the band the ring lives in.
    if dot > margin and ring > margin:
        return margin + 1.0
    if dot <= margin:
        return dot

    angle = math.atan2(dy, dx)
    best = margin + 1.0
    for centre, cap_a, cap_b in DASH_CAPS:
        delta = _wrap(angle - centre)
        if abs(delta) <= DASH_HALF_ANGLE:
            distance = abs(radius - RING_RADIUS)
        else:
            cap = cap_b if delta > 0 else cap_a
            distance = math.hypot(x - cap[0], y - cap[1])
        best = min(best, distance - STROKE_HALF)
    return best


SUPERSAMPLE = 2


def render(size: int, rgb: tuple[int, int, int]) -> list[bytes]:
    """Rasterises the glyph to RGBA rows, antialiased by coverage."""
    scale = size / GRID
    margin = 1.0 / scale + 0.01
    step = 1.0 / SUPERSAMPLE
    samples = SUPERSAMPLE * SUPERSAMPLE
    red, green, blue = rgb

    rows: list[bytes] = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            coverage = 0.0
            for sy in range(SUPERSAMPLE):
                y = (py + (sy + 0.5) * step) / scale
                for sx in range(SUPERSAMPLE):
                    x = (px + (sx + 0.5) * step) / scale
                    # Into pixels, where a half-pixel of distance is a half
                    # covered pixel.
                    distance = glyph_distance(x, y, margin) * scale
                    if distance < 0.5:
                        coverage += 1.0 if distance <= -0.5 else 0.5 - distance
            alpha = round(coverage / samples * 255)
            row += bytes((red, green, blue, alpha))
        rows.append(bytes(row))
    return rows


# --- containers -------------------------------------------------------------


def png(size: int, rows: list[bytes]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


# Above this, an entry is stored as PNG rather than as a raw bitmap. A 256px
# entry costs 256 kB uncompressed and every byte of this file ends up inside
# the .exe; Windows has read PNG entries since Vista.
ICO_PNG_FROM = 128


def ico(images: list[tuple[int, list[bytes]]]) -> bytes:
    entries: list[bytes] = []
    blobs: list[bytes] = []
    offset = 6 + 16 * len(images)

    for size, rows in images:
        if size >= ICO_PNG_FROM:
            blob = png(size, rows)
        else:
            # Height is doubled because the format expects the colour data and
            # the AND mask stacked in one bitmap.
            header = struct.pack(
                "<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0
            )

            colour = bytearray()
            for row in reversed(rows):  # BMP rows run bottom-up
                for index in range(0, len(row), 4):
                    red, green, blue, alpha = row[index : index + 4]
                    colour += bytes((blue, green, red, alpha))

            # Fully transparent mask: the alpha channel already carries the shape.
            mask_stride = ((size + 31) // 32) * 4
            blob = header + bytes(colour) + bytes(mask_stride * size)

        # 0 means 256 in this field, which is why it is a single byte.
        dimension = 0 if size >= 256 else size
        entries.append(struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(blob), offset))
        offset += len(blob)
        blobs.append(blob)

    return struct.pack("<HHH", 0, 1, len(images)) + b"".join(entries) + b"".join(blobs)


# --- what gets written ------------------------------------------------------

# Same table as `STATE_COLOUR` in styles.css. Idle is --ink-dim rather than
# --ink-faint: the same tone has to stay findable on a dark taskbar.
TRAY_COLOURS = {
    "idle": (0xA4, 0x9F, 0xB4),
    "sharing": (0xF5, 0xA5, 0x24),
    "watching": (0x56, 0xB6, 0xFF),
    "error": (0xF2, 0x55, 0x5A),
}

ACCENT = (0x8B, 0x7C, 0xF6)

TRAY_SIZE = 32
APP_PNG_SIZES = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512}
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    icons = Path(__file__).resolve().parent.parent / "apps/desktop/src-tauri/icons"
    icons.mkdir(parents=True, exist_ok=True)

    for state, colour in TRAY_COLOURS.items():
        path = icons / f"tray-{state}.png"
        path.write_bytes(png(TRAY_SIZE, render(TRAY_SIZE, colour)))
        print(f"[icons] {path.name}")

    for name, size in APP_PNG_SIZES.items():
        path = icons / name
        path.write_bytes(png(size, render(size, ACCENT)))
        print(f"[icons] {path.name}")

    path = icons / "icon.ico"
    path.write_bytes(ico([(size, render(size, ACCENT)) for size in ICO_SIZES]))
    print(f"[icons] {path.name}")


if __name__ == "__main__":
    main()
