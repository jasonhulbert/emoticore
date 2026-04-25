import * as THREE from 'three';
import { simplex3d } from './shaders/noise.glsl.js';

// Particle cloud that lives in the shell between the core blob and the orb wall.
// Each particle is placed at a stable random seed; the vertex shader advects it
// by curl noise sharing the SAME uTime/uNoiseScale as the core blob so the two
// fields visibly interact — particles swirl with the morphing surface rather
// than floating independently.
export function createParticles({
  count = 4000,
  innerRadius = 0.62,
  outerRadius = 0.95,
} = {}) {
  const geometry = new THREE.BufferGeometry();

  const seeds = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Uniform distribution in the shell between inner and outer radius.
    const u = Math.random();
    const r = Math.cbrt(
      innerRadius ** 3 + u * (outerRadius ** 3 - innerRadius ** 3),
    );
    const theta = Math.acos(2 * Math.random() - 1);
    const phi = 2 * Math.PI * Math.random();
    seeds[i * 3 + 0] = r * Math.sin(theta) * Math.cos(phi);
    seeds[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
    seeds[i * 3 + 2] = r * Math.cos(theta);
    phases[i] = Math.random() * Math.PI * 2.0;
    // Mix of small dust and rarer bright sparks.
    sizes[i] = Math.random() < 0.08 ? 2.4 + Math.random() * 2.0 : 0.6 + Math.random() * 1.1;
  }

  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  // position attribute is required by three.js, but we compute the real
  // position in the shader from aSeed. Keep it equal to aSeed so frustum
  // culling has something sensible to work with.
  geometry.setAttribute('position', new THREE.BufferAttribute(seeds.slice(), 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius + 0.2);

  const uniforms = {
    uTime: { value: 0 },
    uNoiseScale: { value: 1.6 }, // match core
    uNoiseSpeed: { value: 0.35 }, // match core
    uFlowStrength: { value: 0.25 },
    uDisplacement: { value: 0.22 }, // match core
    uInner: { value: innerRadius },
    uOuter: { value: outerRadius },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uColorCool: { value: new THREE.Color('#7fd8ff') },
    uColorWarm: { value: new THREE.Color('#ffb36c') },
    uSpark: { value: new THREE.Color('#ffffff') },
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

        // Curl-noise flow: the derivative of the scalar field that shapes the
        // core blob, so particles naturally stream around its bulges.
        vec3 flow = snoiseCurl(seed * uNoiseScale + vec3(0.0, t, 0.0));
        vec3 pos = seed + flow * uFlowStrength;

        // Radial push: when the core bulges outward in a direction, particles
        // near that direction get nudged outward too.
        vec3 dir = normalize(seed);
        float coreField = fbm(dir * uNoiseScale + vec3(0.0, t, 0.0));
        float bulge = coreField * uDisplacement;
        pos += dir * bulge * 0.9;

        // Keep the cloud inside the shell. If the core bulge has eaten past
        // this particle, float it back out to the inner surface.
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
        gl_PointSize = size * uPixelRatio * (220.0 / -mvPosition.z);
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

        // Soft radial falloff; sparks get a tight hot core plus halo.
        float core = smoothstep(0.5, 0.0, d);
        float halo = smoothstep(0.5, 0.15, d);
        float shape = mix(core * 0.6 + halo * 0.4, core * 0.2 + pow(halo, 3.0), vSpark);

        vec3 col = mix(uColorCool, uColorWarm, clamp(vSpeed * 1.5, 0.0, 1.0));
        col = mix(col, uSpark, vSpark * 0.7);

        // Fade particles near the orb wall so they feel contained by frost.
        float edgeFade = 1.0 - smoothstep(0.7, 1.0, vRadial);
        float alpha = shape * (0.35 + 0.65 * edgeFade);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 0;

  return {
    points,
    uniforms,
    update(elapsed) {
      uniforms.uTime.value = elapsed;
    },
  };
}
