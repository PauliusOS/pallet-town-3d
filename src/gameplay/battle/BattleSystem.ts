import * as THREE from 'three';
import type { GameContext } from '../../core/Context';
import { EVENTS } from '../../core/Context';
import type { System } from '../../core/Engine';
import { clamp, lerp } from '../../core/Noise';
import { buildPokeBall, type PokeBall } from '../pokemon/PokeBall';
import { Battle, type BattleAction, type BattleEvent, type Side } from './BattleEngine';
import { MOVES, SPECIES, type SpeciesId } from './data';
import { buildCreature, type BattleCreature } from './creatures';
import { BattleFX } from './BattleFX';
import { PlayerData } from './PlayerData';
import { ARENA_CENTER, PAD_PLAYER, PAD_WILD, type BattleArena } from './BattleScene';
import { BattleUI, type MenuChoice } from '../../ui/BattleUI';

/**
 * BattleSystem — the wild-battle director.
 *
 * Registered AFTER player-sys so its camera write wins the frame. Owns the
 * whole flow: transition, intro sweep, send-out, menu loop, turn playback
 * from BattleEngine's event list, outcome, and the return to the overworld.
 *
 * Time inside a battle runs on its own clock (`bt`) scaled by `timeScale`,
 * which is what lets the screenshot harness fast-forward to a phase, freeze
 * the exact frame it wants, and get the same pixels every run.
 */

type Phase =
  | 'idle'
  | 'transition-in'
  | 'intro'
  | 'menu'
  | 'moves'
  | 'turn'
  | 'outcome'
  | 'transition-out';

interface StartOpts {
  wild?: SpeciesId;
  playerMon?: SpeciesId;
  seed?: number;
  wildLevel?: number;
}

/** Player spawn used by the white-out return. Mirrors main.ts. */
const SPAWN = new THREE.Vector3(-7.6, 0, 6.2);
const SPAWN_YAW = -0.62;

interface PlayerLike {
  teleport(pos: THREE.Vector3, yaw?: number): void;
  state: { position: THREE.Vector3 };
}

function getPlayer(): PlayerLike | null {
  const g = (globalThis as unknown as { __GAME__?: { player?: PlayerLike } }).__GAME__;
  return g?.player ?? null;
}

const V = () => new THREE.Vector3();

export class BattleSystem implements System {
  readonly name = 'battle-sys';

  phase: Phase = 'idle';
  /** Fine-grained sub-phase for the capture harness. */
  marker = '';
  timeScale = 1;

  private ctx: GameContext;
  private arena: BattleArena;
  private ui: BattleUI;
  private fx: BattleFX;

  private battle: Battle | null = null;
  private allyMon: BattleCreature | null = null;
  private wildMon: BattleCreature | null = null;
  private ball: PokeBall | null = null;
  private battleGroup = new THREE.Group();

  // ---- battle clock ------------------------------------------------------
  private bt = 0;
  private waits: { t: number; res: () => void }[] = [];
  private anims: { t0: number; dur: number; fn: (t: number) => void; res: () => void }[] = [];
  private predicates: { test: () => boolean; res: () => void }[] = [];

  // ---- camera ------------------------------------------------------------
  private camPos = V();
  private camLook = V();
  private camPosT = V();
  private camLookT = V();
  private camSpeed = 3;
  private idleDrift = false;
  private shakeMag = 0;

  // ---- transition dressing ----------------------------------------------
  private fader: HTMLDivElement;
  private flash: HTMLDivElement;
  private gradeBase: { exposure: number; saturation: number; chromatic: number; vignette: number };

  private menuChoice: MenuChoice | null = null;
  private pendingSkip = false;
  private disposed = false;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    const arena = ctx.scene.userData.battleArena as BattleArena | undefined;
    if (!arena) throw new Error('[battle] arena missing — was buildBattleArena registered?');
    this.arena = arena;

    this.battleGroup.name = 'BattleActors';
    this.arena.group.add(this.battleGroup);
    this.fx = new BattleFX(this.arena.group, ctx.seed);

    const host = (document.querySelector('#app .pt-ui') as HTMLElement) ?? document.getElementById('app') ?? document.body;
    this.ui = new BattleUI(host);
    this.ui.onChoose = (c) => {
      this.menuChoice = c;
    };
    this.ui.onNavigate = () => ctx.events.emit('ui:tick');

    // Fade / flash overlays for the transition.
    this.fader = document.createElement('div');
    this.fader.style.cssText =
      'position:fixed;inset:0;background:#08070c;opacity:0;pointer-events:none;z-index:39;transition:opacity 300ms ease-in-out';
    document.body.appendChild(this.fader);
    this.flash = document.createElement('div');
    this.flash.style.cssText =
      'position:fixed;inset:0;background:radial-gradient(circle at 50% 46%, #ffffff 0%, #ffe9c0 55%, rgba(255,233,192,0) 100%);opacity:0;pointer-events:none;z-index:41;transition:opacity 90ms ease-out';
    document.body.appendChild(this.flash);

