# The prompt

Everything in this repository grew out of a single message, sent to Claude Code on 2026-07-29.
It is reproduced here verbatim.

---

> want you to recreate Pokemon leaf green but in modern 3D cartoon style. The first town pallet town
> and choosing the Pokemon sequence. It should be first person. at the level of the most recent
> animal crossing games. It should be utterly perfect, visually beautiful, with every single thing
> done at AAA quality—from textures to physics to anything you could think of.
>
> Fan out sub-agents and have sub-agents tackle each one individually so that the game is utterly
> perfect. You should /loop on each item and have a separate sub-agent check it visually to ensure
> it looks triple A. That separate sub-agent should be a really harsh critic, and if it doesn't look
> triple A, it should keep going.
>
> Don't stop until each sub-agent is utterly wowed with the quality when compared with the actual
> latest Pokemon game. It should literally compare them side by side blind and say which one looks
> better. Do this in ThreeJS. /loop until it's utterly perfect. Fan out sub-agents and ultracode.

---

The shape of the codebase follows directly from it. The demand for a harsh critic in the loop is
why `tools/capture.mjs` exists as a first-class tool rather than a convenience, why the shot list is
a fixed contract, and why the world is seeded — a screenshot is only worth arguing about if the only
thing that changed between two of them is the art. Many hands working in parallel is why
`ART_DIRECTION.md` outranks individual taste, and why the constraints in `CONTRIBUTING.md` are
written down at all.
