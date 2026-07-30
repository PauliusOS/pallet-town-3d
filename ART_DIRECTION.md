# Pallet Town — Art Direction Bible

**Every agent working on this project must read this file first and must not deviate from it.**
Ten people building ten beautiful things in ten different styles produces an ugly game. Coherence
beats individual brilliance. When in doubt, match this document rather than your own taste.

---

## 1. The target

Animal Crossing: New Horizons, rendered at the fidelity of a current-gen console title, seen in
first person. Specifically:

- **Soft, rounded, hand-crafted.** Nothing in this world has a sharp 90° edge. Every hard edge is
  bevelled or filleted. Objects look like they were carved from soap and painted with gouache.
- **Saturated but not neon.** Colours are rich and cheerful, sitting around 55–75% saturation.
  Nothing is pure `#00FF00`. Greens lean warm-yellow in light, cool-blue in shadow.
- **Overcast-free.** The scene is lit by a clear late-morning sun, roughly 9:30am, sun elevation
  ~38°. Long-ish shadows that still read as "morning", not "sunset".
- **Miniature-diorama scale cues.** Slight exaggeration of proportion: chunky fence posts, oversized
  flowers, thick roof tiles. Everything is ~10% chunkier than reality.

## 2. Hard rules

These are not suggestions. A reviewer will reject work that breaks any of them.

1. **No sharp edges.** Every box-like form uses a bevelled or rounded profile. Minimum bevel 1.5cm
   at world scale. Use `RoundedBoxGeometry`-style construction or extruded rounded shapes.
2. **No untextured flat-colour surfaces.** Every material has at minimum an albedo variation and a
   normal map from `TextureLab`. Perfectly uniform colour reads as "untextured placeholder" and is
   the single fastest way to look amateur.
3. **No pure black and no pure white.** Darkest albedo `#1a1614`, brightest `#f4efe6`. Pure values
   destroy the pastel feel.
4. **Everything casts and receives shadow** unless it is foliage billboard filler or beyond 60m.
5. **Nothing intersects the ground plane visibly.** Objects sit on the terrain via
   `ctx.collision.groundHeight(x, z)`, with a small skirt or contact detail (dirt ring, grass tuft)
   where they meet it. A cylinder poking through a plane is the second fastest way to look amateur.
6. **No z-fighting.** Coplanar surfaces get a minimum 2mm offset or `polygonOffset`.
7. **Silhouette first.** If the object is not recognisable as a black shape against the sky, the
   modelling is wrong and no amount of texture will save it.

## 3. Palette

Use these. Do not invent new hues; derive tints and shades from these instead.

| Role | Hex | Notes |
|---|---|---|
| Grass, lit | `#7cc24a` | Warm yellow-green |
| Grass, mid | `#5b9e3c` | Base turf |
| Grass, shadow | `#3f7d3a` | Cool, never grey |
| Foliage light | `#8fd257` | Canopy tops |
| Foliage dark | `#3c6b34` | Canopy underside |
| Dirt path | `#c9a173` | Warm sand |
| Dirt dark | `#9a6f45` | Compacted |
| Roof red | `#d0553f` | Player + rival house |
| Roof blue | `#4a86c4` | Lab |
| Wall cream | `#f0e3c8` | Primary cladding |
| Wall warm white | `#faf3e4` | Trim |
| Wood trim | `#8a5c3b` | Beams, fences |
| Stone | `#b8b3a8` | Cobble, lab base |
| Water shallow | `#5fc8d2` | Turquoise |
| Water deep | `#1f7ba8` | |
| Sky zenith | `#3f7fd6` | |
| Sky horizon | `#bfe0f2` | |
| Sun | `#fff3d6` | |
| Flower accents | `#f25d7a` `#ffd447` `#f5f0ea` `#b57fe0` | pink / yellow / white / purple |

## 4. Lighting rig

Owned by `src/world/Atmosphere.ts`. Nobody else creates lights.

- **Key**: one `DirectionalLight`, colour `#fff3d6`, intensity ~3.2, elevation 38°, azimuth from the
  south-east. Casts shadows, VSM, 4096 map, tight ortho frustum around the playable area.
