import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCore } from './core.js';
import { createOnyx } from './orb.js';
import { createParticles } from './particles.js';

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
camera.position.set(0, 0.1, 4.8);

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
const onyx = createOnyx({ radius: 0.55 });
const core = createCore({ radius: 1.15 });
const particles = createParticles({
  count: 2700,
  innerRadius: 1.00,
  outerRadius: 2.30,
});

core.mesh.renderOrder = 1;
particles.points.renderOrder = 2;

// Lock the particle shader's view of the plasma surface to the actual
// envelope: same base radius, displacement, noise scale, and time speed.
particles.uniforms.uEnvBase.value = 1.15;
particles.uniforms.uEnvDisp.value = core.uniforms.uDisplacement.value;
particles.uniforms.uNoiseScale.value = core.uniforms.uNoiseScale.value;
particles.uniforms.uNoiseSpeed.value = core.uniforms.uNoiseSpeed.value;

const group = new THREE.Group();
group.add(onyx.mesh);
group.add(core.mesh);
group.add(particles.points);
scene.add(group);

window.addEventListener('pointerdown', () => {
  core.poke(0.6);
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

  core.update(elapsed, dt);
  particles.update(elapsed);

  // Pulse the plasma's displacement on click — both the plasma shader and
  // the particle shader read uEnvDisp / uDisplacement as the same value,
  // so a click physically swells the plasma surface and the impenetrable-
  // boundary clamp pushes the corona outward in response.
  particles.uniforms.uEnvDisp.value =
    core.uniforms.uDisplacement.value + core.uniforms.uPulse.value * 0.15;

  group.rotation.y = Math.sin(elapsed * 0.15) * 0.15;
  group.position.y = Math.sin(elapsed * 0.6) * 0.02;

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

tick();
