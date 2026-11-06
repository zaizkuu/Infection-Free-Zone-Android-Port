import type { SfxName } from '../game/sim';

/**
 * Tiny procedural sound engine (WebAudio). Every sound is synthesised at runtime,
 * so the game ships without audio files.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ambient: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private last: Partial<Record<SfxName, number>> = {};
  enabled = true;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.7 : 0;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbient();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.7 : 0, this.ctx.currentTime, 0.05);
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private startAmbient(): void {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    const gain = c.createGain();
    gain.gain.value = 0.035;
    src.connect(filter).connect(gain).connect(this.master!);
    src.start();
    this.ambient = { src, gain, filter };
  }

  /** Night makes the wind darker and a bit louder. */
  setMood(night: number): void {
    if (!this.ambient || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.ambient.filter.frequency.setTargetAtTime(380 - night * 180, t, 1);
    this.ambient.gain.gain.setTargetAtTime(0.03 + night * 0.025, t, 1);
  }

  /** vol: 0..1 already attenuated by distance from the camera. */
  play(name: SfxName, vol = 1): void {
    const c = this.ctx;
    if (!c || !this.master || !this.enabled || vol <= 0.02) return;
    const now = c.currentTime;
    const minGap: Partial<Record<SfxName, number>> = { pistol: 0.03, rifle: 0.04, hit: 0.06, zdie: 0.05, groan: 0.5, melee: 0.05, door: 0.1, tower: 0.05 };
    if ((this.last[name] ?? -1) + (minGap[name] ?? 0) > now) return;
    this.last[name] = now;
    switch (name) {
      case 'pistol':
        this.burst(now, 0.16, 1800, 0.5 * vol, 'lowpass');
        this.thump(now, 140, 60, 0.12, 0.35 * vol);
        break;
      case 'rifle':
      case 'tower':
        this.burst(now, 0.25, 1200, 0.65 * vol, 'lowpass');
        this.thump(now, 110, 40, 0.18, 0.5 * vol);
        break;
      case 'melee':
        this.thump(now, 180, 70, 0.08, 0.4 * vol);
        this.burst(now, 0.05, 900, 0.2 * vol, 'bandpass');
        break;
      case 'hit':
        this.thump(now, 120, 50, 0.1, 0.35 * vol);
        break;
      case 'zdie':
        this.groan(now, 0.5, 90, 0.18 * vol);
        break;
      case 'groan':
        this.groan(now, 1.1, 70 + Math.random() * 40, 0.16 * vol);
        break;
      case 'sdie':
        this.tone(now, 330, 220, 0.6, 0.25, 'triangle');
        this.tone(now + 0.15, 262, 175, 0.8, 0.22, 'triangle');
        break;
      case 'alarm':
        this.tone(now, 440, 440, 0.35, 0.18, 'square', 1200);
        this.tone(now + 0.4, 330, 330, 0.5, 0.18, 'square', 1200);
        break;
      case 'build':
        for (let i = 0; i < 3; i++) this.thump(now + i * 0.11, 260, 120, 0.06, 0.35);
        break;
      case 'loot':
        this.tone(now, 660, 660, 0.12, 0.12, 'sine');
        this.tone(now + 0.09, 880, 880, 0.18, 0.12, 'sine');
        break;
      case 'door':
        this.burst(now, 0.08, 500, 0.12 * vol, 'bandpass');
        break;
      case 'dawn':
        this.tone(now, 392, 392, 1.2, 0.12, 'sine');
        this.tone(now + 0.25, 523, 523, 1.4, 0.1, 'sine');
        this.tone(now + 0.5, 659, 659, 1.6, 0.08, 'sine');
        break;
    }
  }

  uiClick(): void {
    const c = this.ctx;
    if (!c || !this.enabled) return;
    this.tone(c.currentTime, 900, 700, 0.05, 0.06, 'sine');
  }

  private burst(t: number, dur: number, freq: number, vol: number, type: BiquadFilterType): void {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq * (0.85 + Math.random() * 0.3);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  private thump(t: number, f0: number, f1: number, dur: number, vol: number): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private tone(t: number, f0: number, f1: number, dur: number, vol: number, type: OscillatorType, lp = 4000): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f1, t + dur);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private groan(t: number, dur: number, f0: number, vol: number): void {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * 0.75, t + dur);
    const lfo = c.createOscillator();
    lfo.frequency.value = 7 + Math.random() * 4;
    const lfoG = c.createGain();
    lfoG.gain.value = 6;
    lfo.connect(lfoG).connect(o.frequency);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 500;
    f.Q.value = 3;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(this.master!);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }
}
