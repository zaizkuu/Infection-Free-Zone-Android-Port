/**
 * Generative ambient score (WebAudio). Nothing is pre-recorded: slow pads move
 * through a minor-key progression, sparse plucked notes drift over the top, and
 * the mood shifts with the time of day and the danger the haven is in.
 */

const BAR = 8; // seconds per chord

// MIDI note numbers. Day: D minor colours; night: darker, with a flat second.
const DAY_CHORDS = [
  [50, 57, 64, 65],
  [46, 53, 57, 62],
  [41, 48, 55, 57],
  [48, 55, 62, 64],
];
const NIGHT_CHORDS = [
  [50, 57, 62, 65],
  [51, 58, 63, 67],
  [46, 53, 58, 62],
  [45, 52, 57, 62],
];
const DAY_SCALE = [62, 65, 67, 69, 72, 74, 77];
const NIGHT_SCALE = [50, 53, 55, 57, 62, 63];

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private verb: ConvolverNode | null = null;
  private echo: DelayNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBar = 0;
  private bar = 0;
  private night = 0;
  private tension = 0;
  enabled = true;
  volume = 0.24;

  attach(ctx: AudioContext): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.enabled ? this.volume : 0;
    this.out.connect(ctx.destination);
    // reverb from a generated, decaying noise impulse
    const len = Math.floor(ctx.sampleRate * 3.5);
    const imp = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = imp.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = imp;
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.verb.connect(wet).connect(this.out);
    // echo for plucks
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.35;
    this.echo.connect(fb).connect(this.echo);
    this.echo.connect(echoOut).connect(this.verb);
    this.nextBar = ctx.currentTime + 0.5;
    this.timer = setInterval(() => this.schedule(), 250);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.4);
  }

  /** night 0..1, tension 0..1 (horde close to the haven). */
  setMood(night: number, tension: number): void {
    this.night = night;
    this.tension += (tension - this.tension) * 0.05;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const c = this.ctx;
    if (!c || c.state !== 'running' || !this.enabled) {
      if (c) this.nextBar = Math.max(this.nextBar, c.currentTime + 0.2);
      return;
    }
    while (this.nextBar < c.currentTime + 1.5) {
      this.playBar(this.nextBar);
      this.nextBar += BAR;
      this.bar++;
    }
  }

  private playBar(t: number): void {
    const dark = this.night > 0.5;
    const chords = dark ? NIGHT_CHORDS : DAY_CHORDS;
    const chord = chords[this.bar % chords.length];
    const cutoff = dark ? 650 : 1100;
    for (const n of chord) this.pad(t, hz(n), cutoff, dark ? 0.05 : 0.045);
    if (dark) {
      this.pad(t, hz(38), 300, 0.06);
      this.pad(t, hz(45), 300, 0.03);
    }
    // sparse melody
    const scale = dark ? NIGHT_SCALE : DAY_SCALE;
    const notes = dark ? (Math.random() < 0.6 ? 1 : 0) : 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i++) {
      const at = t + Math.floor(Math.random() * 8) * (BAR / 8) + Math.random() * 0.08;
      this.pluck(at, hz(scale[Math.floor(Math.random() * scale.length)] + (dark ? 12 : 0)), dark ? 0.05 : 0.07);
    }
    // tension: heartbeat and a dissonant shimmer while the horde is close
    if (this.tension > 0.15) {
      const beat = 60 / 72;
      for (let b = t; b < t + BAR; b += beat) {
        this.thump(b, 0.18 * this.tension);
        this.thump(b + 0.22, 0.12 * this.tension);
      }
      this.shimmer(t, hz(74), hz(75), 0.012 * this.tension);
    }
  }

  private pad(t: number, f: number, cutoff: number, vol: number): void {
    const c = this.ctx!;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 2.4);
    g.gain.setValueAtTime(vol, t + BAR - 0.5);
    g.gain.linearRampToValueAtTime(0.0001, t + BAR + 2.5);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 0.4;
    for (const [type, det, v] of [
      ['triangle', 0, 1],
      ['sawtooth', -8, 0.35],
      ['sawtooth', 7, 0.35],
    ] as const) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = det;
      const og = c.createGain();
      og.gain.value = v;
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + BAR + 2.6);
    }
    lp.connect(g);
    g.connect(this.out!);
    g.connect(this.verb!);
  }

  private pluck(t: number, f: number, vol: number): void {
    const c = this.ctx!;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const o2 = c.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = f * 2;
    const g2 = c.createGain();
    g2.gain.value = 0.18;
    o.connect(g);
    o2.connect(g2).connect(g);
    g.connect(this.out!);
    g.connect(this.echo!);
    g.connect(this.verb!);
    o.start(t);
    o2.start(t);
    o.stop(t + 2.3);
    o2.stop(t + 2.3);
  }

  private thump(t: number, vol: number): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + 0.3);
  }

  private shimmer(t: number, f1: number, f2: number, vol: number): void {
    const c = this.ctx!;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 3);
    g.gain.linearRampToValueAtTime(0.0001, t + BAR + 1);
    const trem = c.createOscillator();
    trem.frequency.value = 6.5;
    const tg = c.createGain();
    tg.gain.value = vol * 0.6;
    trem.connect(tg).connect(g.gain);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    for (const f of [f1, f2]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start(t);
      o.stop(t + BAR + 1.2);
    }
    lp.connect(g);
    g.connect(this.verb!);
    trem.start(t);
    trem.stop(t + BAR + 1.2);
  }
}
