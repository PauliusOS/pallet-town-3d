import * as THREE from 'three';
import { metaSurface, noiseDisplace, bakeCavityAO, type Ball } from '../../fx/Sculpt';
import { creatureSkin } from '../../fx/CreatureMaterials';
import { clamp, smoothstep, Simplex } from '../../core/Noise';
import { createRig, IdleAnimator, addEye, finishBody, disposeCreature, type Creature } from './shared';

/**
 * Bulbasaur — a squat quadruped with a tight, waxy bud rooted into its back.
 *
 * The silhouette reads "low, wide, patient": the body is longer than it is
 * tall, the legs are stubby, and the bud is heavy enough to visually anchor
 * the hips. Everything above the shoulders is deliberately oversized — head
 * and especially eyes — because a quadruped whose head matches its body reads
 * as an animal, and this has to read as a character.
 *
 * Two things carry the character's identity and both are treated as
 * first-class modelling problems rather than surface polish: the dark
 * blue-green spots across the flanks and haunches, and the closed bud. Get
 * either wrong and the render is a generic green frog.
 */

/* ------------------------------------------------------------------ */
/* Local sculpting helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Vertex colours are the only channel a marching-cubes surface has — it comes
 * out of the mesher with no UVs, so markings have to be painted into the mesh
 * itself. Any geometry that shares the skin material therefore needs a colour
 * attribute, or the driver hands the shader an undefined attribute and the
 * part renders black.
 */
function ensureVertexColor(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geo.attributes.color) {
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  return geo;
}

function fbm3(s: Simplex, x: number, y: number, z: number, octaves = 3): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * s.noise3D(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

/**
 * One marking, defined as a *projected* ellipse rather than a solid.
 *
 * The obvious implementation — an ellipsoid of pigment in model space — does
 * not work on a metaball body, and failing at it silently is why the previous
 * two passes shipped with invisible spots. The surface of a fused metaball
 * sculpt sits a long way outside the nominal ball radii (the Wyvill iso
 * crosses at roughly 1.06r for a lone ball and much further where several
 * blend), so a hand-placed ellipsoid that looks correct against the ball
 * coordinates is usually buried entirely inside the skin, and the mesh never
 * passes through it. It paints nothing, from every angle.
 *
 * Projecting instead removes the radial axis from the test altogether: a
 * flank spot is a disc in (y, z) that extends however far out it needs to in
 * x, gated by the surface normal so it only lands on the side it belongs to.
 * The mark then lies wherever the skin actually is.
 */
interface Spot {
  /**
   * Which axis the ellipse is projected along, and from which side.
   * 'z' exists purely for the dead-ahead view: a flank spot's facing gate
   * collapses to almost nothing on surfaces whose normal points at the camera,
   * so front-of-chest and front-of-leg markings have to be projected along the
   * view axis or they simply do not appear in the front render.
   */
  axis: 'x' | 'y' | 'z';
  /** Direction along that axis the marked surface faces: +1 or -1. */
  face: number;
  /** Centre in the two coordinates the ellipse is measured in. */
  u: number;
  v: number;
  ru: number;
  rv: number;
}

/**
 * Paints the spots.
 *
 * An earlier pass cut the markings out of a noise field, which is what a real
 * animal's dappling looks like — and at viewing distance it averaged out to
 * one flat green with some grubbiness on it. Bulbasaur's spots are *drawn*
 * shapes: a countable number of large dark ellipses in specific places. So
 * they are authored as an explicit list and only *edge*-warped by noise,
 * which keeps the border organic while the shape stays a shape.
 *
 * The value step is deliberately large. Vertex colour is multiplied by the
 * cavity-AO pass and then washed out again by wrap lighting and the sky
 * probe, so a marking that looks correct as a number is invisible as a pixel.
 */
function paintSpots(
  geo: THREE.BufferGeometry,
  spots: Spot[],
  tint: [number, number, number],
  opts: { seed: number; warp?: number; feather?: number; belly?: [number, number, number] },
): void {
  ensureVertexColor(geo);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const s = new Simplex(opts.seed);
  const warp = opts.warp ?? 0.011;
  // Where the falloff starts, as a fraction of the ellipse radius. A tight
  // band gives a soft-but-readable border; a wide one turns back into haze.
  const feather = opts.feather ?? 0.74;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);

    // Two independent warps so the border wobbles and never betrays the
    // underlying ellipse.
    const w0 = fbm3(s, x * 11 + 3.1, y * 11 - 1.7, z * 11 + 6.4, 2) * warp;
    const w1 = fbm3(s, x * 11 - 5.2, y * 11 + 2.3, z * 11 - 0.9, 2) * warp;

    let mask = 0;
    for (const sp of spots) {
      // Only the surface facing the projection direction is eligible, with a
      // soft cutoff so the mark fades as the skin turns away instead of
      // ending on a hard terminator.
      // The x-axis gate is deliberately generous: a strict side-facing test
      // puts every marking on the flanks and leaves the front view a plain
      // green bean, because from dead ahead almost nothing has a sideways
      // normal. Letting the mark carry round onto surfaces that face mostly
      // forward is what makes the spots readable from every angle.
      const facing = sp.axis === 'x'
        ? smoothstep(-0.06, 0.24, nx * sp.face)
        : sp.axis === 'y'
          ? smoothstep(-0.10, 0.34, ny * sp.face)
          : smoothstep(-0.04, 0.30, nz * sp.face);
      if (facing <= 0) continue;
      const du = ((sp.axis === 'x' ? y : x) + w0 - sp.u) / sp.ru;
      const dv = ((sp.axis === 'z' ? y : z) + w1 - sp.v) / sp.rv;
      const d = Math.sqrt(du * du + dv * dv);
      if (d >= 1) continue;
      mask = Math.max(mask, smoothstep(1.0, feather, d) * facing);
    }
    // Nothing on the underside: the belly is the pale countershaded surface
    // and a spot down there just reads as dirt.
    mask *= smoothstep(-0.62, -0.20, ny);

    let r = col.getX(i);
    let g = col.getY(i);
    let b = col.getZ(i);
    if (opts.belly) {
      const belly = smoothstep(-0.18, -0.75, ny);
      r *= 1 + (opts.belly[0] - 1) * belly;
      g *= 1 + (opts.belly[1] - 1) * belly;
      b *= 1 + (opts.belly[2] - 1) * belly;
    }
    r *= 1 + (tint[0] - 1) * mask;
    g *= 1 + (tint[1] - 1) * mask;
    b *= 1 + (tint[2] - 1) * mask;
    col.setXYZ(i, r, g, b);
  }
  col.needsUpdate = true;
}

