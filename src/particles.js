import * as THREE from 'three';
import { simplex3d } from './shaders/noise.glsl.js';

// Energy corona surrounding the plasma envelope. The vertex shader treats
// the plasma surface as a moving fluid boundary and derives each particle's
// position from a velocity field that decays with distance from the surface:
//
//   v(p) = v_surface(dir(p))      where p is near the surface
//        ≈ v_ambient(p)           where p is far from the surface
//
// Components of the surface velocity:
//   - Tangential: curl-noise flow along the surface (turbulent eddies)
//   - Normal:     ∂surface/∂t (radial expansion when the plasma bulges out)
//
// Particles are also strictly impenetrable: any position inside the plasma
// surface gets clamped to surface + ε, like dust around a fluid boundary.
export function createParticles({
  count = 2750,
  innerRadius = 1.25,
  outerRadius = 1.95,
} = {}) {
  const geometry = new THREE.BufferGeometry();

  const seeds = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Bias inward so the corona is densest just outside the plasma surface,
    // where the coupling is strongest, and feathers out into the dark.
    const u = Math.pow(Math.random(), 1.6);
    const r = innerRadius + u * (outerRadius - innerRadius);
    const theta = Math.acos(2 * Math.random() - 1);
    const phi = 2 * Math.PI * Math.random();
    seeds[i * 3 + 0] = r * Math.sin(theta) * Math.cos(phi);
    seeds[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
    seeds[i * 3 + 2] = r * Math.cos(theta);
    phases[i] = Math.random() * Math.PI * 2.0;
    sizes[i] = Math.random() < 0.12
      ? 2.2 + Math.random() * 1.8
      : 0.6 + Math.random() * 1.0;
  }

  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds.slice(), 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius + 0.5);

  const uniforms = {
    uTime: { value: 0 },
    // Plasma envelope parameters (kept identical to core.js so the surface
    // particles see is the surface they're rendered next to).
    uEnvBase: { value: 0.93 },
    uEnvDisp: { value: 0.27 },
    uNoiseScale: { value: 1.6 },
    uNoiseSpeed: { value: 0.4 },
    // Coupling strengths. Sweep is tangential drag (eddies dragging dust
    // along the surface). Push is radial impulse when the surface expands
    // outward at this point. Falloff controls how fast influence decays
    // with distance from the surface.
    uEnvSweep: { value: 0.55 },
    uEnvPush: { value: 0.7 },
    uEnvFalloff: { value: 4.0 },
    // Background curl-noise drift far from the surface.
    uAmbientFlow: { value: 0.18 },
    uOuter: { value: outerRadius },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uColorCool: { value: new THREE.Color('#7fd8ff') },
    uColorWarm: { value: new THREE.Color('#ffb36c') },
    uSpark: { value: new THREE.Color('#fff4d8') },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${simplex3d}
      uniform float uTime;
      uniform float uEnvBase;
      uniform float uEnvDisp;
      uniform float uNoiseScale;
      uniform float uNoiseSpeed;
      uniform float uEnvSweep;
      uniform float uEnvPush;
      uniform float uEnvFalloff;
      uniform float uAmbientFlow;
      uniform float uOuter;
      uniform float uPixelRatio;

      attribute vec3 aSeed;
      attribute float aPhase;
      attribute float aSize;

      varying float vSpeed;
      varying float vRadial;
      varying float vSpark;
      varying float vInfluence;

      float fbm(vec3 p) {
        float n = 0.0;
        float a = 0.5;
        for (int i = 0; i < 3; i++) {
          n += a * snoise(p);
          p *= 2.02;
          a *= 0.5;
        }
        return n;
      }

      // Plasma surface radius in a given unit direction at time t.
      float surfaceAt(vec3 dir, float t) {
        return uEnvBase + fbm(dir * uNoiseScale + vec3(0.0, t, 0.0)) * uEnvDisp;
      }

      void main() {
        float t = uTime * uNoiseSpeed;

        // Slow orbital drift unique to each particle keeps streamlines from
        // collapsing into static patterns.
        float orbit = uTime * 0.10 + aPhase;
        mat3 rot = mat3(
          cos(orbit), 0.0, sin(orbit),
          0.0,        1.0, 0.0,
          -sin(orbit), 0.0, cos(orbit)
        );
        vec3 seed = rot * aSeed;
        vec3 dir = normalize(seed);

        // Ambient turbulence (curl noise = divergence-free turbulent flow,
        // a standard approximation for incompressible fluid motion).
        vec3 ambient = snoiseCurl(seed * uNoiseScale * 0.7 + vec3(0.0, t, 0.0));
        vec3 pos = seed + ambient * uAmbientFlow;

        // Plasma surface samples: at the particle's direction, now and a
        // small step into the future. The future sample lets us recover
        // ∂surface/∂t (radial surface velocity) without per-frame state.
        float surf  = surfaceAt(dir, t);
        float surfF = surfaceAt(dir, t + 0.08);
        float surfVel = (surfF - surf) / 0.08;

        // Influence factor: 1 right at the surface, decaying exponentially
        // with distance. This is the physical "viscous boundary layer"
        // approximation — the surface drags the surrounding medium with a
        // strength that falls off with distance.
        float distOut = max(length(pos) - surf, 0.0);
        float influence = exp(-distOut * uEnvFalloff);
        vInfluence = influence;

        // Tangential surface flow — sample curl noise at a slightly higher
        // frequency on the unit sphere so it reads as turbulence riding on
        // the surface rather than ambient drift.
        vec3 surfTangent = snoiseCurl(dir * uNoiseScale * 1.6 + vec3(13.7, t * 1.1, 5.2));
        // Project onto the local tangent plane so it doesn't push radially.
        surfTangent -= dir * dot(surfTangent, dir);
        pos += surfTangent * uEnvSweep * influence;

        // Radial push: when the surface is expanding outward at this point
        // (positive surfVel), particles get accelerated outward. Negative
        // surfVel (surface receding) doesn't pull particles back — gas
        // doesn't get sucked into a deflating boundary in this model.
        pos += dir * max(surfVel, 0.0) * uEnvPush * influence;

        // Impenetrable plasma surface: any position inside surf + ε gets
        // pushed back out to the surface. ε keeps the densest dust band
        // visibly separated from the plasma rim.
        float minRadius = surf + 0.04;
        float L = length(pos);
        if (L < minRadius) {
          pos = (pos / L) * minRadius;
        } else if (L > uOuter) {
          pos = (pos / L) * uOuter;
        }

        // Final velocity proxy for shading — particles strongly coupled to
        // the surface, or moving fast in ambient curl, glow warmer.
        vSpeed = length(ambient) + length(surfTangent) * influence;
        vRadial = (length(pos) - minRadius) / (uOuter - minRadius);
        vSpark = step(1.8, aSize);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float size = aSize * (1.0 + vSpeed * 0.5);
        gl_PointSize = clamp(size * uPixelRatio * (160.0 / -mvPosition.z), 1.0, 90.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColorCool;
      uniform vec3 uColorWarm;
      uniform vec3 uSpark;

      varying float vSpeed;
      varying float vRadial;
      varying float vSpark;
      varying float vInfluence;

      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;

        float dust = exp(-d * d * 12.0);
        float halo = smoothstep(0.5, 0.05, d);
        float shape = mix(dust * 0.7 + halo * 0.25, dust * 0.4 + pow(halo, 2.5), vSpark);

        // Particles riding the plasma surface lean warm / spark-colored —
        // they're hotter and faster than ambient dust drifting in the dark.
        float warmth = clamp(vSpeed * 1.0 + vInfluence * 0.6, 0.0, 1.0);
        vec3 col = mix(uColorCool, uColorWarm, warmth);
        col = mix(col, uSpark, vSpark * 0.7);

        // Soft outer fade so the corona feathers into black instead of
        // cutting off at the boundary sphere.
        float edgeFade = 1.0 - smoothstep(0.7, 1.0, vRadial);
        float alpha = shape * (0.35 + 0.55 * edgeFade);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2;

  return {
    points,
    uniforms,
    update(elapsed) {
      uniforms.uTime.value = elapsed;
    },
  };
}
