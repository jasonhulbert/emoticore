import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCore } from './core.js';
import { createOnyx } from './orb.js';
import { createParticles } from './particles.js';
import { MoodManager } from './moods.js';

const container = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
camera.position.set(0, 0.1, 6.0);

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
  count: 2700,
  outerRadius: 2.40,
});

// Real-time cubemap for the onyx reflections. Rendered each frame from the
// sphere's center (with the sphere itself hidden during capture), so the
// cubemap contains the actual surrounding particles + plasma. The sphere's
// shader looks up this cubemap with the world-space reflection vector, so
// reflections track the world — they don't rotate with the sphere.
const reflectionTarget = new THREE.WebGLCubeRenderTarget(256, {
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
particles.uniforms.uNoiseSpeed.value = core.uniforms.uNoiseSpeed.value;

const group = new THREE.Group();
group.add(onyx.mesh);
group.add(core.mesh);
group.add(particles.points);
scene.add(group);

// Pokes only fire on canvas taps so the mood buttons can be clicked
// without also pulsing the core every time.
renderer.domElement.addEventListener('pointerdown', () => {
  core.poke(0.6);
});

// Mood manager — smoothly lerps a curated set of plasma/particle/onyx
// uniforms toward a named target each frame.
const moods = new MoodManager({ core, particles, onyx, transitionSeconds: 1.5 });

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
  particles.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);
});

const clock = new THREE.Clock();
function tick() {
  const dt = clock.getDelta();
  const elapsed = clock.elapsedTime;

  // Mood lerp runs first so subsequent updates read the freshly
  // interpolated uniforms (e.g. uDisplacement piped to particles).
  moods.update(dt);

  core.update(elapsed, dt);
  particles.update(elapsed);
  onyx.uniforms.uTime.value = elapsed;

  // Sync the particle shader's view of the plasma surface every frame so
  // it tracks both (a) click pokes (uPulse decay) and (b) the mood-driven
  // mesh scaling. uEnvBase + uEnvDisp + outer-fade radii all multiply by
  // plasmaScale because the visible plasma surface in world space is
  // (object-space surface) × mesh.scale.
  const ps = moods.plasmaScale;
  particles.uniforms.uEnvBase.value = PLASMA_BASE_RADIUS * ps;
  particles.uniforms.uEnvDisp.value =
    (core.uniforms.uDisplacement.value + core.uniforms.uPulse.value * 0.15) * ps;
  particles.uniforms.uSoftOuter.value = PARTICLE_OUTER_RADIUS * ps;
  particles.uniforms.uFadeRadius.value = PARTICLE_FADE_RADIUS * ps;

  group.rotation.y = Math.sin(elapsed * 0.15) * 0.15;
  group.position.y = Math.sin(elapsed * 0.6) * 0.02;

  controls.update();

  // Capture the reflection cubemap: hide the onyx so the cube camera only
  // sees the surrounding particles + plasma, render the 6 faces, then
  // restore visibility before the main render.
  onyx.mesh.visible = false;
  reflectionCamera.update(renderer, scene);
  onyx.mesh.visible = true;

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

tick();
