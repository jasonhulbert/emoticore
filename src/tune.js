import GUI from 'lil-gui';

// Live tuning panel.
//
// Two kinds of parameters are exposed:
//
//   1. Per-mood targets — written into moods.targets[currentMood][...].
//      The mood manager keeps lerping toward the target every frame, so
//      changes ease in over `transitionSeconds` instead of snapping. The
//      result is that you're editing the *current mood preset*; switch
//      moods and you're tuning that one instead.
//
//   2. Global uniforms — synapse intensity / bend / glow size / radius
//      and the mood transition speed. These aren't bound to any preset
//      and apply uniformly across moods.
//
// When the user clicks a mood button (which calls moods.setMood) the
// proxy values are re-read from the new mood's target and the GUI
// displays update — so the controls always show the active preset.
export function createTuningPanel({ moods, synapses }) {
  const gui = new GUI({ title: 'Tuning', width: 300 });
  gui.close();

  // Proxy holds the values the GUI controllers bind to. We don't bind
  // controllers directly to mood-target objects because those objects
  // change identity when the active mood switches — the proxy gives a
  // stable surface that we re-sync on mood change.
  const proxy = {
    syn_rate: 0,
    syn_burst: 0,
    syn_color: '#ffffff',
    pl_noiseSpeed: 0,
    pl_displacement: 0,
    pl_flareSpeed: 0,
    pl_flareDisp: 0,
    pa_drift: 0,
    pa_ambient: 0,
    on_envIntensity: 0,
    on_waveStrength: 0,
    sc_plasma: 1,
  };

  function readFromMood() {
    const t = moods.targets[moods.currentName];
    proxy.syn_rate         = t.synapses.rate;
    proxy.syn_burst        = t.synapses.burst;
    proxy.syn_color        = '#' + t.synapses.uColor.getHexString();
    proxy.pl_noiseSpeed    = t.plasma.uNoiseSpeed;
    proxy.pl_displacement  = t.plasma.uDisplacement;
    proxy.pl_flareSpeed    = t.plasma.uFlareSpeed;
    proxy.pl_flareDisp     = t.plasma.uFlareDisp;
    proxy.pa_drift         = t.particles.uDrift;
    proxy.pa_ambient       = t.particles.uAmbient;
    proxy.on_envIntensity  = t.onyx.uEnvIntensity;
    proxy.on_waveStrength  = t.onyx.uWaveStrength;
    proxy.sc_plasma        = t.scale.plasma;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  // Helper to wire a per-mood scalar: GUI value writes into the active
  // mood's target so the lerp eases the live uniform toward it.
  const writeMood = (path, key) => (v) => {
    const t = moods.targets[moods.currentName];
    let obj = t;
    for (const p of path) obj = obj[p];
    obj[key] = v;
  };

  // ── Synapses ──
  const synFolder = gui.addFolder('Synapses');
  synFolder.add(proxy, 'syn_rate', 0, 120, 0.5).name('rate (per s)')
    .onChange(writeMood(['synapses'], 'rate'));
  synFolder.add(proxy, 'syn_burst', 0, 1, 0.01).name('burst')
    .onChange(writeMood(['synapses'], 'burst'));
  synFolder.addColor(proxy, 'syn_color').name('color')
    .onChange((v) => moods.targets[moods.currentName].synapses.uColor.set(v));
  // Global synapse uniforms
  synFolder.add(synapses.uniforms.uIntensity, 'value', 0, 6, 0.05).name('intensity');
  synFolder.add(synapses.uniforms.uBend,      'value', 0, 0.4, 0.005).name('bend');
  synFolder.add(synapses.uniforms.uGlowSize,  'value', 0, 40, 0.5).name('glow size');
  synFolder.add(synapses.uniforms.uRadius,    'value', 1.5, 3.0, 0.01).name('radius');

  // ── Plasma ──
  const plFolder = gui.addFolder('Plasma');
  plFolder.add(proxy, 'pl_noiseSpeed',   0, 1.5, 0.01).name('noise speed')
    .onChange(writeMood(['plasma'], 'uNoiseSpeed'));
  plFolder.add(proxy, 'pl_displacement', 0, 0.8, 0.01).name('displacement')
    .onChange(writeMood(['plasma'], 'uDisplacement'));
  plFolder.add(proxy, 'pl_flareSpeed',   0, 1.5, 0.01).name('flare speed')
    .onChange(writeMood(['plasma'], 'uFlareSpeed'));
  plFolder.add(proxy, 'pl_flareDisp',    0, 0.4, 0.01).name('flare disp')
    .onChange(writeMood(['plasma'], 'uFlareDisp'));
  plFolder.add(proxy, 'sc_plasma',       0.5, 1.5, 0.01).name('scale')
    .onChange(writeMood(['scale'], 'plasma'));
  plFolder.close();

  // ── Particles ──
  const paFolder = gui.addFolder('Particles');
  paFolder.add(proxy, 'pa_drift',   0, 1.5, 0.01).name('drift')
    .onChange(writeMood(['particles'], 'uDrift'));
  paFolder.add(proxy, 'pa_ambient', 0, 0.6, 0.01).name('ambient')
    .onChange(writeMood(['particles'], 'uAmbient'));
  paFolder.close();

  // ── Onyx ──
  const onFolder = gui.addFolder('Onyx');
  onFolder.add(proxy, 'on_envIntensity', 0, 3, 0.05).name('env intensity')
    .onChange(writeMood(['onyx'], 'uEnvIntensity'));
  onFolder.add(proxy, 'on_waveStrength', 0, 1.2, 0.01).name('wave strength')
    .onChange(writeMood(['onyx'], 'uWaveStrength'));
  onFolder.close();

  // ── Global ──
  const gFolder = gui.addFolder('Global');
  gFolder.add(moods, 'transitionSeconds', 0.1, 5.0, 0.1).name('transition (s)');
  gFolder.close();

  // Re-sync the proxy whenever the active mood changes via the existing
  // mood buttons. We wrap setMood rather than introducing an event bus.
  const origSet = moods.setMood.bind(moods);
  moods.setMood = (name) => {
    origSet(name);
    readFromMood();
  };

  readFromMood();
  return gui;
}
