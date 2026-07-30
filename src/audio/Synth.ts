/**
 * Synth — the DSP bakery.
 *
 * Everything audible in this game is generated here at runtime: we ship no
 * audio files. The module is deliberately allocation-light: buffers (noise,
 * reverb impulses) are baked once at unlock, and per-event voices build a
 * three-or-four node chain that tears itself down in `onended`.
 *
 * Nothing in here touches the game; it is a pure WebAudio toolkit that
 * `Audio.ts` orchestrates.
 */

// ---------------------------------------------------------------------------
// Seeded randomness — so a given build has the same "personality" every run,
// while still sounding varied moment to moment.
// ---------------------------------------------------------------------------

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** xorshift32 in [0,1). */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** MIDI note number to Hz. */
export function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Buffer bakery
// ---------------------------------------------------------------------------

/**
 * Seamless looping noise. `colour` in 0..1 leans the spectrum from white (0)
 * toward brown (1) via a one-pole integrator. The tail is crossfaded into the
 * head so a looped source never clicks at the seam.
 */
export function makeNoise(ac: BaseAudioContext, seconds: number, rng: Rng, colour = 0): AudioBuffer {
  const len = Math.max(64, Math.floor(ac.sampleRate * seconds));
  const xf = Math.min(len >> 2, Math.floor(ac.sampleRate * 0.25));
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  const tmp = new Float32Array(len + xf);

  for (let c = 0; c < 2; c++) {
    const out = buf.getChannelData(c);
    const k = clamp(colour, 0, 0.995);
    let lp = 0;
    let dc = 0;
    for (let i = 0; i < tmp.length; i++) {
      const w = rng.next() * 2 - 1;
      lp = lp * k + w * (1 - k);
      // Gentle DC blocker so brown noise does not wander off centre.
      dc += (lp - dc) * 0.0006;
      tmp[i] = lp - dc;
    }
    // Crossfade the overhang back over the head: a perfect loop point.
    for (let i = 0; i < len; i++) out[i] = tmp[i];
    for (let i = 0; i < xf; i++) {
      const w = i / xf;
      out[i] = tmp[i] * w + tmp[len + i] * (1 - w);
    }
    let peak = 1e-6;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
    const g = 0.9 / peak;
    for (let i = 0; i < len; i++) out[i] *= g;
  }
  return buf;
}

/**
 * A procedural reverb impulse: soft diffuse onset, a handful of early
 * reflections, then an exponentially decaying, progressively duller tail.
 * Sounds like a wide outdoor space rather than a plate.
 */
export function makeImpulse(ac: BaseAudioContext, seconds: number, decay: number, rng: Rng): AudioBuffer {
  const sr = ac.sampleRate;
  const len = Math.max(64, Math.floor(sr * seconds));
  const buf = ac.createBuffer(2, len, sr);
  const preDelay = Math.floor(sr * 0.012);

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = preDelay; i < len; i++) {
      const t = (i - preDelay) / (len - preDelay);
      const n = rng.next() * 2 - 1;
      // The tail darkens as it decays — high frequencies die first outdoors.
      const cut = 0.45 - 0.35 * t;
      lp += (n - lp) * cut;
      // Soft onset ramp avoids the "slap" of a raw noise impulse.
      const onset = Math.min(1, (i - preDelay) / (sr * 0.03));
      d[i] = lp * Math.pow(1 - t, decay) * onset;
    }
    // Early reflections: a few discrete, decorrelated taps per channel.
    for (let r = 0; r < 7; r++) {
      const at = preDelay + Math.floor(rng.range(0.006, 0.09) * sr);
      if (at < len) d[at] += rng.range(-0.5, 0.5) * (1 - r / 8);
    }
    let peak = 1e-6;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    const g = 0.85 / peak;
    for (let i = 0; i < len; i++) d[i] *= g;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Envelopes and teardown
// ---------------------------------------------------------------------------

const FLOOR = 0.00015;

/** Percussive envelope: linear attack to `peak`, exponential fall over `decay`. */
export function pluckEnv(p: AudioParam, t0: number, attack: number, peak: number, decay: number): number {
  const a = Math.max(0.0008, attack);
  p.cancelScheduledValues(t0);
  p.setValueAtTime(FLOOR, t0);
  p.linearRampToValueAtTime(Math.max(peak, FLOOR * 2), t0 + a);
  p.exponentialRampToValueAtTime(FLOOR, t0 + a + Math.max(0.01, decay));
  return t0 + a + decay;
}

/** Sustained envelope for pads: slow swell, hold, long release. */
export function padEnv(
  p: AudioParam,
  t0: number,
  attack: number,
  peak: number,
  hold: number,
  release: number,
): number {
  p.cancelScheduledValues(t0);
  p.setValueAtTime(FLOOR, t0);
  p.linearRampToValueAtTime(Math.max(peak, FLOOR * 2), t0 + attack);
  p.setValueAtTime(Math.max(peak, FLOOR * 2), t0 + attack + hold);
  p.exponentialRampToValueAtTime(FLOOR, t0 + attack + hold + release);
  return t0 + attack + hold + release;
}

