import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCore } from './core.js';
import { createOnyx } from './orb.js';
import { createParticles } from './particles.js';
import { createSynapses } from './synapses.js';
import { MoodManager } from './moods.js';
import { createTuningPanel } from './tune.js';

const container = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
// Pixel ratio cap 1.5 (was 2.0) — on a Retina display this cuts fragment
// shader work by ~44% with barely perceptible softening on this kind of
// organic content. Single biggest fragment-shader savings in the scene.
const PIXEL_RATIO_CAP = 1.5;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  40,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
// Initial camera distance: pull back enough to fit the orb's outer
// corona horizontally on narrow viewports. Wide desktops use the
// default 6.0; portrait phones (aspect ~0.5) end up around z ~ 12 so
// the whole sphere is visible without the user having to zoom out.
{
  const aspect = window.innerWidth / window.innerHeight;
  const halfTanFov = Math.tan((40 * Math.PI / 180) / 2);
  const orbExtent = 2.4; // particle outer fade radius
  const dForWidth = orbExtent / (halfTanFov * aspect);
  const initialZ = Math.max(6.0, dForWidth);
  camera.position.set(0, 0.1, initialZ);
}

// Subtle env map for the polished onyx highlights — kept dim so the stone
// reads as solid mass, not a chrome ball.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 1.6;
// Allow zooming way out so the orb compresses into a small bright ball of
// energy around the onyx — the "potential energy contained" reading.
controls.maxDistance = 28.0;

// Cool rim from one side, warm key from the other — gives the onyx two
// distinct highlight tones so it never looks flat.
const rim = new THREE.DirectionalLight(0x88bbff, 0.7);
rim.position.set(-2, 1.5, -2);
scene.add(rim);

const key = new THREE.DirectionalLight(0xffe6c6, 0.45);
key.position.set(2.5, 1.2, 2.0);
scene.add(key);

scene.add(new THREE.AmbientLight(0xffffff, 0.08));

// Layer order from inside out: opaque onyx stone → noise-displaced plasma
// envelope → particle corona whose inner band overlaps the plasma's bulge
// envelope so the impenetrable-surface clamp visibly sweeps dust outward.
// Onyx is now nearly as large as the plasma. Plasma min trough sits at
// uEnvBase - uEnvDisp = 1.60, so onyx at 1.55 leaves a thin breathing
// gap that the plasma always wraps without intersecting the stone.
const onyx = createOnyx({ radius: 1.55 });
const core = createCore({ radius: 1.90 });
const particles = createParticles({
  count: 2000,
  outerRadius: 2.40,
});
// Synapse arcs live just outside the plasma surface — they read as
// discharges between adjacent corona regions, so they sit in the same
// shell the inner particles travel through.
// Plasma envelope max is uEnvBase(1.90) + uEnvDisp(0.30) = 2.20; place
// arcs comfortably past that so flare crests can't occlude them, while
// still well inside the particle outer fade (2.40).
const SYNAPSE_BASE_RADIUS = 2.28;
const synapses = createSynapses({ surfaceRadius: SYNAPSE_BASE_RADIUS });

// Real-time cubemap for the onyx reflections. Rendered from the sphere's
// center (with the sphere itself hidden during capture), so the cubemap
// contains the actual surrounding particles + plasma. The sphere's shader
// looks up this cubemap with the world-space reflection vector, so
// reflections track the world — they don't rotate with the sphere.
//
// Resolution 128 (was 256) — 4x fewer pixels per face. Reflections are
// sampled with low LOD on a glossy surface so the resolution drop is
// invisible. Combined with every-other-frame updates in the tick loop,
// this is the single biggest performance win in the scene.
const reflectionTarget = new THREE.WebGLCubeRenderTarget(128, {
  generateMipmaps: false,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
});
const reflectionCamera = new THREE.CubeCamera(0.1, 50, reflectionTarget);
// Added to scene (not the group) so the group's idle sway rotation does
// not move the cubemap origin — reflections stay world-aligned.
scene.add(reflectionCamera);
onyx.uniforms.uEnvMap.value = reflectionTarget.texture;

