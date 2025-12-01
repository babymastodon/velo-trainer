// --------------------------- Audio / overlay ---------------------------

// Beeper singleton
export const Beeper = (() => {
  const statusOverlay = document.getElementById("statusOverlay");
  const statusText = document.getElementById("statusText");

  let audioCtx = null;
  let enabled = true;
  let currentNodes = [];
  let countdownRunning = false;
  let timeouts = [];

  // ---------------------------------------------------------------------------
  // Timeout management
  // ---------------------------------------------------------------------------

  function addTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    timeouts.push(id);
    return id;
  }

  function clearAllTimeouts() {
    timeouts.forEach(id => clearTimeout(id));
    timeouts = [];
  }

  // ---------------------------------------------------------------------------
  // Core audio plumbing
  // ---------------------------------------------------------------------------

  function ensureAudioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext;
      if (!AC) {
        console.warn("Web Audio API not supported");
        return null;
      }
      audioCtx = new AC();
    }
    return audioCtx;
  }

  function track(n) {
    if (n) currentNodes.push(n);
    return n;
  }

  function stopCurrent() {
    if (!audioCtx) {
      currentNodes = [];
      return;
    }
    currentNodes.forEach(node => {
      try {if (node.stop) node.stop(audioCtx.currentTime + 0.01);} catch {}
      try {if (node.disconnect) node.disconnect();} catch {}
    });
    currentNodes = [];
  }

  // Full stop: audio + scheduled audio + overlay state
  function stopAll() {
    clearAllTimeouts();
    stopCurrent();
    countdownRunning = false;
    if (typeof statusOverlay !== "undefined" && statusOverlay) {
      statusOverlay.style.opacity = "0";
      statusOverlay.style.display = "none";
    }
  }

  // Public audio toggle: only affects sound (not overlays / timeouts)
  function setEnabled(flag) {
    enabled = !!flag;
    if (!enabled) stopCurrent();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function createMasterGain(ctx, startTime, totalSec, fadeInSec = 0.03, fadeOutSec = 0.1) {
    const g = track(ctx.createGain());
    g.gain.value = 0.0001;
    g.connect(ctx.destination);

    const end = startTime + totalSec;
    g.gain.setValueAtTime(0.0001, startTime);
    g.gain.linearRampToValueAtTime(1.0, startTime + fadeInSec);
    g.gain.setValueAtTime(1.0, end - fadeOutSec);
    g.gain.linearRampToValueAtTime(0.0001, end);
    return g;
  }

  // Private: show overlay with computed styles
  function showOverlay(text, fontSizePx) {
    if (!statusOverlay || !statusText) return;

    statusOverlay.style.display = "flex";
    statusText.textContent = text;
    statusText.style.fontSize = `${fontSizePx}px`;

    void statusOverlay.offsetWidth;
    statusOverlay.style.opacity = "1";
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: simple beep (no stopping here)
  // ---------------------------------------------------------------------------

  function playBeep(durationMs = 120, freq = 880, gain = 0.75) {
    if (!enabled) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const durSec = durationMs / 1000;

    const osc = track(ctx.createOscillator());
    const g = track(ctx.createGain());

    osc.type = "square";
    osc.frequency.value = freq;

    g.gain.value = 0.0001;
    osc.connect(g);
    g.connect(ctx.destination);

    const attack = 0.005;
    const release = 0.03;
    const end = now + durSec;

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.setValueAtTime(gain, Math.max(now + attack, end - release));
    g.gain.linearRampToValueAtTime(0.0001, end);

    osc.start(now);
    osc.stop(end + 0.05);
  }

  // ---------------------------------------------------------------------------
  // PRIVATE: AIR RAID SIREN + MEGA HONK (no stopping here)
  // ---------------------------------------------------------------------------

  function playAirRaidSiren(
    cycles = 3,
    rampDurationSec = 3,
    baseFreq = 110,
    topFreq = 1400,
    gain = 0.28
  ) {
    if (!enabled) return 0;
    const ctx = ensureAudioContext();
    if (!ctx) return 0;

    const now = ctx.currentTime;
    const totalSec = cycles * rampDurationSec;
    const endTime = now + totalSec;

    const masterGain = createMasterGain(ctx, now, totalSec, 0.05, 0.1);

    const sirenGain = track(ctx.createGain());
    sirenGain.gain.value = 0.0001;
    sirenGain.connect(masterGain);

    sirenGain.gain.setValueAtTime(0.0001, now);
    sirenGain.gain.linearRampToValueAtTime(gain, now + 0.3);
    sirenGain.gain.setValueAtTime(gain, endTime - 0.3);
    sirenGain.gain.linearRampToValueAtTime(0.0001, endTime);

    const voices = [
      {octave: 0.25, detune: -4},
      {octave: 0.5, detune: +3},
      {octave: 1.0, detune: -2},
      {octave: 2.0, detune: +6}
    ];

    function scheduleRamp(osc, base, top, start, dur) {
      const rEnd = start + dur;
      osc.frequency.setValueAtTime(base, start);
      osc.frequency.linearRampToValueAtTime(top, rEnd);
      osc.frequency.setValueAtTime(base, rEnd);
    }

    voices.forEach(v => {
      const osc = track(ctx.createOscillator());
      osc.type = "sawtooth";
      osc.detune.value = v.detune;
      osc.connect(sirenGain);

      for (let i = 0; i < cycles; i++) {
        const t0 = now + i * rampDurationSec;
        scheduleRamp(
          osc,
          baseFreq * v.octave,
          topFreq * v.octave,
          t0,
          rampDurationSec
        );
      }

      osc.start(now);
      osc.stop(endTime + 0.05);
    });

    return totalSec;
  }

  function playMegaHonk(
    totalDurationSec = 9,
    honkDurationSec = 0.36,
    gapSec = 0.18,
    baseFreq = 320,
    gain = 0.6
  ) {
    if (!enabled) return 0;
    const ctx = ensureAudioContext();
    if (!ctx) return 0;

    const now = ctx.currentTime;
    const end = now + totalDurationSec;

    const masterGain = createMasterGain(ctx, now, totalDurationSec, 0.04, 0.1);

    const voiceGain = track(ctx.createGain());
    voiceGain.gain.value = 0.0001;
    voiceGain.connect(masterGain);

    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.linearRampToValueAtTime(gain, now + 0.05);
    voiceGain.gain.setValueAtTime(gain, end - 0.15);
    voiceGain.gain.linearRampToValueAtTime(0.0001, end);

    const voiceDefs = [
      {type: "sawtooth", freqMul: 0.5, detune: -8},
      {type: "sawtooth", freqMul: 1.0, detune: 0},
      {type: "square", freqMul: 2.0, detune: +4},
      {type: "sawtooth", freqMul: 3.0, detune: -4},
      {type: "square", freqMul: 5.0, detune: 0},
      {type: "square", freqMul: 6.5, detune: +6},
      {type: "square", freqMul: 8.0, detune: -6}
    ];

    const voices = voiceDefs.map(v => {
      const osc = track(ctx.createOscillator());
      osc.type = v.type;
      osc.detune.value = v.detune;
      osc.frequency.value = baseFreq * v.freqMul;
      osc.connect(voiceGain);
      osc.start(now);
      osc.stop(end + 0.1);
      return {osc, freqMul: v.freqMul};
    });

    const attack = 0.01;
    const punchDrop = 0.06;
    const releaseTail = 0.08;
    const pitchEnvTime = 0.08;

    let t = now;
    while (t < end) {
      const hs = t;
      const he = hs + honkDurationSec;
      if (hs >= end) break;
      const safeEnd = Math.min(he, end);

      const peak = gain * 1.2;
      const sustain = gain * 0.85;

      voiceGain.gain.setValueAtTime(0.0001, hs);
      voiceGain.gain.linearRampToValueAtTime(peak, hs + attack);
      voiceGain.gain.linearRampToValueAtTime(sustain, hs + punchDrop);
      voiceGain.gain.setValueAtTime(
        sustain,
        Math.max(hs + punchDrop, safeEnd - releaseTail)
      );
      voiceGain.gain.linearRampToValueAtTime(0.0001, safeEnd);

      voices.forEach(({osc, freqMul}) => {
        const base = baseFreq * freqMul;
        if (freqMul <= 1.0) {
          osc.frequency.setValueAtTime(base * 1.06, hs);
          osc.frequency.linearRampToValueAtTime(
            base,
            Math.min(hs + pitchEnvTime, safeEnd)
          );
        } else {
          osc.frequency.setValueAtTime(base * 0.96, hs);
          osc.frequency.linearRampToValueAtTime(
            base * 1.02,
            Math.min(hs + pitchEnvTime * 0.8, safeEnd)
          );
        }
      });

      t += honkDurationSec + gapSec;
    }

    voiceGain.gain.setValueAtTime(0.0001, end);
    return totalDurationSec;
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Beep pattern – directly calls playBeep via scheduled timeouts
  // ---------------------------------------------------------------------------

  function playBeepPattern(
    shortCount = 3,
    shortDurationMs = 120,
    shortFreq = 880,
    longDurationMs = 500,
    longFreq = 660,
    spacingSec = 1.0,
    gain = 0.75
  ) {
    if (!enabled) return;
    if (!ensureAudioContext()) return;

    // Public entrypoint: fully reset previous audio/schedules
    stopAll();

    for (let i = 0; i < shortCount; i++) {
      const offsetMs = i * spacingSec * 1000;
      addTimeout(() => {
        playBeep(shortDurationMs, shortFreq, gain);
      }, offsetMs);
    }

    const longOffsetMs = shortCount * spacingSec * 1000;
    addTimeout(() => {
      playBeep(longDurationMs, longFreq, gain);
    }, longOffsetMs);
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Paused / Resumed overlays
  // ---------------------------------------------------------------------------

  function showStatusMessage(text, heightRatio = 0.2, durationMs = 800) {
    if (!statusOverlay || !statusText) return;
    const totalHeight = window.innerHeight || 800;
    const fontSize = Math.floor(totalHeight * heightRatio);

    showOverlay(text, fontSize);

    addTimeout(() => {
      statusOverlay.style.opacity = "0";
      addTimeout(() => {
        statusOverlay.style.display = "none";
      }, 300);
    }, durationMs);
  }

  function showPausedOverlay() {
    showStatusMessage("Workout Paused", 0.2, 1600);
  }

  function showResumedOverlay() {
    showStatusMessage("Workout Resumed", 0.2, 1600);
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: Start countdown – now stops existing first
  // ---------------------------------------------------------------------------

  function runStartCountdown(onDone) {
    if (!statusOverlay || !statusText) {
      onDone && onDone();
      return;
    }

    // Reset any previous countdown/audio/overlay state
    stopAll();

    countdownRunning = true;
    const seq = ["3", "2", "1", "Start"];
    const totalHeight = window.innerHeight || 800;
    const fontSize = Math.floor(totalHeight * 0.25);

    const step = idx => {
      if (!countdownRunning) return;

      if (idx >= seq.length) {
        statusOverlay.style.opacity = "0";
        addTimeout(() => {
          statusOverlay.style.display = "none";
          countdownRunning = false;
          onDone && onDone();
        }, 200);
        return;
      }

      const label = seq[idx];
      showOverlay(label, fontSize);

      // Beep per step using same primitive as patterns
      if (label === "Start") {
        playBeep(220, 660, 0.75);
      } else {
        playBeep(120, 880, 0.75);
      }

      addTimeout(() => {
        statusOverlay.style.opacity = "0";
      }, 500);

      addTimeout(() => step(idx + 1), 1000);
    };

    step(0);
  }

  // ---------------------------------------------------------------------------
  // PUBLIC: DangerDanger — siren followed by mega honk
  // ---------------------------------------------------------------------------

  function playDangerDanger() {
    if (!enabled) return;
    if (!ensureAudioContext()) return;

    // Reset any previous sequences first
    stopAll();

    const sirenDurationSec = playAirRaidSiren();
    if (sirenDurationSec <= 0) return;

    addTimeout(() => {
      playMegaHonk();
    }, sirenDurationSec * 1000 + 50);
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    setEnabled,
    stop: stopAll,
    playBeepPattern,
    runStartCountdown,
    showPausedOverlay,
    showResumedOverlay,
    playDangerDanger
  };
})();
