import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import { EVENTS } from '../core/Context';
import { clamp } from '../core/Noise';

/**
 * First-person player controller.
 *
 * Feel targets, in priority order:
 *  1. The camera must never jitter. All smoothing is framerate-independent
 *     exponential decay, and the eye height follows the ground through a
 *     critically-damped spring so kerbs and slopes never punch the view.
 *  2. Movement is grounded, not floaty — quick acceleration, quick stop, with
 *     a small amount of momentum so strafing feels like a body and not a
 *     tripod.
 *  3. Head bob is driven by distance travelled, not by time, so it stays
 *     locked to footfalls at every speed and stops dead when you do.
 */

const EYE_HEIGHT = 1.62;
const CROUCH_HEIGHT = 1.05;
const RADIUS = 0.32;

const WALK_SPEED = 2.5;
const RUN_SPEED = 4.85;
const CROUCH_SPEED = 1.35;

const ACCEL_GROUND = 42;
const DECEL_GROUND = 34;
const AIR_CONTROL = 6;

const GRAVITY = 22;
const JUMP_VELOCITY = 5.4;

const MAX_PITCH = Math.PI / 2 - 0.035;

export interface PlayerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  speed: number;
}

export class PlayerController {
  readonly name = 'player';
  readonly state: PlayerState = {
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    grounded: true,
    speed: 0,
  };

  /** Blocks input while a cutscene or dialogue owns the camera. */
  frozen = false;
  /** Blocks translation only; look still works (used during dialogue). */
  movementLocked = false;

  private ctx: GameContext;
  private camera: THREE.PerspectiveCamera;

  private eyeY = EYE_HEIGHT;
  private eyeVel = 0;
  private targetEye = EYE_HEIGHT;

  private bobDistance = 0;
  private bobOffset = new THREE.Vector3();
  private rollTarget = 0;
  private roll = 0;

  private fovBase = 62;
  private fovCurrent = 62;

  private lastFootstep = 0;
  private wasGrounded = true;

  private tmp = new THREE.Vector2();
  private wishDir = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();

  constructor(ctx: GameContext, spawn: THREE.Vector3, yaw = 0) {
    this.ctx = ctx;
    this.camera = ctx.camera;
    this.state.position.copy(spawn);
    this.state.yaw = yaw;
    this.fovBase = this.camera.fov;
    this.fovCurrent = this.fovBase;

    ctx.events.on(EVENTS.CINEMATIC, (active) => {
      this.frozen = Boolean(active);
    });
    ctx.events.on(EVENTS.DIALOGUE_ACTIVE, (active) => {
      this.movementLocked = Boolean(active);
    });
  }

  /** Places the player and snaps the camera, skipping all smoothing. */
  teleport(pos: THREE.Vector3, yaw?: number): void {
    this.state.position.copy(pos);
    this.state.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.state.yaw = yaw;
    this.eyeY = this.targetEye;
    this.eyeVel = 0;
    this.bobOffset.set(0, 0, 0);
    this.applyCamera();
  }

