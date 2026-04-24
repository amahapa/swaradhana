/**
 * @fileoverview Accent sample player for Swaradhana.
 *
 * Loads per-matra accent sounds (manjira, ghungroo, tali …) from MP3 files
 * and plays them layered on top of tabla bols. The player routes through the
 * existing tabla input node on audioEngine to avoid adding new graph topology
 * — the chain stays identical to "plain tabla playback plus an extra buffer
 * source per matra", which keeps mobile stability equivalent to a multi-bol
 * matra.
 *
 * @module accents
 */

import audioEngine from './audio-engine.js';

/**
 * Accent key → file path. Keys are what gets persisted in a variation's
 * `accents` array, so they are the stable public identifier.
 */
const ACCENT_FILES = Object.freeze({
  manjira_1:  'assets/audio/other/manjira_1.mp3',
  manjira_2:  'assets/audio/other/manjira_2.mp3',
  ghungroo_1: 'assets/audio/other/ghungroo_1.mp3',
  tali_1:     'assets/audio/other/tali_1.mp3',
});

/**
 * Per-accent loudness multiplier. Kept well below 1.0 so stacked accents do
 * not push the tabla bus above 0 dBFS on mobile (there is no limiter
 * downstream).
 */
const ACCENT_GAIN = Object.freeze({
  manjira_1:  0.7,
  manjira_2:  0.7,
  ghungroo_1: 0.55,
  tali_1:     0.8,
});

const DEFAULT_ACCENT_GAIN = 0.6;

/** Human labels used in the UI palette. */
export const ACCENT_LABELS = Object.freeze({
  manjira_1:  'Manjira 1',
  manjira_2:  'Manjira 2',
  ghungroo_1: 'Ghungroo',
  tali_1:     'Tali',
});

/** Ordered list for palette rendering. */
export const ACCENT_KEYS = Object.freeze(Object.keys(ACCENT_FILES));

class AccentPlayer {
  constructor() {
    /** @type {Object<string, AudioBuffer>} */
    this.buffers = {};
    this.isLoaded = false;
    this._loadPromise = null;
  }

  /**
   * Load and decode all accent MP3s into AudioBuffers. Idempotent — calling
   * twice while the first call is pending returns the same promise.
   */
  async load() {
    if (this.isLoaded) return;
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._loadInternal().finally(() => {
      this._loadPromise = null;
    });
    return this._loadPromise;
  }

  async _loadInternal() {
    if (!audioEngine.isInitialized) await audioEngine.init();
    await audioEngine.resume();
    const ctx = audioEngine.audioCtx;
    if (!ctx) return;

    const entries = Object.entries(ACCENT_FILES);
    await Promise.all(entries.map(async ([key, url]) => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          console.warn(`[Accents] Failed to load ${url}: ${resp.status}`);
          return;
        }
        const ab = await resp.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        this.buffers[key] = buf;
      } catch (e) {
        console.warn(`[Accents] Error loading ${url}:`, e?.message || e);
      }
    }));

    this.isLoaded = true;
    console.log(`[Accents] Loaded ${Object.keys(this.buffers).length} accent samples.`);
  }

  /**
   * Schedule an accent playback at the given audio-context time.
   *
   * @param {string} key - One of ACCENT_KEYS.
   * @param {number} time - AudioContext time to start playback.
   * @param {number} [velocity=1.0] - Volume multiplier (0–1).
   */
  play(key, time, velocity = 1.0) {
    if (!audioEngine.audioCtx) return;
    const buf = this.buffers[key];
    if (!buf) return;

    const ctx = audioEngine.audioCtx;
    const now = Math.max(time, ctx.currentTime);

    const source = ctx.createBufferSource();
    source.buffer = buf;

    const gainNode = ctx.createGain();
    const level = (ACCENT_GAIN[key] ?? DEFAULT_ACCENT_GAIN) * Math.max(0, Math.min(1, velocity));
    gainNode.gain.setValueAtTime(level, now);

    // Route through the tabla input node so accents share the existing
    // graph topology — no new buses, no new compressor/convolver paths.
    let destination;
    try {
      destination = audioEngine.getInputNode('tabla');
    } catch (e) {
      destination = ctx.destination;
    }

    source.connect(gainNode);
    gainNode.connect(destination);
    source.start(now);

    // Explicit cleanup so nodes are GC'd on mobile promptly.
    source.onended = () => {
      try { source.disconnect(); } catch (_) {}
      try { gainNode.disconnect(); } catch (_) {}
    };
  }

  /**
   * Play a list of accent keys simultaneously at the given time. No-op if
   * the list is empty. Used by the scheduler when a matra has one or more
   * accents attached.
   */
  playList(keys, time, velocity = 1.0) {
    if (!keys || keys.length === 0) return;
    for (const key of keys) this.play(key, time, velocity);
  }
}

const accentPlayer = new AccentPlayer();
export default accentPlayer;
