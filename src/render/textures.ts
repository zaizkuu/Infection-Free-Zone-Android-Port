import { Rng, valueNoise } from '../core/rng';
import { mixHex } from '../core/math';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/** Draws seamless random speckles/strokes into a square tile. */
function speckleTile(size: number, seed: number, count: number, colors: string[], minL: number, maxL: number, alpha: [number, number], strokes: boolean): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d')!;
  const rng = new Rng(seed);
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const l = rng.range(minL, maxL);
    const a = rng.range(-0.6, 0.6) - Math.PI / 2;
    g.globalAlpha = rng.range(alpha[0], alpha[1]);
    g.strokeStyle = g.fillStyle = rng.pick(colors);
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        const px = x + ox;
        const py = y + oy;
        if (px < -maxL || py < -maxL || px > size + maxL || py > size + maxL) continue;
        if (strokes) {
          g.lineWidth = rng.range(0.8, 1.6);
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
          g.stroke();
        } else {
          g.fillRect(px, py, l, l);
        }
      }
  }
  return c;
}

export interface Textures {
  grass: HTMLCanvasElement;
  asphalt: HTMLCanvasElement;
  concrete: HTMLCanvasElement;
  dirt: HTMLCanvasElement;
  water: HTMLCanvasElement;
  ground: HTMLCanvasElement;
}

/** Pixel density of detail textures: texture px per world unit. */
export const TEX_DENSITY = 2;

export function buildTextures(seed: number, mapW: number, mapH: number): Textures {
  const grass = speckleTile(192, seed + 1, 1300, ['#3f5a2c', '#5d7d3d', '#8aa45f', '#4a6a34', '#9aa866'], 2, 5, [0.18, 0.45], true);
  const asphalt = speckleTile(128, seed + 2, 900, ['#2a2d31', '#55595e', '#61656a', '#24272b'], 0.8, 1.8, [0.25, 0.6], false);
  const concrete = speckleTile(128, seed + 3, 700, ['#7d7b74', '#b8b4aa', '#8f8c84', '#a7a399'], 0.8, 1.6, [0.2, 0.45], false);
  const dirt = speckleTile(128, seed + 4, 900, ['#6d5a40', '#a48c68', '#5a4a36', '#b39c78'], 0.8, 2.2, [0.25, 0.55], false);
  const water = speckleTile(192, seed + 5, 120, ['#9fd0e0', '#6aa3bd'], 6, 14, [0.12, 0.25], true);

  // Large-scale ground tint: one pixel per 12 world units, smoothed on draw.
  const gw = Math.ceil(mapW / 12);
  const gh = Math.ceil(mapH / 12);
  const ground = makeCanvas(gw, gh);
  const g = ground.getContext('2d')!;
  const img = g.createImageData(gw, gh);
  const base = '#6a8547';
  const dry = '#8c8f55';
  const dark = '#56733e';
  const lush = '#61864a';
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const n1 = valueNoise(x / 18, y / 18, seed);
      const n2 = valueNoise(x / 6, y / 6, seed + 7);
      const n3 = valueNoise(x / 40, y / 40, seed + 13);
      let col = base;
      col = mixHex(col, dry, Math.max(0, n1 - 0.5) * 1.3);
      col = mixHex(col, dark, Math.max(0, 0.45 - n2) * 0.9);
      col = mixHex(col, lush, Math.max(0, n3 - 0.55) * 1.4);
      const p = parseInt(col.slice(1), 16);
      const i = (y * gw + x) * 4;
      img.data[i] = (p >> 16) & 255;
      img.data[i + 1] = (p >> 8) & 255;
      img.data[i + 2] = p & 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return { grass, asphalt, concrete, dirt, water, ground };
}

/** Pattern whose texels map to world units (respects the current ctx transform). */
export function worldPattern(ctx: CanvasRenderingContext2D, tex: HTMLCanvasElement, density = TEX_DENSITY): CanvasPattern {
  const p = ctx.createPattern(tex, 'repeat')!;
  p.setTransform(new DOMMatrix().scale(1 / density));
  return p;
}
