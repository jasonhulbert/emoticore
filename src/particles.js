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
  count = 1800,
  // Inner radius is intentionally *inside* the plasma's max bulge so the
  // impenetrable-surface clamp fires every frame for some particles —
  // bulges literally sweep dust outward, the most visible coupling effect.
  innerRadius = 1.00,
  outerRadius = 1.90,
} = {}) {
  const geometry = new THREE.BufferGeometry();

  const seeds = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const rates = new Float32Array(count);

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
    // Per-particle orbit rate (and sign) so the cloud doesn't rotate as a
    // rigid sphere — different particles travel at different angular speeds
    // and some go counter-clockwise, breaking up the uniform pattern.
    rates[i] = (Math.random() - 0.5) * 0.18;
  }

  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aRate', new THREE.BufferAttribute(rates, 1));
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds.slice(), 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius + 1.5);

  const uniforms = {
    uTime: { value: 0 },
    // Plasma envelope parameters (kept identical to core.js so the surface
    // particles see is the surface they're rendered next to).
    uEnvBase: { value: 1.15 },
    uEnvDisp: { value: 0.32 },
    uNoiseScale: { value: 1.4 },
    uNoiseSpeed: { value: 0.28 },
    // Coupling strengths. Sweep is tangential drag (eddies dragging dust
    // along the surface). Push is radial impulse when the surface expands
    // outward at this point. Falloff controls how fast influence decays
    // with distance from the surface.
    uEnvSweep: { value: 1.10 },
    uEnvPush: { value: 1.40 },
    uEnvFalloff: { value: 2.2 },
    // Background curl-noise drift far from the surface.
    uAmbientFlow: { value: 0.28 },
    // Outer containment: a soft elastic clamp rather than a hard pin, so
    // particles can't fly off but the boundary doesn't read as a perfect
    // sphere either. uOuter is the hard cap (rare), uSoftOuter is where
    // exponential repulsion begins so most particles get gently pushed
    // back inward as they approach the cap.
    uSoftOuter: { value: outerRadius },
    uOuter: { value: outerRadius + 0.25 },
    uFadeRadius: { value: outerRadius + 0.1 },
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
      uniform float uSoftOuter;
      uniform float uOuter;
      uniform float uFadeRadius;
      uniform float uPixelRatio;

      attribute vec3 aSeed;
      attribute float aPhase;
      attribute float aSize;
      attribute float aRate;

      varying float vSpeed;
      varying float vRadial;
      varying float vSpark;
      varying float vInfluence;
      varying float vDistance;

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

      // Rotate a vector around a given unit axis by an angle (Rodrigues).
      vec3 rotateAxis(vec3 v, vec3 axis, float angle) {
        float c = cos(angle);
        float s = sin(angle);
        return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
      }

      void main() {
        float t = uTime * uNoiseSpeed;

        // Per-particle orbital drift around an axis derived from the phase.
        // Different rates and axes per particle prevent the cloud from
        // rotating as a coherent sphere.
        vec3 axis = normalize(vec3(
          sin(aPhase * 1.3),
          cos(aPhase * 0.7) + 0.5,
          sin(aPhase * 1.9)
        ));
        float angle = uTime * aRate + aPhase;
        vec3 seed = rotateAxis(aSeed, axis, angle);
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
        // with distance. Standard viscous-boundary-layer model.
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
        // surfVel (surface receding) doesn't pull particles back.
        pos += dir * max(surfVel, 0.0) * uEnvPush * influence;

        // Impenetrable plasma surface: any position inside surf + ε gets
        // pushed back out to the surface.
        float minRadius = surf + 0.04;
        float L = length(pos);
        if (L < minRadius) {
          pos = (pos / L) * minRadius;
          L = minRadius;
        }

        // Soft elastic outer containment. Past uSoftOuter, particles are
        // pulled radially inward by an exponentially growing force that
        // hits a hard wall at uOuter. Result: the bulk of the cloud sits
        // inside uSoftOuter without forming a sharp sphere boundary, but
        // nothing escapes to infinity.
        if (L > uSoftOuter) {
          float over = L - uSoftOuter;
          float pullback = 1.0 - exp(-over * 6.0);
          float maxOver = uOuter - uSoftOuter;
          float clampedOver = min(over * (1.0 - pullback), maxOver);
          pos = (pos / L) * (uSoftOuter + clampedOver);
        }

        // Final velocity proxy for shading — particles strongly coupled to
        // the surface, or moving fast in ambient curl, glow warmer.
        vSpeed = length(ambient) + length(surfTangent) * influence;
        vDistance = length(pos);
        vRadial = vDistance / uFadeRadius;
        vSpark = step(1.8, aSize);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float size = aSize * (1.0 + vSpeed * 0.5);
        // Sharper max cap: at the previous 90px the gaussian-shaded core
        // was spread across 50+ pixels and read as a soft cotton blob.
        // At 55px the core occupies a tight 15-20 pixels with the halo +
        // star-spike pattern around it, so the structure is visible.
        gl_PointSize = clamp(size * uPixelRatio * (140.0 / -mvPosition.z), 1.0, 55.0);
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
      varying float vDistance;

      // Particle shading is composed of three layers, the same approach
      // used on the plasma surface — each particle reads as a lit point
      // rather than a soft disc.
      //
      //   1. Hot core: tight gaussian (exp(-d² · 80)) — pixel-sharp at the
      //      center, ~20% of disc radius. Reads as the actual hot point.
      //   2. Halo: wider gaussian (exp(-d² · 6)) — soft outer glow that
      //      gives the particle a sense of light spilling into space.
      //   3. Star spikes: 4-pointed cross, only sparks. Classic lens-flare
      //      shape; cos(2θ) raised to a high power picks out sharp peaks
      //      along the diagonal cross axes, multiplied by a radial fade
      //      so the spikes are anchored at the core.
      //
      // Dust particles get a softer base + small core; spark particles get
      // the full bright core + halo + spikes treatment.
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;

        float core = exp(-d * d * 80.0);
        float halo = exp(-d * d * 6.0);

        float angle = atan(uv.y, uv.x);
        float crossPattern = pow(abs(cos(angle * 2.0)), 18.0);
        float spikes = crossPattern * smoothstep(0.5, 0.04, d);

        float dustShape  = exp(-d * d * 14.0) * 0.65 + halo * 0.10;
        float sparkShape = core * 1.00 + halo * 0.22 + spikes * 0.55;
        float intensity  = mix(dustShape, sparkShape, vSpark);

        // Particles riding the plasma surface, or moving fast in ambient
        // curl, glow warmer; sparks pull toward white.
        float warmth = clamp(vSpeed * 0.7 + vInfluence * 0.6, 0.0, 1.0);
        vec3 col = mix(uColorCool, uColorWarm, warmth);
        col = mix(col, uSpark, vSpark * 0.7);

        // Subtle chromatic edge: the outer halo carries a touch of cool
        // blue, mimicking the chromatic aberration of a real bright point
        // through a lens. Adds a "lit" feel rather than flat additive blur.
        float chroma = max(halo - core, 0.0);
        col = mix(col, col * vec3(0.65, 0.85, 1.15), chroma * 0.35);

        // Soft alpha fade based on absolute distance from origin — particles
        // that drift far from the cloud's natural envelope feather to black
        // instead of being clamped onto a hard sphere.
        float edgeFade = 1.0 - smoothstep(0.85, 1.25, vRadial);
        float alpha = intensity * (0.40 + 0.50 * edgeFade);

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
