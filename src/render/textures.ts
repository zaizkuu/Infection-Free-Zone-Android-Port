import { Rng, valueNoise } from '../core/rng';
import { mixHex } from '../core/math';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

interface SpeckleOpts {
  size: number;
  seed: number;
  count: number;
  colors: string[];
  min: number;
  max: number;
  alpha: [number, number];
  strokes?: boolean;
  blobs?: { count: number; colors: string[]; r: [number, number]; alpha: [number, number] };
}

/** Seamless tile of random speckles / grass blades (wraps at the edges). */
function speckleTile(o: SpeckleOpts): HTMLCanvasElement {
  const { size } = o;
  const c = makeCanvas(size, size);
  const g = c.getContext('2d')!;
  const rng = new Rng(o.seed);
  const wrap = (x: number, y: number, r: number, fn: (x: number, y: number) => void) => {
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        const px = x + ox;
        const py = y + oy;
        if (px < -r || py < -r || px > size + r || py > size + r) continue;
        fn(px, py);
      }
  };
  if (o.blobs) {
    for (let i = 0; i < o.blobs.count; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      const r = rng.range(o.blobs.r[0], o.blobs.r[1]);
      const col = rng.pick(o.blobs.colors);
      const a = rng.range(o.blobs.alpha[0], o.blobs.alpha[1]);
      wrap(x, y, r, (px, py) => {
        const gr = g.createRadialGradient(px, py, 0, px, py, r);
        gr.addColorStop(0, col);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = a;
        g.fillStyle = gr;
        g.fillRect(px - r, py - r, r * 2, r * 2);
      });
    }
  }
  for (let i = 0; i < o.count; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const l = rng.range(o.min, o.max);
    const a = rng.range(-0.7, 0.7) - Math.PI / 2;
    g.globalAlpha = rng.range(o.alpha[0], o.alpha[1]);
    g.strokeStyle = g.fillStyle = rng.pick(o.colors);
    const lw = rng.range(0.7, 1.4);
    wrap(x, y, o.max, (px, py) => {
      if (o.strokes) {
        g.lineWidth = lw;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
        g.stroke();
      } else g.fillRect(px, py, l, l);
    });
  }
  g.globalAlpha = 1;
  return c;
}

export interface Textures {
  grass: HTMLCanvasElement;
  asphalt: HTMLCanvasElement;
  concrete: HTMLCanvasElement;
  gravel: HTMLCanvasElement;
  metal: HTMLCanvasElement;
  grain: HTMLCanvasElement;
  dirt: HTMLCanvasElement;
  water: HTMLCanvasElement;
  ground: HTMLCanvasElement;
  film: HTMLCanvasElement;
}

/** Pixel density of detail textures: texture px per world unit. */
export const TEX_DENSITY = 2;