/** Mirrors a set of side spots onto both flanks. */
function bothSides(spots: Omit<Spot, 'axis' | 'face'>[]): Spot[] {
  return spots.flatMap((s) => [
    { ...s, axis: 'x' as const, face: 1 },
    { ...s, axis: 'x' as const, face: -1 },
  ]);
}

/**
 * Darkens a collar of skin around the bud's foot.
 *
 * A bud that simply intersects the back is a prop resting on an animal. Two
 * things sell it as *growing out of* the back: skin that swells up around the
 * foot (metaballs, below) and a ring of shadow in the seam, which is what the
 * eye actually reads as "this goes in there".
 */
function paintCollar(
  geo: THREE.BufferGeometry,
  cx: number,
  cz: number,
  inner: number,
  outer: number,
  amount: number,
): void {
  ensureVertexColor(geo);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx;
    const dz = pos.getZ(i) - cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > outer) continue;
    // Only the upward-facing back, and darkest right in the seam.
    const up = smoothstep(0.05, 0.55, nor.getY(i));
    const k = 1 - amount * smoothstep(outer, inner, d) * up;
    if (k < 1) col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
}

/**
 * The bud's core: a turgid, closed egg.
 *
 * This is the volume the scales are lapped over, and its only jobs are to be
 * convex — so no camera angle can ever find a cavity between the scales — and
 * to draw in to a soft point at the crown. Flutes are deliberately almost
 * absent; the plate read comes from the real, thick scales wrapped around it,
 * not from ridges pressed into a sphere, which is what made the previous pass
 * look like a cabbage.
 */
function budCoreGeometry(R: number, segsU = 36, segsV = 24): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(R, segsU, segsV);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const lat = clamp(v.y / R, -1, 1);
    const theta = Math.atan2(v.z, v.x);
    const crown = smoothstep(0.10, 1.0, lat);
    const foot = smoothstep(-0.35, -1.0, lat);
    // Egg, drawn in at the crown, tucked at the foot so it sinks into its seam.
    // Only lightly drawn in at the crown. At 0.34, combined with a y-stretch,
    // the core came to a point and the whole bud read as an onion dome — a
    // closed bud is a fat rounded volume with a soft apex, not a cone.
    let radial = (1 - 0.19 * crown * crown) * (1 - 0.22 * foot);
    // A whisper of five-fold swell so the core agrees with the scale count.
    radial += 0.016 * Math.cos(theta * 5) * (1 - crown);
    v.x *= radial;
    v.z *= radial;
    v.y = v.y * (1.0 + 0.10 * crown);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  noiseDisplace(geo, 0.0014, 14, 91, 2);
  geo.computeVertexNormals();
  return geo;
}

/**
 * One bud scale: a thick, broad, rounded plate.
 *
 * The critical property is that it is a *solid* — a closed convex lens with
 * real thickness in the middle and a rounded margin — rather than a card. A
 * card has a zero-thickness edge that reads as a floppy leaf from every
 * grazing angle, and that single decision is the difference between a closed
 * bud and a lettuce. Local space: length along +y from root, width on x,
 * thickness on z, with the plate cupped so it hugs the core it wraps.
 */
