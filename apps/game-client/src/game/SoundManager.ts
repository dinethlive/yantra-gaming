/**
 * Sound manager using Web Audio API.
 * SFX are procedurally generated (no files needed).
 * Background music loads from /sounds/ambience.mp3 and loops via AudioBufferSourceNode
 * for gapless, low-overhead infinite playback on all devices.
 */

type SoundName = 'dice_roll' | 'impact' | 'win' | 'lose' | 'bet_placed' | 'countdown_tick';

const AMBIENCE_URL = '/sounds/ketapola-bg-1.mp3';
const AMBIENCE_VOLUME = 0.12;

class SoundManagerClass {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private _muted = false;
  private _volume = 0.7;
  private _initialized = false;

  /* Ambience — file-based, decoded once, loops via AudioBufferSourceNode */
  private ambienceBuffer: AudioBuffer | null = null;
  private ambienceSource: AudioBufferSourceNode | null = null;
  private ambienceGain: GainNode | null = null;
  private ambiencePlaying = false;
  private ambienceLoading = false;

  /* ─── Storage helpers ─── */
  private readStorage(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, value: string): void {
    const write = () => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* quota/private */
      }
    };
    typeof requestIdleCallback === 'function' ? requestIdleCallback(write) : write();
  }

  /* ─── AudioContext lifecycle ─── */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this._muted ? 0 : this._volume;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /* ─── Public API (same interface as before) ─── */

  init(): void {
    if (this._initialized) return;

    const savedMute = this.readStorage('ketapola-mute');
    if (savedMute === 'true') this._muted = true;

    const savedVolume = this.readStorage('ketapola-volume');
    if (savedVolume) this._volume = parseFloat(savedVolume);

    /* AudioContext requires user gesture — warm it up on first interaction */
    const warmUp = () => {
      this.ensureContext();
      document.removeEventListener('click', warmUp);
      document.removeEventListener('touchstart', warmUp);
      document.removeEventListener('keydown', warmUp);
    };
    document.addEventListener('click', warmUp);
    document.addEventListener('touchstart', warmUp);
    document.addEventListener('keydown', warmUp);

    this._initialized = true;
  }

  play(name: string): void {
    if (this._muted) return;
    const ctx = this.ensureContext();
    if (!this.masterGain) return;

    const generators: Record<SoundName, () => void> = {
      dice_roll: () => this.genDiceRoll(ctx),
      impact: () => this.genImpact(ctx),
      win: () => this.genWin(ctx),
      lose: () => this.genLose(ctx),
      bet_placed: () => this.genBetPlaced(ctx),
      countdown_tick: () => this.genTick(ctx),
    };

    const gen = generators[name as SoundName];
    if (gen) gen();
  }

  stop(_name: string): void {
    /* Procedural sounds are fire-and-forget; ambience has its own stop */
  }

  /**
   * Load the ambience MP3 once, decode it, and cache the AudioBuffer.
   * Subsequent calls are no-ops. Fetch + decode happens off the main thread.
   */
  private async loadAmbienceBuffer(ctx: AudioContext): Promise<AudioBuffer | null> {
    if (this.ambienceBuffer) return this.ambienceBuffer;
    if (this.ambienceLoading) return null;
    this.ambienceLoading = true;

    try {
      const res = await fetch(AMBIENCE_URL);
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();
      this.ambienceBuffer = await ctx.decodeAudioData(arrayBuf);
      return this.ambienceBuffer;
    } catch {
      /* File missing or decode error — ambience simply won't play */
      return null;
    } finally {
      this.ambienceLoading = false;
    }
  }

  async startAmbience(): Promise<void> {
    if (this._muted || this.ambiencePlaying) return;
    const ctx = this.ensureContext();
    if (!this.masterGain) return;

    const buffer = await this.loadAmbienceBuffer(ctx);
    if (!buffer || this.ambiencePlaying) return;

    /* Dedicated gain for ambience volume */
    this.ambienceGain = ctx.createGain();
    this.ambienceGain.gain.value = 0;
    this.ambienceGain.connect(this.masterGain);

    /* AudioBufferSourceNode — gapless loop, minimal CPU */
    this.ambienceSource = ctx.createBufferSource();
    this.ambienceSource.buffer = buffer;
    this.ambienceSource.loop = true;
    this.ambienceSource.connect(this.ambienceGain);
    this.ambienceSource.start();

    /* Fade in over 2s */
    this.ambienceGain.gain.linearRampToValueAtTime(AMBIENCE_VOLUME, ctx.currentTime + 2);
    this.ambiencePlaying = true;
  }

  stopAmbience(): void {
    if (!this.ambiencePlaying) return;
    const t = this.ctx?.currentTime ?? 0;

    if (this.ambienceGain) {
      this.ambienceGain.gain.linearRampToValueAtTime(0, t + 0.5);
    }
    /* Cleanup after fade-out */
    setTimeout(() => {
      try {
        this.ambienceSource?.stop();
      } catch {
        /* already stopped */
      }
      this.ambienceSource?.disconnect();
      this.ambienceSource = null;
      this.ambienceGain?.disconnect();
      this.ambienceGain = null;
    }, 600);
    this.ambiencePlaying = false;
  }

  get muted(): boolean {
    return this._muted;
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    this.writeStorage('ketapola-mute', String(this._muted));

    if (this.masterGain) {
      this.masterGain.gain.value = this._muted ? 0 : this._volume;
    }

    if (this._muted) {
      this.stopAmbience();
    } else {
      this.startAmbience();
    }
    return this._muted;
  }

  setVolume(vol: number): void {
    this._volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && !this._muted) {
      this.masterGain.gain.value = this._volume;
    }
    this.writeStorage('ketapola-volume', String(this._volume));
  }

  get volume(): number {
    return this._volume;
  }

  /* ═══════════════════════════════════════════════════════════════
     Procedural sound generators
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Dice roll — filtered noise burst with rapid tremolo simulating
   * dice rattling in a cup, then a short tail.
   */
  private genDiceRoll(ctx: AudioContext): void {
    const now = ctx.currentTime;
    const dur = 1.2;

    /* White noise via buffer */
    const bufSize = ctx.sampleRate * dur;
    const noiseBuf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;

    /* Bandpass filter for "wooden rattle" character */
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.2;

    /* Amplitude tremolo via gain modulation */
    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 18;
    const lfoAmp = ctx.createGain();
    lfoAmp.gain.value = 0.4;
    lfo.connect(lfoAmp);
    lfoAmp.connect(tremoloGain.gain);

    /* Envelope */
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.7, now + 0.06);
    env.gain.setValueAtTime(0.7, now + 0.5);
    env.gain.exponentialRampToValueAtTime(0.01, now + dur);

    noise.connect(bp);
    bp.connect(tremoloGain);
    tremoloGain.connect(env);
    env.connect(this.masterGain!);

    lfo.start(now);
    noise.start(now);
    noise.stop(now + dur);
    lfo.stop(now + dur);
  }

  /**
   * Impact — short thud with a low "punch" fundamental.
   * Simulates a die hitting the table surface.
   */
  private genImpact(ctx: AudioContext): void {
    const now = ctx.currentTime;

    /* Low "thud" fundamental */
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(50, now + 0.15);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.5, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc.connect(oscGain);

    /* Noise transient for the "click" of impact */
    const bufSize = ctx.sampleRate * 0.08;
    const noiseBuf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, now);
    lp.frequency.exponentialRampToValueAtTime(300, now + 0.08);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.4, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

    noise.connect(lp);
    lp.connect(noiseGain);

    oscGain.connect(this.masterGain!);
    noiseGain.connect(this.masterGain!);

    osc.start(now);
    noise.start(now);
    osc.stop(now + 0.25);
    noise.stop(now + 0.1);
  }

  /**
   * Win — bright ascending arpeggio (C5→E5→G5→C6).
   * Feels celebratory, like coins clinking.
   */
  private genWin(ctx: AudioContext): void {
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    const noteLen = 0.13;
    const gap = 0.04;

    notes.forEach((freq, i) => {
      const t = now + i * (noteLen + gap);

      /* Main tone */
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      /* Harmonic shimmer */
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = freq * 2;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.01, t + noteLen + 0.1);

      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0, t);
      gain2.gain.linearRampToValueAtTime(0.1, t + 0.01);
      gain2.gain.exponentialRampToValueAtTime(0.01, t + noteLen);

      osc.connect(gain);
      osc2.connect(gain2);
      gain.connect(this.masterGain!);
      gain2.connect(this.masterGain!);

      osc.start(t);
      osc2.start(t);
      osc.stop(t + noteLen + 0.15);
      osc2.stop(t + noteLen + 0.1);
    });
  }

  /**
   * Lose — soft descending two-note motif (G4→Eb4).
   * Subdued and brief so it's not punishing.
   */
  private genLose(ctx: AudioContext): void {
    const now = ctx.currentTime;
    const notes = [392.0, 311.13]; // G4, Eb4
    const noteLen = 0.2;

    notes.forEach((freq, i) => {
      const t = now + i * noteLen;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      /* Gentle vibrato */
      const vib = ctx.createOscillator();
      vib.frequency.value = 5;
      const vibGain = ctx.createGain();
      vibGain.gain.value = 3;
      vib.connect(vibGain);
      vibGain.connect(osc.frequency);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.01, t + noteLen + 0.15);

      osc.connect(gain);
      gain.connect(this.masterGain!);

      vib.start(t);
      osc.start(t);
      osc.stop(t + noteLen + 0.2);
      vib.stop(t + noteLen + 0.2);
    });
  }

  /**
   * Bet placed — crisp "ding" confirmation.
   * Two harmonics for a metallic, satisfying click.
   */
  private genBetPlaced(ctx: AudioContext): void {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1200;

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 1800;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0.15, now);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    osc.connect(gain);
    osc2.connect(gain2);
    gain.connect(this.masterGain!);
    gain2.connect(this.masterGain!);

    osc.start(now);
    osc2.start(now);
    osc.stop(now + 0.2);
    osc2.stop(now + 0.15);
  }

  /**
   * Countdown tick — very short, subtle click.
   */
  private genTick(ctx: AudioContext): void {
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);

    osc.connect(gain);
    gain.connect(this.masterGain!);

    osc.start(now);
    osc.stop(now + 0.06);
  }
}

/* Singleton */
export const SoundManager = new SoundManagerClass();
