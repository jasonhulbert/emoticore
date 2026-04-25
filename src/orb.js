import * as THREE from 'three';

// The central onyx void: a polished black stone the energy swirls around.
// Slightly metallic with low roughness so the env map gives it subtle cool
// highlights — never pure flat black, but always reading as solid mass.
export function createOnyx({ radius = 0.55 } = {}) {
  const geometry = new THREE.SphereGeometry(radius, 96, 96);

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#06080c'),
    roughness: 0.22,
    metalness: 0.55,
    envMapIntensity: 0.9,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Opaque, so it depth-tests against the additive particle cloud and
  // visually anchors the center as a clean dark silhouette.
  mesh.renderOrder = 0;
  return { mesh, material };
}
