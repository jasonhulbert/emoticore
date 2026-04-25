import * as THREE from 'three';
import { simplex3d } from './shaders/noise.glsl.js';

// Electrical "synapse" arcs that briefly bridge regions of the corona —
// the visible analogue of dielectric breakdown in the ionized envelope
// around the orb.
//
// Spawn model (a discharge is a Poisson event):
//   The corona behaves like a weakly ionized gas. Random local charge
//   fluctuations occasionally exceed the breakdown threshold, producing a
//   streamer between two nearby regions. Arrivals are Poisson because
//   events are memoryless. The instantaneous rate is multiplied by a
//   slow log-normal envelope so high-burst moods alternate quiet
//   stretches with clusters; low-burst moods fire metronomically.
//
// Render model — two passes that share spawn data:
//   1. LineSegments core: noise-jagged great-circle path drawn as 16
//      hardware line segments. WebGL clamps line width to 1px on most
//      GPUs, but a 1px additive line is exactly the right thing for the
//      sharp electrical core — the streamer's actual ionization channel
//      is much thinner than its glow.
//   2. Points glow: 8 sparse, large, very soft additive sprites along
//      the same arc. They never read as discrete dots — instead they
//      additively blend into a soft bloom that tracks each line, the
//      visible analogue of the ionization heat dispersing into the
//      surrounding plasma.
//
//   Both layers use identical envelope/taper math and share per-arc
//   metadata via parallel attribute buffers updated together on spawn.
const POOL = 32;
const SEGMENTS = 16;
const GLOW_PER_ARC = 8;

