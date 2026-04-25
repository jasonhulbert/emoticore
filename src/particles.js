import * as THREE from 'three';
import { simplex3d } from './shaders/noise.glsl.js';

// The energy cloud that swirls around the onyx void. Particles are placed in
// a thick shell whose inner edge sits just outside the stone; their motion is
// driven by curl noise of an unseen field at the center, so the cloud reads
// as energy responding to "something" hidden inside the stone. Heavily
// additive — the falloffs are tuned to bloom into a luminous corona at small
// scales and reveal swirling chaos when zoomed in.
export function createParticles({
  count = 5500,
  innerRadius = 0.58,
  outerRadius = 1.25,
} = {}) {
  const geometry = new THREE.BufferGeometry();

  const seeds = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Bias the radial distribution toward the inner shell so the corona
    // is dense near the stone and feathers out into the dark.
    const u = Math.pow(Math.random(), 1.6);
    const r = innerRadius + u * (outerRadius - innerRadius);
    const theta = Math.acos(2 * Math.random() - 1);
    const phi = 2 * Math.PI * Math.random();
    seeds[i * 3 + 0] = r * Math.sin(theta) * Math.cos(phi);
    seeds[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
    seeds[i * 3 + 2] = r * Math.cos(theta);
    phases[i] = Math.random() * Math.PI * 2.0;
    // 12% sparks (bright, motion-blurred streaks) on a bed of warm dust.
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
    uNoiseScale: { value: 1.6 },
    uNoiseSpeed: { value: 0.35 },
    uFlowStrength: { value: 0.32 },
    uDisplacement: { value: 0.22 },
    uInner: { value: innerRadius },
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
      uniform float uNoiseScale;
      uniform float uNoiseSpeed;
      uniform float uFlowStrength;
      uniform float uDisplacement;
      uniform float uInner;
      uniform float uOuter;
      uniform float uPixelRatio;

      attribute vec3 aSeed;
      attribute float aPhase;
      attribute float aSize;

      varying float vSpeed;
      varying float vRadial;
      varying float vSpark;

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

      void main() {
        float t = uTime * uNoiseSpeed;

        // Slow orbital drift unique to each particle keeps the cloud from
        // collapsing into static streamlines.
        float orbit = uTime * 0.12 + aPhase;
        mat3 rot = mat3(
          cos(orbit), 0.0, sin(orbit),
          0.0,        1.0, 0.0,
          -sin(orbit), 0.0, cos(orbit)
        );
        vec3 seed = rot * aSeed;

        // Curl noise of the hidden energy field — particles stream around
        // invisible bulges as if reacting to something inside the stone.
        vec3 flow = snoiseCurl(seed * uNoiseScale + vec3(0.0, t, 0.0));
        vec3 pos = seed + flow * uFlowStrength;

        vec3 dir = normalize(seed);
        float field = fbm(dir * uNoiseScale + vec3(0.0, t, 0.0));
        float bulge = field * uDisplacement;
        pos += dir * bulge * 0.9;

        // Never let particles intrude into the stone.
        float len = length(pos);
        float innerBound = uInner + max(bulge, 0.0);
        if (len < innerBound) {
          pos = normalize(pos) * innerBound;
        } else if (len > uOuter) {
          pos = normalize(pos) * uOuter;
        }

        vSpeed = length(flow);
        vRadial = (length(pos) - uInner) / (uOuter - uInner);
        vSpark = step(1.8, aSize);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        float size = aSize * (1.0 + vSpeed * 0.6);
        // Cap kept generous so the bloom can build up but no single point
        // dominates the screen on high-DPI displays.
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

      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;

        // Soft dust + a punchy halo for sparks. Halo's wide shoulders are
        // what creates the bloom corona when zoomed out.
        float dust = exp(-d * d * 12.0);
        float halo = smoothstep(0.5, 0.05, d);
        float shape = mix(dust * 0.7 + halo * 0.25, dust * 0.4 + pow(halo, 2.5), vSpark);

        // Cool deep in the cloud, warm on the fast-moving streaks. Sparks
        // bias toward a warm-white core so the corona feels alive, not icy.
        vec3 col = mix(uColorCool, uColorWarm, clamp(vSpeed * 1.2, 0.0, 1.0));
        col = mix(col, uSpark, vSpark * 0.7);

        // Soft fade at the very outer edge so the corona feathers into black
        // instead of cutting off.
        float edgeFade = 1.0 - smoothstep(0.7, 1.0, vRadial);
        float alpha = shape * (0.35 + 0.55 * edgeFade);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  // Render after the opaque onyx so depthTest hides particles behind the
  // stone while ones in front bloom additively over the dark silhouette.
  points.renderOrder = 1;

  return {
    points,
    uniforms,
    update(elapsed) {
      uniforms.uTime.value = elapsed;
    },
  };
}
