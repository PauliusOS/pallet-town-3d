import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { InteractionSystem } from '../src/world/Interaction.ts';

function lookAt(camera, x, z) {
  camera.lookAt(x, camera.position.y, z);
  camera.updateMatrixWorld(true);
}

test('each starter station can receive and activate focus', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.6, 0);

  const interactions = new InteractionSystem(camera);
  const activated = [];
  const starters = [
    ['starter-bulbasaur', -1],
    ['starter-charmander', 0],
    ['starter-squirtle', 1],
  ];

  for (const [id, x] of starters) {
    interactions.register({
      id,
      position: new THREE.Vector3(x, 1, -2),
      radius: 3,
      label: `Look at ${id}`,
      onInteract: () => activated.push(id),
    });
  }

  for (const [id, x] of starters) {
    lookAt(camera, x, -2);
    interactions.update(1 / 60);
    assert.equal(interactions.focused?.id, id);
    assert.equal(interactions.activate(), true);
  }

  assert.deepEqual(activated, starters.map(([id]) => id));
});

test('the lab exit activates when enabled and rejects stale focus while busy', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  lookAt(camera, 0, -1);

  const interactions = new InteractionSystem(camera);
  let inside = true;
  let busy = false;
  let exits = 0;

  interactions.register({
    id: 'lab.door.exit',
    position: new THREE.Vector3(0, 1.3, -1),
    radius: 2.6,
    label: 'Step outside',
    enabled: () => inside && !busy,
    onInteract: () => exits++,
  });

  interactions.update(1 / 60);
  assert.equal(interactions.focused?.id, 'lab.door.exit');

  busy = true;
  assert.equal(interactions.activate(), false);
  assert.equal(interactions.focused, null);
  assert.equal(exits, 0);

  busy = false;
  interactions.update(1 / 60);
  assert.equal(interactions.activate(), true);
  assert.equal(exits, 1);

  inside = false;
  interactions.update(1 / 60);
  assert.equal(interactions.focused, null);
});