function budScaleGeometry(halfW: number, len: number, thick: number, cup: number): THREE.BufferGeometry {
  // 12x8 left visible facets along every scale's margin, and since the scales
  // form the bud's silhouette that faceting read as an artichoke. The bulb is
  // this character's single most identifying feature and it sits at the top of
  // the silhouette, so it earns the extra few thousand triangles.
  const geo = new THREE.SphereGeometry(1, 20, 13);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const u = clamp((v.y + 1) / 2, 0, 1); // 0 root, 1 tip
    // A sphere used raw tapers to a pole at each end, and a pole on a scale is
    // a SPIKE — six or seven of them ringing a bud is precisely the artichoke
    // silhouette the previous pass shipped. Re-profiling the sphere's sine
    // cross-section with a fractional power makes the plate carry most of its
    // width and thickness all the way to a rounded margin, so it ends in a
    // blunt fingernail instead of a thorn.
    const rr = Math.hypot(v.x, v.z);
    const broad = rr > 1e-4 ? Math.min(2.4, Math.pow(rr, 0.42) / rr) : 0;
    const nar = 1 - 0.30 * smoothstep(0.62, 1.0, u);
    const th = thick * (1 - 0.32 * smoothstep(0.60, 1.0, u));
    const x = v.x * broad * halfW * nar;
    const z = v.z * broad * th;
    // The quadratic is an ogee, not a bend: the plate bulges outward through
    // its middle (giving the bud its shoulders) and curls back INWARD over the
    // crown, which is what closes the silhouette to a dome.
    pos.setXYZ(i, x, u * len, z - cup * (u - 0.35) * (u - 0.35) * len + cup * 0.12 * len);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Shades a scale from root to tip in vertex colour.
 *
 * The plates of a closed bud only separate because the light falls off into
 * each lap. Baking that into the mesh rather than relying on the lighting is
 * what keeps the courses readable when the bud is turned away from the key.
 */
function shadeScale(geo: THREE.BufferGeometry, len: number, root: number, tip: number): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = clamp(pos.getY(i) / len, 0, 1);
    const k = root + (tip - root) * Math.pow(t, 0.75);
    c[i * 3] = k;
    c[i * 3 + 1] = k;
    c[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/**
 * The bud, assembled.
 *
 * A closed bud is not a flower with the petals shut — it is a *solid* wrapped
 * in laps. So the shape is built from the inside out: a convex egg that no
 * camera can ever see a cavity in, then two staggered whorls of thick scales
 * lapped over it, each one curling its tip back INWARD over the crown so the
 * silhouette closes to a soft point. Every scale tip therefore sits above the
 * core it covers and below the whorl inside it, which is what makes the thing
 * read as turgid and packed rather than as a rosette of leaves.
 *
 * Local origin is the bud's foot, so the caller can bury it in the back.
 */
function budAssembly(R: number, mat: THREE.Material, deepMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();

  // The core is the hidden volume that guarantees no camera finds a cavity — it
  // is NOT the visible surface, and sizing it as if it were is what erased the
  // scales: at R*0.94 it swelled straight through the whorls and the bud
  // rendered as one smooth egg. It has to stay comfortably inside the plates
  // that wrap it, close enough to back them and far enough not to become them.
  // Sizing the core is the whole ballgame and the last two passes both got it
  // wrong in opposite directions. Too big and it swallows the plates (one smooth
  // egg); too tall and it stands ABOVE where the scale tips converge, so the
  // scales end up splayed around its waist like a collar of petals and the bud
  // reads as an open artichoke — which is exactly what the side render showed.
  // The core must be strictly *inside* the envelope the plates describe: below
  // their convergence point (~1.25R) and narrower than their mid-course radius
  // (~0.72R). At 0.52R centred at 0.52R it tops out at 1.09R and never shows.
  const core = new THREE.Mesh(budCoreGeometry(R * 0.56, 22, 14), mat);
  core.position.y = R * 0.50;
  bakeCavityAO(core.geometry, new THREE.Vector3(0, 0, 0), 0.18);
  core.castShadow = true;
  core.receiveShadow = true;
  g.add(core);

  // Outer whorl: broad, low, leaning out — this is the course that gives the
  // bud its shoulders and hides the seam with the back.
  // Root-to-tip value range widened. The laps only separate because each plate
  // darkens into the one it overlaps; with the range this narrow the whole bud
  // averaged out to a single smooth dome and the scale read disappeared.
  const outerGeo = shadeScale(budScaleGeometry(R * 0.52, R * 0.86, R * 0.20, 0.95), R * 0.86, 0.44, 1.12);
  // Inner whorl: narrower, steeper, staggered half a step so no gap lines up.
  const innerGeo = shadeScale(budScaleGeometry(R * 0.46, R * 0.72, R * 0.18, 1.15), R * 0.72, 0.50, 1.14);
  // Crown: broad blunt caps that close the very top. These were long and narrow
  // and stood almost upright, so they broke the silhouette as three spikes and
  // turned the bud into an artichoke. Short, wide and blunt instead: the crown
  // has to read as the last lap closing over, not as a set of points.
  const crownGeo = shadeScale(budScaleGeometry(R * 0.32, R * 0.44, R * 0.16, 1.5), R * 0.44, 0.58, 1.10);

  const whorl = (
    geo: THREE.BufferGeometry, m: THREE.Material, count: number,
    phase: number, radius: number, yRoot: number, tilt: number,
  ) => {
    for (let i = 0; i < count; i++) {
      const a = phase + (i / count) * Math.PI * 2;
      const pivot = new THREE.Group();
      pivot.rotation.y = a;
      const s = new THREE.Mesh(geo, m);
      s.position.set(0, yRoot, radius);
      s.rotation.x = tilt;
      s.castShadow = true;
      s.receiveShadow = true;
      pivot.add(s);
      g.add(pivot);
    }
  };

  // Tilts are DRASTICALLY reduced from the previous pass (0.60/0.34 rad). Those
  // leaned the plates outward, and once the group's vertical squash was applied
  // on top they lay down into a flat rosette. A closed bud's plates stand almost
  // upright and do their wrapping with the ogee, not with the mount angle: each
  // course now rises steeply and curls its tip back over the axis, so every tip
  // sits above the core it covers and under the whorl inside it.
  //
  // Roots sit low (R*0.04) so the body's collar closes over them — a root that
  // floats above the seam leaves a slot that reads from the side as a hollow.
  //
  // The three courses are STAGGERED in height on purpose. When all three
  // converged on the same apex the bud closed correctly but every lap merged
  // into one smooth lime dome — closed, and completely characterless. Ending
  // each course a clear step below the next leaves its rounded margin exposed
  // as a visible lapped edge partway up the flank, which is what makes the
  // volume read as packed plates rather than as a helmet.
  whorl(outerGeo, deepMat, 6, 0.0, R * 0.46, R * 0.04, 0.42);
  whorl(innerGeo, mat, 5, Math.PI / 5, R * 0.34, R * 0.44, 0.26);
  // Three broad crown plates whose tips cross the axis, lapping over one another
  // so the apex is solid skin from directly above. This is the guarantee that no
  // camera anywhere finds a cavity down the middle of the bud.
  whorl(crownGeo, mat, 3, Math.PI / 3, R * 0.13, R * 0.86, 0.14);

  return g;
}

/**
 * Bulbasaur's eye, built locally.
 *
 * The shared makeEye is authored for a hero close-up: a bright white sclera,
 * a glossy clearcoat and a two-catchlight setup. On a small character that
 * combination is exactly the bug-eyed read — a white ball with a red ring on
 * it, wet-looking, and speckled wherever the environment probe lands. What
 * Bulbasaur actually has is a flat crimson eye with a fat black pupil and one
 * hard specular dot, and no visible sclera at all. So the whole eyeball is the
 * iris: one solid, near-matte crimson sphere.
 */
function bulbaEye(r: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Eye';
  // Flat, unlit crimson. A lit iris on a small eye is what produced the
  // speckle: the normal map, the environment probe and the wrap term all land
  // on a strongly curved surface at once, and the result is mottling that reads
  // as a bloodshot sclera. MeshBasic has no normal to speckle and no probe to
  // sample, so the iris is exactly the one colour it was authored as. The only
  // light on the whole eye is the single catchlight, which is also the only
  // light a drawn Pokemon eye has.
  // Deepened from a bright crimson: unlit full-saturation red against the dark
  // green face read as self-illuminated, which is what made the face look
  // demonic rather than friendly. A darker iris sits in the head instead of
  // glowing out of it.
  const irisMat = new THREE.MeshBasicMaterial({ color: 0x9c2130 });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), irisMat);
  g.add(ball);

  // No limbal ring here, deliberately. One was tried: on an eye this small,
  // seated this deep, the ring occupies most of the visible aperture and reads
  // as heavy eyeliner around a black almond — considerably worse than the plain
  // crimson it was meant to seat. The socket rim already supplies the boundary.

  // The pupil. Sized against the *visible aperture*, not against the eyeball:
  // the ball is seated deep enough that the socket rim eats the outer third of
  // it, so a pupil that looks correctly proportioned on the sphere in isolation
  // swallows everything that actually shows and the eye renders as a black
  // almond with a red sliver — which is what the previous pass did. At 0.46 the
  // red reads as the colour of the eye and the black reads as a pupil inside
  // it, which is the way the character is drawn.
  // The pupil is a cap on a sphere, so it only reads as a round pupil while the
  // socket aperture in front of it stays CONCENTRIC with it. The idle animator
  // yaws the head up to 0.1 rad, and a cap buried deep behind a narrow aperture
  // slides visibly off-centre under that rotation — which is why earlier passes
  // rendered a black wedge in one corner with a red crescent opposite, reading as
  // a sidelong, faintly sinister glance. The cure is clearance, not size: the
  // pupil is kept comfortably smaller than the visible cap (see the seat depth
  // and socket strength below) so a full red annulus surrounds it from any angle
  // the head actually reaches.
  const pupil = new THREE.Mesh(
    new THREE.SphereGeometry(r * 1.006, 18, 12, 0, Math.PI * 2, 0, Math.asin(0.56)),
    new THREE.MeshBasicMaterial({ color: 0x180f12 }),
  );
  pupil.rotation.x = Math.PI / 2;
  g.add(pupil);

  // One catchlight, up-left, on the pupil's edge. Small and crisp: a big soft
  // one is a wet eye, and a wet eye on a cartoon face reads as frightened.
  const hi = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.135, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  hi.position.set(-r * 0.24, r * 0.28, r * 0.955);
  g.add(hi);

  g.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
  });
  return g;
}