core.mesh.renderOrder = 1;
particles.points.renderOrder = 2;

// Baseline radii for the plasma surface envelope (object space). Particle
// uniforms tracking the plasma surface are recomputed each frame as
// (baseline * moods.plasmaScale) so they follow mesh scaling.
const PLASMA_BASE_RADIUS = 1.90;
const PARTICLE_OUTER_RADIUS = 2.40;
const PARTICLE_FADE_RADIUS = 2.60;

particles.uniforms.uEnvBase.value = PLASMA_BASE_RADIUS;
particles.uniforms.uEnvDisp.value = core.uniforms.uDisplacement.value;
particles.uniforms.uNoiseScale.value = core.uniforms.uNoiseScale.value;

const group = new THREE.Group();
group.add(onyx.mesh);
group.add(core.mesh);
// Gradient glow billboard: camera-facing quad rendered behind the plasma
// with a radial gradient that's brightest at the orb center and fades
// outward. The opaque onyx occludes the inner portion via depth test, so
// the visible result is a soft volumetric aura bleeding past the plasma
// silhouette — light emitting from the center outward.
group.add(core.glow);
group.add(synapses.mesh);
scene.add(group);

// Particles live OUTSIDE the orb group so they don't rigidly follow
// its rotation. Instead they drift in response to the orb's angular
// velocity (see tick loop) — a sudden mood-change spin nudges them in
// the same direction and the drift decays back to zero, so they
// always settle in their natural orientation rather than ending up
// rotated relative to scene space.
scene.add(particles.points);

// Glow size baseline; main.js scales it each frame to track moods.plasmaScale
// so the aura swells/contracts in sync with the plasma mesh.
const GLOW_BASE_SIZE = core.glow.material.uniforms.uSize.value;

// Pokes only fire on canvas taps so the mood buttons can be clicked
// without also pulsing the core every time.
renderer.domElement.addEventListener('pointerdown', () => {
  core.poke(0.6);
});

// Mood manager — smoothly lerps a curated set of plasma/particle/onyx
// uniforms toward a named target each frame. transitionSeconds defaults
// to 0.35 in MoodManager (snappy crossfade); override only if you want
// to slow that down.
const moods = new MoodManager({ core, particles, onyx, synapses });

createTuningPanel({ moods, synapses });

const moodButtons = document.querySelectorAll('#moods button');
moodButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    moodButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    moods.setMood(btn.dataset.mood);
  });
});

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  particles.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP);
  synapses.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP);
});