  update(dt: number): void {
    const input = this.ctx.engine.input;
    const s = this.state;

    // ---- Look -------------------------------------------------------
    if (!this.frozen) {
      s.yaw -= input.mouseDX;
      s.pitch = clamp(s.pitch - input.mouseDY, -MAX_PITCH, MAX_PITCH);
    }

    // ---- Wish direction ---------------------------------------------
    const canMove = !this.frozen && !this.movementLocked;
    let ix = 0;
    let iz = 0;
    if (canMove) {
      if (input.anyDown('KeyW', 'ArrowUp')) iz += 1;
      if (input.anyDown('KeyS', 'ArrowDown')) iz -= 1;
      if (input.anyDown('KeyD', 'ArrowRight')) ix += 1;
      if (input.anyDown('KeyA', 'ArrowLeft')) ix -= 1;
    }

    const crouching = canMove && input.anyDown('ShiftLeft', 'ShiftRight') === false && input.anyDown('KeyC');
    const running = canMove && input.anyDown('ShiftLeft', 'ShiftRight') && !crouching;

    const maxSpeed = crouching ? CROUCH_SPEED : running ? RUN_SPEED : WALK_SPEED;

    this.forward.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
    this.right.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));

    this.wishDir.set(0, 0, 0);
    if (ix !== 0 || iz !== 0) {
      this.wishDir.addScaledVector(this.forward, iz).addScaledVector(this.right, ix).normalize();
    }

    // ---- Horizontal acceleration ------------------------------------
    const vh = this.tmp.set(s.velocity.x, s.velocity.z);
    const control = s.grounded ? 1 : AIR_CONTROL / ACCEL_GROUND;

    if (this.wishDir.lengthSq() > 0) {
      const targetX = this.wishDir.x * maxSpeed;
      const targetZ = this.wishDir.z * maxSpeed;
      const rate = ACCEL_GROUND * control * dt;
      vh.x += (targetX - vh.x) * Math.min(1, rate);
      vh.y += (targetZ - vh.y) * Math.min(1, rate);
    } else if (s.grounded) {
      const drop = DECEL_GROUND * dt;
      const len = vh.length();
      const next = Math.max(0, len - drop);
      if (len > 1e-5) vh.multiplyScalar(next / len);
      else vh.set(0, 0);
    }
    s.velocity.x = vh.x;
    s.velocity.z = vh.y;

    // ---- Jump and gravity -------------------------------------------
    if (canMove && s.grounded && input.wasPressed('Space')) {
      s.velocity.y = JUMP_VELOCITY;
      s.grounded = false;
    }
    if (!s.grounded) s.velocity.y -= GRAVITY * dt;

    // ---- Integrate and collide --------------------------------------
    const nextX = s.position.x + s.velocity.x * dt;
    const nextZ = s.position.z + s.velocity.z * dt;
    let nextY = s.position.y + s.velocity.y * dt;

    const headY = s.position.y + (crouching ? CROUCH_HEIGHT : EYE_HEIGHT);
    const resolved = this.ctx.collision.resolve(
      nextX,
      nextZ,
      s.position.y + 0.12,
      headY,
      RADIUS,
      this.tmp,
    );

    // Kill velocity into the surface we were pushed off, so sliding along a
    // wall keeps its tangential speed instead of stalling.
    const pushX = resolved.x - nextX;
    const pushZ = resolved.y - nextZ;
    if (pushX !== 0 || pushZ !== 0) {
      const n = this.tmp.clone().set(pushX, pushZ);
      const nl = n.length();
      if (nl > 1e-6) {
        n.divideScalar(nl);
        const into = s.velocity.x * n.x + s.velocity.z * n.y;
        if (into < 0) {
          s.velocity.x -= n.x * into;
          s.velocity.z -= n.y * into;
        }
      }
    }

    s.position.x = resolved.x;
    s.position.z = resolved.y;

    const ground = this.ctx.collision.groundHeight(s.position.x, s.position.z);
    if (nextY <= ground) {
      nextY = ground;
      if (!s.grounded) this.onLand(Math.abs(s.velocity.y));
      s.velocity.y = 0;
      s.grounded = true;
    } else {
      // Small step tolerance keeps the player attached to the ground when
      // walking down a gentle slope instead of launching into a fall.
      s.grounded = nextY - ground < 0.06 && s.velocity.y <= 0;
      if (s.grounded) nextY = ground;
    }
    s.position.y = nextY;

    const horizontalSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    s.speed = horizontalSpeed;

    // ---- Eye height spring ------------------------------------------
    // Critically damped: reaches the target fast with no overshoot, which is
    // what stops slopes from feeling like a boat.
    this.targetEye = crouching ? CROUCH_HEIGHT : EYE_HEIGHT;
    const stiffness = 150;
    const damping = 2 * Math.sqrt(stiffness);
    const accel = (this.targetEye - this.eyeY) * stiffness - this.eyeVel * damping;
    this.eyeVel += accel * dt;
    this.eyeY += this.eyeVel * dt;

    // ---- Head bob ----------------------------------------------------
    if (s.grounded && horizontalSpeed > 0.15) {
      this.bobDistance += horizontalSpeed * dt;
      const cycle = this.bobDistance * 3.1;
      const intensity = clamp(horizontalSpeed / RUN_SPEED, 0, 1);
      // Vertical bobs at twice the lateral rate — one dip per footfall,
      // one sway per stride.
      const vert = Math.sin(cycle * 2) * 0.032 * intensity;
      const lat = Math.sin(cycle) * 0.026 * intensity;
      this.bobOffset.x += (lat - this.bobOffset.x) * Math.min(1, dt * 18);
      this.bobOffset.y += (vert - this.bobOffset.y) * Math.min(1, dt * 18);

      // Footstep on each downward zero-crossing of the vertical bob.
      const phase = (cycle * 2) % (Math.PI * 2);
      if (phase < this.lastFootstep) {
        this.ctx.events.emit(EVENTS.FOOTSTEP, {
          surface: this.ctx.collision.surfaceAt(s.position.x, s.position.z),
          speed: horizontalSpeed,
        });
      }
      this.lastFootstep = phase;
    } else {
      this.bobOffset.x += (0 - this.bobOffset.x) * Math.min(1, dt * 10);
      this.bobOffset.y += (0 - this.bobOffset.y) * Math.min(1, dt * 10);
    }

    // ---- Strafe roll -------------------------------------------------
    // A degree and a half of camera roll when strafing; below the threshold
    // of conscious notice, but the motion reads as weight.
    this.rollTarget = -ix * 0.026 * clamp(horizontalSpeed / WALK_SPEED, 0, 1);
    this.roll += (this.rollTarget - this.roll) * Math.min(1, dt * 8);

    // ---- Speed FOV ---------------------------------------------------
    const fovTarget = this.fovBase + clamp((horizontalSpeed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED), 0, 1) * 6;
    this.fovCurrent += (fovTarget - this.fovCurrent) * Math.min(1, dt * 5);

    this.applyCamera();
  }

  private onLand(impactSpeed: number): void {
    // Convert landing impact into a downward eye kick the spring absorbs.
    this.eyeVel -= Math.min(impactSpeed * 0.32, 2.4);
    this.ctx.events.emit(EVENTS.FOOTSTEP, {
      surface: this.ctx.collision.surfaceAt(this.state.position.x, this.state.position.z),
      speed: impactSpeed,
      land: true,
    });
  }

  private applyCamera(): void {
    const s = this.state;
    this.camera.position.set(
      s.position.x + this.bobOffset.x,
      s.position.y + this.eyeY + this.bobOffset.y,
      s.position.z,
    );
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = s.yaw;
    this.camera.rotation.x = s.pitch;
    this.camera.rotation.z = this.roll;

    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }
  }
}