/**
 * Tie a voice's lifetime to its source. When the source ends every node in the
 * chain is disconnected, so nothing accumulates in the graph.
 */
export function disposeWith(src: AudioScheduledSourceNode, chain: AudioNode[]): void {
  src.onended = () => {
    try {
      src.disconnect();
    } catch {
      /* already gone */
    }
    for (const n of chain) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

export interface BurstOpts {
  t0: number;
  /** Decay time of the amplitude envelope. */
  dur: number;
  gain: number;
  freq: number;
  type?: BiquadFilterType;
  q?: number;
  attack?: number;
  /** Resample the noise for grain-size variation. */
  rate?: number;
  pan?: number;
}

/**
 * A filtered noise burst — the workhorse behind footsteps, surf swells and
 * anything else that is "air moving over a surface".
 */
export function noiseBurst(ac: AudioContext, dest: AudioNode, buf: AudioBuffer, o: BurstOpts): void {
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = o.rate ?? 1;

  const filt = ac.createBiquadFilter();
  filt.type = o.type ?? 'bandpass';
  filt.frequency.value = clamp(o.freq, 20, 18000);
  filt.Q.value = o.q ?? 1;

  const g = ac.createGain();
  const end = pluckEnv(g.gain, o.t0, o.attack ?? 0.004, o.gain, o.dur);

  src.connect(filt).connect(g);
  const chain: AudioNode[] = [filt, g];
  if (o.pan !== undefined && ac.createStereoPanner) {
    const pan = ac.createStereoPanner();
    pan.pan.value = clamp(o.pan, -1, 1);
    g.connect(pan).connect(dest);
    chain.push(pan);
  } else {
    g.connect(dest);
  }

  // A random start offset means two identical bursts never share a grain.
  const offset = (buf.duration - 0.1) * Math.random();
  src.start(o.t0, Math.max(0, offset));
  src.stop(end + 0.05);
  disposeWith(src, chain);
}

export interface ToneOpts {
  t0: number;
  freq: number;
  gain: number;
  attack?: number;
  decay?: number;
  hold?: number;
  release?: number;
  type?: OscillatorType;
  detune?: number;
  /** Lowpass applied to the voice; keeps triangles from getting glassy. */
  cutoff?: number;
  pan?: number;
  /** Optional parallel send (reverb). */
  send?: AudioNode;
  sendGain?: number;
}

/** A soft pitched voice: triangle/sine through a lowpass, gentle envelope. */
export function tone(ac: AudioContext, dest: AudioNode, o: ToneOpts): void {
  const osc = ac.createOscillator();
  osc.type = o.type ?? 'triangle';
  osc.frequency.value = clamp(o.freq, 15, 12000);
  if (o.detune) osc.detune.value = o.detune;

  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = o.cutoff ?? Math.min(9000, o.freq * 6 + 500);
  lp.Q.value = 0.4;

  const g = ac.createGain();
  const end =
    o.hold !== undefined || o.release !== undefined
      ? padEnv(g.gain, o.t0, o.attack ?? 0.6, o.gain, o.hold ?? 1, o.release ?? 1.5)
      : pluckEnv(g.gain, o.t0, o.attack ?? 0.02, o.gain, o.decay ?? 1.2);

  osc.connect(lp).connect(g);
  const chain: AudioNode[] = [lp, g];
  let out: AudioNode = g;
  if (o.pan !== undefined && ac.createStereoPanner) {
    const pan = ac.createStereoPanner();
    pan.pan.value = clamp(o.pan, -1, 1);
    g.connect(pan);
    chain.push(pan);
    out = pan;
  }
  out.connect(dest);
  if (o.send) {
    const s = ac.createGain();
    s.gain.value = o.sendGain ?? 0.35;
    out.connect(s).connect(o.send);
    chain.push(s);
  }

  osc.start(o.t0);
  osc.stop(end + 0.08);
  disposeWith(osc, chain);
}

export interface ChirpOpts {
  t0: number;
  /** Start and end carrier frequency — the glide is what makes it birdlike. */
  f0: number;
  f1: number;
  dur: number;
  gain: number;
  /** FM index; higher gives a reedier, more whistly timbre. */
  index?: number;
  ratio?: number;
  pan?: number;
  send?: AudioNode;
  sendGain?: number;
}

/** A two-operator FM chirp — birdsong, and the basis of the UI blips. */
export function fmChirp(ac: AudioContext, dest: AudioNode, o: ChirpOpts): void {
  const carrier = ac.createOscillator();
  carrier.type = 'sine';
  const mod = ac.createOscillator();
  mod.type = 'sine';
  const modGain = ac.createGain();

  const ratio = o.ratio ?? 2.01;
  const index = o.index ?? 0.4;
  carrier.frequency.setValueAtTime(o.f0, o.t0);
  carrier.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1), o.t0 + o.dur);
  mod.frequency.setValueAtTime(o.f0 * ratio, o.t0);
  mod.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1 * ratio), o.t0 + o.dur);
  modGain.gain.setValueAtTime(o.f0 * index, o.t0);
  modGain.gain.exponentialRampToValueAtTime(Math.max(1, o.f1 * index * 0.25), o.t0 + o.dur);
  mod.connect(modGain).connect(carrier.frequency);

  const g = ac.createGain();
  const attack = Math.min(0.012, o.dur * 0.25);
  const end = pluckEnv(g.gain, o.t0, attack, o.gain, o.dur);
  carrier.connect(g);

  const chain: AudioNode[] = [mod, modGain, g];
  let out: AudioNode = g;
  if (o.pan !== undefined && ac.createStereoPanner) {
    const pan = ac.createStereoPanner();
    pan.pan.value = clamp(o.pan, -1, 1);
    g.connect(pan);
    chain.push(pan);
    out = pan;
  }
  out.connect(dest);
  if (o.send) {
    const s = ac.createGain();
    s.gain.value = o.sendGain ?? 0.3;
    out.connect(s).connect(o.send);
    chain.push(s);
  }

  mod.start(o.t0);
  carrier.start(o.t0);
  mod.stop(end + 0.05);
  carrier.stop(end + 0.05);
  disposeWith(carrier, chain);
  mod.onended = () => {
    try {
      mod.disconnect();
    } catch {
      /* already gone */
    }
  };
}

