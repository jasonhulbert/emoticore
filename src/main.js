import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCore } from './core.js';
import { createOrb } from './orb.js';
import { createParticles } from './particles.js';

const container = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  40,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0.1, 3.4);

// Environment map drives the frosted glass reflections.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 2.0;
controls.maxDistance = 8.0;

// A soft backlight so the silhouette of the orb reads clearly on dark backgrounds.
const rim = new THREE.DirectionalLight(0x88bbff, 0.8);
rim.position.set(-2, 1.5, -2);
scene.add(rim);

const key = new THREE.DirectionalLight(0xffe6c6, 0.5);
key.position.set(2.5, 1.2, 2.0);
scene.add(key);

scene.add(new THREE.AmbientLight(0xffffff, 0.1));

const core = createCore();
const particles = createParticles({
  count: 4500,
  innerRadius: 0.62,
  outerRadius: 0.95,
});
const orb = createOrb();

// Group so we can gently sway the whole assistant as one.
const group = new THREE.Group();
group.add(core.mesh);
group.add(particles.points);
group.add(orb.mesh);
scene.add(group);

// Click/tap pokes the core, which ripples out through the particles because
// they share the displacement uniform.
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

  // Keep core + particle fields locked together so poking the core ripples
  // visibly out into the cloud.
  particles.uniforms.uDisplacement.value =
    core.uniforms.uDisplacement.value + core.uniforms.uPulse.value * 0.15;

  // Idle sway gives the orb subtle "alive" motion even without interaction.
  group.rotation.y = Math.sin(elapsed * 0.15) * 0.15;
  group.position.y = Math.sin(elapsed * 0.6) * 0.02;

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

tick();
