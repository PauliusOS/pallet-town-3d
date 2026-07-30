import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { metaSurface, roundedBox, noiseDisplace } from '../src/fx/Sculpt.ts';

/**
 * Guards the marching-cubes mesher.
 *
 * Every creature and several props are sculpted with `metaSurface`, and the
 * failure mode that cost the most time was silent: the classic triangle table
 * assumes a cube-index bit set for corners *inside* the surface, while the
 * field test sets it for corners *above* the isolevel. Getting that backwards
 * mirrors every face, so the whole model lights against the inside of its own
 * skin — which reads as flat, washed-out shading rather than as an obvious
 * error. These tests make that regression loud.
 */

/**
 * Mean of N · normalize(p − centroid) over all vertices.
 *
 * A correctly wound closed surface scores strongly positive; the mirrored
 * surface scores strongly negative. Convex-ish blobs land close to 1.
 */
function outwardness(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  assert.ok(nor, 'geometry must have normals');

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < pos.count; i++) {
    cx += pos.getX(i);
    cy += pos.getY(i);
    cz += pos.getZ(i);
  }
  cx /= pos.count;
  cy /= pos.count;
  cz /= pos.count;

  let sum = 0;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx;
    const dy = pos.getY(i) - cy;
    const dz = pos.getZ(i) - cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    sum += (nor.getX(i) * dx + nor.getY(i) * dy + nor.getZ(i) * dz) / len;
  }
  return sum / pos.count;
}

test('metaSurface winds a single blob outward', () => {
  const geo = metaSurface([{ x: 0, y: 0, z: 0, r: 0.5 }], { resolution: 40 });
  assert.ok(geo.attributes.position.count > 100, 'expected a real surface');
  const score = outwardness(geo);
  assert.ok(score > 0.9, `normals should point outward, got ${score.toFixed(3)}`);
});

test('metaSurface winds fused blobs outward', () => {
  // Two overlapping spheres must fuse into one skin and stay outward-facing;
  // the concave saddle where they meet is where a winding bug shows up first.
  const geo = metaSurface(
    [
      { x: 0, y: 0, z: 0, r: 0.5 },
      { x: 0.4, y: 0.2, z: 0, r: 0.3 },
    ],
    { resolution: 44 },
  );
  const score = outwardness(geo);
  assert.ok(score > 0.8, `fused surface should be outward, got ${score.toFixed(3)}`);
});

test('metaSurface respects non-uniform ball scaling', () => {
  // An egg twice as tall as it is wide must come out that way, or every
  // creature proportioned with sx/sy/sz is silently wrong.
  const geo = metaSurface([{ x: 0, y: 0, z: 0, r: 0.3, sy: 2 }], { resolution: 40 });
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3());
  assert.ok(size.y > size.x * 1.5, `expected a tall egg, got ${JSON.stringify(size)}`);
});

test('metaSurface welds vertices so shading is smooth', () => {
  // Marching cubes emits a triangle soup; without welding, every facet gets
  // its own normal and the creature looks like cut glass.
  const geo = metaSurface([{ x: 0, y: 0, z: 0, r: 0.5 }], { resolution: 36 });
  const index = geo.getIndex();
  assert.ok(index, 'geometry should be indexed');
  assert.ok(
    geo.attributes.position.count < index.count,
    'indexed vertices should be shared between triangles',
  );
});

test('roundedBox fills its requested extents', () => {
  const geo = roundedBox(1, 2, 3, 0.2, 4);
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 1) < 0.02, `width ${size.x}`);
  assert.ok(Math.abs(size.y - 2) < 0.02, `height ${size.y}`);
  assert.ok(Math.abs(size.z - 3) < 0.02, `depth ${size.z}`);
});

test('noiseDisplace is deterministic for a given seed', () => {
  const a = noiseDisplace(new THREE.SphereGeometry(1, 12, 10), 0.1, 4, 99);
  const b = noiseDisplace(new THREE.SphereGeometry(1, 12, 10), 0.1, 4, 99);
  const pa = a.attributes.position;
  const pb = b.attributes.position;
  assert.equal(pa.count, pb.count);
  for (let i = 0; i < pa.count; i++) {
    assert.ok(Math.abs(pa.getX(i) - pb.getX(i)) < 1e-9, `vertex ${i} diverged`);
  }
});