/**
 * The mouth line: a tube that tapers to nothing at both ends.
 *
 * A constant-radius tube has to be capped, and a cap on a dark line is a bead
 * of lip at each corner — which is what turned the last pass into a human
 * smirk. Tapering to zero tucks the corners into the cheek the way the
 * official design draws them.
 */
function mouthLineGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  radius: number,
  rings = 26,
  radial = 6,
): THREE.BufferGeometry {
  const geo = new THREE.TubeGeometry(curve, rings, radius, radial, false);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const perRing = radial + 1;
  const c = new THREE.Vector3();
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const s = Math.pow(Math.sin(Math.PI * t), 0.42);
    curve.getPoint(t, c);
    for (let j = 0; j < perRing; j++) {
      const k = i * perRing + j;
      if (k >= pos.count) break;
      pos.setXYZ(
        k,
        c.x + (pos.getX(k) - c.x) * s,
        c.y + (pos.getY(k) - c.y) * s,
        c.z + (pos.getZ(k) - c.z) * s,
      );
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Finds the frontmost point of a sculpted surface near a given (x, y).
 *
 * Face details — the mouth line, the nostril beads — are authored as explicit
 * coordinates, but the surface they have to sit on is the *output* of a
 * metaball solve, and the Wyvill iso crosses a long way outside the nominal
 * ball radii wherever several balls blend. So a coordinate that looks correct
 * against the ball positions is typically 2–3cm inside the finished skin, and
 * the detail renders as nothing at all: that is exactly how the last revision
 * lost the mouth and both nostrils off the front view while every number in the
 * file still looked sensible.
 *
 * Probing the meshed result removes the guesswork. Any change to the muzzle
 * balls now carries the face along with it instead of silently swallowing it.
 */
function frontSurfaceZ(geo: THREE.BufferGeometry, x: number, y: number, eps: number): number {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  let best = -Infinity;
  const e2 = eps * eps;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - x;
    const dy = pos.getY(i) - y;
    if (dx * dx + dy * dy > e2) continue;
    const z = pos.getZ(i);
    if (z > best) best = z;
  }
  return best;
}

/** A small smooth claw: a teardrop with a rounded root and a real point. */
function clawGeometry(radius: number, length: number): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(radius, 8, 6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / radius; // -1..1
    const t = clamp((y + 1) / 2, 0, 1);
    // Stretch along Y and pinch the tip to a point.
    const s = Math.pow(1 - t, 0.62);
    pos.setXYZ(i, pos.getX(i) * s, (y * 0.5 + 0.5) * length, pos.getZ(i) * s);
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildBulbasaur(): Creature {
  const rig = createRig();
  rig.root.name = 'Bulbasaur';

  // A cool, blue-leaning teal — not mint, and definitely not seafoam. The
  // wrapped-diffuse term, the sky fill and the environment probe between them
  // add roughly 60/255 to every channel and lift the render well above the
  // albedo, so the albedo has to start deep and *saturated* or the result is
  // a pastel. Hue sits at ~168°, on the blue side of green.
  const SKIN = 0x08705e;
  const SKIN_SUB = 0x0a5750;

  const skin = creatureSkin({
    color: SKIN,
    // Scatter colour stays cool: a warm or pale scatter is what turns cartoon
    // skin milky, and it is the fastest way to lose a saturated character.
    subsurface: SKIN_SUB,
    wrap: 0.11,
    rim: 0.05,
    roughness: 1.0,
    detail: 'pores',
    detailScale: 5,
  });
  // Broad white speculars across the flanks are what desaturated the whole
  // model to mint. Skin here is soft-matte with barely any surface gloss.
  skin.clearcoat = 0.03;
  skin.clearcoatRoughness = 0.75;
  skin.sheen = 0.04;
  skin.sheenColor = new THREE.Color(SKIN_SUB).multiplyScalar(0.3);
  skin.normalScale.set(0.26, 0.26);
  // The studio probe is what actually bleached this to mint: a broad, bright
  // environment reflection sitting on top of every up-facing surface.
  skin.envMapIntensity = 0.22;
  // The baked roughness map dips to 0.42 in places, and those dips are exactly
  // the broad white streaks that were running down the flanks.
  skin.roughnessMap = null;
  skin.roughness = 0.88;

  // The spot tint. Dark and *bluer* than the base — Bulbasaur's markings are
  // not simply shadowed skin, they are a different, colder pigment.
  // Strong enough to survive the wrap term, the sky fill and the cavity pass,
  // all three of which lift and desaturate whatever is painted underneath. At
  // 0.19/0.37/0.53 the markings rendered as grey smudges; a marking has to be
  // authored roughly twice as dark as it should look.
  // 0.10/0.25/0.40 was a marking authored to survive the lighting and it
  // over-survived: at that depth the ellipses render as near-black camouflage
  // patches, and where two of them touched they merged into one amoeba. Lifted
  // to a value that still reads as a distinctly colder, darker pigment while
  // staying inside the same family as the hide.
  // Rendered, 0.26/0.44/0.55 came out as GREY cloud. Crushing green and blue
  // together by that much removes the hue along with the value, and the eye reads
  // the result as dirt or as a shadow rather than as pigment. The fix is to hold
  // blue almost where the hide has it and take the value out of green alone:
  // the mark then stays inside the same teal family while landing several steps
  // darker and visibly cooler, which is what a Bulbasaur dapple actually is.
  const SPOT: [number, number, number] = [0.46, 0.56, 0.82];
  const BELLY: [number, number, number] = [1.20, 1.11, 1.02];

  /* --- Body ---------------------------------------------------------- */
  // Ground contact sits at y ≈ 0.010; the barrel is lifted clear of it so the
  // animal has daylight underneath and reads as a quadruped, not a potato.
  // Four legs, authored explicitly. The previous pass tucked them *inside* the
  // barrel's half-width, so the metaball field fused them into the belly and
  // from the front the whole animal was one bean with toes. A quadruped reads
  // as a quadruped when the limbs stand OUTSIDE the ribcage and there is sky
  // between them, so the barrel narrows and the legs move out under the
  // shoulder and haunch masses that cap them.
  const LEGS = [
    { x: 0.134, z: 0.130 }, // fore
    { x: 0.144, z: -0.178 }, // hind
  ];
  const bodyBalls: Ball[] = [
    // Barrel: narrower than before on X, and long on Z. Low and wide is a
    // proportion, not a volume — width comes from the shoulders and haunches.
    { x: 0, y: 0.220, z: -0.030, r: 0.140, sx: 1.00, sy: 0.86, sz: 1.34 },
    { x: 0, y: 0.220, z: 0.128, r: 0.106, sx: 1.00, sy: 0.92, sz: 0.94 },
    { x: 0, y: 0.228, z: 0.196, r: 0.074, sx: 0.90, sy: 0.86 },
    { x: 0, y: 0.212, z: -0.205, r: 0.122, sx: 1.00, sy: 1.00, sz: 0.94 },
    // Belly: held high and pulled in, so there is daylight under the animal.
    { x: 0, y: 0.176, z: -0.020, r: 0.084, sx: 0.94, sy: 0.50, sz: 1.14 },
    // Shoulders and haunches — the two masses that give a quadruped its
    // silhouette from the front, and the reason the legs read as legs.
    { x: 0.126, y: 0.226, z: 0.112, r: 0.082, sx: 0.94, sy: 0.94, sz: 1.02 },
    { x: -0.126, y: 0.226, z: 0.112, r: 0.082, sx: 0.94, sy: 0.94, sz: 1.02 },
    { x: 0.138, y: 0.204, z: -0.176, r: 0.096, sx: 0.94, sy: 1.02, sz: 1.02 },
    { x: -0.138, y: 0.204, z: -0.176, r: 0.096, sx: 0.94, sy: 1.02, sz: 1.02 },
    // The back swells up into a collar around the bud's base so the skin
    // visibly climbs its flank instead of the bud resting on the spine. Sits
    // well behind the shoulders, where the bud now lives.
    // Deliberately LOW and shallow. At y 0.282 / sy 0.62 this swell topped out
    // around y 0.357 — which was above the bud's own foot, so the skin closed
    // over the bottom 40% of the bud and the animal wore it like a bowl with
    // petals sitting in it. A seam wants to swallow roughly a tenth of the bud,
    // not half of it.
    { x: 0, y: 0.270, z: -0.062, r: 0.102, sx: 1.20, sy: 0.56, sz: 1.08 },
    { x: 0.060, y: 0.256, z: -0.058, r: 0.066 },
    { x: -0.060, y: 0.256, z: -0.058, r: 0.066 },
  ];
  for (const sgn of [1, -1]) {
    for (const leg of LEGS) {
      const x = sgn * leg.x;
      const lz = leg.z;
      // Upper leg, shank, then a wide flat foot pad. Stubby: the whole limb is
      // only about a fifth of the animal's height.
      bodyBalls.push({ x, y: 0.150, z: lz, r: 0.074, sx: 0.92, sy: 0.96, sz: 0.98 });
      bodyBalls.push({ x, y: 0.092, z: lz, r: 0.062, sy: 0.94, sz: 0.96 });
      bodyBalls.push({ x, y: 0.048, z: lz + 0.008, r: 0.062, sx: 1.06, sy: 0.60, sz: 1.14 });
      // Three toes, splayed forward.
      for (const tx of [-0.036, 0, 0.036]) {
        bodyBalls.push({ x: x + tx, y: 0.042, z: lz + 0.052, r: 0.030, sx: 0.86, sy: 0.58, sz: 1.0 });
      }
      // Grooves between the toes, cut back far enough through the pad that the
      // toes separate in silhouette instead of fusing into a mitten.
      for (const gx of [-0.018, 0.018]) {
        bodyBalls.push({
          x: x + gx, y: 0.048, z: lz + 0.044, r: 0.027, sx: 0.52, sz: 2.2,
          strength: -0.92,
        });
      }
      // Carve the web between the pair of legs. Without this the field between
      // two nearby limbs closes over into a skirt and the gap the front view
      // depends on never opens. Wide and moderate, not tight and strong — a
      // tight carve leaves a raised lip around itself.
      bodyBalls.push({
        x: 0, y: 0.086, z: lz, r: 0.072, sx: 1.30, sy: 1.15, sz: 0.85,
        strength: -0.80,
      });
      // And under the chest/groin, to lift the belly line clear of the floor.
      bodyBalls.push({ x: 0, y: 0.120, z: lz, r: 0.058, sx: 1.05, sy: 0.9, sz: 0.9, strength: -0.34 });
    }
    // Waist, between shoulder and haunch: a wide, weak carve. A tight strong
    // one does not make a smooth hollow, it makes a dent with a raised lip.
    bodyBalls.push({ x: sgn * 0.140, y: 0.196, z: -0.026, r: 0.086, sx: 0.9, sz: 1.35, strength: -0.30 });
    // Shadowed crease under the jaw, likewise softened.
    bodyBalls.push({ x: sgn * 0.050, y: 0.258, z: 0.186, r: 0.070, strength: -0.20 });
  }

  // Resolution is the whole poly budget. At 0.5m tall and 1–3m away the body
  // only needs a cell of about a centimetre; the smoothing kernel, not the
  // grid, is what keeps the surface from faceting, so 'smooth' goes up as
  // resolution comes down.
  const bodyGeo = metaSurface(bodyBalls, { resolution: 31, smooth: 1.02, padding: 0.04 });
  const body = finishBody(new THREE.Mesh(bodyGeo, skin), new THREE.Vector3(0, 0.20, -0.01), 0.34);

  // The markings, as drawn shapes. Mirrored, so the two sides match the way
  // an illustrated character's do rather than the way a real animal's don't.
  // Deliberately fewer and smaller than the previous pass, and spaced so no two
  // ellipses touch. Bulbasaur's dapples are countable: a dozen discrete marks
  // reads as a pattern, whereas the two dozen overlapping ones that were here
  // fused into continuous dark territory and read as mud.
  const bodySpots: Spot[] = [
    ...bothSides([
      // Shoulder.
      { u: 0.250, v: 0.124, ru: 0.038, rv: 0.042 },
      // Mid flank — the one the three-quarter shot lives on.
      { u: 0.236, v: -0.024, ru: 0.036, rv: 0.042 },
      // Low flank, tucked under the barrel's turn.
      { u: 0.160, v: -0.096, ru: 0.028, rv: 0.032 },
      // Haunch.
      { u: 0.224, v: -0.188, ru: 0.038, rv: 0.042 },
      // Rear thigh, below and behind the haunch.
      { u: 0.130, v: -0.146, ru: 0.026, rv: 0.030 },
    ]),
    // Front of each foreleg and haunch, projected along the view axis so they
    // land on the surfaces that face the dead-ahead camera. Without these the
    // front render has no markings in it at all — every flank spot has turned
    // edge-on by the time the camera is square to the animal.
    { axis: 'z', face: 1, u: 0.136, v: 0.150, ru: 0.034, rv: 0.036 },
    { axis: 'z', face: 1, u: -0.136, v: 0.150, ru: 0.034, rv: 0.036 },
    { axis: 'z', face: 1, u: 0.132, v: 0.086, ru: 0.028, rv: 0.028 },
    { axis: 'z', face: 1, u: -0.132, v: 0.086, ru: 0.028, rv: 0.028 },
    // Outer shoulder. From dead ahead the head occludes the whole chest, so the
    // only body masses the front camera can see are the two shoulder domes
    // either side of the skull and the four legs below — those are where a
    // front-readable marking has to go.
    { axis: 'z', face: 1, u: 0.152, v: 0.236, ru: 0.040, rv: 0.036 },
    { axis: 'z', face: 1, u: -0.152, v: 0.236, ru: 0.040, rv: 0.036 },
    // Back, flanking the bud's collar, read from above.
    { axis: 'y', face: 1, u: 0.104, v: 0.020, ru: 0.038, rv: 0.044 },
    { axis: 'y', face: 1, u: -0.104, v: 0.020, ru: 0.038, rv: 0.044 },
    // Rump.
    { axis: 'y', face: 1, u: 0.062, v: -0.262, ru: 0.042, rv: 0.040 },
    { axis: 'y', face: 1, u: -0.062, v: -0.262, ru: 0.042, rv: 0.040 },
  ];
  // Warp right down and the feather band widened: the border wobble was being
  // quantised by the mesh's own cell size and coming out as hard zigzags, which
  // is the opposite of the soft-edged ellipse it was meant to produce.
  // Feather up hard from 0.46. That value put the falloff band over half the
  // ellipse's radius, so every marking was gradient all the way through and had
  // no shape left — a soft-EDGED ellipse still needs a solid middle. 0.76 keeps
  // the border organic while the mark reads as a drawn shape.
  paintSpots(bodyGeo, bodySpots, SPOT, { seed: 71, belly: BELLY, warp: 0.005, feather: 0.76 });
  // The seam. Without a ring of shadow where the bud enters the back, the bud
  // is an object balanced on an animal no matter how well it is modelled.
  // 0.46 was dark enough that the ring itself read as the gap it was meant to
  // explain. A seam wants to be a hint of contact shadow, not a black band.
  paintCollar(bodyGeo, 0, -0.062, 0.104, 0.176, 0.30);
  rig.body.add(body);

  // Claws — three per foot, small, warm bone, angled down and forward. Kept
  // deliberately low-contrast: they are the least important shape on the model.
  const clawMat = new THREE.MeshPhysicalMaterial({
    color: 0xbdb49c, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4,
  });
  const clawGeo = clawGeometry(0.0074, 0.020);
  for (const sgn of [1, -1]) {
    for (const leg of LEGS) {
      for (const tx of [-0.036, 0, 0.036]) {
        const claw = new THREE.Mesh(clawGeo, clawMat);
        claw.position.set(sgn * leg.x + tx, 0.030, leg.z + 0.078);
        claw.rotation.set(Math.PI * 0.62, 0, -tx * 5.0);
        claw.castShadow = true;
        rig.body.add(claw);
      }
    }
  }

  /* --- Head ---------------------------------------------------------- */
  rig.head.position.set(0, 0.286, 0.238);
  // The head was oversized to buy appeal and it bought the opposite: at 1.12 it
  // was as wide as the ribcage and rounder, so from the front it occluded the
  // entire body and the animal read as a head with feet — and it hid the bud
  // completely. A quadruped's head has to be *smaller* than its chest for the
  // four-square stance to be the first thing the eye reads.
  rig.head.scale.setScalar(0.89);

  // Forward, close-set and HIGH on the skull. Wide-set eyes low on the face is
  // the frog read; bringing them in and up is most of what makes a face warm.
  const eyeX = 0.048;
  const eyeY = 0.031;
  const eyeZ = 0.100;
  const headBalls: Ball[] = [
    // Wide and slightly flattened rather than a ball — a spherical skull is
    // what gives a stubby quadruped the pug read.
    { x: 0, y: 0, z: 0, r: 0.140, sx: 1.16, sy: 0.90, sz: 0.98 },
    // Muzzle: short, broad, dropped — a snub nose, not a snout.
    { x: 0, y: -0.038, z: 0.084, r: 0.090, sx: 1.08, sy: 0.72, sz: 0.80 },
    { x: 0, y: -0.076, z: 0.032, r: 0.070, sx: 1.0, sy: 0.56, sz: 1.0 },
    { x: 0.100, y: -0.030, z: 0.028, r: 0.060, sy: 0.88 },
    { x: -0.100, y: -0.030, z: 0.028, r: 0.060, sy: 0.88 },
    // Cheeks packed out under the eyes, which is what makes a large eye read
    // as set into a face instead of stuck onto a ball.
    { x: 0.086, y: -0.036, z: 0.070, r: 0.058, sx: 0.9, sy: 0.80, sz: 0.86 },
    { x: -0.086, y: -0.036, z: 0.070, r: 0.058, sx: 0.9, sy: 0.80, sz: 0.86 },
  ];
  // NO BROW. Bulbasaur has no bony ridge over the eye; a sculpted one gives
  // the character a permanent scowl no amount of eye tuning can undo. The
  // fold above the eye is painted instead (see paintEyeFold), and the only
  // geometry up there is the skull's own smooth curve.

  // Ears: broad, flat, leaf-shaped flaps swept back and out. Each is a chain
  // of heavily flattened balls (thin on X, wide on Y/Z) so the whole flap is
  // a plate with a rounded margin rather than the pointed horn this had
  // before. A horn on a quadruped reads as a predator; a leaf reads as grass.
  for (const sgn of [1, -1]) {
    headBalls.push({ x: sgn * 0.082, y: 0.036, z: -0.012, r: 0.064, sx: 0.36, sy: 1.00, sz: 1.15 });
    headBalls.push({ x: sgn * 0.098, y: 0.078, z: -0.070, r: 0.058, sx: 0.32, sy: 1.02, sz: 1.30 });
    // Terminal ball taken up rather than further back: at z -0.132 it fused with
    // the skull into one swept hump behind the head, which reads from the side as
    // a crest. Ending the chain higher keeps the flap a distinct pointed leaf.
    headBalls.push({ x: sgn * 0.106, y: 0.116, z: -0.106, r: 0.038, sx: 0.30, sy: 0.94, sz: 1.16 });
  }
  // Eye sockets. The eye has to sit DOWN IN one of these so that only a
  // spherical cap shows, flush with the skin — an eyeball sitting proud of the
  // skull is the single thing that made this creature alarming rather than
  // cute. Two counter-intuitive details matter: the carve must be wide and only
  // moderately strong, because a tight strong negative against a strong
  // positive field pushes up a raised lip around itself (that lip was reading
  // as a heavy scowling brow), and a long sz tunnels the socket forward through
  // the cheek instead of opening the aperture into a canyon.
  for (const sgn of [1, -1]) {
    headBalls.push({
      // sy raised from 0.82: a socket flattened that hard is a horizontal SLOT,
      // and its top rim clipped the eyeball into a crescent. The aperture has to
      // be roughly as round as the eye it holds, or the pupil can never sit
      // concentric inside it.
      x: sgn * eyeX, y: eyeY + 0.002, z: eyeZ - 0.008, r: 0.052, sx: 1.12, sy: 0.94, sz: 1.55,
      strength: -0.33,
    });
  }
  // Mouth: a single wide upcurve. The corners rise and the arc is shallow —
  // no philtrum, no lip volume, no S-curve. Every one of those is what made
  // the previous pass a human smirk.
  // Wide and shallow. The previous curve dipped 0.078 below the corners over
  // only 0.092 of half-width, and a deep narrow upcurve is not a grin — it is a
  // pursed mouth, and with the muzzle mass sitting under it the pair read as a
  // pout with a chin. Widening the span and halving the dip turns the same
  // shape into a broad, relaxed line.
  const smile: THREE.Vector3[] = [
    // Corners pulled in from ±0.100. At that span the line carried right round
    // onto the cheek, so from the side the mouth ended in a black hook rather
    // than tucking away out of sight.
    new THREE.Vector3(-0.086, 0.002, 0.084),
    new THREE.Vector3(-0.052, -0.030, 0.132),
    new THREE.Vector3(0, -0.042, 0.158),
    new THREE.Vector3(0.052, -0.030, 0.132),
    new THREE.Vector3(0.086, 0.002, 0.084),
  ];
  const smileCurve = new THREE.CatmullRomCurve3(smile, false, 'catmullrom', 0.5);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const p = smileCurve.getPoint(t);
    // The carve fades out at the corners so the groove tucks away instead of
    // ending in two dimples.
    const taper = Math.pow(Math.sin(Math.PI * t), 0.4);
    headBalls.push({
      x: p.x, y: p.y, z: p.z, r: 0.028, sx: 0.9, sy: 0.30, sz: 0.9,
      strength: -0.22 * taper,
    });
  }
  // Nostrils: a broad shallow dish only. A tight negative ball against a
  // strong muzzle field pushes up a raised rim around itself and renders as a
  // pimple — the exact opposite of the hole it is supposed to cut.
  for (const sgn of [1, -1]) {
    headBalls.push({ x: sgn * 0.021, y: -0.004, z: 0.150, r: 0.028, sy: 0.6, sz: 0.45, strength: -0.26 });
  }

  const headGeo = metaSurface(headBalls, { resolution: 33, smooth: 0.96, padding: 0.035 });
  // Cavity strength dropped hard, from 0.24. The pass darkens by proximity to
  // the form's core, and the deepest thing on a head is the eye socket — so at
  // 0.24 it drew a dark crescent over each eye, and two dark crescents slanting
  // toward the nose is an angry eyebrow no matter what the geometry is doing.
  const head = finishBody(new THREE.Mesh(headGeo, skin), new THREE.Vector3(0, 0, 0), 0.13);
  // Markings continue onto the back and sides of the skull only — the face
  // itself is clean, and mottling on a muzzle reads as disease.
  const headSpots: Spot[] = [
    ...bothSides([
      { u: 0.038, v: -0.062, ru: 0.044, rv: 0.050 },
      { u: -0.026, v: -0.104, ru: 0.034, rv: 0.038 },
    ]),
    { axis: 'y', face: 1, u: 0.042, v: -0.088, ru: 0.042, rv: 0.050 },
    { axis: 'y', face: 1, u: -0.042, v: -0.088, ru: 0.042, rv: 0.050 },
  ];
  paintSpots(headGeo, headSpots, SPOT, { seed: 23, warp: 0.008 });
  // NO PAINTED FOLD. Even at 0.09 the ring above the eye rendered as a dark
  // slanted wedge over each socket, and two dark wedges slanting down toward
  // the nose is a scowl — the exact fault the fold was supposed to avoid. The
  // socket's own cavity shading is all the contact shadow the eye needs, and it
  // sits *around* the eye rather than *above* it, which is the difference
  // between a set-in eye and an eyebrow.
  rig.head.add(head);

  /* --- Mouth line ---------------------------------------------------- */
  // Near-black cool green rather than a lip colour. The previous maroon read
  // as a pink mouth interior from every angle, and Bulbasaur's mouth is a
  // drawn line with nothing behind it.
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x1d2a24, roughness: 0.7 });
  // Snapped onto the meshed muzzle rather than trusting the authored z. The
  // groove carved above pulls the skin back along this line, so the visible
  // line is laid just proud of where the surface actually ended up.
  const mouthCurve = new THREE.CatmullRomCurve3(
    smile.map((p) => {
      const zs = frontSurfaceZ(headGeo, p.x, p.y, 0.017);
      return new THREE.Vector3(p.x, p.y, Number.isFinite(zs) ? zs + 0.0015 : p.z);
    }),
    false, 'catmullrom', 0.5,
  );
  const mouth = new THREE.Mesh(mouthLineGeometry(mouthCurve, 0.0068, 22, 5), mouthMat);
  mouth.renderOrder = 1;
  rig.head.add(mouth);

  // The hole itself is a dark inset bead. At this scale a nostril is a value,
  // not a form, and a sunk bead reads as one from every angle where a sculpted
  // dent just catches a highlight and disappears.
  // Kept very close to the skin's own value. Two dark beads sitting right above
  // the mouth line read as a pig's snout; the nostrils only need to be enough
  // of a break in the surface to stop the muzzle being blank.
  const nostrilMat = new THREE.MeshStandardMaterial({ color: 0x156056, roughness: 0.9 });
  for (const sgn of [1, -1]) {
    const n = new THREE.Mesh(new THREE.SphereGeometry(0.0080, 9, 6), nostrilMat);
    const nx = sgn * 0.021;
    const ny = -0.004;
    const nz = frontSurfaceZ(headGeo, nx, ny, 0.014);
    n.position.set(nx, ny, (Number.isFinite(nz) ? nz : 0.148) - 0.0012);
    n.scale.set(0.85, 1.15, 0.42);
    n.rotation.z = sgn * -0.30;
    rig.head.add(n);
  }

  /* --- Eyes ---------------------------------------------------------- */
  // Small, seated deep in the sockets carved above, and only slightly proud of
  // the skin. The previous eye was 0.0405 on a 0.140 skull and sat clear of the
  // surface as a polished sphere: that is a Muppet, and it is why this lineup
  // scored what it scored. Everything here is aimed at the opposite read —
  // small, matte, set in, and relaxed.
  const EYE_R = 0.0330;
  for (const sgn of [1, -1]) {
    const holder = new THREE.Group();
    // Pushed back into the skull so the socket rim overlaps the eyeball's
    // equator all the way round and only a cap is visible. 0.42 rather than
    // 0.52: seated any deeper and the aperture closes down over the iris until
    // only the pupil shows, so the eye stops being red.
    // 0.32 rather than 0.38. Still deep enough that the socket rim overlaps the
    // eyeball's equator all the way round — so only a cap shows and nothing
    // protrudes — but shallow enough that the visible cap is a good deal wider
    // than the pupil, which is what keeps the red reading as a ring.
    holder.position.set(sgn * eyeX, eyeY, eyeZ - EYE_R * 0.32);
    // Splay halved. Any meaningful yaw swings the pupil off the aperture's centre
    // and the pair read as looking past the camera rather than at it.
    holder.rotation.y = sgn * 0.05;
    // A gentle vertical squash: a perfectly round eye is a startled eye.
    holder.scale.set(1, 0.90, 1);

    const eye = bulbaEye(EYE_R);
    holder.add(eye);

    // Blink lid, in the skin material so it disappears into the face. Cheap —
    // it is only ever seen for a tenth of a second.
    const lid = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_R * 1.06, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      skin,
    );
    ensureVertexColor(lid.geometry);
    lid.scale.y = 0;
    lid.castShadow = false;
    holder.add(lid);

    rig.head.add(holder);
    rig.eyes.push(eye);
    rig.eyelids.push(lid);
  }

  /* --- Bulb ---------------------------------------------------------- */
  const bulbGroup = new THREE.Group();
  // ON THE BACK, not on the head. The head sits at z = +0.242; the bud's axis
  // is at z = -0.055, which is behind the shoulders and over the spine, and its
  // FOOT is at y = 0.286 — below the head's centre line. Those two facts
  // together are the whole difference between a Pokemon with a bulb and a
  // Pokemon in a hat: the bud must start lower than the skull and well behind
  // it, so the neck and the back of the head are visible above and in front of
  // it from every angle.
  const BULB_Z = -0.062;
  // Lifted so the foot sits just at the skin rather than a finger's width under
  // it: the seam should eat the scale roots and nothing else.
  bulbGroup.position.set(0, 0.320, BULB_Z);
  // Squat, but only mildly. At 0.78 the squash was flattening the whorls faster
  // than the ogee could close them, which is half of why the bud opened out.
  bulbGroup.scale.set(1, 0.92, 1);
  rig.body.add(bulbGroup);

  // Paler and yellower than the skin, so the bud separates from the body as a
  // different substance — waxy plant against matte hide.
  const bulbMat = creatureSkin({
    color: 0x5f8c2c,
    subsurface: 0x9cbe49,
    // A bud is thin and translucent — light passes right through the scale
    // margins, so the wrap term runs hotter here than on skin.
    wrap: 0.22,
    rim: 0.07,
    roughness: 0.95,
    // A cellular normal gives the packed-plate surface of a closed bud, and
    // is the main thing separating bulb from skin as a material.
    detail: 'scales',
    detailScale: 2,
  });
  // Waxy, not glossy: a broad soft clearcoat sheen along the plate crowns.
  bulbMat.clearcoat = 0.28;
  bulbMat.clearcoatRoughness = 0.42;
  bulbMat.sheen = 0.10;
  // The cellular normal was crazing the whole bud like cracked glaze, which
  // reads as a diseased or ceramic surface. Barely there is enough.
  bulbMat.normalScale.set(0.07, 0.07);
  bulbMat.envMapIntensity = 0.30;
  bulbMat.roughnessMap = null;
  bulbMat.roughness = 0.72;

  bulbMat.vertexColors = true;
  // The outer whorl, one shade deeper so the courses separate as value rather
  // than relying on the lighting to find the laps.
  const bulbDeep = bulbMat.clone();
  bulbDeep.color.setHex(0x4d7420);
  bulbDeep.vertexColors = true;

  const BULB_R = 0.176;
  bulbGroup.add(budAssembly(BULB_R, bulbMat, bulbDeep));

  rig.extras.push(bulbGroup);

  const anim = new IdleAnimator(rig, 11);
  let attention = 0;

  return {
    id: 'bulbasaur',
    name: 'Bulbasaur',
    group: rig.root,
    get attention() { return attention; },
    set attention(v: number) { attention = clamp(v, 0, 1); },
    update(dt, elapsed) {
      anim.update(dt, elapsed, attention);
      // The shared blink lid is a hemisphere scaled to zero on Y when open,
      // which leaves a coplanar disc that renders edge-on as a hard dark line
      // across the eyeball. Hiding it while it is fully open costs nothing.
      for (const lid of rig.eyelids) lid.visible = lid.scale.y > 0.02;
      // The bud is heavy — it lags the body's motion.
      bulbGroup.rotation.z = Math.sin(elapsed * 0.44 - 0.5) * 0.05;
      bulbGroup.rotation.x = Math.sin(elapsed * 1.55 - 0.7) * 0.03;
    },
    celebrate: () => anim.celebrate(),
    dispose: () => disposeCreature(rig.root),
  };
}
