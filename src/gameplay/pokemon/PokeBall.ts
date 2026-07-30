import * as THREE from 'three';
import { pokeBallShell, pokeBallMetal } from '../../fx/CreatureMaterials';
import { makeRng, clamp } from '../../core/Noise';

/**
 * The Poke Ball.
 *
 * Built as an assembly of spherical caps rather than a split sphere, so the
 * red and white shells, the black band and the button all share one silhouette
 * with no z-fighting at the seams — each part is offset radially by a fraction
 * of a millimetre in the order they physically stack.
 */

export interface PokeBall {
  group: THREE.Group;
  /** Opens the lid and emits the release flash. 0 = shut, 1 = fully open. */
  setOpen(t: number): void;
  update(dt: number, elapsed: number): void;
}

/**
 * A Poke Ball, 7.4cm across.
 *
 * Built as a lathe-free assembly of spherical caps so the red and white
 * shells, the black band and the button all share one silhouette with no
 * z-fighting at the seams — each part is offset radially by a fraction of a
 * millimetre in the order they physically stack.
 */
export function buildPokeBall(seed = 1): PokeBall {
  const R = 0.037;

  // `group` is the caller's to position; `bob` carries the idle motion.
  // Animating the outer group directly would overwrite whatever placement the
  // caller set — which sank the ball through the floor in the viewer and threw
  // the three balls 60m off the lab table, since the interior sits at y=-60.
  const group = new THREE.Group();
  group.name = 'PokeBall';
  const bob = new THREE.Group();
  bob.name = 'PokeBallBob';
  group.add(bob);

  const SEAM = 0.088; // half-height of the black band, as a fraction of R

  const topPivot = new THREE.Group();
  bob.add(topPivot);

  // Upper shell: a cap from the pole down to just above the seam.
  const topAngle = Math.acos(SEAM);
  const top = new THREE.Mesh(
    new THREE.SphereGeometry(R, 48, 32, 0, Math.PI * 2, 0, topAngle),
    pokeBallShell(0xc4161c),
  );
  topPivot.add(top);

  // Rolled lip so the shell reads as having wall thickness, not zero.
  const lipTop = new THREE.Mesh(
    new THREE.TorusGeometry(R * Math.sin(topAngle), R * 0.026, 10, 64),
    pokeBallShell(0x8e0f14),
  );
  lipTop.rotation.x = Math.PI / 2;
  lipTop.position.y = R * SEAM;
  topPivot.add(lipTop);

  const bottom = new THREE.Mesh(
    new THREE.SphereGeometry(R, 48, 32, 0, Math.PI * 2, Math.PI - topAngle, topAngle),
    pokeBallShell(0xf2efe9),
  );
  bob.add(bottom);

  const lipBottom = new THREE.Mesh(
    new THREE.TorusGeometry(R * Math.sin(topAngle), R * 0.026, 10, 64),
    pokeBallShell(0xd8d4cc),
  );
  lipBottom.rotation.x = Math.PI / 2;
  lipBottom.position.y = -R * SEAM;
  bob.add(lipBottom);

  // Equatorial band, very slightly inset so it never fights the shells.
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.9985, R * 0.9985, R * SEAM * 2, 48, 1, true),
    pokeBallMetal(0x24211f),
  );
  bob.add(band);

  // Button assembly: bezel ring, then the button proud of it.
  const bezel = new THREE.Mesh(
    new THREE.TorusGeometry(R * 0.235, R * 0.05, 12, 40),
    pokeBallMetal(0x1e1c1a),
  );
  bezel.position.z = R * 0.965;
  bob.add(bezel);

  const buttonMat = new THREE.MeshPhysicalMaterial({
    color: 0xf6f3ec,
    roughness: 0.12,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    emissive: new THREE.Color(0xffd9a0),
    emissiveIntensity: 0.0,
  });
  const button = new THREE.Mesh(new THREE.SphereGeometry(R * 0.2, 28, 20), buttonMat);
  button.position.z = R * 0.985;
  button.scale.z = 0.5;
  bob.add(button);

  // Release flash — a soft additive sprite that only appears while opening.
  const flashMat = new THREE.SpriteMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flash = new THREE.Sprite(flashMat);
  flash.scale.setScalar(R * 7);
  // Hidden rather than merely transparent. GTAO rebuilds the scene into a
  // normal/depth buffer, where a camera-facing sprite quad becomes a solid
  // occluder — so a zero-opacity flash still stamped a dark rectangle of fake
  // occlusion behind every ball. `visible` is the only flag every pass honours.
  flash.visible = false;
  bob.add(flash);

  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  const rng = makeRng(seed);
  const bobPhase = rng() * Math.PI * 2;
  let open = 0;

  return {
    group,
    setOpen(t: number) {
      open = clamp(t, 0, 1);
      // The lid hinges back and lifts, as it does in the games.
      topPivot.rotation.x = -open * 2.1;
      topPivot.position.y = open * R * 0.5;
      topPivot.position.z = -open * R * 0.28;
      const glow = Math.sin(open * Math.PI) * 0.9;
      flashMat.opacity = glow;
      flash.visible = glow > 0.002;
      buttonMat.emissiveIntensity = open * 2.4;
    },
    update(_dt: number, elapsed: number) {
      // Idle: an almost-imperceptible float and rock. Motion draws the eye to
      // the thing the player is meant to interact with.
      bob.position.y = Math.sin(elapsed * 1.1 + bobPhase) * 0.0022;
      bob.rotation.z = Math.sin(elapsed * 0.63 + bobPhase) * 0.02;
      if (open > 0.01) flash.material.rotation = elapsed * 2;
    },
  };
}
