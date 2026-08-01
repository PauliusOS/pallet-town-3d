import * as THREE from 'three';
import { metaSurface } from '../../fx/Sculpt';
import { creatureSkin } from '../../fx/CreatureMaterials';
import { clamp } from '../../core/Noise';
import { createRig, IdleAnimator, addEye, finishBody, disposeCreature, type Creature } from './shared';

/**
 * Rattata — placeholder stub. A proper capture-judged sculpt replaces this
 * file wholesale; the stub only guarantees the species is buildable so the
 * viewer, battle system and tools can wire against it.
 */
export function buildRattata(): Creature {
  const rig = createRig();
  rig.root.name = 'Rattata';

  const skin = creatureSkin({ color: 0x9a7ab8, subsurface: 0x7a5a98, wrap: 0.16, rim: 0.05, roughness: 0.9 });
  skin.vertexColors = true;

  const body = finishBody(
    new THREE.Mesh(
      metaSurface(
        [
          { x: 0, y: 0.14, z: 0, r: 0.1, sx: 1.0, sy: 0.92, sz: 1.14 },
          { x: 0, y: 0.24, z: 0.05, r: 0.068 },
        ],
        { resolution: 30, smooth: 0.9 },
      ),
      skin,
    ),
    new THREE.Vector3(0, 0.16, 0),
    0.26,
  );
  rig.body.add(body);
  rig.head.position.set(0, 0.24, 0.05);
  for (const s of [1, -1]) {
    addEye(rig, rig.head, {
      position: new THREE.Vector3(s * 0.032, 0.01, 0.05),
      radius: 0.014,
      irisColor: 0x2a1a10,
      splay: s * 0.5,
      lidMaterial: skin,
    });
  }

  const anim = new IdleAnimator(rig, 19);
  let attention = 0;
  return {
    id: 'rattata',
    name: 'Rattata',
    group: rig.root,
    get attention() {
      return attention;
    },
    set attention(v: number) {
      attention = clamp(v, 0, 1);
    },
    update: (dt, elapsed) => anim.update(dt, elapsed, attention),
    celebrate: () => anim.celebrate(),
    dispose: () => disposeCreature(rig.root),
  };
}
