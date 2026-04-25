import * as THREE from 'three';

// The outer shell: a semi-transparent frosted glass sphere. Uses
// MeshPhysicalMaterial with transmission so it refracts what's behind it
// (including the core blob and particles) and roughness for the frosted look.
export function createOrb() {
  const geometry = new THREE.SphereGeometry(1.0, 128, 128);

  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#bfe4ff'),
    roughness: 0.18,
    metalness: 0.0,
    transmission: 1.0,
    thickness: 0.9,
    ior: 1.35,
    attenuationColor: new THREE.Color('#9ec9ff'),
    attenuationDistance: 2.5,
    clearcoat: 1.0,
    clearcoatRoughness: 0.12,
    transparent: true,
    opacity: 1.0,
    side: THREE.FrontSide,
    envMapIntensity: 1.2,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  return { mesh, material };
}
