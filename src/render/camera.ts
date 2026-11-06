import { clamp } from '../core/math';

/** Camera centred on (x, y) in world units; zoom is CSS px per world unit. */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1.2;
  vw = 1;
  vh = 1;
  dpr = 1;
  minZoom = 0.3;
  maxZoom = 3.2;
  // smooth follow target
  tx: number | null = null;
  ty: number | null = null;

  constructor(
    public mapW: number,
    public mapH: number,
  ) {}

  get scale(): number {
    return this.zoom * this.dpr;
  }

  /** World coordinate at the top-left of the screen. */
  get left(): number {
    return this.x - this.vw / 2 / this.zoom;
  }
  get top(): number {
    return this.y - this.vh / 2 / this.zoom;
  }

  resize(vw: number, vh: number, dpr: number): void {
    this.vw = vw;
    this.vh = vh;
    this.dpr = dpr;
    this.minZoom = Math.max(vw / this.mapW, vh / this.mapH) * 1.02;
    this.clamp();
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.left + sx / this.zoom, y: this.top + sy / this.zoom };
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.left) * this.zoom, y: (wy - this.top) * this.zoom };
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  pan(dxCss: number, dyCss: number): void {
    this.x -= dxCss / this.zoom;
    this.y -= dyCss / this.zoom;
    this.tx = this.ty = null;
    this.clamp();
  }

  focus(x: number, y: number): void {
    this.tx = x;
    this.ty = y;
  }

  update(dt: number): void {
    if (this.tx !== null && this.ty !== null) {
      const k = Math.min(1, dt * 6);
      this.x += (this.tx - this.x) * k;
      this.y += (this.ty - this.y) * k;
      if (Math.abs(this.tx - this.x) < 0.5 && Math.abs(this.ty - this.y) < 0.5) this.tx = this.ty = null;
      this.clamp();
    }
  }

  clamp(): void {
    const hw = this.vw / 2 / this.zoom;
    const hh = this.vh / 2 / this.zoom;
    this.x = hw * 2 >= this.mapW ? this.mapW / 2 : clamp(this.x, hw, this.mapW - hw);
    this.y = hh * 2 >= this.mapH ? this.mapH / 2 : clamp(this.y, hh, this.mapH - hh);
  }
}
