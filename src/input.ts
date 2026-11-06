import type { Camera } from './render/camera';

interface Pt {
  x: number;
  y: number;
  sx: number;
  sy: number;
  t: number;
}

/** Touch & mouse camera controls: drag to pan (with inertia), pinch / wheel to zoom, tap to act. */
export class Input {
  private pts = new Map<number, Pt>();
  private panning = false;
  private pinch = 0;
  private mid = { x: 0, y: 0 };
  private vx = 0;
  private vy = 0;
  private lastT = 0;
  private multi = false;
  enabled = true;

  constructor(
    private el: HTMLElement,
    private cam: Camera,
    private onTap: (x: number, y: number) => void,
    private onHover?: (x: number, y: number) => void,
  ) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!this.enabled) return;
        this.cam.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
      },
      { passive: false },
    );
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    this.el.setPointerCapture(e.pointerId);
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    this.vx = this.vy = 0;
    if (this.pts.size === 2) {
      this.multi = true;
      const [a, b] = [...this.pts.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      this.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    } else if (this.pts.size === 1) {
      this.multi = false;
      this.panning = false;
    }
  }

  private move(e: PointerEvent): void {
    if (!this.enabled) return;
    const p = this.pts.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.onHover?.(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pts.size === 1 && !this.multi) {
      if (!this.panning && Math.hypot(p.x - p.sx, p.y - p.sy) > 9) this.panning = true;
      if (this.panning) {
        this.cam.pan(dx, dy);
        const now = performance.now();
        const dt = Math.max(1, now - this.lastT) / 1000;
        this.lastT = now;
        this.vx = this.vx * 0.6 + (dx / dt) * 0.4;
        this.vy = this.vy * 0.6 + (dy / dt) * 0.4;
      }
    } else if (this.pts.size >= 2) {
      const [a, b] = [...this.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.pinch > 0) this.cam.zoomAt(m.x, m.y, d / this.pinch);
      this.cam.pan(m.x - this.mid.x, m.y - this.mid.y);
      this.pinch = d;
      this.mid = m;
    }
  }

  private up(e: PointerEvent, cancel = false): void {
    const p = this.pts.get(e.pointerId);
    this.pts.delete(e.pointerId);
    if (!p || !this.enabled) return;
    if (this.pts.size === 1) {
      // continue panning with the remaining finger without a jump
      const [r] = [...this.pts.values()];
      r.sx = r.x;
      r.sy = r.y;
      this.panning = true;
      return;
    }
    if (this.pts.size > 0) return;
    const long = performance.now() - p.t > 600;
    if (!cancel && !this.panning && !this.multi && !long) this.onTap(e.clientX, e.clientY);
    if (!this.panning || performance.now() - this.lastT > 80) this.vx = this.vy = 0;
    this.panning = false;
  }

  update(dt: number): void {
    if (this.pts.size || (Math.abs(this.vx) < 5 && Math.abs(this.vy) < 5)) return;
    this.cam.pan(this.vx * dt, this.vy * dt);
    const k = Math.exp(-dt * 5);
    this.vx *= k;
    this.vy *= k;
  }
}
