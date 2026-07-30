import type { GameContext } from '../core/Context';
import { EVENTS } from '../core/Context';
import {
  Rng,
  mtof,
  clamp,
  makeNoise,
  makeImpulse,
  noiseBurst,
  noiseBed,
  tone,
  fmChirp,
  bell,
  type BedHandle,
} from './Synth';

/**
 * AudioDirector — the entire soundscape, generated in code.
 *
 * Three layers, mixed on their own buses:
 *   ambience  wind, surf and birdsong, driven by where the player is standing
 *   music     a slow, warm, original four-bar progression with an arpeggio
 *   sfx       footsteps and UI
 *
 * The AudioContext is only ever created inside `unlock()`, which main.ts calls
 * from the first click. Every handler is registered up front but no-ops until
 * then, so nothing has to be re-wired after the gesture.
 */

type FootPayload = { surface?: string; speed?: number; land?: boolean };

interface FootRecipe {
  /** Body of the step — the material scuff. */
  freq: number;
  type: BiquadFilterType;
  q: number;
  dur: number;
  gain: number;
  attack: number;
  /** Low-frequency weight under the scuff. */
  thumpFreq: number;
  thumpGain: number;
  /** Optional ringing tail (stone only). */
  tailFreq?: number;
  tailQ?: number;
  tailGain?: number;
  tailDur?: number;
}

const FOOT: Record<string, FootRecipe> = {
  // Soft, airy, gone almost immediately — a scuff through blades.
  grass: {
    freq: 1900, type: 'bandpass', q: 0.7, dur: 0.085, gain: 0.30, attack: 0.005,
    thumpFreq: 190, thumpGain: 0.16,
  },
  // Duller and lower: packed earth swallows the top end.
  dirt: {
    freq: 780, type: 'lowpass', q: 0.6, dur: 0.075, gain: 0.34, attack: 0.004,
    thumpFreq: 135, thumpGain: 0.24,
  },
  // A hard, bright click with a short resonant ring off the slab.
  stone: {
    freq: 3400, type: 'bandpass', q: 2.2, dur: 0.035, gain: 0.26, attack: 0.0015,
    thumpFreq: 160, thumpGain: 0.14,
    tailFreq: 1500, tailQ: 9, tailGain: 0.09, tailDur: 0.19,
  },
  // Softest and longest — sand keeps hissing after the foot lands.
  sand: {
    freq: 1250, type: 'lowpass', q: 0.5, dur: 0.17, gain: 0.24, attack: 0.012,
    thumpFreq: 110, thumpGain: 0.10,
  },
};

/**
 * An original progression in F major — I / vi / IV / V with added ninths and
 * sixths, which is where the warmth lives. Deliberately not anyone's melody:
 * the arpeggio is generated from the chord tones each bar.
 */
const CHORDS: readonly (readonly number[])[] = [
  [41, 53, 57, 60, 64, 69], // Fmaj9   — home
  [38, 50, 57, 60, 65, 69], // Dm7     — the wistful turn
  [46, 53, 58, 62, 65, 70], // Bb6/9   — opens outward
  [36, 48, 55, 60, 62, 67], // Csus2   — leans back home
];

const BPM = 68;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

export class AudioDirector {
  readonly name = 'audio';

  private ctx: GameContext;
  private ac: AudioContext | null = null;
  private rng: Rng;

  // ---- mixer -------------------------------------------------------------
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private verb!: ConvolverNode;
  private verbReturn!: GainNode;

  // ---- beds --------------------------------------------------------------
  private wind: BedHandle | null = null;
  private windHiss: BedHandle | null = null;
  private surf: BedHandle | null = null;
  private surfDistance!: GainNode;
  private noiseSoft!: AudioBuffer;
  private noiseBright!: AudioBuffer;

  // ---- schedulers --------------------------------------------------------
  private birdTimer = 4;
  private nextBar = 0;
  private barIndex = 0;
  private lastFoot = -1;
  private lastUi = -1;
  private footToggle = 0;

