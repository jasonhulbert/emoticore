import * as THREE from 'three';
import { simplex3d } from './shaders/noise.glsl.js';

// The morphing energy blob at the center of the orb. A high-res sphere whose
// vertices are displaced by layered 3D noise in the vertex shader, shaded with
// a fresnel-weighted emissive gradient so the core reads as luminous plasma.
export function createCore() {
  const geometry = new THREE.IcosahedronGeometry(0.55, 64);

  const uniforms = {
    uTime: { value: 0 },
    uNoiseScale: { value: 1.6 },
    uNoiseSpeed: { value: 0.35 },
    uDisplacement: { value: 0.22 },
    uPulse: { value: 0.0 },
    uColorA: { value: new THREE.Color('#6ce0ff') }, // cool cyan
    uColorB: { value: new THREE.Color('#b16cff') }, // violet
    uColorC: { value: new THREE.Color('#ffd36c') }, // warm core highlight
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${simplex3d}
      uniform float uTime;
      uniform float uNoiseScale;
      uniform float uNoiseSpeed;
      uniform float uDisplacement;
      uniform float uPulse;

      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying float vDisplacement;

      // Layered FBM: big slow rolls + smaller faster ripples.
      float fbm(vec3 p) {
        float n = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          n += a * snoise(p);
          p *= 2.02;
          a *= 0.5;
        }
        return n;
      }

      void main() {
        vec3 p = position;
        float t = uTime * uNoiseSpeed;
        float n = fbm(p * uNoiseScale + vec3(0.0, t, 0.0));
        float pulse = (0.5 + 0.5 * sin(uTime * 0.8)) * 0.15 + uPulse;
        float disp = n * uDisplacement + pulse * 0.05;

        vec3 displaced = p + normal * disp;

        vDisplacement = disp;
        vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
        vViewPosition = -mvPosition.xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform vec3 uColorC;

      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying float vDisplacement;

      void main() {
        vec3 viewDir = normalize(vViewPosition);
        float fresnel = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.2);

        // Displacement drives the core-to-edge color shift.
        float m = smoothstep(-0.1, 0.2, vDisplacement);
        vec3 col = mix(uColorA, uColorB, m);
        col = mix(col, uColorC, fresnel * 0.65);

        // Bias toward a hot center so the blob reads as energy, not matte clay.
        float center = 1.0 - fresnel;
        col += uColorC * center * 0.35;

        float alpha = clamp(0.55 + fresnel * 0.6, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;

  return {
    mesh,
    uniforms,
    update(elapsed, dt) {
      uniforms.uTime.value = elapsed;
      // Slow rotation so the displacement pattern reads as motion from all angles.
      mesh.rotation.y += dt * 0.15;
      mesh.rotation.x += dt * 0.07;
      // Gentle breathing pulse decays back toward zero each frame.
      uniforms.uPulse.value *= Math.max(0.0, 1.0 - dt * 2.5);
    },
    poke(amount = 1.0) {
      uniforms.uPulse.value = Math.min(1.0, uniforms.uPulse.value + amount);
    },
  };
}