export function createSynapses({ surfaceRadius = 2.05 } = {}) {
  // ── Per-arc spawn state — single source of truth for both passes ──
  const slots = new Array(POOL).fill(null).map(() => ({ deathTime: -1 }));

  // ── Shared shader fragments (slerp + jag + envelope) ──
  // The line and glow vertex shaders compute the same world position;
  // only the size/alpha behavior differs. Inlined into both shaders.
  const sharedVertexCommon = /* glsl */ `
    ${simplex3d}
    uniform float uTime;
    uniform float uRadius;
    uniform float uBend;

    attribute vec3 aStart;
    attribute vec3 aEnd;
    attribute float aT;
    attribute float aBirth;
    attribute float aDuration;
    attribute float aSeed;

    varying float vLife;
    varying float vT;

    bool computePos(out vec3 outPos) {
      float age = uTime - aBirth;
      if (age < 0.0 || age > aDuration || aDuration <= 0.0) {
        vLife = 0.0;
        vT = 0.0;
        return false;
      }
      // RC-discharge envelope: sub-frame rise, exponential decay.
      float k = age / aDuration;
      vLife = (1.0 - exp(-k * 25.0)) * exp(-k * 3.5) * 1.7;
      vT = aT;

      vec3 a = normalize(aStart);
      vec3 b = normalize(aEnd);
      float cosAng = clamp(dot(a, b), -0.999, 0.999);
      float ang = acos(cosAng);
      float sinAng = max(sin(ang), 1e-3);
      vec3 dir = (sin((1.0 - aT) * ang) * a + sin(aT * ang) * b) / sinAng;
      dir = normalize(dir);

      vec3 ref = abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 nA = normalize(cross(dir, ref));
      vec3 nB = cross(dir, nA);

      float taper = sin(aT * 3.14159265);
      float n1 = snoise(vec3(aT * 14.0, aSeed,        0.0));
      float n2 = snoise(vec3(aSeed * 1.7, aT * 14.0, 5.3));
      vec3 jag = (n1 * nA + n2 * nB) * uBend * taper;

      outPos = dir * uRadius + jag;
      return true;
    }
  `;

  // ── Build a layer (line or glow) ──
  // Each layer has its own buffer geometry and material but the spawn
  // function below writes the same per-arc metadata into both.
  function buildLayer(vertsPerArc) {
    const totalVerts = POOL * vertsPerArc;
    const aT = new Float32Array(totalVerts);
    const aStart = new Float32Array(totalVerts * 3);
    const aEnd = new Float32Array(totalVerts * 3);
    const aBirth = new Float32Array(totalVerts);
    const aDuration = new Float32Array(totalVerts);
    const aSeed = new Float32Array(totalVerts);
    for (let i = 0; i < totalVerts; i++) aBirth[i] = -1000;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(totalVerts * 3), 3));
    geom.setAttribute('aT', new THREE.BufferAttribute(aT, 1));

    const startAttr = new THREE.BufferAttribute(aStart, 3);
    const endAttr = new THREE.BufferAttribute(aEnd, 3);
    const birthAttr = new THREE.BufferAttribute(aBirth, 1);
    const durAttr = new THREE.BufferAttribute(aDuration, 1);
    const seedAttr = new THREE.BufferAttribute(aSeed, 1);
    for (const a of [startAttr, endAttr, birthAttr, durAttr, seedAttr]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geom.setAttribute('aStart',    startAttr);
    geom.setAttribute('aEnd',      endAttr);
    geom.setAttribute('aBirth',    birthAttr);
    geom.setAttribute('aDuration', durAttr);
    geom.setAttribute('aSeed',     seedAttr);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), surfaceRadius + 1.0);

    return {
      geom,
      buffers: { aT, aStart, aEnd, aBirth, aDuration, aSeed },
      attrs: { startAttr, endAttr, birthAttr, durAttr, seedAttr },
    };
  }

  // ── Line layer — 16 segments × 2 verts per arc ──
  const lineLayer = buildLayer(SEGMENTS * 2);
  for (let s = 0; s < POOL; s++) {
    for (let seg = 0; seg < SEGMENTS; seg++) {
      const i = s * SEGMENTS * 2 + seg * 2;
      lineLayer.buffers.aT[i]     = seg / SEGMENTS;
      lineLayer.buffers.aT[i + 1] = (seg + 1) / SEGMENTS;
    }
  }

  // ── Glow layer — 8 sparse points per arc, distributed to favor the
  // middle of the arc where the bend amplitude is highest. ──
  const glowLayer = buildLayer(GLOW_PER_ARC);
  for (let s = 0; s < POOL; s++) {
    for (let i = 0; i < GLOW_PER_ARC; i++) {
      glowLayer.buffers.aT[s * GLOW_PER_ARC + i] = (i + 0.5) / GLOW_PER_ARC;
    }
  }

  // Shared uniforms — line and glow read from the same color/radius
  // values so a mood swap retints both atomically.
  const uniforms = {
    uTime:       { value: 0 },
    uRadius:     { value: surfaceRadius },
    uColor:      { value: new THREE.Color('#dceeff') },
    uIntensity:  { value: 2.4 },
    uBend:       { value: 0.14 },
    uGlowSize:   { value: 11.0 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
  };

  const lineMaterial = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    // Always-on-top: the plasma's flare crests would otherwise occlude
    // arcs that pass behind them. Discharges are brief flickers, so
    // depth-correct compositing isn't visually important.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${sharedVertexCommon}
      void main() {
        vec3 pos;
        if (!computePos(pos)) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying float vLife;
      varying float vT;
      void main() {
        float taper = sin(vT * 3.14159265);
        float a = vLife * taper * uIntensity;
        if (a < 0.001) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  const glowMaterial = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${sharedVertexCommon}
      uniform float uGlowSize;
      uniform float uPixelRatio;
      void main() {
        vec3 pos;
        if (!computePos(pos)) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          return;
        }
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        // Soft halo only — large but dim; the line above provides the
        // hot core. Size tapers along the arc and fades with the
        // discharge envelope so the glow blooms with the line, not
        // independently.
        float taper = sin(vT * 3.14159265);
        float sizeT = uGlowSize * (0.4 + 0.6 * taper) * vLife;
        gl_PointSize = clamp(sizeT * uPixelRatio * (60.0 / -mv.z), 1.0, 28.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying float vLife;
      varying float vT;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        // Pure halo, no hard core — bloom only.
        float halo = exp(-d * d * 5.5);
        float taper = sin(vT * 3.14159265);
        // 0.22× the line intensity: glow is a faint atmospheric bloom
        // beneath the line, never competing with the bright core.
        float a = vLife * halo * taper * uIntensity * 0.22;
        if (a < 0.001) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  const lineMesh = new THREE.LineSegments(lineLayer.geom, lineMaterial);
  lineMesh.frustumCulled = false;
  lineMesh.renderOrder = 4;

  const glowMesh = new THREE.Points(glowLayer.geom, glowMaterial);
  glowMesh.frustumCulled = false;
  glowMesh.renderOrder = 3; // glow renders behind the line

  const group = new THREE.Group();
  group.add(glowMesh);
  group.add(lineMesh);

  function writeArcInto(layer, vertsPerArc, idx, ax, ay, az, bx, by, bz, time, duration, seed) {
    const { aStart, aEnd, aBirth, aDuration, aSeed } = layer.buffers;
    const base = idx * vertsPerArc;
    for (let v = 0; v < vertsPerArc; v++) {
      const i3 = (base + v) * 3;
      aStart[i3]     = ax; aStart[i3 + 1] = ay; aStart[i3 + 2] = az;
      aEnd[i3]       = bx; aEnd[i3 + 1]   = by; aEnd[i3 + 2]   = bz;
      aBirth[base + v]    = time;
      aDuration[base + v] = duration;
      aSeed[base + v]     = seed;
    }
    layer.attrs.startAttr.needsUpdate = true;
    layer.attrs.endAttr.needsUpdate = true;
    layer.attrs.birthAttr.needsUpdate = true;
    layer.attrs.durAttr.needsUpdate = true;
    layer.attrs.seedAttr.needsUpdate = true;
  }

  function spawn(time) {
    // Find an inactive slot; if none, replace the one closest to death.
    let idx = -1;
    let oldestDeath = Infinity;
    for (let i = 0; i < POOL; i++) {
      if (slots[i].deathTime <= time) { idx = i; break; }
      if (slots[i].deathTime < oldestDeath) {
        oldestDeath = slots[i].deathTime;
        idx = i;
      }
    }
    if (idx < 0) return;

    // Endpoint A: uniform on the sphere.
    const u = 2 * Math.random() - 1;
    const phi = 2 * Math.PI * Math.random();
    const r = Math.sqrt(1 - u * u);
    const ax = r * Math.cos(phi);
    const ay = r * Math.sin(phi);
    const az = u;

    // Orthonormal basis perpendicular to A.
    const refX = Math.abs(ay) < 0.9 ? 0 : 1;
    const refY = Math.abs(ay) < 0.9 ? 1 : 0;
    let n1x = ay * 0  - az * refY;
    let n1y = az * refX - ax * 0;
    let n1z = ax * refY - ay * refX;
    const nl = Math.hypot(n1x, n1y, n1z) || 1;
    n1x /= nl; n1y /= nl; n1z /= nl;
    const n2x = ay * n1z - az * n1y;
    const n2y = az * n1x - ax * n1z;
    const n2z = ax * n1y - ay * n1x;

    // Angular separation: bias toward small angles. Local discharges
    // dominate; the long tail (~50°) is rare but visually important.
    const bias = Math.pow(Math.random(), 1.6);
    const angle = (8 + bias * 50) * Math.PI / 180;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const phi2 = 2 * Math.PI * Math.random();
    const cp = Math.cos(phi2);
    const sp = Math.sin(phi2);
    const ox = cp * n1x + sp * n2x;
    const oy = cp * n1y + sp * n2y;
    const oz = cp * n1z + sp * n2z;

    const bx = ax * ca + ox * sa;
    const by = ay * ca + oy * sa;
    const bz = az * ca + oz * sa;

    const duration = 0.10 + Math.random() * 0.18;
    const seed = Math.random() * 1000;

    writeArcInto(lineLayer, SEGMENTS * 2, idx, ax, ay, az, bx, by, bz, time, duration, seed);
    writeArcInto(glowLayer, GLOW_PER_ARC, idx, ax, ay, az, bx, by, bz, time, duration, seed);

    slots[idx].deathTime = time + duration;
  }

  let meanRate = 12.0;
  let burst = 0.20;
  function setEnergy(rate, b) {
    meanRate = rate;
    burst = b;
  }

  function modulation(time) {
    if (burst <= 1e-3) return 1.0;
    const env =
      Math.sin(time * 1.10) * 0.45 +
      Math.sin(time * 0.43 + 2.1) * 0.35 +
      Math.sin(time * 0.13 + 4.7) * 0.20;
    return Math.exp(burst * env * 1.7);
  }

  function update(time, dt) {
    uniforms.uTime.value = time;
    const lambda = meanRate * modulation(time) * dt;
    let n = 0;
    let p = Math.exp(-lambda);
    let f = p;
    const r = Math.random();
    while (r > f && n < 8) {
      n++;
      p *= lambda / n;
      f += p;
    }
    for (let i = 0; i < n; i++) spawn(time);
  }

  return {
    mesh: group,
    uniforms,
    update,
    setEnergy,
  };
}