  // ---- smoothed mix state ------------------------------------------------
  private mixAccum = 0;
  private surfLevel = 0;
  private indoorMix = 0;
  private duck = 0;
  private dialogueOpen = false;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.rng = new Rng((ctx.seed | 0) ^ 0x5eed_a17);
    this.wireEvents();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Called on the first user gesture. Browsers block audio before this. */
  unlock(): void {
    if (this.ac) {
      if (this.ac.state === 'suspended') this.resume(this.ac);
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return;

    let ac: AudioContext;
    try {
      ac = new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      console.warn('[audio] AudioContext unavailable', err);
      return;
    }
    this.ac = ac;

    try {
      this.buildMixer(ac);
      this.buildAmbience(ac);
      this.nextBar = ac.currentTime + 0.6;
      this.resume(ac);
    } catch (err) {
      console.warn('[audio] init failed', err);
      this.ac = null;
      return;
    }

    // Graceful fade-in: the town should ease into earshot, not snap on.
    const now = ac.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(0.0001, now);
    this.master.gain.linearRampToValueAtTime(0.85, now + 2.6);
  }

  /** resume() rejects on some platforms; a soundless game must never throw. */
  private resume(ac: AudioContext): void {
    try {
      const p: unknown = ac.resume();
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => undefined);
      }
    } catch {
      /* audio simply stays silent */
    }
  }

  private buildMixer(ac: AudioContext): void {
    this.master = ac.createGain();
    this.master.gain.value = 0.0001;
    this.master.connect(ac.destination);

    // One shared reverb for music and the sweeter SFX. Baked once.
    this.verb = ac.createConvolver();
    this.verb.buffer = makeImpulse(ac, 2.9, 2.6, new Rng(0x1f2e3d));
    this.verbReturn = ac.createGain();
    this.verbReturn.gain.value = 0.9;
    this.verb.connect(this.verbReturn).connect(this.master);

    this.musicBus = ac.createGain();
    this.musicBus.gain.value = 0.30;
    this.musicBus.connect(this.master);

    this.sfxBus = ac.createGain();
    this.sfxBus.gain.value = 0.62;
    this.sfxBus.connect(this.master);

    this.ambBus = ac.createGain();
    this.ambBus.gain.value = 0.5;
    this.ambBus.connect(this.master);
  }

  private buildAmbience(ac: AudioContext): void {
    // Two noise buffers only — every bed and every footstep resamples these.
    this.noiseSoft = makeNoise(ac, 6.5, this.rng, 0.72);
    this.noiseBright = makeNoise(ac, 3.0, this.rng, 0.12);

    // Wind: a broad body with a slowly wandering bandpass...
    this.wind = noiseBed(ac, this.ambBus, this.noiseSoft, {
      type: 'bandpass', freq: 460, q: 0.55, gain: 0.34,
      sweepHz: 0.043, sweepDepth: 250,
      swellHz: 0.071, swellDepth: 0.38,
    });
    // ...and a quiet high hiss on a different period, which reads as leaves.
    this.windHiss = noiseBed(ac, this.ambBus, this.noiseBright, {
      type: 'bandpass', freq: 3100, q: 0.8, gain: 0.045,
      sweepHz: 0.107, sweepDepth: 900,
      swellHz: 0.13, swellDepth: 0.55,
    });

    // Surf: heavily lowpassed with a long swell, gated by distance to the sea.
    this.surfDistance = ac.createGain();
    this.surfDistance.gain.value = 0.0001;
    this.surfDistance.connect(this.ambBus);
    this.surf = noiseBed(ac, this.surfDistance, this.noiseSoft, {
      type: 'lowpass', freq: 400, q: 0.9, gain: 0.85,
      sweepHz: 0.061, sweepDepth: 180,
      swellHz: 0.083, swellDepth: 0.62,
      rate: 0.8,
    });
  }

  // =========================================================================
  // Events
  // =========================================================================

  private wireEvents(): void {
    const ev = this.ctx.events;
    ev.on(EVENTS.FOOTSTEP, (p) => this.onFootstep(p as FootPayload));
    ev.on('input:confirm', () => {
      // While a dialogue box is open the confirm key advances text.
      if (this.dialogueOpen) this.tick();
      else this.confirm();
    });
    ev.on(EVENTS.SAY, () => this.tick());
    ev.on(EVENTS.DIALOGUE_ACTIVE, (a) => {
      this.dialogueOpen = !!a;
      if (a) this.tick();
    });
    ev.on(EVENTS.STARTER_CHOSEN, () => this.chime());
    ev.on(EVENTS.ENTER_ZONE, () => this.confirm());
    // Generic hooks so any system can ask for a sound without importing us.
    ev.on('ui:confirm', () => this.confirm());
    ev.on('ui:tick', () => this.tick());
    ev.on('ui:chime', () => this.chime());
  }

  // =========================================================================
  // Public SFX API — other systems call these directly or via 'ui:*' events.
  // =========================================================================

  /**
   * Rate limit shared by the UI voices: whatever another system does with its
   * events, we never stack blips on top of each other.
   */
  private gate(min: number): number {
    const ac = this.ac!;
    const t = ac.currentTime;
    if (t - this.lastUi < min) return -1;
    this.lastUi = t;
    return t;
  }

  /** Soft confirm blip: a small upward two-note gesture. */
  confirm(): void {
    const ac = this.ac;
    if (!ac) return;
    const t = this.gate(0.06);
    if (t < 0) return;
    fmChirp(ac, this.sfxBus, {
      t0: t, f0: 660, f1: 990, dur: 0.075, gain: 0.16, index: 0.25, ratio: 3.0,
      send: this.verb, sendGain: 0.14,
    });
    tone(ac, this.sfxBus, {
      t0: t + 0.055, freq: 1320, gain: 0.075, attack: 0.004, decay: 0.14,
      type: 'sine', send: this.verb, sendGain: 0.2,
    });
  }

  /** Dialogue-advance tick: dry, tiny, non-intrusive. */
  tick(): void {
    const ac = this.ac;
    if (!ac) return;
    const t = this.gate(0.04);
    if (t < 0) return;
    const f = 1500 * this.rng.range(0.94, 1.07);
    tone(ac, this.sfxBus, {
      t0: t, freq: f, gain: 0.055, attack: 0.002, decay: 0.045, type: 'triangle',
      cutoff: 4200,
    });
  }

  /** Warm chime for rewards and story beats — a rising major triad. */
  chime(): void {
    const ac = this.ac;
    if (!ac) return;
    const t = this.gate(0.35);
    if (t < 0) return;
    const notes = [65, 69, 72, 77]; // F A C F — bright and unambiguous.
    for (let i = 0; i < notes.length; i++) {
      bell(ac, this.sfxBus, {
        t0: t + i * 0.085,
        freq: mtof(notes[i]),
        gain: 0.11 * (1 - i * 0.12),
        decay: 1.5 + i * 0.35,
        send: this.verb,
        sendGain: 0.55,
      });
    }
  }

  private onFootstep(p: FootPayload): void {
    const ac = this.ac;
    if (!ac) return;
    const t = ac.currentTime;
    // Guard against double-triggers from bob phase jitter.
    if (t - this.lastFoot < 0.11) return;
    this.lastFoot = t;

    const r = FOOT[p.surface ?? 'grass'] ?? FOOT.grass;
    const rng = this.rng;
    const land = !!p.land;
    const speed = clamp(p.speed ?? 2.4, 0, 8);
    // Quiet at a stroll, present at a run; landings hit harder still.
    const drive = (land ? 1.75 : 0.55 + 0.45 * clamp(speed / 4.2, 0, 1)) * (1 - this.indoorMix * 0.25);
    // Per-step humanisation: no two steps share pitch, level or stereo place.
    const rate = rng.range(0.86, 1.18);
    const detune = rng.range(0.9, 1.13);
    const vol = rng.range(0.82, 1.14);
    this.footToggle ^= 1;
    const pan = (this.footToggle ? 1 : -1) * rng.range(0.05, 0.16);

    noiseBurst(ac, this.sfxBus, this.noiseBright, {
      t0: t,
      dur: r.dur * (land ? 1.35 : 1) * rng.range(0.9, 1.15),
      gain: r.gain * drive * vol,
      freq: r.freq * detune,
      type: r.type,
      q: r.q,
      attack: r.attack,
      rate,
      pan,
    });

    // The thump is the body weight; it is what sells contact with ground.
    noiseBurst(ac, this.sfxBus, this.noiseSoft, {
      t0: t,
      dur: (land ? 0.13 : 0.07) * rng.range(0.9, 1.1),
      gain: r.thumpGain * drive * vol,
      freq: r.thumpFreq * rng.range(0.88, 1.14),
      type: 'lowpass',
      q: 0.7,
      attack: 0.003,
      rate: rng.range(0.8, 1.1),
      pan: pan * 0.5,
    });

    if (r.tailFreq) {
      noiseBurst(ac, this.sfxBus, this.noiseBright, {
        t0: t + 0.004,
        dur: (r.tailDur ?? 0.18) * rng.range(0.85, 1.2),
        gain: (r.tailGain ?? 0.08) * drive * vol,
        freq: r.tailFreq * detune,
        type: 'bandpass',
        q: r.tailQ ?? 8,
        attack: 0.002,
        rate,
        pan,
      });
    }

    if (land) {
      // A short sine thud under a hard landing.
      tone(ac, this.sfxBus, {
        t0: t, freq: 74 * rng.range(0.92, 1.1), gain: 0.16, attack: 0.004,
        decay: 0.16, type: 'sine', cutoff: 300,
      });
    }
  }

  // =========================================================================
  // Per-frame: mix from world state, then two lookahead schedulers.
  // =========================================================================

  update(dt: number): void {
    const ac = this.ac;
    if (!ac || ac.state !== 'running') return;
    const now = ac.currentTime;

    // --- mix, at 12 Hz. AudioParam ramps do the smoothing, not the frame loop.
    this.mixAccum += dt;
    if (this.mixAccum >= 0.08) {
      this.mixAccum = 0;
      this.updateMix(ac, now);
    }

    // --- birdsong: sparse, randomised motifs, daylight and outdoors only.
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      const hour = this.ctx.env.timeOfDay;
      const awake = hour > 5 && hour < 20 && this.indoorMix < 0.5;
      if (awake) this.birdMotif(ac, now + 0.05);
      this.birdTimer = this.rng.range(awake ? 3.5 : 8, awake ? 11 : 16);
    }

    // --- music: schedule a bar at a time, a bar ahead.
    while (this.nextBar < now + BAR) {
      this.scheduleBar(ac, Math.max(this.nextBar, now + 0.05));
      this.nextBar += BAR;
      this.barIndex++;
    }
  }

  private updateMix(ac: AudioContext, now: number): void {
    const cam = this.ctx.camera.position;

    // Below the world floor means we are in the lab interior at y ~ -60.
    const indoorTarget = cam.y < -30 ? 1 : 0;
    this.indoorMix += (indoorTarget - this.indoorMix) * 0.25;

    // Surf rises as the player walks north toward the shoreline at z ~ -25.
    const seaT = clamp((-cam.z - 6) / 20, 0, 1);
    const surfTarget = seaT * seaT * (3 - 2 * seaT) * 0.85 * (1 - this.indoorMix);
    if (Math.abs(surfTarget - this.surfLevel) > 0.004) {
      this.surfLevel = surfTarget;
      this.surfDistance.gain.setTargetAtTime(Math.max(0.0001, surfTarget), now, 0.5);
    }

    // Wind tracks the atmosphere system, and drops indoors to a dull room tone.
    const gust = 0.55 + 0.75 * clamp(this.ctx.env.windStrength, 0, 1);
    const outdoor = 1 - this.indoorMix;
    if (this.wind) this.wind.level.gain.setTargetAtTime(0.34 * gust * (0.12 + 0.88 * outdoor), now, 0.35);
    if (this.windHiss) this.windHiss.level.gain.setTargetAtTime(0.05 * gust * outdoor, now, 0.35);

    // Duck the music a touch under dialogue so text reads clearly.
    const duckTarget = this.dialogueOpen ? 0.55 : 1;
    if (Math.abs(duckTarget - this.duck) > 0.01) {
      this.duck = duckTarget;
      this.musicBus.gain.setTargetAtTime(0.30 * duckTarget, now, 0.4);
    }
  }

  // =========================================================================
  // Generators
  // =========================================================================

  /** A short motif of 2-5 chirps, panned somewhere off in the trees. */
  private birdMotif(ac: AudioContext, t0: number): void {
    const rng = this.rng;
    const n = rng.int(2, 5);
    const pan = rng.range(-0.85, 0.85);
    const base = rng.range(1750, 3100);
    const far = rng.range(0.35, 1);
    let t = t0;
    for (let i = 0; i < n; i++) {
      const up = rng.chance(0.62);
      const f0 = base * rng.range(0.9, 1.15);
      const f1 = f0 * (up ? rng.range(1.25, 1.9) : rng.range(0.55, 0.82));
      const dur = rng.range(0.04, 0.11);
      fmChirp(ac, this.ambBus, {
        t0: t,
        f0,
        f1,
        dur,
        gain: 0.05 * far * (1 - this.indoorMix) * rng.range(0.7, 1.15),
        index: rng.range(0.12, 0.5),
        ratio: rng.chance(0.5) ? 2.0 : 3.01,
        pan,
        send: this.verb,
        sendGain: 0.45 * (1 - far * 0.5),
      });
      t += dur + rng.range(0.035, 0.13);
    }
  }

  /**
   * One bar of music: a swelling pad on the low chord tones plus a sparse,
   * wandering eighth-note arpeggio on the upper ones. Every fourth bar gets a
   * two-note answering phrase up top. It loops forever without repeating
   * exactly, because the arpeggio is re-rolled each time.
   */
  private scheduleBar(ac: AudioContext, t0: number): void {
    const rng = this.rng;
    const chord = CHORDS[this.barIndex % CHORDS.length];
    const send = this.verb;

    // --- pad: the bottom three voices, slow in, slow out, slightly detuned.
    for (let i = 0; i < 3; i++) {
      const m = chord[i];
      tone(ac, this.musicBus, {
        t0,
        freq: mtof(m),
        gain: (i === 0 ? 0.075 : 0.045) * rng.range(0.9, 1.08),
        attack: 1.1,
        hold: BAR * 0.45,
        release: BAR * 0.85,
        type: i === 0 ? 'sine' : 'triangle',
        detune: rng.range(-7, 7),
        cutoff: 900 + i * 350,
        pan: i === 1 ? -0.3 : i === 2 ? 0.3 : 0,
        send,
        sendGain: 0.4,
      });
    }

    // --- arpeggio: eighths, with rests, drifting up and down the chord.
    const upper = chord.slice(2);
    let idx = rng.int(0, upper.length - 1);
    let dir = rng.chance(0.5) ? 1 : -1;
    for (let s = 0; s < 8; s++) {
      // Leave air: a fully dense arpeggio would fight the ambience.
      if (s !== 0 && rng.chance(0.32)) {
        idx = clamp(idx + dir, 0, upper.length - 1);
        continue;
      }
      idx += dir;
      if (idx >= upper.length) {
        idx = upper.length - 2;
        dir = -1;
      } else if (idx < 0) {
        idx = 1;
        dir = 1;
      }
      const oct = rng.chance(0.18) ? 12 : 0;
      const t = t0 + s * (BEAT / 2) + rng.range(-0.012, 0.012);
      tone(ac, this.musicBus, {
        t0: t,
        freq: mtof(upper[idx] + oct),
        gain: 0.05 * rng.range(0.7, 1.1) * (s % 2 === 0 ? 1 : 0.78),
        attack: 0.012,
        decay: rng.range(0.9, 1.7),
        type: 'triangle',
        cutoff: 2600,
        pan: rng.range(-0.35, 0.35),
        send,
        sendGain: 0.5,
      });
    }

    // --- answering phrase every fourth bar: two soft high notes.
    if (this.barIndex % 4 === 3) {
      const top = chord[chord.length - 1] + 12;
      const a = top - rng.pick([0, 2, 3, 5]);
      const b = top - rng.pick([5, 7, 9]);
      tone(ac, this.musicBus, {
        t0: t0 + BEAT * 2, freq: mtof(a), gain: 0.042, attack: 0.05,
        decay: 1.4, type: 'sine', pan: 0.15, send, sendGain: 0.6,
      });
      tone(ac, this.musicBus, {
        t0: t0 + BEAT * 3, freq: mtof(b), gain: 0.038, attack: 0.05,
        decay: 1.8, type: 'sine', pan: -0.15, send, sendGain: 0.6,
      });
    }
  }

  // =========================================================================

  /** Fade out and release the graph. Not used in-game, but keeps this honest. */
  dispose(): void {
    const ac = this.ac;
    if (!ac) return;
    this.wind?.stop();
    this.windHiss?.stop();
    this.surf?.stop();
    this.wind = this.windHiss = this.surf = null;
    void ac.close().catch(() => undefined);
    this.ac = null;
  }
}
