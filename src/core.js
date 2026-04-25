import * as THREE from 'three';
import { simplex3d } from './shaders/noise.glsl.js';

// The morphing plasma envelope wrapping the onyx stone. A noise-displaced
// sphere sized just outside the stone, additively blended so where it
// intersects the onyx the depth test culls it cleanly and where it extends
// past the silhouette it reads as glowing plasma. Same noise field as the
// particle cloud so plasma surface bulges and particle motion stay locked.
//
// The fragment shader composites four physically-motivated layers to create
// rich plasma lighting:
//   1. Temperature ramp (displacement -> hue/brightness): peaks are hotter,
//      troughs are deep ember. Like blackbody radiation across a surface
//      with varying temperature.
//   2. Fresnel rim: edges-on to the camera glow brightest, simulating the
//      thicker line-of-sight optical depth through a translucent shell.
//   3. Internal veins: low-frequency 3D noise on the surface direction,
//      animated independently from the displacement, reads as flickering
//      plasma channels under the skin.
//   4. Electric crackles: high-frequency noise with a sharp threshold —
//      brief brilliant filaments that flash across the surface.
//   5. Slow pulse: global brightness modulation tied to the displacement so
//      brighter regions also breathe.
export function createCore({ radius = 1.15 } = {}) {
  // Detail 64 -> ~80k tris. The previous 24 was too coarse for the noise
  // frequency we're displacing at: each fbm feature was smaller than the
  // inter-vertex spacing in places, producing visible faceting at peaks.
  const geometry = new THREE.IcosahedronGeometry(radius, 64);

  const uniforms = {
    uTime: { value: 0 },
    uNoiseScale: { value: 1.4 },
    uNoiseSpeed: { value: 0.28 },
    uDisplacement: { value: 0.32 },
    uPulse: { value: 0.0 },
    // Warm palette matched to the corona — deep ember through amber up to
    // a hot spark white, so the plasma reads as a continuation of the
    // particle cloud's color story rather than a competing element.
    uColorEmber: { value: new THREE.Color('#1a0500') }, // deep red-black base
    uColorAmber: { value: new THREE.Color('#ff5e10') }, // orange body
    uColorHot:   { value: new THREE.Color('#ffb050') }, // bright amber peaks
    uColorSpark: { value: new THREE.Color('#fff4cc') }, // warm white filaments
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
      varying vec3 vSurfaceDir;
      varying float vDisplacement;
      varying float vNoise;

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
        vec3 dir = normalize(p);
        float t = uTime * uNoiseSpeed;
        float n = fbm(p * uNoiseScale + vec3(0.0, t, 0.0));
        float pulse = (0.5 + 0.5 * sin(uTime * 0.8)) * 0.15 + uPulse;
        float disp = n * uDisplacement + pulse * 0.05;

        vec3 displaced = p + normal * disp;

        vDisplacement = disp;
        vNoise = n;
        // Pass the undisplaced unit direction so the fragment shader can
        // sample stable noise patterns over the rotating surface.
        vSurfaceDir = dir;
        vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
        vViewPosition = -mvPosition.xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      ${simplex3d}
      uniform float uTime;
      uniform vec3 uColorEmber;
      uniform vec3 uColorAmber;
      uniform vec3 uColorHot;
      uniform vec3 uColorSpark;

      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vSurfaceDir;
      varying float vDisplacement;
      varying float vNoise;

      float fbm4(vec3 p) {
        float n = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          n += a * snoise(p);
          p *= 2.05;
          a *= 0.5;
        }
        return n;
      }

      void main() {
        vec3 viewDir = normalize(vViewPosition);
        float ndv = max(dot(vNormal, viewDir), 0.0);
        float fresnel = pow(1.0 - ndv, 2.0);

        // (1) Temperature: rises with the noise displacement so peaks are
        // hotter than troughs.
        float temp = smoothstep(-0.18, 0.20, vDisplacement);

        // (3) Internal veins — low-frequency noise on the surface direction
        // animated independently from the main displacement, gives the
        // sense of subsurface energy channels flickering under the skin.
        float t2 = uTime * 0.55;
        float vein = fbm4(vSurfaceDir * 5.5 + vec3(0.0, t2, 0.0));
        float veins = pow(max(vein * 1.4, 0.0), 3.0);

        // (4) Mid-frequency surface ripple — soft warm shimmer over the
        // plasma body, the slow fluid layer.
        float rippleN = fbm4(vSurfaceDir * 9.0 + vec3(t2 * 1.6, 0.0, 7.3));
        float ripple = pow(max(rippleN * 1.3, 0.0), 3.0);

        // (5) High-frequency electric crackle — sharp threshold gives
        // brief brilliant filaments that flash across the surface,
        // riding on top of the smoother ripple layer.
        float crackleN = fbm4(vSurfaceDir * 18.0 + vec3(t2 * 3.5, 11.2, 0.0));
        float crackle = pow(max(crackleN * 1.6, 0.0), 6.0);

        // Color buildup: ember base at troughs -> amber at the body ->
        // hot rim at fresnel grazing -> spark filaments on top of that.
        vec3 col = mix(uColorEmber, uColorAmber, temp);
        col = mix(col, uColorHot, fresnel * 0.85);

        // Hot bias on the bulge centers (high temp + low fresnel) so the
        // peaks glow from within rather than only at their silhouette.
        col += uColorHot * temp * (1.0 - fresnel) * 0.45;

        // Veins paint warm light onto the surface, brightest where they
        // line up with the rim — like seeing through to deeper channels.
        col += uColorSpark * veins * (0.55 + fresnel * 0.7);

        // Ripples add a soft warm shimmer over the body.
        col += uColorSpark * ripple * 0.9;

        // Crackle flashes white-hot regardless of fresnel — the fastest
        // and most intermittent of the layers.
        col += uColorSpark * crackle * 1.5;

        // (6) Slow whole-body pulse keyed to the noise so brighter regions
        // also breathe more — never feels static.
        float pulse = 0.85 + 0.15 * sin(uTime * 1.2 + vNoise * 4.0);
        col *= pulse;

        // Alpha is the sum of fresnel rim, vein contribution, and crackle
        // flashes — the silhouette and bright filaments dominate, the dim
        // body stays mostly transparent so the corona shows through.
        float alpha = clamp(
          0.16
          + fresnel * 0.75
          + veins * 0.30
          + ripple * 0.25
          + crackle * 0.55,
          0.0,
          1.0
        );

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