export interface BellOpts {
  t0: number;
  freq: number;
  gain: number;
  decay?: number;
  send?: AudioNode;
  sendGain?: number;
}

/** Additive bell: three inharmonic partials with staggered decays. */
export function bell(ac: AudioContext, dest: AudioNode, o: BellOpts): void {
  const partials = [1, 2.005, 3.01, 4.52];
  const weights = [1, 0.42, 0.22, 0.1];
  const decay = o.decay ?? 1.6;
  const bus = ac.createGain();
  bus.gain.value = 1;
  bus.connect(dest);
  if (o.send) {
    const s = ac.createGain();
    s.gain.value = o.sendGain ?? 0.5;
    bus.connect(s).connect(o.send);
    // The send hangs off the bus, so it dies with it below.
    setTimeoutDispose(s, decay * 1000 + 400);
  }
  for (let i = 0; i < partials.length; i++) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = o.freq * partials[i];
    const g = ac.createGain();
    const end = pluckEnv(g.gain, o.t0, 0.006, o.gain * weights[i], decay * (1 - i * 0.16));
    osc.connect(g).connect(bus);
    osc.start(o.t0);
    osc.stop(end + 0.05);
    disposeWith(osc, [g]);
  }
  setTimeoutDispose(bus, decay * 1000 + 500);
}

function setTimeoutDispose(node: AudioNode, ms: number): void {
  setTimeout(() => {
    try {
      node.disconnect();
    } catch {
      /* already gone */
    }
  }, ms);
}

// ---------------------------------------------------------------------------
// Ambience beds
// ---------------------------------------------------------------------------

export interface BedHandle {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  /** The bed's own level; the director drives this from world state. */
  level: GainNode;
  lfos: OscillatorNode[];
  stop(): void;
}

/**
 * A continuous filtered-noise bed with a slowly modulated filter and a slow
 * amplitude swell. Two LFOs is all it takes to keep a loop from sounding
 * looped.
 */
export function noiseBed(
  ac: AudioContext,
  dest: AudioNode,
  buf: AudioBuffer,
  cfg: {
    type: BiquadFilterType;
    freq: number;
    q: number;
    gain: number;
    /** Filter sweep. */
    sweepHz: number;
    sweepDepth: number;
    /** Amplitude swell. */
    swellHz: number;
    swellDepth: number;
    rate?: number;
  },
): BedHandle {
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = cfg.rate ?? 1;

  const filt = ac.createBiquadFilter();
  filt.type = cfg.type;
  filt.frequency.value = cfg.freq;
  filt.Q.value = cfg.q;

  const swell = ac.createGain();
  swell.gain.value = 1 - cfg.swellDepth;

  const level = ac.createGain();
  level.gain.value = cfg.gain;

  src.connect(filt).connect(swell).connect(level).connect(dest);

  const lfos: OscillatorNode[] = [];

  if (cfg.sweepDepth > 0) {
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = cfg.sweepHz;
    const amt = ac.createGain();
    amt.gain.value = cfg.sweepDepth;
    lfo.connect(amt).connect(filt.frequency);
    lfo.start();
    lfos.push(lfo);
  }
  if (cfg.swellDepth > 0) {
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = cfg.swellHz;
    const amt = ac.createGain();
    amt.gain.value = cfg.swellDepth;
    lfo.connect(amt).connect(swell.gain);
    lfo.start();
    lfos.push(lfo);
  }

  src.start(0, Math.random() * Math.max(0.01, buf.duration - 0.5));

  return {
    source: src,
    filter: filt,
    level,
    lfos,
    stop() {
      try {
        src.stop();
      } catch {
        /* not started */
      }
      for (const l of lfos) {
        try {
          l.stop();
        } catch {
          /* not started */
        }
      }
    },
  };
}
