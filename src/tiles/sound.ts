// The 2D game's sounds, made on the fly with Web Audio (no files): booms, rumbles, thunder,
// chimes. Quiet by design; the browser lets them play only after the player has clicked.

export type SoundKind = 'boom' | 'rumble' | 'thunder' | 'chime' | 'plague' | 'war' | 'whoosh' | 'fanfare' | 'siren'

export class Sound {
  enabled = true
  private ctx: AudioContext | null = null

  private audio(): AudioContext | null {
    if (!this.enabled) return null
    try {
      this.ctx ??= new AudioContext()
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return this.ctx
    } catch {
      return null
    }
  }

  /** White noise through a filter, shaped by an envelope. */
  private noise(ctx: AudioContext, seconds: number, filter: BiquadFilterType, freq: number, gain: number, attack = 0.01) {
    const len = Math.ceil(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = filter
    f.frequency.value = freq
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds)
    src.connect(f).connect(g).connect(ctx.destination)
    src.start()
    return f
  }

  /** A tone gliding from one pitch to another. */
  private tone(ctx: AudioContext, type: OscillatorType, from: number, to: number, seconds: number, gain: number, delay = 0) {
    const o = ctx.createOscillator()
    o.type = type
    const g = ctx.createGain()
    const t = ctx.currentTime + delay
    o.frequency.setValueAtTime(from, t)
    o.frequency.exponentialRampToValueAtTime(to, t + seconds)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds)
    o.connect(g).connect(ctx.destination)
    o.start(t)
    o.stop(t + seconds + 0.05)
  }

  play(kind: SoundKind) {
    const ctx = this.audio()
    if (!ctx) return
    switch (kind) {
      case 'boom':
        this.noise(ctx, 2.2, 'lowpass', 400, 0.5)
        this.tone(ctx, 'sine', 90, 30, 1.6, 0.4)
        break
      case 'rumble': {
        const f = this.noise(ctx, 3, 'lowpass', 160, 0.35, 0.4)
        f.Q.value = 4
        break
      }
      case 'thunder':
        this.noise(ctx, 0.25, 'highpass', 1500, 0.25)
        this.noise(ctx, 2.5, 'lowpass', 300, 0.3, 0.15)
        break
      case 'chime':
        this.tone(ctx, 'sine', 880, 880, 0.9, 0.12)
        this.tone(ctx, 'sine', 1320, 1320, 1.1, 0.08, 0.08)
        break
      case 'plague':
        this.tone(ctx, 'sawtooth', 220, 110, 1.2, 0.06)
        this.tone(ctx, 'sawtooth', 233, 116, 1.2, 0.05)
        break
      case 'war':
        this.tone(ctx, 'square', 196, 196, 0.25, 0.06)
        this.tone(ctx, 'square', 147, 147, 0.5, 0.06, 0.25)
        break
      case 'whoosh':
        this.noise(ctx, 0.6, 'bandpass', 900, 0.15, 0.2)
        break
      case 'siren': {
        // an air-raid siren: a slow rise and fall, twice
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        const g = ctx.createGain()
        const t = ctx.currentTime
        o.frequency.setValueAtTime(300, t)
        o.frequency.linearRampToValueAtTime(700, t + 1.2)
        o.frequency.linearRampToValueAtTime(300, t + 2.4)
        o.frequency.linearRampToValueAtTime(700, t + 3.6)
        o.frequency.linearRampToValueAtTime(300, t + 4.8)
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(0.05, t + 0.3)
        g.gain.setValueAtTime(0.05, t + 4.4)
        g.gain.linearRampToValueAtTime(0, t + 4.8)
        o.connect(g).connect(ctx.destination)
        o.start(t)
        o.stop(t + 5)
        break
      }
      case 'fanfare':
        ;[523, 659, 784, 1047].forEach((f, k) => this.tone(ctx, 'triangle', f, f, 0.5, 0.1, k * 0.13))
        break
    }
  }
}