    const s = ctx.engine.postfx.settings;
    this.gradeBase = {
      exposure: s.exposure,
      saturation: s.saturation,
      chromatic: s.chromatic,
      vignette: s.vignette,
    };

    PlayerData.init(ctx);

    ctx.events.on('battle:encounter', (payload) => {
      const p = payload as { species?: SpeciesId; level?: number; seed?: number } | undefined;
      if (this.phase !== 'idle') return;
      void this.startBattle({
        wild: p?.species ?? 'pidgey',
        wildLevel: p?.level ?? 3,
        seed: p?.seed ?? 1,
      });
    });

    this.publishDebug();
  }

  get active(): boolean {
    return this.phase !== 'idle';
  }

  /* ================================================================== */
  /* Clock                                                              */
  /* ================================================================== */

  private wait(seconds: number): Promise<void> {
    return new Promise((res) => this.waits.push({ t: this.bt + seconds, res }));
  }

  /** Runs `fn(t)` every frame for `dur` battle-seconds, t eased 0..1 raw. */
  private animate(dur: number, fn: (t: number) => void): Promise<void> {
    return new Promise((res) => this.anims.push({ t0: this.bt, dur, fn, res }));
  }

  private waitFor(test: () => boolean): Promise<void> {
    if (test()) return Promise.resolve();
    return new Promise((res) => this.predicates.push({ test, res }));
  }

  /* ================================================================== */
  /* Start                                                              */
  /* ================================================================== */

  async startBattle(opts: StartOpts = {}): Promise<void> {
    if (this.phase !== 'idle') return;
    this.phase = 'transition-in';
    this.marker = 'flash';
    this.bt = 0;

    const seed = (opts.seed ?? ((this.ctx.seed ^ 0x6a11) >>> 0)) >>> 0;
    if (opts.playerMon) PlayerData.setPartner(opts.playerMon, 5);
    const partner = PlayerData.ensurePartner('charmander');
    const wildSpecies = opts.wild ?? 'pidgey';
    const wildLevel = opts.wildLevel ?? 3;

    this.battle = new Battle({
      player: { species: partner.species, level: partner.level, hp: partner.hp },
      wild: { species: wildSpecies, level: wildLevel },
      seed,
    });
    this.fx.reseed(seed ^ 0x77);

    // Freeze the overworld.
    this.ctx.scene.userData.battleActive = true;
    this.ctx.events.emit(EVENTS.CINEMATIC, true);
    this.ctx.engine.input.suspended = true;
    this.ctx.events.emit('battle:start');
    this.ctx.events.emit('ui:tick');

    // ---- Transition: chromatic snap + white flash + dip to black.
    const s = this.ctx.engine.postfx.settings;
    void this.animate(0.3, (t) => {
      s.chromatic = this.gradeBase.chromatic + t * 0.02;
      s.saturation = this.gradeBase.saturation * (1 - t * 0.65);
      s.exposure = this.gradeBase.exposure * (1 + t * 0.5);
    });
    await this.wait(0.16);
    this.flash.style.opacity = '1';
    await this.wait(0.14);
    this.fader.style.opacity = '1';
    this.flash.style.opacity = '0';
    await this.wait(0.34);

    // ---- Build the stage while the screen is black.
    this.arena.setActive(true);
    this.spawnCombatants(wildSpecies, partner.species, seed);
    this.warmPrograms();
    s.chromatic = this.gradeBase.chromatic;
    s.saturation = this.gradeBase.saturation;
    s.exposure = this.gradeBase.exposure;

    // Wild mon reveal framing: low, close, dramatic.
    const wildHead = PAD_WILD.clone().add(new THREE.Vector3(0, 0.32, 0));
    this.cutTo(PAD_WILD.clone().add(new THREE.Vector3(-1.0, 0.3, 1.35)), wildHead);
    this.idleDrift = false;

    this.ui.show();
    this.ui.setFoe(SPECIES[wildSpecies].name.toUpperCase(), wildLevel, 1);
    this.ui.setAlly(SPECIES[partner.species].name.toUpperCase(), partner.level, this.battle.player.hp, this.battle.player.stats.hp);

    await this.wait(0.12);
    this.fader.style.opacity = '0';

    // ---- Intro.
    this.phase = 'intro';
    this.marker = 'intro-reveal';
    void this.intro();
  }

  private spawnCombatants(wild: SpeciesId, ally: SpeciesId, seed: number): void {
    this.wildMon = buildCreature(wild);
    this.wildMon.group.position.copy(PAD_WILD).sub(ARENA_CENTER);
    this.wildMon.group.rotation.y = 0; // faces +Z, toward the player pad
    this.wildMon.group.scale.setScalar(0.001);
    this.wildMon.attention = 1;
    this.battleGroup.add(this.wildMon.group);

    this.allyMon = buildCreature(ally);
    this.allyMon.group.position.copy(PAD_PLAYER).sub(ARENA_CENTER);
    this.allyMon.group.rotation.y = Math.PI; // faces -Z, toward the wild pad
    // Visible at zero scale rather than hidden: Charmander carries two point
    // lights, and flipping them on mid-battle changes the scene's light count
    // and recompiles every material on the send-out frame.
    this.allyMon.group.scale.setScalar(0.0001);
    this.allyMon.attention = 1;
    this.battleGroup.add(this.allyMon.group);

    this.ball = buildPokeBall(seed % 97);
    this.ball.group.visible = false;
    // Remove the ball's release-flash sprite outright. On the ANGLE/Metal
    // path a visible SpriteMaterial in this scene intermittently wedged the
    // entire frame into black (sprites bypass scene.overrideMaterial, so they
    // are the one transparent quad the G-buffer prepass cannot hide). The
    // send-out burst is carried by BattleFX's ring + sparkles instead.
    const sprites: THREE.Object3D[] = [];
    this.ball.group.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) sprites.push(o);
    });
    for (const s of sprites) s.removeFromParent();
    this.battleGroup.add(this.ball.group);
  }

  /**
   * Compiles every program a battle can need while the fader is opaque.
   *
   * First-use shader compilation mid-battle is not just a hitch: on the
   * ANGLE/Metal path a compile landing on the same frame as new transparent
   * geometry (the ball's release-flash sprite, the burst particles)
   * intermittently wedged the whole scene into rendering black until some
   * later material change flushed the state. Compiling up front, behind the
   * transition, removes the race and the hitch together.
   */
  private warmPrograms(): void {
    const ball = this.ball!;
    const ballVis = ball.group.visible;
    ball.group.visible = true;
    ball.setOpen(0.5); // makes the release-flash sprite renderable

    // Exercise every FX program variant far below the stage.
    const off = new THREE.Vector3(0, -30, 0);
    this.fx.ring(off);
    this.fx.sparkles(off, 0xffffff, 4);
    this.fx.impact(off, 0xffffff, 0.1);
    this.fx.dust(off, 4);
    this.fx.vineWhip(off, off.clone().add(new THREE.Vector3(1, 0, 0)), 0.2);

    const engine = this.ctx.engine;
    engine.renderer.compile(engine.scene, this.ctx.camera);

    this.fx.clear();
    ball.setOpen(0);
    ball.group.visible = ballVis;
  }

  private async intro(): Promise<void> {
    const b = this.battle!;
    const wildName = b.wild.name;

    // Wild mon pops onto its pad under the rim light.
    this.fx.ring(PAD_WILD.clone().sub(ARENA_CENTER), 0xbcd4ff, 1.5, 0.5);
    this.fx.dust(PAD_WILD.clone().sub(ARENA_CENTER), 20);
    void this.animate(0.42, (t) => {
      this.wildMon?.group.scale.setScalar(Math.max(0.001, easeOutBack(t)));
    });
    this.ctx.events.emit('battle:appear');

    const sayP = this.ui.say(`Wild ${wildName} appeared!`, 0.7);

    // Slow arc from the low reveal up into the wide two-shot.
    const wildHead = PAD_WILD.clone().add(new THREE.Vector3(0, 0.32, 0));
    await this.animate(2.0, (t) => {
      const e = smooth(t);
      const a = lerp(-0.78, 0.4, e);
      const r = lerp(1.55, 5.3, e);
      const y = lerp(0.26, 1.4, e * e);
      this.cutTo(
        new THREE.Vector3(ARENA_CENTER.x + Math.sin(a) * r, ARENA_CENTER.y + y, ARENA_CENTER.z + Math.cos(a) * r * 0.92),
        wildHead.clone().lerp(ARENA_CENTER.clone().add(new THREE.Vector3(0, 0.55, -0.2)), e),
      );
    });
    await sayP;

    // ---- Send-out: ball toss, burst, creature out.
    this.marker = 'send-out';
    const sendSay = this.ui.say(`Go! ${b.player.name}!`, 0.5);
    await this.throwBall();
    await sendSay;

    this.beginMenu();
  }

  private async throwBall(): Promise<void> {
    const ball = this.ball!;
    const pad = PAD_PLAYER.clone().sub(ARENA_CENTER);
    const from = pad.clone().add(new THREE.Vector3(-1.4, 1.1, 2.6));
    ball.group.visible = true;
    ball.setOpen(0);

    await this.animate(0.55, (t) => {
      const e = t;
      const p = from.clone().lerp(pad, e);
      p.y += Math.sin(e * Math.PI) * 1.15 + 0.037;
      ball.group.position.copy(p);
      ball.group.rotation.x = e * Math.PI * 3.2;
    });

    // Burst.
    this.marker = 'send-out-burst';
    ball.setOpen(1);
    this.fx.ring(pad, 0xfff0c4, 1.6, 0.5);
    this.fx.sparkles(pad, 0xfff4d0, 48);
    this.ctx.events.emit('ui:confirm');

    const mon = this.allyMon!;
    mon.group.scale.setScalar(0.001);
    void this.animate(0.5, (t) => {
      mon.group.scale.setScalar(Math.max(0.001, easeOutBack(t)));
      ball.setOpen(1 - t * 0.4);
    });
    await this.wait(0.35);
    ball.group.visible = false;
  }

  private beginMenu(): void {
    if (!this.battle) return;
    this.phase = 'menu';
    this.marker = 'menu';
    this.idleDrift = true;
    this.menuChoice = null;
    this.ui.showMainMenu();
    void this.ui.say(`What will ${this.battle.player.name} do?`, 9999);
  }

  /* ================================================================== */
  /* Menu input                                                          */
  /* ================================================================== */

  private handleMenuInput(): void {
    const input = this.ctx.engine.input;
    if (input.wasPressed('KeyW') || input.wasPressed('ArrowUp')) this.ui.nav('up');
    if (input.wasPressed('KeyS') || input.wasPressed('ArrowDown')) this.ui.nav('down');
    if (input.wasPressed('KeyA') || input.wasPressed('ArrowLeft')) this.ui.nav('left');
    if (input.wasPressed('KeyD') || input.wasPressed('ArrowRight')) this.ui.nav('right');
    if (
      input.wasPressed('KeyE') ||
      input.wasPressed('Enter') ||
      input.wasPressed('NumpadEnter') ||
      input.wasPressed('Space')
    ) {
      this.ui.confirm();
    }
    if (input.wasPressed('KeyQ') || input.wasPressed('Escape')) this.ui.back();

    const c = this.menuChoice;
    if (!c) return;
    this.menuChoice = null;

    if (this.phase === 'menu') {
      if (c.kind === 'fight') {
        this.phase = 'moves';
        this.marker = 'moves';
        this.ui.showMoves(this.battle!.player.moves);
        this.ctx.events.emit('ui:confirm');
      } else if (c.kind === 'run') {
        this.ctx.events.emit('ui:confirm');
        void this.playTurn({ type: 'run' });
      }
    } else if (this.phase === 'moves') {
      if (c.kind === 'back') {
        this.beginMenu();
        this.ctx.events.emit('ui:tick');
      } else if (c.kind === 'move') {
        this.ctx.events.emit('ui:confirm');
        void this.playTurn({ type: 'move', index: c.index });
      }
    }
  }

  /* ================================================================== */
  /* Turn playback                                                       */
  /* ================================================================== */

  private async playTurn(action: BattleAction): Promise<void> {
    if (!this.battle || (this.phase !== 'menu' && this.phase !== 'moves')) return;
    this.phase = 'turn';
    this.marker = 'turn';
    this.idleDrift = false;
    this.ui.hideMenu();
    this.ui.hideMessage();

    const events = this.battle.turn(action);
    for (const ev of events) {
      if (this.disposed) return;
      await this.playEvent(ev);
    }

    PlayerData.setHp(this.battle.player.hp);

    if (this.battle.result) {
      await this.finish(this.battle.result);
    } else {
      this.toWideShot(2.2);
      this.beginMenu();
    }
  }

  private creatureOf(side: Side): BattleCreature {
    return side === 'player' ? this.allyMon! : this.wildMon!;
  }

  private padOf(side: Side): THREE.Vector3 {
    return (side === 'player' ? PAD_PLAYER : PAD_WILD).clone().sub(ARENA_CENTER);
  }

  private async playEvent(ev: BattleEvent): Promise<void> {
    switch (ev.kind) {
      case 'move':
        await this.playMove(ev);
        break;
      case 'stat':
        await this.playStat(ev);
        break;
      case 'faint':
        await this.playFaint(ev.side);
        break;
      case 'run':
        await this.ui.say(ev.success ? 'Got away safely!' : "Can't escape!", 0.8);
        break;
      case 'end':
        break;
    }
  }

  private async playMove(ev: Extract<BattleEvent, { kind: 'move' }>): Promise<void> {
    const attacker = this.creatureOf(ev.side);
    const defenderSide: Side = ev.side === 'player' ? 'wild' : 'player';
    const defender = this.creatureOf(defenderSide);
    const aPad = this.padOf(ev.side);
    const dPad = this.padOf(defenderSide);
    const move = MOVES[ev.moveId];
    const b = this.battle!;
    const attackerName = ev.side === 'player' ? b.player.name : `Wild ${b.wild.name}`;

    // Camera: punch in over the attacker's shoulder.
    this.marker = 'windup';
    this.punchInOn(ev.side);
    const sayP = this.ui.say(`${attackerName} used ${move.name.toUpperCase()}!`, 0.4);

    // Wind-up: crouch and coil.
    await this.animate(0.22, (t) => {
      const c = Math.sin(t * Math.PI);
      attacker.group.scale.set(1 + c * 0.08, 1 - c * 0.16, 1 + c * 0.08);
      attacker.group.position.y = aPad.y;
    });

    const contact = move.fx === 'tackle' || move.fx === 'quick';
    const aWorld = aPad.clone().add(new THREE.Vector3(0, 0.3, 0));
    const dWorld = dPad.clone().add(new THREE.Vector3(0, 0.3, 0));

    if (contact) {
      // Dash to the defender.
      const hitPoint = aPad.clone().lerp(dPad, 0.72);
      if (move.fx === 'quick') this.fx.dashStreak(aWorld, dWorld, 0xffffff);
      await this.animate(move.fx === 'quick' ? 0.12 : 0.18, (t) => {
        const e = t * t;
        attacker.group.position.copy(aPad.clone().lerp(hitPoint, e));
        attacker.group.position.y = aPad.y + Math.sin(t * Math.PI) * 0.22;
        const st = 1 + t * 0.12;
        attacker.group.scale.set(1 / Math.sqrt(st), 1 / Math.sqrt(st), st);
      });
    } else {
      // Ranged: cast the projectile from the attacker's face.
      const mouth = aPad.clone().add(new THREE.Vector3(0, 0.35, 0)).lerp(dWorld, 0.12);
      let flight = 0.34;
      switch (move.fx) {
        case 'ember':
          this.fx.emberArc(mouth, dWorld, 0.38);
          flight = 0.38;
          break;
        case 'water':
          this.fx.waterStream(mouth, dWorld, 0.42);
          flight = 0.32;
          break;
        case 'gust': {
          this.fx.gust(dPad.clone(), 0.75);
          // Wing thrash while the vortex spins up.
          void this.animate(0.5, (t) => {
            attacker.group.rotation.z = Math.sin(t * Math.PI * 5) * 0.16;
          });
          flight = 0.5;
          break;
        }
        case 'vine':
          this.fx.vineWhip(aWorld, dWorld, 0.4);
          flight = 0.26;
          break;
        default:
          flight = 0.3;
      }
      await this.wait(flight);
    }

    // ---- Impact frame.
    if (ev.missed) {
      this.cutToDefender(defenderSide);
      // Sidestep dodge.
      void this.animate(0.3, (t) => {
        const c = Math.sin(t * Math.PI);
        defender.group.position.x = dPad.x + c * 0.5;
      });
      await sayP;
      await this.ui.say('The attack missed!', 0.7);
    } else {
      const eff = ev.effectiveness;
      const strength = (eff >= 2 ? 1.7 : eff === 0 ? 0.3 : eff < 1 ? 0.6 : 1) * (ev.crit ? 1.35 : 1);
      this.marker = 'impact';
      this.cutToDefender(defenderSide);
      this.shakeMag = 0.05 * strength;
      this.fx.impact(dWorld, eff >= 2 ? 0xffd24a : 0xffe9a8, strength);
      this.flashCreature(defender, strength);
      this.ctx.events.emit('battle:hit', { eff, crit: ev.crit });

      // Knockback jitter on the defender.
      const dir = dPad.clone().sub(aPad).setY(0).normalize();
      void this.animate(0.34, (t) => {
        const k = Math.sin(Math.min(1, t * 1.6) * Math.PI) * 0.24 * strength;
        const jit = Math.sin(t * 60) * 0.03 * strength * (1 - t);
        defender.group.position.set(dPad.x + dir.x * k + jit, dPad.y, dPad.z + dir.z * k);
        const sq = 1 - Math.sin(t * Math.PI) * 0.12 * Math.min(1.2, strength);
        defender.group.scale.set(1 + (1 - sq), sq, 1 + (1 - sq));
      });

      // Hold the impact marker long enough for the harness to catch it.
      await this.wait(0.12);

      // HP drain begins as the hit lands.
      this.marker = 'drain';
      if (defenderSide === 'wild') this.ui.driveFoeHp(ev.hpAfter / b.wild.stats.hp);
      else this.ui.driveAllyHp(ev.hpAfter);

      await sayP;

      if (ev.crit) await this.ui.say('A critical hit!', 0.55);
      if (eff >= 2) {
        this.marker = 'message-eff';
        await this.ui.say("It's super effective!", 0.65);
      } else if (eff === 0) {
        await this.ui.say(`It doesn't affect ${defenderSide === 'wild' ? `Wild ${b.wild.name}` : b.player.name}...`, 0.65);
      } else if (eff < 1) {
        await this.ui.say("It's not very effective...", 0.65);
      }
      await this.waitFor(() => !this.ui.draining);
    }

    // Return the attacker to its pad and settle scales.
    await this.animate(0.22, (t) => {
      attacker.group.position.lerpVectors(attacker.group.position.clone(), aPad, smooth(t));
      attacker.group.scale.setScalar(1);
      attacker.group.rotation.z = 0;
      defender.group.scale.setScalar(1);
    });
    attacker.group.position.copy(aPad);
    defender.group.position.copy(this.padOf(defenderSide));
  }

  private async playStat(ev: Extract<BattleEvent, { kind: 'stat' }>): Promise<void> {
    const b = this.battle!;
    const userName = ev.side === 'player' ? b.player.name : `Wild ${b.wild.name}`;
    const targetName = ev.target === 'player' ? b.player.name : `Wild ${b.wild.name}`;
    const user = this.creatureOf(ev.side);
    const target = this.creatureOf(ev.target);
    const uPad = this.padOf(ev.side);
    const tPad = this.padOf(ev.target);

    this.marker = 'windup';
    this.punchInOn(ev.side);
    const sayP = this.ui.say(`${userName} used ${ev.moveName.toUpperCase()}!`, 0.4);

    // Posture: rear up (growl) or a quick spin (tail whip / sand).
    await this.animate(0.4, (t) => {
      const c = Math.sin(t * Math.PI);
      if (ev.moveName === 'Growl') {
        user.group.scale.set(1 + c * 0.1, 1 + c * 0.14, 1 + c * 0.1);
      } else {
        user.group.rotation.y += Math.sin(t * Math.PI * 2) * 0.06;
        user.group.scale.setScalar(1 + c * 0.05);
      }
    });

    const uWorld = uPad.clone().add(new THREE.Vector3(0, 0.3, 0));
    const tWorld = tPad.clone().add(new THREE.Vector3(0, 0.3, 0));
    if (ev.moveName === 'Sand Attack') this.fx.sandFan(uWorld, tWorld, 0.45);
    else this.fx.sonicRings(uWorld, tWorld);
    this.ctx.events.emit('ui:tick');
    await this.wait(0.45);
    user.group.scale.setScalar(1);

    // Target reaction: a small recoil shiver.
    void this.animate(0.35, (t) => {
      target.group.rotation.z = Math.sin(t * Math.PI * 6) * 0.05 * (1 - t);
    });

    await sayP;
    if (ev.failed) {
      await this.ui.say('But it failed!', 0.6);
    } else {
      const statName = ev.stat === 'atk' ? 'ATTACK' : ev.stat === 'def' ? 'DEFENSE' : ev.stat === 'spe' ? 'SPEED' : 'ACCURACY';
      await this.ui.say(`${targetName}'s ${statName} ${ev.delta < 0 ? 'fell' : 'rose'}!`, 0.7);
    }
    target.group.rotation.z = 0;
  }

  private async playFaint(side: Side): Promise<void> {
    const mon = this.creatureOf(side);
    const pad = this.padOf(side);
    const b = this.battle!;
    const name = side === 'player' ? b.player.name : `Wild ${b.wild.name}`;

    this.marker = 'faint';
    this.ctx.events.emit('battle:faint');

    // Low-angle tragedy shot.
    const camSide = side === 'wild' ? 1 : -1;
    this.glideTo(
      pad.clone().add(ARENA_CENTER).add(new THREE.Vector3(1.9 * camSide, 0.28, side === 'wild' ? 2.2 : -2.2)),
      pad.clone().add(ARENA_CENTER).add(new THREE.Vector3(0, 0.3, 0)),
      5,
    );

    // Fall over, sink, dust.
    await this.animate(0.55, (t) => {
      const e = smooth(t);
      mon.group.rotation.z = e * 1.45 * camSide;
      mon.group.position.y = pad.y + Math.sin(Math.min(1, t * 2) * Math.PI) * 0.12 - e * 0.1;
    });
    this.fx.dust(pad, 30);
    await this.animate(0.5, (t) => {
      mon.group.position.y = pad.y - 0.1 - t * 0.55;
      mon.group.scale.setScalar(Math.max(0.001, 1 - t * 0.65));
    });
    mon.group.visible = false;

    await this.ui.say(`${name} fainted!`, 0.85);
  }

  /* ================================================================== */
  /* Outcome                                                             */
  /* ================================================================== */

  private async finish(result: 'victory' | 'defeat' | 'fled'): Promise<void> {
    this.phase = 'outcome';

    if (result === 'victory') {
      this.marker = 'victory';
      const mon = this.allyMon!;
      // Hero shot on the winner.
      this.glideTo(
        PAD_PLAYER.clone().add(new THREE.Vector3(1.5, 0.75, -2.4)),
        PAD_PLAYER.clone().add(new THREE.Vector3(0, 0.35, 0)),
        4,
      );
      mon.celebrate();
      this.ctx.events.emit('battle:victory');
      await this.ui.say(`You defeated the wild ${this.battle!.wild.name}!`, 1.1);
      await this.wait(0.7);
    } else if (result === 'defeat') {
      this.marker = 'defeat';
      await this.ui.say('You whited out!', 1.2);
      PlayerData.healAll();
    } else {
      this.marker = 'fled';
      await this.wait(0.1);
    }

    await this.exitBattle(result);
  }

  private async exitBattle(result: 'victory' | 'defeat' | 'fled'): Promise<void> {
    this.phase = 'transition-out';
    this.marker = 'fade-out';
    this.ui.hideMessage();

    this.fader.style.opacity = '1';
    await this.wait(0.42);

    // Tear down the stage.
    this.arena.setActive(false);
    this.despawn();
    this.ui.hide();

    if (result === 'defeat') {
      getPlayer()?.teleport(SPAWN.clone(), SPAWN_YAW);
    }

    // Hand control back while the screen is still black.
    this.ctx.scene.userData.battleActive = false;
    this.ctx.engine.input.suspended = false;
    this.ctx.events.emit(EVENTS.CINEMATIC, false);
    await this.wait(0.08);

    this.fader.style.opacity = '0';
    this.timeScale = 1;
    this.phase = 'idle';
    this.marker = '';
    this.ctx.events.emit('battle:end', { result });
  }

  private despawn(): void {
    this.fx.clear();
    if (this.wildMon) {
      this.battleGroup.remove(this.wildMon.group);
      this.wildMon.dispose();
      this.wildMon = null;
    }
    if (this.allyMon) {
      this.battleGroup.remove(this.allyMon.group);
      this.allyMon.dispose();
      this.allyMon = null;
    }
    if (this.ball) {
      this.battleGroup.remove(this.ball.group);
      this.ball = null;
    }
    this.battle = null;
  }

  /* ================================================================== */
  /* Camera                                                              */
  /* ================================================================== */

  private cutTo(pos: THREE.Vector3, look: THREE.Vector3): void {
    this.camPos.copy(pos);
    this.camLook.copy(look);
    this.camPosT.copy(pos);
    this.camLookT.copy(look);
  }

  private glideTo(pos: THREE.Vector3, look: THREE.Vector3, speed = 3): void {
    this.camPosT.copy(pos);
    this.camLookT.copy(look);
    this.camSpeed = speed;
  }

  /** The default wide two-shot, from behind the player's mon right shoulder. */
  private toWideShot(speed = 3): void {
    this.glideTo(
      ARENA_CENTER.clone().add(new THREE.Vector3(2.4, 1.35, 4.7)),
      ARENA_CENTER.clone().add(new THREE.Vector3(0, 0.42, -0.6)),
      speed,
    );
  }

  private punchInOn(side: Side): void {
    const pad = (side === 'player' ? PAD_PLAYER : PAD_WILD).clone();
    const other = (side === 'player' ? PAD_WILD : PAD_PLAYER).clone();
    const back = pad.clone().sub(other).setY(0).normalize();
    const rightV = new THREE.Vector3(back.z, 0, -back.x);
    const cam = pad
      .clone()
      .addScaledVector(back, 1.55)
      .addScaledVector(rightV, 0.95)
      .add(new THREE.Vector3(0, 0.7, 0));
    this.glideTo(cam, other.clone().add(new THREE.Vector3(0, 0.32, 0)), 7);
  }

  private cutToDefender(side: Side): void {
    const pad = (side === 'player' ? PAD_PLAYER : PAD_WILD).clone();
    const attackerPad = (side === 'player' ? PAD_WILD : PAD_PLAYER).clone();
    const toward = attackerPad.clone().sub(pad).setY(0).normalize();
    const rightV = new THREE.Vector3(toward.z, 0, -toward.x);
    const cam = pad
      .clone()
      .addScaledVector(toward, 1.7)
      .addScaledVector(rightV, side === 'wild' ? -1.15 : 1.15)
      .add(new THREE.Vector3(0, 0.55, 0));
    this.cutTo(cam, pad.clone().add(new THREE.Vector3(0, 0.3, 0)));
  }

  private applyCamera(dt: number): void {
    const cam = this.ctx.camera;

    if (this.idleDrift) {
      // Breathing orbit on the wide shot.
      const t = this.bt;
      const a = Math.sin(t * 0.16) * 0.16;
      const r = 5.3 + Math.sin(t * 0.11 + 1.3) * 0.2;
      this.camPosT.set(
        ARENA_CENTER.x + Math.sin(a + 0.47) * r,
        ARENA_CENTER.y + 1.35 + Math.sin(t * 0.21) * 0.09,
        ARENA_CENTER.z + Math.cos(a + 0.47) * r * 0.9,
      );
      this.camLookT.set(ARENA_CENTER.x, ARENA_CENTER.y + 0.42, ARENA_CENTER.z - 0.6);
      this.camSpeed = 1.6;
    }

    const k = 1 - Math.exp(-this.camSpeed * dt);
    this.camPos.lerp(this.camPosT, k);
    this.camLook.lerp(this.camLookT, k);

    // Screen shake: camera-space noise, decaying fast.
    this.shakeMag *= Math.exp(-dt / 0.11);
    const s = this.shakeMag;
    const t = this.bt;
    const ox = (Math.sin(t * 47.1) + Math.sin(t * 23.7 + 1.2) * 0.6) * s;
    const oy = (Math.sin(t * 61.3 + 0.7) + Math.sin(t * 31.9 + 2.1) * 0.6) * s;

    cam.position.copy(this.camPos);
    cam.position.x += ox;
    cam.position.y += oy;
    cam.lookAt(this.camLook.x + ox * 0.4, this.camLook.y + oy * 0.4, this.camLook.z);
    cam.rotation.z += Math.sin(t * 39.7) * s * 0.35;
  }

  /* ================================================================== */
  /* Creature hit flash                                                  */
  /* ================================================================== */

  private flashCreature(mon: BattleCreature, strength: number): void {
    interface FlashOrig {
      hex: number;
      intensity: number;
    }
    const touched: { m: THREE.MeshStandardMaterial; orig: FlashOrig }[] = [];
    mon.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        if (!std.emissive) continue;
        // Originals are recorded ONCE per material. Overlapping flashes at
        // high time-scale used to capture mid-flash white as the "original"
        // and leave the whole creature glowing forever.
        const ud = std.userData as { __flashOrig?: FlashOrig };
        if (!ud.__flashOrig) ud.__flashOrig = { hex: std.emissive.getHex(), intensity: std.emissiveIntensity };
        touched.push({ m: std, orig: ud.__flashOrig });
        std.emissive.setHex(0xffffff);
      }
    });
    const peak = 0.7 * Math.min(1.4, strength);
    void this.animate(0.16, (t) => {
      const on = t < 0.5 || (t > 0.62 && t < 0.82); // double-strobe
      for (const rec of touched) rec.m.emissiveIntensity = on ? peak : 0;
    }).then(() => {
      for (const rec of touched) {
        rec.m.emissive.setHex(rec.orig.hex);
        rec.m.emissiveIntensity = rec.orig.intensity;
      }
    });
  }

  /* ================================================================== */
  /* Frame                                                               */
  /* ================================================================== */

  update(dt: number, elapsed: number): void {
    if (this.phase === 'idle') return;

    const sdt = dt * this.timeScale;
    this.bt += sdt;

    // Clock: waits, animations, predicates.
    if (this.waits.length) {
      const due = this.waits.filter((w) => w.t <= this.bt);
      this.waits = this.waits.filter((w) => w.t > this.bt);
      for (const w of due) w.res();
    }
    if (this.anims.length) {
      const done: typeof this.anims = [];
      for (const a of this.anims) {
        const t = a.dur <= 0 ? 1 : clamp((this.bt - a.t0) / a.dur, 0, 1);
        a.fn(t);
        if (t >= 1) done.push(a);
      }
      if (done.length) {
        this.anims = this.anims.filter((a) => !done.includes(a));
        for (const a of done) a.res();
      }
    }
    if (this.predicates.length) {
      const hit = this.predicates.filter((p) => p.test());
      this.predicates = this.predicates.filter((p) => !p.test());
      for (const p of hit) p.res();
    }

    // Skip-to-menu fast-forward.
    if (this.pendingSkip && this.phase === 'menu') {
      this.pendingSkip = false;
      this.timeScale = 1;
    }

    // Actors and stage.
    this.allyMon?.update(sdt, elapsed);
    this.wildMon?.update(sdt, elapsed);
    this.ball?.update(sdt, elapsed);
    this.arena.update(sdt, this.bt);
    this.fx.update(sdt);
    this.ui.update(sdt);

    // Input.
    if (this.phase === 'menu' || this.phase === 'moves') {
      this.handleMenuInput();
    } else if (this.phase === 'turn' || this.phase === 'intro') {
      // Confirm rushes the current message, like every Pokemon game.
      const input = this.ctx.engine.input;
      if (input.wasPressed('KeyE') || input.wasPressed('Enter') || input.wasPressed('Space')) {
        this.ui.rushMessage();
      }
    }

    this.applyCamera(sdt > 0 ? sdt : dt * 0.0001);
  }

  /* ================================================================== */
  /* Harness                                                             */
  /* ================================================================== */

  private publishDebug(): void {
    this.ctx.scene.userData.battleDebug = {
      start: (opts?: StartOpts) => {
        void this.startBattle(opts ?? {});
      },
      choose: (action: 'fight' | 'run') => {
        if (this.phase === 'menu') {
          this.menuChoice = { kind: action };
          // Processed on the next frame by handleMenuInput.
        }
      },
      move: (index: number) => {
        if (this.phase === 'menu') {
          this.menuChoice = { kind: 'fight' };
        }
        // Queue the move for when the move list opens (same frame or next).
        const submit = () => {
          if (this.phase === 'moves') {
            this.menuChoice = { kind: 'move', index };
            return true;
          }
          return false;
        };
        if (!submit()) void this.waitFor(() => this.phase === 'moves').then(() => submit());
      },
      skipToMenu: () => {
        if (this.phase === 'idle') void this.startBattle({});
        if (this.phase !== 'menu') {
          this.pendingSkip = true;
          this.timeScale = 30;
        }
      },
      resolveTurn: () => {
        if (this.phase === 'menu') void this.playTurn({ type: 'move', index: 0 });
        else if (this.phase === 'moves') void this.playTurn({ type: 'move', index: 0 });
      },
      state: () => `${this.phase}:${this.marker}`,
      setTimeScale: (k: number) => {
        this.timeScale = clamp(k, 0, 40);
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.ui.dispose();
    this.fader.remove();
    this.flash.remove();
  }
}

/* ------------------------------------------------------------------ */

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