export function buildTextures(seed: number, mapW: number, mapH: number): Textures {
  const grass = speckleTile({
    size: 256,
    seed: seed + 1,
    count: 3200,
    colors: ['#27301b', '#3d4a29', '#58623a', '#333f22', '#6b6b45', '#4b5631', '#7a7550'],
    min: 1.6,
    max: 4.5,
    alpha: [0.18, 0.5],
    strokes: true,
    blobs: { count: 70, colors: ['#1f2716', '#6a6640', '#2f3a1f'], r: [4, 12], alpha: [0.12, 0.3] },
  });
  const asphalt = speckleTile({
    size: 128,
    seed: seed + 2,
    count: 1700,
    colors: ['#141516', '#393b3e', '#4b4c4e', '#0f1011', '#5a5a58'],
    min: 0.5,
    max: 1.3,
    alpha: [0.25, 0.65],
    blobs: { count: 18, colors: ['#121314', '#3c3d3f'], r: [6, 16], alpha: [0.12, 0.25] },
  });
  const concrete = speckleTile({
    size: 128,
    seed: seed + 3,
    count: 1300,
    colors: ['#4d4c49', '#8a8780', '#626059', '#9a968c', '#3f3e3b'],
    min: 0.5,
    max: 1.3,
    alpha: [0.2, 0.45],
    blobs: { count: 22, colors: ['#2e2d2a', '#57544c', '#3a3a30'], r: [5, 14], alpha: [0.1, 0.25] },
  });
  const gravel = speckleTile({
    size: 128,
    seed: seed + 6,
    count: 2400,
    colors: ['#2f302f', '#7a7871', '#55554f', '#8f8c84', '#454643'],
    min: 0.6,
    max: 1.5,
    alpha: [0.3, 0.7],
    blobs: { count: 14, colors: ['#262725', '#4a473f'], r: [6, 14], alpha: [0.15, 0.3] },
  });
  const metal = speckleTile({
    size: 128,
    seed: seed + 7,
    count: 500,
    colors: ['#2b2c2d', '#8e8f8c', '#6b4a32'],
    min: 0.5,
    max: 1.2,
    alpha: [0.1, 0.3],
    blobs: { count: 12, colors: ['#6b4026', '#3a3b3c'], r: [5, 16], alpha: [0.12, 0.3] },
  });
  const grain = speckleTile({
    size: 128,
    seed: seed + 8,
    count: 2600,
    colors: ['#000000', '#ffffff', '#000000'],
    min: 0.5,
    max: 1.1,
    alpha: [0.05, 0.14],
    blobs: { count: 16, colors: ['#000000'], r: [4, 12], alpha: [0.06, 0.14] },
  });
  const dirt = speckleTile({
    size: 128,
    seed: seed + 4,
    count: 1200,
    colors: ['#3b3124', '#6a5a44', '#2e271d', '#7a6a50', '#4f5232'],
    min: 0.6,
    max: 2,
    alpha: [0.25, 0.55],
  });
  const water = speckleTile({
    size: 192,
    seed: seed + 5,
    count: 140,
    colors: ['#5f7a7c', '#3a5154', '#6d8684'],
    min: 5,
    max: 13,
    alpha: [0.08, 0.18],
    strokes: true,
  });
  // Screen-space film grain (luminance noise), drawn every frame with a random offset.
  const film = makeCanvas(160, 160);
  {
    const fg = film.getContext('2d')!;
    const img = fg.createImageData(160, 160);
    const rng = new Rng(seed + 9);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(rng.next() * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    fg.putImageData(img, 0, 0);
  }

  // Large-scale ground tint: one pixel per 12 world units, smoothed on draw.
  const gw = Math.ceil(mapW / 12);
  const gh = Math.ceil(mapH / 12);
  const ground = makeCanvas(gw, gh);
  const g = ground.getContext('2d')!;
  const img = g.createImageData(gw, gh);
  const base = '#4a5434';
  const dry = '#6a6745';
  const dark = '#343d25';
  const mud = '#55493a';
  const moss = '#3f4c2c';
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const n1 = valueNoise(x / 18, y / 18, seed);
      const n2 = valueNoise(x / 5, y / 5, seed + 7);
      const n3 = valueNoise(x / 42, y / 42, seed + 13);
      const n4 = valueNoise(x / 9, y / 9, seed + 21);
      let col = base;
      col = mixHex(col, dry, Math.max(0, n1 - 0.48) * 1.5);
      col = mixHex(col, dark, Math.max(0, 0.48 - n2) * 1.1);
      col = mixHex(col, moss, Math.max(0, n3 - 0.5) * 1.3);
      col = mixHex(col, mud, Math.max(0, n4 - 0.72) * 2.2);
      const p = parseInt(col.slice(1), 16);
      const i = (y * gw + x) * 4;
      img.data[i] = (p >> 16) & 255;
      img.data[i + 1] = (p >> 8) & 255;
      img.data[i + 2] = p & 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return { grass, asphalt, concrete, gravel, metal, grain, dirt, water, ground, film };
}

/** Pattern whose texels map to world units (respects the current ctx transform). */
export function worldPattern(ctx: CanvasRenderingContext2D, tex: HTMLCanvasElement, density = TEX_DENSITY): CanvasPattern {
  const p = ctx.createPattern(tex, 'repeat')!;
  p.setTransform(new DOMMatrix().scale(1 / density));
  return p;
}
