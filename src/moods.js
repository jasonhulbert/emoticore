import * as THREE from 'three';

// Mood presets. Each mood specifies target values for a curated set of
// plasma / particle / onyx uniforms. The MoodManager smoothly lerps the
// active uniforms toward the target each frame, so switching moods feels
// like the orb gradually shifting state rather than snapping.
//
// Color values are written as hex strings; resolved to THREE.Color objects
// once at construction so the per-frame loop doesn't allocate.
const MOODS = {
  // Cool blue-white serene standby. Baseline geometry size.
  idle: {
    plasma: {
      uNoiseSpeed: 0.20,
      uDisplacement: 0.26,
      uFlareSpeed: 0.15,
      uFlareDisp: 0.06,
      uColorEmber: '#020618',
      uColorAmber: '#1864c8',
      uColorHot:   '#80c8ff',
      uColorSpark: '#f0faff',
    },
    particles: {
      uDrift: 0.32,
      uAmbient: 0.18,
      uColorCool: '#80c0ff',
      uColorWarm: '#c0e0ff',
      uSpark:     '#ffffff',
    },
    onyx: {
      uEnvIntensity: 1.4,
      uWaveStrength: 0.35,
      uBaseColor: '#020414',
      uWaveColor: '#4080d0',
    },
    scale: { onyx: 1.00, plasma: 1.00 },
  },

  // Deep blue-violet, drawn inward. Both onyx and plasma contract
  // slightly — introspective, focused.
  thinking: {
    plasma: {
      uNoiseSpeed: 0.14,
      uDisplacement: 0.20,
      uFlareSpeed: 0.08,
      uFlareDisp: 0.04,
      uColorEmber: '#06021a',
      uColorAmber: '#4030a8',
      uColorHot:   '#8068ff',
      uColorSpark: '#d8c8ff',
    },
    particles: {
      uDrift: 0.26,
      uAmbient: 0.13,
      uColorCool: '#6048d0',
      uColorWarm: '#a890ff',
      uSpark:     '#e8e0ff',
    },
    onyx: {
      uEnvIntensity: 1.1,
      uWaveStrength: 0.30,
      uBaseColor: '#060418',
      uWaveColor: '#5040d0',
    },
    scale: { onyx: 0.92, plasma: 0.94 },
  },

  // Hot orange-yellow, expanded. Plasma swells more than the onyx so
  // the energy halo widens — bursting outward.
  excited: {
    plasma: {
      uNoiseSpeed: 0.50,
      uDisplacement: 0.42,
      uFlareSpeed: 0.55,
      uFlareDisp: 0.22,
      uColorEmber: '#100600',
      uColorAmber: '#ff8020',
      uColorHot:   '#ffd840',
      uColorSpark: '#ffffd0',
    },
    particles: {
      uDrift: 0.65,
      uAmbient: 0.32,
      uColorCool: '#ffa050',
      uColorWarm: '#ffd060',
      uSpark:     '#ffffd0',
    },
    onyx: {
      uEnvIntensity: 2.0,
      uWaveStrength: 0.65,
      uBaseColor: '#0a0500',
      uWaveColor: '#ff8020',
    },
    scale: { onyx: 1.04, plasma: 1.10 },
  },

  // Deep saturated red. Onyx contracts slightly while plasma swells —
  // tense readiness, energy field puffed out around a denser core.
  alert: {
    plasma: {
      uNoiseSpeed: 0.45,
      uDisplacement: 0.34,
      uFlareSpeed: 0.75,
      uFlareDisp: 0.18,
      uColorEmber: '#1a0200',
      uColorAmber: '#c01010',
      uColorHot:   '#ff4020',
      uColorSpark: '#ffd870',
    },
    particles: {
      uDrift: 0.55,
      uAmbient: 0.28,
      uColorCool: '#ff5030',
      uColorWarm: '#ff8040',
      uSpark:     '#ffe080',
    },
    onyx: {
      uEnvIntensity: 1.7,
      uWaveStrength: 0.55,
      uBaseColor: '#100200',
      uWaveColor: '#e02010',
    },
    scale: { onyx: 0.97, plasma: 1.07 },
  },
};

export const MOOD_NAMES = Object.keys(MOODS);

export class MoodManager {
  constructor({ core, particles, onyx, transitionSeconds = 1.5 } = {}) {
    this.systems = { core, particles, onyx };
    this.transitionSeconds = transitionSeconds;
    // Pre-resolve color strings to THREE.Color so update() never allocates.
    this.targets = {};
    for (const [name, def] of Object.entries(MOODS)) {
      this.targets[name] = this._resolve(def);
    }
    this.currentName = 'idle';
    this.target = this.targets.idle;
    // Currently applied scale values — start at idle (1.0/1.0) and lerp
    // toward target each frame. Exposed so main.js can scale dependent
    // particle uniforms (uEnvBase, uSoftOuter, etc.) to track the plasma.
    this.onyxScale = this.target.scale.onyx;
    this.plasmaScale = this.target.scale.plasma;
  }

  _resolve(def) {
    const out = {};
    for (const [section, params] of Object.entries(def)) {
      if (section === 'scale') {
        // Numeric pair, no color resolution needed.
        out[section] = { ...params };
        continue;
      }
      out[section] = {};
      for (const [key, val] of Object.entries(params)) {
        out[section][key] = typeof val === 'string'
          ? new THREE.Color(val)
          : val;
      }
    }
    return out;
  }

  setMood(name) {
    if (!this.targets[name]) return;
    this.currentName = name;
    this.target = this.targets[name];
  }

  update(dt) {
    // Frame-rate-independent lerp toward the target. alpha = dt / tau gives
    // exponential approach with time constant ~ transitionSeconds; clamp so
    // a long frame doesn't overshoot.
    const alpha = Math.min(1.0, dt / this.transitionSeconds);
    this._lerpSection(this.systems.core.uniforms, this.target.plasma, alpha);
    this._lerpSection(this.systems.particles.uniforms, this.target.particles, alpha);
    this._lerpSection(this.systems.onyx.uniforms, this.target.onyx, alpha);

    // Lerp scales and apply to mesh transforms. The plasma's surface
    // physics (uEnvBase / uEnvDisp / uSoftOuter etc.) are scaled by
    // main.js using plasmaScale so the particle shader's view of the
    // surface tracks the visible mesh.
    this.onyxScale   += (this.target.scale.onyx   - this.onyxScale)   * alpha;
    this.plasmaScale += (this.target.scale.plasma - this.plasmaScale) * alpha;
    this.systems.onyx.mesh.scale.setScalar(this.onyxScale);
    this.systems.core.mesh.scale.setScalar(this.plasmaScale);
    // Halo shell tracks the plasma's scale so the soft outer glow stays
    // aligned with the visible plasma silhouette across all moods.
    if (this.systems.core.halo) {
      this.systems.core.halo.scale.setScalar(this.plasmaScale);
    }
  }

  _lerpSection(uniforms, target, alpha) {
    for (const key in target) {
      const u = uniforms[key];
      if (!u) continue;
      const targetVal = target[key];
      if (targetVal.isColor) {
        u.value.lerp(targetVal, alpha);
      } else {
        u.value = u.value + (targetVal - u.value) * alpha;
      }
    }
  }
}
