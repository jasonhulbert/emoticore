import * as THREE from 'three';
import { simplex3d } from './shaders/noise.glsl.js';

// The central onyx void: a polished black stone with two distinct surface
// effects layered together.
//
//   1. Reflections — a real cubemap rendered each frame from the sphere's
//      center (with the sphere itself hidden during capture) is sampled
//      using the world-space reflection vector. Because the cubemap is
//      world-aligned, reflections do NOT rotate with the sphere — they
//      track the actual surrounding particles + plasma.
//
//   2. Energy waves — fbm noise sampled in OBJECT space, so the wave
//      pattern rotates with the mesh. This makes rotation visible: as
//      the orb spins (or is dragged), warm energy bands sweep across
//      its surface while the reflections of the particles stay put.
export function createOnyx({ radius = 0.55 } = {}) {
  const geometry = new THREE.SphereGeometry(radius, 96, 96);

  const uniforms = {
    uTime: { value: 0 },
    uEnvMap: { value: null },
    uEnvIntensity: { value: 1.6 },
    uBaseColor: { value: new THREE.Color('#04060a') },
    uWaveColor: { value: new THREE.Color('#ff7a18') },
    uWaveStrength: { value: 0.45 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vObjectPos;

      void main() {
        // Object-space position, untouched by the model matrix — used by
        // the fragment shader to sample noise that rotates with the mesh.
        vObjectPos = position;

        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);

        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      ${simplex3d}
      uniform float uTime;
      uniform samplerCube uEnvMap;
      uniform float uEnvIntensity;
      uniform vec3 uBaseColor;
      uniform vec3 uWaveColor;
      uniform float uWaveStrength;

      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vObjectPos;

      float fbm(vec3 p) {
        float n = 0.0;
        float a = 0.5;
        for (int i = 0; i < 3; i++) {
          n += a * snoise(p);
          p *= 2.05;
          a *= 0.5;
        }
        return n;
      }

      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(vWorldPos - cameraPosition);
        vec3 R = reflect(V, N);

        // Fresnel: glancing angles reflect more strongly, like polished
        // stone. Edges of the orb pick up the brightest highlights.
        float fresnel = pow(1.0 - max(dot(-V, N), 0.0), 2.5);

        // World-space reflection of the surrounding scene (particles +
        // plasma envelope), captured into the cubemap each frame.
        vec3 envColor = textureCube(uEnvMap, R).rgb;

        // Object-space energy waves — two layered noise samples on
        // different time axes give a sense of cross-currents flowing
        // across the surface. Threshold makes the pattern read as bright
        // bands or veins rather than uniform haze.
        float t = uTime * 0.35;
        float wave1 = fbm(vObjectPos * 4.0 + vec3(0.0, t, 0.0));
        float wave2 = fbm(vObjectPos * 9.0 - vec3(t * 1.4, 0.0, 0.0));
        float waves = pow(max(wave1 * 0.6 + wave2 * 0.4, 0.0), 2.5);

        // Compose: dark stone base + reflective highlights + warm waves.
        // Reflection intensity ramps with fresnel so the rim glows with
        // the surrounding particles while the front face stays darker.
        vec3 col = uBaseColor;
        col += envColor * uEnvIntensity * (0.25 + 0.75 * fresnel);
        col += uWaveColor * waves * uWaveStrength;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Opaque, renders first and writes depth so additive layers depth-test
  // correctly against it.
  mesh.renderOrder = 0;
  return { mesh, material, uniforms };
}
