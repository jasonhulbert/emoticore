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
  const births = new Float32Array(count);
  const lifeRates = new Float32Array(count);
  const brightnesses = new Float32Array(count);

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
    // Smaller particles overall — sparks 1.0-1.8 (was 2.2-4.0), dust
    // 0.3-0.8 (was 0.6-1.6). Reads as fine glittering dust instead of
    // fat cartoonish blobs.
    sizes[i] = Math.random() < 0.10
      ? 1.0 + Math.random() * 0.8
      : 0.3 + Math.random() * 0.5;
    rates[i] = (Math.random() - 0.5) * 0.18;
    // Lifecycle: each particle has a phase offset and a life rate. The
    // shader fades brightness in and out across the cycle, so at any
    // moment some particles are fading in, some are bright, some are
    // fading out — the cloud reads as continuously regenerating instead
    // of a static set of dots.
    births[i] = Math.random();
    // lifeRate is cycles per second. 0.04-0.14 -> period 7-25 seconds.
    lifeRates[i] = 0.04 + Math.random() * 0.10;
    // Subtle base-brightness variation per particle (very slight, so the
    // cloud doesn't look like a bimodal light/dark pattern).
    brightnesses[i] = 0.7 + Math.random() * 0.3;
  }

  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aRate', new THREE.BufferAttribute(rates, 1));
  geometry.setAttribute('aBirth', new THREE.BufferAttribute(births, 1));
  geometry.setAttribute('aLifeRate', new THREE.BufferAttribute(lifeRates, 1));
  geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightnesses, 1));
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
      attribute float aBirth;
      attribute float aLifeRate;
      attribute float aBrightness;

      varying float vSpeed;
      varying float vRadial;
      varying float vSpark;
      varying float vInfluence;
      varying float vDistance;
      varying float vLife;
      varying float vBrightness;

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

        // Lifecycle. life01 runs 0->1 each cycle. cycleIdx is the discrete
        // cycle number, used to perturb the seed position so each cycle the
        // particle "respawns" at a slightly different point — what fades in
        // is not exactly what faded out, so the cloud reads as continuously
        // regenerating dust rather than the same pattern blinking in place.
        float lifeT  = uTime * aLifeRate + aBirth;
        float life01 = fract(lifeT);
        float cycleIdx = floor(lifeT);

        // Smooth bell-shaped fade: 0 at boundaries, 1 in the middle of life.
        // Sharp on the way out, slower on the way in, like a real ember.
        float fadeIn  = smoothstep(0.0, 0.25, life01);
        float fadeOut = 1.0 - smoothstep(0.55, 1.0, life01);
        vLife = fadeIn * fadeOut;
        vBrightness = aBrightness;

        // Per-cycle seed perturbation. Sample noise with cycleIdx as one
        // axis so the offset is constant within a cycle but jumps to a new
        // value each respawn. The jump happens while vLife is ~0 so it's
        // invisible — the particle just fades in at a fresh position.
        vec3 cycleOffset = vec3(
          snoise(vec3(cycleIdx * 7.31, aPhase * 1.7, 0.0)),
          snoise(vec3(0.0, cycleIdx * 11.7, aPhase * 0.9)),
          snoise(vec3(aPhase * 2.3, 0.0, cycleIdx * 5.9))
        ) * 0.18;

        // Per-particle orbital drift around an axis derived from the phase.
        // Different rates and axes per particle prevent the cloud from
        // rotating as a coherent sphere.
        vec3 axis = normalize(vec3(
          sin(aPhase * 1.3),
          cos(aPhase * 0.7) + 0.5,
          sin(aPhase * 1.9)
        ));
        float angle = uTime * aRate + aPhase;
        vec3 seed = rotateAxis(aSeed, axis, angle) + cycleOffset;
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
        // Smooth sparkness across the dust/spark gap (dust ≤0.8, sparks ≥1.0)
        // instead of a hard step, for a gentler size→shape mapping.
        vSpark = smoothstep(0.85, 1.4, aSize);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float size = aSize * (1.0 + vSpeed * 0.4);
        // Smaller particles overall — max 22px, so they read as fine
        // glittering dust rather than fat cartoon blobs.
        gl_PointSize = clamp(size * uPixelRatio * (80.0 / -mvPosition.z), 1.0, 22.0);
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
      varying float vLife;
      varying float vBrightness;

      // Each particle is a tight gaussian with a soft halo. No star spikes —
      // those read as cartoonish lens-flare stickers at this scale. Just a
      // bright lit pinpoint with a faint surrounding glow.
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;

        float core = exp(-d * d * 70.0);
        float halo = exp(-d * d * 7.0);

        float dustShape  = exp(-d * d * 14.0) * 0.65 + halo * 0.08;
        float sparkShape = core * 1.00 + halo * 0.20;
        float intensity  = mix(dustShape, sparkShape, vSpark);

        // Particles riding the plasma surface, or moving fast in ambient
        // curl, glow warmer; sparks pull toward white.
        float warmth = clamp(vSpeed * 0.7 + vInfluence * 0.6, 0.0, 1.0);
        vec3 col = mix(uColorCool, uColorWarm, warmth);
        col = mix(col, uSpark, vSpark * 0.7);

        // Subtle chromatic edge: a touch of cool blue on the outer halo
        // mimics the chromatic aberration of a real lit point through a
        // lens. Adds a "lit" feel rather than flat additive blur.
        float chroma = max(halo - core, 0.0);
        col = mix(col, col * vec3(0.7, 0.88, 1.10), chroma * 0.25);

        // Outer envelope fade keeps particles feathering into the dark
        // instead of pinning to a sphere boundary.
        float edgeFade = 1.0 - smoothstep(0.85, 1.25, vRadial);

        // vLife (lifecycle bell curve) and vBrightness (per-particle base
        // brightness, ~0.7-1.0) combine for the final attenuation. With
        // 1800 particles all on independent cycles, at any moment some are
        // bright, some are fading, some are dark — the cloud reads as
        // continuously regenerating instead of a static pattern.
        float alpha = intensity * (0.40 + 0.50 * edgeFade) * vLife * vBrightness;

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
