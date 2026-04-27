import * as THREE from 'three';
import { simplex3d } from './shaders/noise.glsl.js';

// Particle emission model.
//
// Each particle is born at the plasma surface, drifts radially outward
// through the corona over its lifetime, and dies at the outer edge —
// the plasma is the visible source.
//
// Per cycle:
//   life01 = 0.0  →  spawn on the plasma surface in direction `dir`
//   life01 = 1.0  →  near uTravel * (uSoftOuter - surface) past surface
//
// `dir` is derived from the particle's seed direction perturbed per cycle,
// so successive cycles emit from neighboring surface points (visibly
// different "respawn locations"). aRange varies how far the particle
// travels — some die near the plasma, others reach the outer fade.
//
// Tangential drift (curl noise on the local tangent plane) and ambient
// turbulence are layered on, growing with radial progress so the cloud
// looks more turbulent further from the surface where the medium is freer.
//
// All transitions happen while vLife ≈ 0 so the cycle reset is invisible.
export function createParticles({
  count = 2700,
  outerRadius = 2.40,
} = {}) {
  const geometry = new THREE.BufferGeometry();

  // Direction seeds — uniformly distributed on the unit sphere. The radial
  // magnitude is unused; only the direction matters.
  const seeds = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const births = new Float32Array(count);
  const lifeRates = new Float32Array(count);
  const brightnesses = new Float32Array(count);
  const ranges = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const theta = Math.acos(2 * Math.random() - 1);
    const phi = 2 * Math.PI * Math.random();
    seeds[i * 3 + 0] = Math.sin(theta) * Math.cos(phi);
    seeds[i * 3 + 1] = Math.sin(theta) * Math.sin(phi);
    seeds[i * 3 + 2] = Math.cos(theta);
    phases[i] = Math.random() * Math.PI * 2.0;
    // Tight uniform size band — no more "spark" outliers. The previous
    // 10% bright-spark population read as too chunky against the rest
    // of the cloud; a single small range gives a consistent dust look.
    // vSpark in the fragment shader stays at 0 across this range, so
    // the spark-tint code path no longer contributes.
    sizes[i] = 0.30 + Math.random() * 0.20;
    births[i] = Math.random();
    // lifeRate = cycles/sec. 0.06-0.16 -> period 6-16s. Faster than before
    // so visible turnover is shorter and emission feels active.
    lifeRates[i] = 0.06 + Math.random() * 0.10;
    brightnesses[i] = 0.7 + Math.random() * 0.3;
    // aRange: how far each particle travels from the plasma surface,
    // expressed as a fraction of (uSoftOuter - surface). Skewed so most
    // particles die mid-cloud, few reach the outer edge.
    ranges[i] = 0.45 + Math.pow(Math.random(), 1.4) * 0.55;
  }

  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aBirth', new THREE.BufferAttribute(births, 1));
  geometry.setAttribute('aLifeRate', new THREE.BufferAttribute(lifeRates, 1));
  geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightnesses, 1));
  geometry.setAttribute('aRange', new THREE.BufferAttribute(ranges, 1));
  // position required by three.js for frustum culling — give it the seed
  // direction scaled by something reasonable.
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds.slice(), 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius + 1.0);

  const uniforms = {
    uTime: { value: 0 },
    // Plasma envelope parameters (kept identical to core.js so the surface
    // particles spawn from is the surface they're rendered next to).
    uEnvBase: { value: 1.90 },
    uEnvDisp: { value: 0.30 },
    uNoiseScale: { value: 1.4 },
    // Accumulated noise time, set by main.js each frame using the same
    // integration as the plasma so the surface particles see is the
    // surface the plasma renders. Not derived from uTime * uNoiseSpeed
    // because that product jumps when the speed lerps during mood changes.
    uNoiseTime: { value: 0 },
    uNoiseSpeed: { value: 0.28 },
    // Tangential drift strength — curl noise sweeping particles sideways
    // as they travel outward. Grows with radial progress.
    uDrift: { value: 0.45 },
    uAmbient: { value: 0.20 },
    // Outer fade range. Particles past uSoftOuter rapidly fade to 0 by
    // uFadeRadius, so anything that overshoots dies cleanly.
    uSoftOuter: { value: outerRadius },
    uFadeRadius: { value: outerRadius + 0.2 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
    uColorCool: { value: new THREE.Color('#7fd8ff') },
    uColorWarm: { value: new THREE.Color('#ffb36c') },
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
      uniform float uNoiseTime;
      uniform float uDrift;
      uniform float uAmbient;
      uniform float uSoftOuter;
      uniform float uFadeRadius;
      uniform float uPixelRatio;

      attribute vec3 aSeed;
      attribute float aPhase;
      attribute float aSize;
      attribute float aBirth;
      attribute float aLifeRate;
      attribute float aBrightness;
      attribute float aRange;

      varying float vSpeed;
      varying float vRadial;
      varying float vLife;
      varying float vBrightness;
      varying float vProgress;

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
        // uNoiseTime is accumulated externally so mood-driven changes
        // to noise speed don't cause the surface field to jump.
        float t = uNoiseTime;

        // Lifecycle. life01 runs 0->1 each cycle. cycleIdx is the discrete
        // cycle number, used to perturb the spawn direction so each cycle
        // the particle emits from a slightly different surface point.
        float lifeT  = uTime * aLifeRate + aBirth;
        float life01 = fract(lifeT);
        float cycleIdx = floor(lifeT);

        // Bell-shaped fade. Sharper on the way in (fadeIn quick) so the
        // emission feels like a small flash leaving the plasma surface,
        // gentler on the way out so the trail disperses gradually.
        float fadeIn  = smoothstep(0.0, 0.15, life01);
        float fadeOut = 1.0 - smoothstep(0.55, 1.0, life01);
        vLife = fadeIn * fadeOut;
        vBrightness = aBrightness;
        vProgress = life01;

        // Spawn direction: aSeed direction perturbed per cycle. Different
        // cycle index -> different perturbation -> emission from neighboring
        // surface points. Magnitude 0.4 gives ~tens-of-degrees variation.
        vec3 cyclePerturb = vec3(
          snoise(vec3(cycleIdx * 7.31, aPhase * 1.7, 0.0)),
          snoise(vec3(0.0, cycleIdx * 11.7, aPhase * 0.9)),
          snoise(vec3(aPhase * 2.3, 0.0, cycleIdx * 5.9))
        ) * 0.4;
        vec3 dir = normalize(aSeed + cyclePerturb);

        // Plasma surface radius at this direction at this time. This is
        // where the particle is born (life01 = 0).
        float surf = surfaceAt(dir, t);

        // Travel destination: somewhere between the plasma surface and the
        // outer fade, varying per particle so some die near the plasma
        // and others reach the outer edge.
        float destination = mix(surf, uSoftOuter, aRange);

        // Radial progress: pow(life01, 0.7) starts faster, slows toward
        // the end — like a particle losing momentum to drag as it moves
        // through a viscous medium.
        float radialProgress = pow(life01, 0.7);
        float travelRadius = mix(surf, destination, radialProgress);

        // Tangential drift: curl noise on the unit sphere, projected onto
        // the local tangent plane so it doesn't fight the radial flow.
        // Strength grows with radial progress so the trail spreads as it
        // moves out (free turbulence dominates further from the source).
        vec3 tangent = snoiseCurl(dir * uNoiseScale * 1.6 + vec3(13.7, t * 1.1, aPhase));
        tangent -= dir * dot(tangent, dir);
        float driftScale = uDrift * (0.15 + 0.85 * radialProgress);

        // Ambient curl-noise turbulence in 3D world space, light scale
        // proportional to radial progress.
        vec3 ambient = snoiseCurl(dir * travelRadius * 0.6 + vec3(0.0, t, 0.0));
        float ambientScale = uAmbient * radialProgress;

        // Final position: emission direction × travel radius, plus drift
        // and turbulence offsets.
        vec3 pos = dir * travelRadius + tangent * driftScale + ambient * ambientScale;

        // Safety clamp: if a flare bulges the surface past the particle
        // (rare since the particle is always at radius >= surf at start
        // of life), push it back out so it never appears inside the plasma.
        float L = length(pos);
        float minRadius = surf + 0.02;
        if (L < minRadius) {
          pos = (pos / L) * minRadius;
          L = minRadius;
        }

        vSpeed = length(tangent) * driftScale + length(ambient) * ambientScale;
        // Outer boundary fade. Anything that overshoots uSoftOuter
        // (rare given aRange clamps destination, but possible from
        // tangential + ambient layers) fades to 0 by uFadeRadius.
        vRadial = 1.0 - smoothstep(uSoftOuter, uFadeRadius, L);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float size = aSize * (1.0 + vSpeed * 0.4);
        gl_PointSize = clamp(size * uPixelRatio * (40.0 / -mvPosition.z), 1.0, 14.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColorCool;
      uniform vec3 uColorWarm;

      varying float vSpeed;
      varying float vRadial;
      varying float vLife;
      varying float vBrightness;
      varying float vProgress;

      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;

        // Two gaussians: a tight inner blob and a wide halo. The
        // chroma calculation below uses both, and the dust shape
        // composites them.
        float core = exp(-d * d * 70.0);
        float halo = exp(-d * d * 2.5);
        float glowBoost = pow(max(vLife, 0.0), 0.6);
        float intensity = exp(-d * d * 14.0) * 0.55 + halo * (0.40 + 0.65 * glowBoost);

        // Color temperature shifts cool as particles travel outward —
        // start warm at the plasma surface, cool with distance. Fast
        // tangential drift keeps things warm.
        float warmth = clamp((1.0 - vProgress) * 0.7 + vSpeed * 0.6, 0.0, 1.0);
        vec3 col = mix(uColorCool, uColorWarm, warmth);

        // Subtle chromatic edge for a "lit" feel.
        float chroma = max(halo - core, 0.0);
        col = mix(col, col * vec3(0.7, 0.88, 1.10), chroma * 0.25);

        float alpha = intensity * 0.85 * vRadial * vLife * vBrightness;
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
