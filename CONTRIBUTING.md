# Contributing

Contributions are welcome. Open an issue for anything large enough that you would be upset to have
it rejected after the fact; send a pull request for anything smaller.

```bash
npm install
npm run dev          # http://127.0.0.1:5173
npm run check        # typecheck — must pass
npm test             # unit tests — must pass
```

## The rules that are not negotiable

These are what keep a scene assembled by many hands reading as one place. A pull request that
breaks one of them will be asked to change, however good the idea underneath is.

**`ART_DIRECTION.md` outranks individual taste.** It is the art bible. If you think it is wrong,
argue with the document in an issue and change it there first — do not quietly diverge from it in a
commit.

**No binary art assets.** Every texture is baked procedurally at load time, every model is sculpted
from signed-distance fields, every sound is synthesised in WebAudio. A PNG, GLB, or WAV in a pull
request is a design change, not an implementation detail, and needs its own discussion.

**No `Math.random()` in `src/`.** Every random choice goes through the seeded generator in
`core/Noise.ts`, keyed off `World.SEED`. The same build must always produce the same town —
determinism is what makes screenshot review mean anything.

**One tone-map.** The chain runs in HDR half-float and converts to display range exactly once, at
the end of the post chain in `PostFX.ts`. Tone mapping stays disabled on the renderer itself.

**One lighting rig.** `world/Atmosphere.ts` owns every outdoor light. Nothing else in the project
creates one.

**Stay inside the performance budget.** 60fps at 1600×900 on `high` quality, ≤ 260 draw calls,
≤ 2.2M triangles. Anything drawn more than eight times is an `InstancedMesh`.

## Changing how something looks

Screenshots are the unit of quality here, so a visual change should come with visual evidence.

```bash
node tools/capture.mjs --list                    # the shot list, and what each frames
node tools/capture.mjs --out shots/review        # every shot, plus draw calls / tris / fps
node tools/capture.mjs --shots town_reveal,lab_door

node tools/shoot-creature.mjs --subject charmander --angles front,three_quarter,side,back
```

Post before-and-after frames from the same shot names in the pull request. The shot list is a
contract — same cameras, same seed, same time of day on every run — so a difference in a screenshot
is always a difference in the art.

Two things that will waste your time if you do not know them:

- Editing a file in `src/` mid-capture makes Vite reload and restart the ~20s world build, so the
  capture times out. Run reviews in a quiet window, or against `npm run build && npm run preview`,
  which does not hot-reload.
- Judge a creature on the studio set (`shoot-creature.mjs`) rather than in the town. The grade and
  the clutter hide exactly the modelling faults you are looking for.

`shots/` is gitignored. It is output, not source — never commit it.

## Pull requests

Keep them focused on one thing. Explain what visual or behavioural difference the change makes and
why, not just what the code now does. `npm run check` and `npm test` both have to pass.

## Licence

By contributing you agree that your contributions are licensed under the MIT Licence, the same
terms that cover the rest of the project.
