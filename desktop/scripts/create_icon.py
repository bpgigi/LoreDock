"""Generate the small original book icon, without external image dependencies."""
import struct
import zlib
from pathlib import Path

SIZE = 256


def pixel(x, y):
    # Rounded blue tile and an open book built from simple geometric shapes.
    dx, dy = max(28 - x, 0, x - 228), max(28 - y, 0, y - 228)
    if dx * dx + dy * dy > 28 * 28:
        return (0, 0, 0, 0)
    if 57 <= x <= 119 and 64 <= y <= 180 + (x - 57) * .18:
        return (255, 255, 255, 255)
    if 136 <= x <= 198 and 64 <= y <= 191 - (x - 136) * .18:
        return (230, 240, 255, 255)
    if 122 <= x <= 133 and 69 <= y <= 192:
        return (165, 192, 231, 255)
    return (65, 99, 146, 255)


def chunk(kind, payload):
    return struct.pack('!I', len(payload)) + kind + payload + struct.pack('!I', zlib.crc32(kind + payload))


def create():
    rows = bytearray()
    for y in range(SIZE):
        rows.append(0)
        for x in range(SIZE):
            samples = [pixel(x + a / 2, y + b / 2) for a in (0, 1) for b in (0, 1)]
            rows.extend(sum(p[c] for p in samples) // 4 for c in range(4))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', SIZE, SIZE, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
    assets = Path(__file__).resolve().parents[1] / 'assets'
    assets.mkdir(exist_ok=True)
    (assets / 'loredock.png').write_bytes(png)
    (assets / 'loredock.ico').write_bytes(struct.pack('<3H4B2H2I', 0, 1, 1, 0, 0, 0, 0, 1, 32, len(png), 22) + png)


if __name__ == '__main__':
    create()
