import * as THREE from 'three';

// Mood presets. Each mood specifies target values for a curated set of
// plasma / particle / onyx uniforms. The MoodManager smoothly lerps the
// active uniforms toward the target each frame, so switching moods feels
// like the orb gradually shifting state rather than snapping.
//
// Color values are written as hex strings; resolved to THREE.Color objects
// once at construction so the per-frame loop doesn't allocate.
const MOODS = {
  // Cool blue-white serene standby. Slow plasma motion, infrequent
  // gentle flares — the orb at rest, ready.
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
  },

  // Deep blue-violet, very slow, rare flares — contemplative.
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
  },

  // Hot orange-YELLOW (no red push so it stays distinct from alert).
  // Fast plasma, frequent big flares — energetic and active.
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
  },

  // Deep saturated red, the universal warning color. Sharp motion +
  // very frequent flares for urgency.
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
