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
export function createCore({ radius = 1.90 } = {}) {
  // Detail 32 -> ~20k tris (was 64 / 80k). At the current displacement
  // (0.30) and noise scale (1.4), the per-vertex spacing on detail 32 is
  // still finer than the smallest fbm feature so faceting isn't visible,
  // and the vertex shader work is 4x cheaper.
  const geometry = new THREE.IcosahedronGeometry(radius, 32);

  const uniforms = {
    uTime: { value: 0 },
    uNoiseScale: { value: 1.4 },
    uNoiseSpeed: { value: 0.28 },
    uDisplacement: { value: 0.30 },
    // Accumulated noise + flare times. main.js advances these each frame
    // by dt * (current speed), so when the mood lerps the speed uniforms
    // the rate of advance changes smoothly without discontinuities in the
    // sample location. Using uTime * uNoiseSpeed directly would cause the
    // noise field to "jump" mid-transition because the product jumps when
    // the multiplier lerps.
    uNoiseTime: { value: 0 },
    uFlareTime: { value: 0 },
    // Solar flares: rare bright bulges that drift across the surface.
    // Same noise field is sampled by vertex (for displacement bulge) and
    // fragment (for visual brightness) so the visible flash and the
    // physical bulge always line up.
    uFlareSpeed: { value: 0.30 },
    uFlareScale: { value: 1.2 },
    uFlareDisp: { value: 0.12 },
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
      uniform float uNoiseTime;
      uniform float uDisplacement;
      uniform float uFlareTime;
      uniform float uFlareScale;
      uniform float uFlareDisp;
      uniform float uPulse;

      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vSurfaceDir;
      varying float vDisplacement;
      varying float vNoise;
      varying float vFlare;

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
        // uNoiseTime / uFlareTime are accumulated outside the shader so
        // mood transitions don't cause noise-field jumps.
        float t = uNoiseTime;
        float n = fbm(p * uNoiseScale + vec3(0.0, t, 0.0));
        float pulse = (0.5 + 0.5 * sin(uTime * 0.8)) * 0.15 + uPulse;

        // Solar flare field: low-frequency 3D noise drifting slowly through
        // a fourth axis (uFlareTime). High threshold so only the rare
        // crests of the noise field trigger flares — at any moment 0-3
        // active spots. smoothstep -> sharp edges, pow -> sharper still
        // so the active region is small + bright rather than diffuse.
        float flareN = fbm(p * uFlareScale + vec3(0.0, 0.0, uFlareTime));
        float flare = pow(smoothstep(0.55, 0.80, flareN), 2.0);

        float disp = n * uDisplacement + pulse * 0.05 + flare * uFlareDisp;

        vec3 displaced = p + normal * disp;

        vDisplacement = disp;
        vNoise = n;
        vFlare = flare;
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
      varying float vFlare;

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

      // 3-octave variant for the high-frequency layers (ripple + crackle).
      // The 4th octave there sits at sub-pixel frequencies anyway, so
      // dropping it is invisible but saves 25% of those samples.
      float fbm3(vec3 p) {
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
        vec3 viewDir = normalize(vViewPosition);
        float ndv = max(dot(vNormal, viewDir), 0.0);

        // Softer fresnel exponent (was 2.0). A wider falloff spreads the
        // rim glow across more of the surface so the silhouette transition
        // reads as a soft halo bleed rather than a sharp lit edge —
        // visually consistent with the gaussian halo on every particle.
        float fresnel = pow(1.0 - ndv, 1.1);

        // (1) Temperature: smoothed transition (was 0.20) gives a softer
        // peak-to-trough hand-off so bulges don't read as sharp ridges.
        float temp = smoothstep(-0.20, 0.28, vDisplacement);

        // (3) Internal veins — softened threshold (pow 3.0 -> 1.8) so the
        // veins read as wide diffuse glow channels instead of crisp lines.
        float t2 = uTime * 0.55;
        float vein = fbm4(vSurfaceDir * 5.5 + vec3(0.0, t2, 0.0));
        float veins = pow(max(vein * 1.4, 0.0), 1.8);

        // (4) Mid-frequency surface ripple — softened (pow 3.0 -> 1.8)
        // for a wider, fuzzier shimmer across the body.
        float rippleN = fbm3(vSurfaceDir * 9.0 + vec3(t2 * 1.6, 0.0, 7.3));
        float ripple = pow(max(rippleN * 1.3, 0.0), 1.8);

        // (5) High-frequency electric crackle — softened threshold
        // (pow 6.0 -> 3.5) so filaments are wider, fuzzier strokes
        // rather than razor-sharp electric arcs. They still flash but
        // they read as "diffuse light" not "lightning bolt".
        float crackleN = fbm3(vSurfaceDir * 18.0 + vec3(t2 * 3.5, 11.2, 0.0));
        float crackle = pow(max(crackleN * 1.6, 0.0), 3.5);

        // Color buildup: ember base at troughs -> amber at the body ->
        // hot rim at fresnel grazing -> spark filaments on top of that.
        vec3 col = mix(uColorEmber, uColorAmber, temp);
        col = mix(col, uColorHot, fresnel * 0.85);

        // Hot bias on the bulge centers (high temp + low fresnel) so the
        // peaks glow from within rather than only at their silhouette.
        col += uColorHot * temp * (1.0 - fresnel) * 0.55;

        // Body emission boost — bumped (0.18 -> 0.30) so the plasma
        // reads as a uniformly glowing volume that fades smoothly from
        // body to silhouette, rather than a textured surface with bright
        // rim accents.
        col += uColorAmber * 0.30;

        // Veins paint warm light onto the surface, brightest where they
        // line up with the rim.
        col += uColorSpark * veins * (0.55 + fresnel * 0.7);

        // Ripples add a soft warm shimmer over the body.
        col += uColorSpark * ripple * 0.85;

        // Crackle flashes — softened intensity to match the wider shape
        // (1.5 -> 1.0) so they don't blow out.
        col += uColorSpark * crackle * 1.0;

        // (7) Solar flares — bright violent peaks at the rare crests of
        // the flare noise field. The same vFlare value that drove the
        // vertex displacement bulge here drives a bright white-hot color
        // burst, so the visible flash and the physical bulge align.
        col += uColorSpark * vFlare * 3.0;
        col += uColorHot * vFlare * 1.5;

        // (6) Slow whole-body pulse keyed to the noise so brighter regions
        // also breathe more — never feels static.
        float pulse = 0.85 + 0.15 * sin(uTime * 1.2 + vNoise * 4.0);
        col *= pulse;

        // Alpha tuned for a fuzzy/diffuse look:
        //   - Higher base (0.22 -> 0.34) so the body opacity is more
        //     uniform across the surface, less peaky at detail spots.
        //   - Fresnel contribution slightly reduced (0.85 -> 0.65) since
        //     the wider fresnel exponent already spreads its influence
        //     across more pixels — keeps total rim brightness similar.
        //   - Crackle alpha lowered (0.55 -> 0.35) to match the softened
        //     intensity. Veins and ripple also tweaked for balance.
        float alpha = clamp(
          0.34
          + fresnel * 0.65
          + veins * 0.22
          + ripple * 0.20
          + crackle * 0.35
          + vFlare * 0.65,
          0.0,
          1.0
        );

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;

  // Glow billboard: a camera-facing quad with a soft radial gradient,
  // brightest at the center and fading to nothing at the edges. The
  // billboard is depth-shifted in view space so the opaque onyx in the
  // foreground occludes the portion of the gradient inside its silhouette,
  // leaving the visible glow as a soft outer aura around the plasma —
  // light bleeding from the center of the orb outward.
  //
  // Color shares the THREE.Color reference with uColorHot so MoodManager's
  // palette lerp auto-applies. uSize is updated externally each frame so
  // the glow scales with the plasma during mood-driven mesh scaling.
  const glowGeometry = new THREE.PlaneGeometry(1, 1);
  const glowUniforms = {
    uTime: uniforms.uTime,
    uColor: uniforms.uColorHot,
    uIntensity: { value: 1.30 },
    // Larger billboard (radius * 5 vs 3.4): with the smaller size, most
    // of the gradient's bright region was inside the plasma silhouette
    // where the plasma's own fresnel rim swallowed it. At 5x radius, the
    // gradient's softer outer falloff is still meaningfully bright at the
    // plasma silhouette and well past it.
    uSize: { value: radius * 5.0 },
    uDepthOffset: { value: -2.0 },
  };
  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: glowUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uDepthOffset;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // Standard billboard trick: take the model origin in view space,
        // then offset xy by the local quad position scaled by uSize. This
        // keeps the quad camera-facing regardless of mesh rotation.
        vec4 mvCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mvCenter.xy += position.xy * uSize;
        mvCenter.z += uDepthOffset;
        gl_Position = projectionMatrix * mvCenter;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        // Distance from quad center, normalized to [0..1] at the inscribed
        // circle's edge.
        vec2 c = vec2(0.5, 0.5);
        float d = length(vUv - c) * 2.0;
        if (d > 1.0) discard;
        // Smooth radial gradient: 1 at center, 0 at edge. Linear falloff
        // (pow 1.0) so the bleed extends as a wide soft aura that's still
        // clearly bright at the plasma silhouette and well past it,
        // instead of dropping to near-zero just outside the plasma.
        float glow = pow(max(1.0 - d, 0.0), 1.0);
        // Subtle breathing modulation matching the plasma's own pulse.
        float pulse = 0.88 + 0.12 * sin(uTime * 0.7);
        gl_FragColor = vec4(uColor * glow * pulse, glow * uIntensity);
      }
    `,
  });
  const glow = new THREE.Mesh(glowGeometry, glowMaterial);
  // Render before the plasma so the plasma additively layers on top.
  glow.renderOrder = 1;
  // The vertex shader handles its own positioning via modelViewMatrix —
  // the mesh's own scale/rotation is irrelevant.
  glow.frustumCulled = false;

  return {
    mesh,
    glow,
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
