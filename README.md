# Pallet Town

A first-person, modern-3D-cartoon reimagining of the opening of Pokémon LeafGreen — the town, and
the choice of a first partner Pokémon — built in Three.js.

Everything you see is generated in code. The project ships **no binary art assets**: every texture
is baked procedurally at load time, every model is sculpted from signed-distance fields and
marching cubes, and every sound is synthesised in WebAudio.

```bash
npm install
npm run dev          # http://127.0.0.1:5173
npm run check        # typecheck
npm test             # unit tests
```

First load builds the whole world procedurally and currently takes around 20 seconds. That is on
the player's critical path and is the largest outstanding defect in the project; `World.build()`
logs a per-step breakdown to the console so the expensive step is always visible.

Click to lock the pointer. **WASD** move · **Shift** run · **Space** jump · **Mouse** look ·
**E** interact · **Esc** release cursor.

---

## Layout

```
src/
  core/          engine, render pipeline, input, procedural texture bakery, noise
  world/         terrain, sky, water, buildings, vegetation, props, lab interior
  player/        first-person controller
  gameplay/      the starter Pokémon and the choice sequence
  ui/            HUD, dialogue, menus
  audio/         procedural soundscape
  fx/            shared materials and the sculpting toolkit
tools/           headless capture harnesses used for visual review
```

`ART_DIRECTION.md` is the art bible. It is the reason a scene assembled by many hands still reads
as one place, and it takes precedence over individual taste.

## How it renders

The whole chain runs in HDR half-float targets, with exactly one tone-map at the end:

```
scene (MSAA) → GTAO → bloom → grade (DOF · ACES · split-tone · vignette · grain) → SMAA
```

Tone mapping is deliberately disabled on the renderer itself. Bloom has to see true over-range
values or sunlight blooms into a grey halo instead of a soft falloff, so the single ACES conversion
lives at the end of the post chain in `PostFX.ts` — never in both places.

Lighting is a small rig, owned entirely by `world/Atmosphere.ts`: one shadow-casting key light, a
hemisphere fill whose ground colour is what makes shadows read blue-green rather than grey, a dim
warm bounce, and a PMREM environment generated from the sky shader. Nothing else in the project
creates outdoor lights.

## How things are built

**Textures** (`core/TextureLab.ts`) are baked to canvases from a shared noise basis. Normal maps
are derived from the same height field as the albedo via a Sobel pass, so the two always agree, and
everything tiles seamlessly by sampling noise on a torus.

**Props and creatures** (`fx/Sculpt.ts`) come from `metaSurface()`, which blends a set of spheres
into one continuous skin with marching cubes. This is the reason the Pokémon read as characters
rather than as assembled primitives: limbs fuse into the body with a soft fillet, exactly as a
sculpted model does, where parented capsules always betray themselves at the seams.

**Creature skin** (`fx/CreatureMaterials.ts`) patches `MeshPhysicalMaterial` after Three's lighting
has run, adding wrapped diffuse and a fresnel rim. Plain PBR has no subsurface term, which is
precisely why untreated cartoon characters look like vinyl toys.

## Visual review

Screenshots are the unit of quality here, so capture is a first-class tool rather than a
convenience.

```bash
node tools/capture.mjs --list                    # the shot list, and what each frames
node tools/capture.mjs --out shots/review        # every shot, plus draw calls / tris / fps
node tools/capture.mjs --shots town_reveal,lab_door

node tools/shoot-creature.mjs --subject charmander --angles front,three_quarter,side,back
```

The shot list is a contract: same cameras, same seed, same time of day on every run, so a change in
a screenshot always means a change in the art and never in the tool.

One caveat: editing a source file mid-capture makes Vite reload the page and restart the ~20s world
build, so a capture taken while something is actively writing to `src/` will time out. Run reviews
in a quiet window, or against `npm run build && npm run preview`, which does not hot-reload. `shoot-creature.mjs` renders
the Pokémon alone on a neutral three-point studio set — judging a character inside the town is
hopeless, because the grade and the clutter hide exactly the modelling faults the review exists to
find.

There is also a live turntable at `/viewer.html?subject=squirtle&angle=side&bg=white`.

## Determinism

Every random choice runs through a seeded generator in `core/Noise.ts`, keyed off `World.SEED`.
The same build always produces the same town, which is what makes screenshot review meaningful.
`Math.random()` should not appear anywhere in `src/`.

## Performance

Budget at `high` quality is 60fps at 1600×900, ≤ 260 draw calls, ≤ 2.2M triangles. Anything drawn
more than eight times is an `InstancedMesh`. The engine trims pixel ratio before it touches any
visual feature, so the art direction survives on weaker hardware.
