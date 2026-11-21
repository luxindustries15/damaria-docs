const SOUND_ENABLED_KEY = 'damaria_notif_sound_enabled';
const NOTIFICATION_TONE_URL = '/assets/aistudio/notification_o14egLP_9b380fa9.mp3';

let sharedAudioCtx: AudioContext | null = null;
let decodedToneBuffer: AudioBuffer | null = null;
let toneFetchPromise: Promise<AudioBuffer | null> | null = null;
let fallbackAudioEl: HTMLAudioElement | null = null;
let audioElUnlocked = false;
let lastToneAt = 0;

function getAudioContextClass(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext || w.webkitAudioContext || null;
}

function ensureAudioContext(): AudioContext | null {
  const Ctx = getAudioContextClass();
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    try {
      sharedAudioCtx = new Ctx();
    } catch {
      return null;
    }
  }
  return sharedAudioCtx;
}

function ensureAudioElement(): HTMLAudioElement | null {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
  if (!fallbackAudioEl) {
    try {
      const el = new Audio(NOTIFICATION_TONE_URL);
      el.preload = 'auto';
      fallbackAudioEl = el;
    } catch {
      return null;
    }
  }
  return fallbackAudioEl;
}

function preloadToneBuffer(): Promise<AudioBuffer | null> {
  if (decodedToneBuffer) return Promise.resolve(decodedToneBuffer);
  if (toneFetchPromise) return toneFetchPromise;
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    return Promise.resolve(null);
  }

  const ctx = ensureAudioContext();
  if (!ctx || typeof ctx.decodeAudioData !== 'function') {
    return Promise.resolve(null);
  }

  toneFetchPromise = fetch(NOTIFICATION_TONE_URL)
    .then((res) => {
      if (!res.ok) throw new Error('Failed to load notification tone');
      return res.arrayBuffer();
    })
    .then((buf) => ctx.decodeAudioData(buf))
    .then((decoded) => {
      decodedToneBuffer = decoded;
      return decoded;
    })
    .catch(() => {
      toneFetchPromise = null;
      return null;
    });

  return toneFetchPromise;
}

export function isNotificationSoundEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SOUND_ENABLED_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function setNotificationSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore storage errors
  }
}

export function unlockNotificationSound(): void {
  const ctx = ensureAudioContext();
  if (ctx) {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
    preloadToneBuffer().catch(() => undefined);
  }

  const el = ensureAudioElement();
  if (el && !audioElUnlocked) {
    audioElUnlocked = true;
    const prevMuted = el.muted;
    el.muted = true;
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        el.pause();
        el.currentTime = 0;
        el.muted = prevMuted;
      }).catch(() => {
        el.muted = prevMuted;
        audioElUnlocked = false;
      });
    } else {
      el.muted = prevMuted;
    }
  }
}

function playViaHtmlAudio(): void {
  const el = ensureAudioElement();
  if (!el) return;
  try {
    el.muted = false;
    el.currentTime = 0;
    el.play().catch(() => undefined);
  } catch {
    // ignore playback errors
  }
}

/**
 * Plays the custom notification ringtone MP3 (/assets/aistudio/notification_o14egLP_9b380fa9.mp3).
 * Uses a decoded Web Audio buffer when unlocked for instant, reliable async playback,
 * with HTMLAudioElement fallback.
 */
export function playIphoneMessageTone(force = false): void {
  if (!force && !isNotificationSoundEnabled()) return;

  const nowMs = Date.now();
  if (!force && nowMs - lastToneAt < 450) return;
  lastToneAt = nowMs;

  const ctx = ensureAudioContext();
  if (!ctx) {
    playViaHtmlAudio();
    return;
  }

  const startBufferPlayback = (buffer: AudioBuffer) => {
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      playViaHtmlAudio();
    }
  };

  const triggerPlay = () => {
    if (decodedToneBuffer) {
      startBufferPlayback(decodedToneBuffer);
      return;
    }

    preloadToneBuffer().then((buffer) => {
      if (buffer) {
        startBufferPlayback(buffer);
      } else {
        playViaHtmlAudio();
      }
    });
  };

  if (ctx.state === 'suspended') {
    ctx
      .resume()
      .then(triggerPlay)
      .catch(() => playViaHtmlAudio());
  } else {
    triggerPlay();
  }
}
