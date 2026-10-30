// Generates cover.png (800x534) for gladys-recalls-us: plain Node, no dependency.
// (The drawing helpers of gladys-span-panel, via gladys-rappels-canada.)
// A list of recall sheets (one flagged), a warning triangle and a stylised
// car, on a deep navy-to-blue gradient (no logo, seal or flag of any agency
// of the United States). Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [25 + 20 * t, 45 + 40 * t, 110 + 60 * t]);
  }
}
const white = [255, 255, 255];
const dark = [40, 30, 40];
const amber = [250, 185, 50];
const red = [215, 40, 50];
const grey = [200, 200, 210];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// Filled polygon (even-odd), anti-aliased by 4x4 supersampling.
const polygon = (points, color, alpha = 1) => {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y += 1) {
    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x += 1) {
      let n = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) n += 1;
        }
      }
      if (n > 0) set(x, y, color, (n / 16) * alpha);
    }
  }
};

// Soft halo behind the card.
disc(300, 270, 230, white, 0.06);
// The card: a list of recall sheets.
box(130, 90, 470, 450, 22, white);
box(130, 90, 470, 150, 22, [232, 238, 248]);
box(130, 128, 470, 150, 0, [232, 238, 248]);
box(160, 110, 330, 128, 9, red);
for (let i = 0; i < 5; i += 1) {
  const y = 180 + i * 52;
  const flagged = i === 1;
  if (flagged) box(145, y - 12, 455, y + 34, 12, [255, 240, 225]);
  disc(175, y + 11, 11, flagged ? red : amber);
  box(200, y, 420 - (i % 3) * 40, y + 10, 5, flagged ? dark : grey);
  box(200, y + 16, 360 - (i % 2) * 50, y + 24, 4, [225, 225, 232]);
}
// The warning triangle.
const tx = 560;
const ty = 330;
polygon(
  [
    [tx, ty - 120],
    [tx + 120, ty + 90],
    [tx - 120, ty + 90],
  ],
  amber,
);
polygon(
  [
    [tx, ty - 85],
    [tx + 92, ty + 72],
    [tx - 92, ty + 72],
  ],
  [255, 225, 120],
);
box(tx - 9, ty - 40, tx + 9, ty + 30, 8, dark);
disc(tx, ty + 52, 11, dark);
// A stylised car, top right: body, cabin, windows and wheels.
const cx = 660;
const cy = 120;
box(cx - 95, cy - 5, cx + 95, cy + 40, 16, white, 0.95);
polygon(
  [
    [cx - 55, cy - 5],
    [cx - 30, cy - 50],
    [cx + 35, cy - 50],
    [cx + 62, cy - 5],
  ],
  white,
  0.95,
);
polygon(
  [
    [cx - 40, cy - 10],
    [cx - 22, cy - 40],
    [cx - 3, cy - 40],
    [cx - 3, cy - 10],
  ],
  [60, 90, 160],
);
polygon(
  [
    [cx + 5, cy - 10],
    [cx + 5, cy - 40],
    [cx + 28, cy - 40],
    [cx + 46, cy - 10],
  ],
  [60, 90, 160],
);
for (const wx of [cx - 55, cx + 55]) {
  disc(wx, cy + 42, 22, dark);
  disc(wx, cy + 42, 9, grey);
}
// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
