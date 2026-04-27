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
    // Steady, ambient discharge — quiet field, mostly metronomic.
    synapses: { rate: 18.0, burst: 0.20, uColor: '#dceeff' },
  },

  // Deep blue-violet, drawn inward. Plasma contracts slightly while the
  // onyx core holds steady — introspective, focused.
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
      uEnvIntensity: 1.4,
      uWaveStrength: 0.35,
      uBaseColor: '#060418',
      uWaveColor: '#5040d0',
    },
    scale: { onyx: 1.00, plasma: 0.94 },
    // Pondering rhythm — moderate mean rate, highly clustered: long
    // contemplative pauses punctuated by short flurries of activity.
    synapses: { rate: 28.0, burst: 0.75, uColor: '#d8c8ff' },
  },

  // Hot orange-yellow, expanded. Plasma swells around a steady onyx core,
  // so the energy halo widens — bursting outward.
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
      uEnvIntensity: 1.4,
      uWaveStrength: 0.35,
      uBaseColor: '#0a0500',
      uWaveColor: '#ff8020',
    },
    scale: { onyx: 1.00, plasma: 1.10 },
    // Sustained energetic crackle — high mean rate, moderately bursty:
    // continuously active but with rolling waves of intensity.
    synapses: { rate: 65.0, burst: 0.40, uColor: '#ffe8b0' },
  },

  // Deep saturated red. Plasma swells around a steady onyx core —
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
      uEnvIntensity: 1.4,
      uWaveStrength: 0.35,
      uBaseColor: '#100200',
      uWaveColor: '#e02010',
    },
    scale: { onyx: 1.00, plasma: 1.07 },
    // Tense, twitchy — extreme burstiness: long latent stretches broken
    // by sudden volleys of discharges, like a stressed nervous system.
    synapses: { rate: 50.0, burst: 0.95, uColor: '#ffc870' },
  },
};

export const MOOD_NAMES = Object.keys(MOODS);

export class MoodManager {
  constructor({ core, particles, onyx, synapses, transitionSeconds = 0.35 } = {}) {
    this.systems = { core, particles, onyx, synapses };
    // Time-constant of the exponential lerp toward target uniforms —
    // smaller = snappier color/displacement crossfade.
    this.transitionSeconds = transitionSeconds;
    // Independent "kick" animation that fires on every setMood: a
    // partial spin and an elastic scale bounce on the plasma. Lives
    // beyond the uniform lerp so the visible motion settles after the
    // color has already landed, the way an interface element punctuates
    // a state change.
    this.kickDuration = 0.9;
    this.kickTime = this.kickDuration; // start settled
    // Cumulative spin: every setMood adds a randomized delta to
    // spinTarget; the kick eases spinCurrent from spinStart to
    // spinTarget with an elastic-out curve, so the orb overshoots and
    // settles at a NEW orientation rather than returning to its
    // pre-transition pose. Idle sway is layered on top in main.js.
    this.spinCurrent = 0;
    this.spinStart = 0;
    this.spinTarget = 0;
    this.transitionSpin = 0;
    this.plasmaScaleEffective = 1;
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
    // Synapse discharge parameters — main.js feeds these into the
    // synapses module each frame. Lerped here so mood transitions ease
    // into the new firing rhythm rather than snapping.
    this.synapseRate  = this.target.synapses.rate;
    this.synapseBurst = this.target.synapses.burst;
  }