const clock = new THREE.Clock();
let frameCount = 0;
// Accumulated noise + flare clocks for the plasma surface and flare field.
// Advanced each frame by dt * (current speed) so that mood transitions
// don't cause discontinuous jumps in the noise sample location — only
// the rate of advance changes. Plasma and particle shaders both read
// uNoiseTime so they stay locked to the same surface field.
let plasmaNoiseTime = 0;
let plasmaFlareTime = 0;
// Inertial coupling state for the loose particle cloud.
let prevOrbRotY = 0;
let prevCamAzimuth = controls.getAzimuthalAngle();
let particleSpinDrift = 0;
function tick() {
  const dt = clock.getDelta();
  const elapsed = clock.elapsedTime;
  frameCount++;

  // Mood lerp runs first so subsequent updates read the freshly
  // interpolated uniforms (e.g. uDisplacement piped to particles).
  moods.update(dt);

  // Advance the accumulated clocks using the current (post-lerp) speeds.
  plasmaNoiseTime += dt * core.uniforms.uNoiseSpeed.value;
  plasmaFlareTime += dt * core.uniforms.uFlareSpeed.value;
  core.uniforms.uNoiseTime.value = plasmaNoiseTime;
  core.uniforms.uFlareTime.value = plasmaFlareTime;
  particles.uniforms.uNoiseTime.value = plasmaNoiseTime;

  core.update(elapsed, dt);
  particles.update(elapsed);
  onyx.uniforms.uTime.value = elapsed;

  // Sync the particle shader's view of the plasma surface every frame so
  // it tracks both (a) click pokes (uPulse decay) and (b) the mood-driven
  // mesh scaling. uEnvBase + uEnvDisp + outer-fade radii all multiply by
  // plasmaScale because the visible plasma surface in world space is
  // (object-space surface) × mesh.scale. Particle envelope, glow
  // billboard, and synapse shell all key off the same value so they
  // track the visible plasma mesh through mood transitions.
  const ps = moods.plasmaScale;
  particles.uniforms.uEnvBase.value = PLASMA_BASE_RADIUS * ps;
  particles.uniforms.uEnvDisp.value =
    (core.uniforms.uDisplacement.value + core.uniforms.uPulse.value * 0.15) * ps;
  particles.uniforms.uSoftOuter.value = PARTICLE_OUTER_RADIUS * ps;
  particles.uniforms.uFadeRadius.value = PARTICLE_FADE_RADIUS * ps;
  // Glow billboard scales with the plasma so the aura swells and
  // contracts with the visible mesh.
  core.glow.material.uniforms.uSize.value = GLOW_BASE_SIZE * ps;

  // Synapse discharge rate tracks particle drift (mood activity); the
  // arc shell scales with the plasma so discharges always sit just
  // outside the visible surface.
  synapses.setEnergy(moods.synapseRate, moods.synapseBurst);
  synapses.uniforms.uRadius.value = SYNAPSE_BASE_RADIUS * ps;
  synapses.update(elapsed, dt);

  // Idle sway plus the cumulative mood-change spin.
  const orbRotY = Math.sin(elapsed * 0.15) * 0.15 + moods.transitionSpin;
  group.rotation.y = orbRotY;
  group.position.y = Math.sin(elapsed * 0.6) * 0.02;

  // Loose inertial coupling for the particle cloud. Two angular-velocity
  // inputs feed the same integrator and exponentially decay.
  //
  //   (a) orbAngVel — the orb actually rotating in world space (mood
  //       transition spin). Particles drift in the same direction in
  //       world space, lagging the orb visibly.
  //
  //   (b) camAzVel — the user dragging via OrbitControls. The orb stays
  //       still in world space; the camera orbits. We want the visual
  //       result from the user's POV to feel just like a mood spin: the
  //       orb appears to rotate, particles trail behind. To produce
  //       that, particles must rotate in world space in the SAME
  //       direction as the camera (a fraction of camera motion). From
  //       the now-moving camera POV, particles then appear to lag the
  //       orb's apparent rotation. So camAzVel adds with positive sign.
  //
  // Sustained-drag steady-state: particles track at coupling × τ × ω of
  // the camera's angular velocity. With coupling=0.55 and τ=1.0, that's
  // 0.55ω in world, which from camera POV reads as the orb moving and
  // particles trailing at ~45% of its apparent rate.
  const orbAngVel = (orbRotY - prevOrbRotY) / Math.max(dt, 1e-4);
  prevOrbRotY = orbRotY;
  const camAz = controls.getAzimuthalAngle();
  const camAzVel = (camAz - prevCamAzimuth) / Math.max(dt, 1e-4);
  prevCamAzimuth = camAz;

  const coupling = 0.55;
  const decayTau = 1.0;
  const inputVel = orbAngVel + camAzVel;
  particleSpinDrift += inputVel * coupling * dt;
  particleSpinDrift *= Math.exp(-dt / decayTau);
  particles.points.rotation.y = particleSpinDrift;

  controls.update();

  // Capture the reflection cubemap every other frame. The onyx is hidden
  // so the cube camera only sees particles + plasma. Skipping every other
  // frame halves cubemap GPU cost; the 1-frame staleness is invisible
  // because reflections are sampled with low LOD on a glossy surface.
  if (frameCount % 2 === 0) {
    onyx.mesh.visible = false;
    reflectionCamera.update(renderer, scene);
    onyx.mesh.visible = true;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

tick();
