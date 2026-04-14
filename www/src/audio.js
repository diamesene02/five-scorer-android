// Synthesized sound effects via Web Audio API.
// Zero-byte assets, zero latency, offline-native.
//
// AudioContext is unlocked on the first user gesture (iOS/Android restriction).

let ctx = null;
let unlocked = false;

const SOUND_KEY = "fs-sound-enabled";

export function isSoundEnabled() {
  try {
    const v = localStorage.getItem(SOUND_KEY);
    return v === null ? true : v === "1";
  } catch (_) {
    return true;
  }
}

export function setSoundEnabled(on) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch (_) {}
}

export function toggleSound() {
  const next = !isSoundEnabled();
  setSoundEnabled(next);
  return next;
}

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

// Call this from any user-triggered handler to unlock audio on mobile.
export function unlockAudio() {
  if (unlocked) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume();
  // Play silent buffer to fully unlock
  const buf = c.createBuffer(1, 1, 22050);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  src.start(0);
  unlocked = true;
}

function playTone({ freq, duration, type = "sine", gain = 0.22, glideTo = null, delay = 0 }) {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume();
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
  // Fast attack, decay to silence for clean "tick" feel
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// Goal: quick rising chirp + higher confirmation tone
export function playGoalSound() {
  if (!isSoundEnabled()) return;
  playTone({ freq: 440, glideTo: 880, duration: 0.14, type: "triangle", gain: 0.28 });
  playTone({ freq: 1320, duration: 0.12, type: "sine", gain: 0.18, delay: 0.09 });
}

// Undo: descending tone, softer, signals "back"
export function playUndoSound() {
  if (!isSoundEnabled()) return;
  playTone({ freq: 520, glideTo: 260, duration: 0.16, type: "sawtooth", gain: 0.18 });
}
