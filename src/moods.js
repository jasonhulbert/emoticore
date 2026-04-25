import * as THREE from 'three';

// Mood presets. Each mood specifies target values for a curated set of
// plasma / particle / onyx uniforms. The MoodManager smoothly lerps the
// active uniforms toward the target each frame, so switching moods feels
// like the orb gradually shifting state rather than snapping.
//
// Color values are written as hex strings; resolved to THREE.Color objects
// once at construction so the per-frame loop doesn't allocate.
const MOODS = {
  idle: {
    plasma: {
      uNoiseSpeed: 0.28,
      uDisplacement: 0.30,
      uFlareSpeed: 0.30,
      uFlareDisp: 0.12,
      uColorEmber: '#1a0500',
      uColorAmber: '#ff5e10',
      uColorHot:   '#ffb050',
      uColorSpark: '#fff4cc',
    },
    particles: {
      uDrift: 0.45,
      uAmbient: 0.20,
      uColorCool: '#7fd8ff',
      uColorWarm: '#ffb36c',
      uSpark:     '#fff4d8',
    },
    onyx: {
      uEnvIntensity: 1.6,
      uWaveStrength: 0.45,
      uBaseColor: '#04060a',
      uWaveColor: '#ff7a18',
    },
  },

  // Slow, deep, contemplative. Cool blue-violet palette, reduced flares,
  // softer plasma motion — like the orb is processing something.
  thinking: {
    plasma: {
      uNoiseSpeed: 0.16,
      uDisplacement: 0.22,
      uFlareSpeed: 0.10,
      uFlareDisp: 0.05,
      uColorEmber: '#040218',
      uColorAmber: '#3548a8',
      uColorHot:   '#7080ff',
      uColorSpark: '#d8d0ff',
    },
    particles: {
      uDrift: 0.30,
      uAmbient: 0.14,
      uColorCool: '#6080ff',
      uColorWarm: '#a090ff',
      uSpark:     '#e8e0ff',
    },
    onyx: {
      uEnvIntensity: 1.2,
      uWaveStrength: 0.35,
      uBaseColor: '#040618',
      uWaveColor: '#5060d8',
    },
  },

  // Fast, bright, very warm. Frequent flares, larger displacement —
  // active and energetic.
  excited: {
    plasma: {
      uNoiseSpeed: 0.50,
      uDisplacement: 0.40,
      uFlareSpeed: 0.55,
      uFlareDisp: 0.20,
      uColorEmber: '#200400',
      uColorAmber: '#ff3010',
      uColorHot:   '#ffd040',
      uColorSpark: '#ffffe0',
    },
    particles: {
      uDrift: 0.65,
      uAmbient: 0.32,
      uColorCool: '#ff8050',
      uColorWarm: '#ffc060',
      uSpark:     '#ffffe0',
    },
    onyx: {
      uEnvIntensity: 2.0,
      uWaveStrength: 0.65,
      uBaseColor: '#0a0400',
      uWaveColor: '#ff5010',
    },
  },

  // Sharp, electric, intense. Cold-white / cyan tones, very frequent
  // flares — heightened attention.
  alert: {
    plasma: {
      uNoiseSpeed: 0.42,
      uDisplacement: 0.34,
      uFlareSpeed: 0.70,
      uFlareDisp: 0.18,
      uColorEmber: '#001020',
      uColorAmber: '#3088c8',
      uColorHot:   '#a0e0ff',
      uColorSpark: '#ffffff',
    },
    particles: {
      uDrift: 0.55,
      uAmbient: 0.28,
      uColorCool: '#a0d8ff',
      uColorWarm: '#e0f0ff',
      uSpark:     '#ffffff',
    },
    onyx: {
      uEnvIntensity: 1.8,
      uWaveStrength: 0.55,
      uBaseColor: '#020812',
      uWaveColor: '#80c8ff',
    },
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
  }

  _resolve(def) {
    const out = {};
    for (const [section, params] of Object.entries(def)) {
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