  _resolve(def) {
    const out = {};
    for (const [section, params] of Object.entries(def)) {
      if (section === 'scale') {
        // Numeric-only section.
        out[section] = { ...params };
        continue;
      }
      if (section === 'synapses') {
        // Mixed: rate/burst are scalars, uColor is a hex string that
        // needs THREE.Color resolution like other uniform sections.
        out.synapses = {
          rate: params.rate,
          burst: params.burst,
          uColor: new THREE.Color(params.uColor),
        };
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
    if (name === this.currentName) return;
    this.currentName = name;
    this.target = this.targets[name];
    // Restart the kick animation. Random spin direction so successive
    // transitions don't always pivot the same way.
    this.kickTime = 0;
    // Pick a small randomized rotation delta (15°–40°) and a random
    // sign; accumulate into spinTarget so each transition lands at a
    // fresh orientation rather than swinging back. spinStart captures
    // the pose at the start of this kick so the eased path is
    // current → target.
    this.spinStart = this.spinCurrent;
    const dir = Math.random() < 0.5 ? -1 : 1;
    const delta = (Math.PI / 12) + Math.random() * (5 * Math.PI / 36);
    this.spinTarget = this.spinCurrent + delta * dir;
  }

  // One-shot kick motion sampled by update(). Returns:
  //   scaleKick  — multiplier on plasma scale, damped sine that
  //                overshoots and settles to zero (elastic bounce)
  // The cumulative spin is updated in place on this.spinCurrent —
  // it's not returned because it doesn't reset between transitions.
  _computeKick() {
    if (this.kickTime >= this.kickDuration) {
      // Snap to exact target so subtle floating-point drift can't
      // accumulate over many transitions.
      this.spinCurrent = this.spinTarget;
      return { scaleKick: 0 };
    }
    const p = this.kickTime / this.kickDuration;

    // easeOutCubic — smooth deceleration, no overshoot. Reads as a
    // confident settle rather than the cartoonish bounce of an
    // elastic curve.
    const eased = 1 - Math.pow(1 - p, 3);
    this.spinCurrent = this.spinStart + (this.spinTarget - this.spinStart) * eased;

    // No scale bounce — an oscillating elastic scale read as
    // cartoonish. The transition is communicated through the spin
    // and the existing uniform lerp; the plasma scale changes only
    // because the new mood's target.scale.plasma differs.
    return { scaleKick: 0 };
  }

  update(dt) {
    // Frame-rate-independent lerp toward the target. alpha = dt / tau gives
    // exponential approach with time constant ~ transitionSeconds; clamp so
    // a long frame doesn't overshoot.
    const alpha = Math.min(1.0, dt / this.transitionSeconds);
    this._lerpSection(this.systems.core.uniforms, this.target.plasma, alpha);
    this._lerpSection(this.systems.particles.uniforms, this.target.particles, alpha);
    this._lerpSection(this.systems.onyx.uniforms, this.target.onyx, alpha);
    if (this.systems.synapses) {
      // synapses.uColor is the only uniform-style field in the synapses
      // section; rate/burst are read off this.synapseRate/Burst by main.
      const u = this.systems.synapses.uniforms.uColor;
      if (u) u.value.lerp(this.target.synapses.uColor, alpha);
    }

    // Lerp scales and apply to mesh transforms. The plasma's surface
    // physics (uEnvBase / uEnvDisp / uSoftOuter etc.) are scaled by
    // main.js using plasmaScale so the particle shader's view of the
    // surface tracks the visible mesh.
    this.onyxScale    += (this.target.scale.onyx     - this.onyxScale)    * alpha;
    this.plasmaScale  += (this.target.scale.plasma   - this.plasmaScale)  * alpha;
    this.synapseRate  += (this.target.synapses.rate  - this.synapseRate)  * alpha;
    this.synapseBurst += (this.target.synapses.burst - this.synapseBurst) * alpha;
    // Advance the kick clock and apply spin/elastic-bounce on top of
    // the lerped plasma scale. The bounced value is exposed as
    // plasmaScaleEffective so main.js can multiply through to all the
    // dependent radii (particle envelope, glow size, synapse shell)
    // and they bounce together with the visible plasma surface.
    this.kickTime = Math.min(this.kickTime + dt, this.kickDuration + 1);
    const kick = this._computeKick();
    this.transitionSpin = this.spinCurrent;
    this.plasmaScaleEffective = this.plasmaScale * (1 + kick.scaleKick);

    this.systems.onyx.mesh.scale.setScalar(this.onyxScale);
    this.systems.core.mesh.scale.setScalar(this.plasmaScaleEffective);
    // Glow billboard's size is driven by uSize uniform (set by main.js
    // each frame) rather than mesh.scale, since the billboard's vertex
    // shader handles its own sizing — no scale needed here.
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