- **Sky fill**: `HemisphereLight`, sky `#8ec5f0`, ground `#6b8f4e`, intensity ~0.9. This is what
  makes shadows read blue-green instead of grey and is the core of the Animal Crossing look.
- **Environment**: a generated `PMREMGenerator` cubemap from the sky shader, assigned to
  `scene.environment`. Every PBR material must respond to it — this supplies the soft ambient
  specular that separates "3D render" from "flat toy".
- **Bounce**: one very dim warm `DirectionalLight` from below-front (`#ffd9a8`, intensity ~0.25, no
  shadow) to fake ground bounce into the undersides of eaves and canopies.
- Total light count must stay ≤ 5 for performance. No point lights outdoors.

## 5. Materials

Use `MeshStandardMaterial` (or `MeshPhysicalMaterial` where a specific effect needs it). Source all
maps from `src/core/TextureLab.ts` — extend that file rather than baking textures inline.

- **Painted wood / plaster**: roughness 0.55–0.75, metalness 0.
- **Roof tile**: roughness 0.65, normal strength high, slight `clearcoat` (0.15) for a ceramic sheen.
- **Foliage**: roughness 0.8, `side: DoubleSide`, and **must** use translucency — sample the sun
  through the leaf. Backlit leaves glowing green is the signature of good stylised foliage.
- **Water**: `MeshPhysicalMaterial` with `transmission`, animated normal maps, shoreline foam.
- **Metal** (Poké Ball bands, door handles): roughness 0.25, metalness 0.9, and it *must* have the
  environment map or it will look like grey plastic.
- **Glass**: `transmission: 1`, `thickness`, `ior: 1.5`, plus a faked interior reflection so windows
  are never just dark holes.

## 6. Composition of the town

Looking north from the town's south entrance:

```
                        ~~~~~~ sea (north edge, beyond the fence) ~~~~~~
                    ┌─────────────────┐
                    │  OAK'S LAB      │   large, blue roof, stone base,
                    │  (north centre) │   two storeys, satellite dish
                    └────────┬────────┘
                             │  cobble forecourt
        ┌──────────┐   town green   ┌──────────┐
        │ PLAYER   │   with sign    │  RIVAL   │
        │ HOUSE    │   + flowers    │  HOUSE   │
        │ (west)   │                │  (east)  │
        └──────────┘                └──────────┘
              dirt path running north–south
        ~ trees + fences enclosing east and west ~
                        ↑ player spawns here, facing north
```

- Playable area roughly 44m × 52m, bounded by treeline west/east, sea north, tall grass south.
- Two houses are mirror-image in massing but clearly distinct in trim colour and prop dressing.
- The lab is the visual anchor: tallest, coolest colour, terminates the path.

## 7. Density rule

Empty ground is the enemy. Any patch of visible terrain larger than ~3m² with nothing on it must
receive scatter: grass tufts, clover, pebbles, fallen leaves, flowers, or a subtle path scuff.
The Animal Crossing look is dense and busy at ground level and clean at eye level.

Budget guidance (whole scene, `high` quality): ≤ 260 draw calls, ≤ 2.2M triangles, 60fps at 1600×900.
Use `InstancedMesh` for anything appearing more than 8 times. This is a real constraint, not a nicety —
the capture harness reports draw calls and a reviewer will check them.

## 8. Post-processing

Owned by `src/core/PostFX.ts`. Do not add passes elsewhere. The chain is HDR throughout with a
single ACES conversion in the grade pass. If your object looks blown out, fix its albedo or its
emissive — do not change the exposure.

## 9. What "AAA" means for review

A shot passes only if all of these are true:
- Materials read as distinct substances at a glance (wood ≠ plaster ≠ tile ≠ stone).
- There is visible contact shadowing where every object meets the ground.
- There is colour variation *within* each surface, not just between surfaces.
- The silhouette is readable and intentional.
- Nothing is obviously procedural: no visible tiling, no uniform spacing, no repeated identical
  instances in a row at the same rotation.
- The frame has depth: foreground detail, midground subject, background atmosphere.
