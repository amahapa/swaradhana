/**
 * @fileoverview Sample-based tabla player for Swaradhana.
 *
 * Loads pre-recorded MP3 files of real tabla bols and plays them via
 * AudioBufferSourceNode. Supports pitch-shifting to match the user's
 * selected key (samples are recorded at a reference key, e.g., E).
 *
 * When a bol is played, the corresponding AudioBuffer is triggered with
 * a playbackRate adjustment for key transposition. For short durations,
 * a quick fade-out envelope is applied.
 *
 * @module tabla-samples
 */

import audioEngine from './audio-engine.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fallback reference key when the sample set is unknown. */
const DEFAULT_REFERENCE_FREQ = 164.81; // E3

/**
 * Per-sample-set reference Sa frequency. Used to compute the runtime
 * playbackRate for dayan bols (`playbackRate = userSa / referenceFreq`).
 *
 * `tabla_e_1` was recorded at E3 (164.81 Hz).
 * `tabla_c_1` is the Naad set — dayan bols pitch-normalised to C4 (261.63 Hz).
 */
const REFERENCE_FREQ_BY_SET = Object.freeze({
    'tabla_e_1': 164.81,  // E3
    'tabla_c_1': 261.63,  // C4
});

/**
 * Per-sample-set loudness multiplier. Applied to the bol's velocity at
 * playback time. Use this to normalise sets recorded at different levels.
 * `tabla_c_1` is ~20% quieter than `tabla_e_1` at the same velocity, so
 * it gets a 1.2× boost.
 */
const GAIN_BY_SET = Object.freeze({
    'tabla_e_1': 1.0,
    'tabla_c_1': 1.2,  // Naad recordings are ~20% quieter than tabla_e_1 — kept at 1.2 rather
                       // than 1.5 to avoid per-bol peaks exceeding 1.0 on mobile (which the
                       // removed per-bus limiter used to absorb).
});
const DEFAULT_SET_GAIN = 1.0;

/**
 * Mapping from bol names (as used in taal definitions) to sample filenames.
 * Handles both ASCII and Devanagari bol names.
 * Some bols map to the same sample or a close alternative.
 */
const BOL_TO_FILE = {
  // Direct matches
  'Dha': 'Dha', 'Dhin': 'Dhin', 'Dhi': 'Dhi', 'Ta': 'Ta', 'Na': 'Na',
  'Tin': 'Tin', 'Ti': 'Ti', 'Ge': 'Ge', 'Ke': 'Ke', 'Ka': 'Ka',
  'Kat': 'Kat', 'Tu': 'Tu', 'Ga': 'Ga', 'Ghe': 'Ghe', 'Te': 'Te', 'R': 'R',

  // Compound bols — use the first component
  'DhaGe': 'Dha', 'TiRaKiTa': 'Ti',

  // Devanagari mappings
  'धा': 'Dha', 'धिं': 'Dhin', 'धी': 'Dhi', 'ता': 'Ta', 'ना': 'Na',
  'तिं': 'Tin', 'ती': 'Ti', 'गे': 'Ge', 'क': 'Ke', 'तू': 'Tu',
  'कत': 'Kat', 'रे': 'R', 'ग': 'Ga', 'तिरकिट': 'Ti',
};

// ---------------------------------------------------------------------------
// TablaSamplePlayer class
// ---------------------------------------------------------------------------

class TablaSamplePlayer {
  constructor() {
    /** @type {Object<string, AudioBuffer>} Loaded audio buffers keyed by bol name */
    this.buffers = {};

    /** @type {Object<string, number>} Per-sample offset (seconds) to skip leading silence */
    this.sampleOffsets = {};

    /** @type {string|null} Currently loaded sample set path */
    this.loadedSet = null;

    /** @type {boolean} Whether buffers have been loaded */
    this.isLoaded = false;

    /** @type {number} Current Sa frequency for pitch shifting */
    this.saFreq = DEFAULT_REFERENCE_FREQ;

    /** @type {number} Reference Sa frequency of the currently-loaded set. */
    this.referenceFreq = DEFAULT_REFERENCE_FREQ;

    /** @type {number} Loudness multiplier for the currently-loaded set. */
    this.setGain = DEFAULT_SET_GAIN;
  }

  /**
   * Analyze a decoded AudioBuffer to find where the audio actually starts,
   * skipping MP3 encoder padding / leading silence. Scans channel 0 for the
   * first sample whose absolute value exceeds a threshold.
   *
   * @param {AudioBuffer} buffer - Decoded audio buffer
   * @returns {number} Offset in seconds to the first audible sample
   * @private
   */
  _detectLeadingSilence(buffer) {
    const data = buffer.getChannelData(0);
    const threshold = 0.005; // -46 dB — well above noise floor
    const sampleRate = buffer.sampleRate;

    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > threshold) {
        // Back up a tiny bit (2ms) to avoid clipping the attack transient
        const offsetSamples = Math.max(0, i - Math.floor(sampleRate * 0.002));
        return offsetSamples / sampleRate;
      }
    }
    return 0; // No silence detected (or entirely silent)
  }

  /**
   * Load all MP3 files from a tabla sample directory into AudioBuffers.
   *
   * @param {string} setPath - Path to the sample directory, e.g., 'assets/audio/tabla/tabla_e_1'
   * @returns {Promise<void>}
   */
  async loadSampleSet(setPath) {
    if (!audioEngine.isInitialized) {
      await audioEngine.init();
    }
    await audioEngine.resume();

    const ctx = audioEngine.audioCtx;
    if (!ctx) throw new Error('[TablaSamples] No AudioContext');

    // List of all sample files to load
    const files = [
      'Dha', 'Dhin', 'Dhi', 'Ta', 'Na', 'Tin', 'Ti',
      'Ge', 'Ke', 'Ka', 'Kat', 'Tu', 'Ga', 'Ghe', 'Te', 'R'
    ];

    this.buffers = {};
    this.sampleOffsets = {};
    const loadPromises = files.map(async (name) => {
      const url = `${setPath}/${name}.mp3`;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[TablaSamples] Failed to load ${url}: ${response.status}`);
          return;
        }
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        this.buffers[name] = audioBuffer;

        // Detect and store leading silence offset for precise timing
        const offset = this._detectLeadingSilence(audioBuffer);
        this.sampleOffsets[name] = offset;
        if (offset > 0.001) {
          console.log(`[TablaSamples] ${name}: ${(offset * 1000).toFixed(1)}ms leading silence detected`);
        }
      } catch (err) {
        console.warn(`[TablaSamples] Error loading ${url}:`, err.message);
      }
    });

    await Promise.all(loadPromises);
    this.loadedSet = setPath;
    this.isLoaded = true;

    // Derive the reference Sa for this set so dayan bols pitch-shift against
    // the correct base frequency at runtime.
    const setName = setPath.split('/').filter(Boolean).pop();
    this.referenceFreq = REFERENCE_FREQ_BY_SET[setName] ?? DEFAULT_REFERENCE_FREQ;
    this.setGain = GAIN_BY_SET[setName] ?? DEFAULT_SET_GAIN;

    console.log(`[TablaSamples] Loaded ${Object.keys(this.buffers).length} samples from ${setPath} (referenceFreq=${this.referenceFreq} Hz)`);
  }

  /**
   * Set the target Sa frequency for pitch shifting.
   * Samples are pitch-shifted relative to the reference frequency.
   *
   * @param {number} freq - Target Sa frequency in Hz
   */
  setSaFreq(freq) {
    this.saFreq = freq;
  }

  /**
   * Play a tabla bol sample at the specified time.
   *
   * The sample is pitch-shifted to match the current key by adjusting
   * playbackRate. Only the Dayan (treble) component is shifted — bayan-heavy
   * bols (Ge, Ke, Ka, Kat) stay at their natural bass frequency.
   *
   * For short durations, a fade-out envelope is applied so the sample
   * doesn't ring past the next beat.
   *
   * @param {string} bolName - Bol name (ASCII or Devanagari)
   * @param {number} time - AudioContext time to start playback
   * @param {number} velocity - Volume multiplier (0-1)
   * @param {number} [maxDuration] - Optional max duration; sample fades out after this
   */
  playBol(bolName, time, velocity, maxDuration) {
    if (!this.isLoaded || !audioEngine.audioCtx) return;

    // Skip rests
    if (!bolName || bolName === 'x') return;

    // Resolve bol name to sample file name
    const fileName = BOL_TO_FILE[bolName] || BOL_TO_FILE[bolName.trim()] || null;
    if (!fileName) {
      console.warn(`[TablaSamples] No sample mapping for bol "${bolName}"`);
      return;
    }

    const buffer = this.buffers[fileName];
    if (!buffer) {
      console.warn(`[TablaSamples] No buffer loaded for "${fileName}"`);
      return;
    }

    const ctx = audioEngine.audioCtx;
    const now = Math.max(time, ctx.currentTime);

    // Create source
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Pitch shift only the dayan bols — the bayan always stays at its
    // recorded pitch (~C/C# bass) regardless of the user's global key.
    const bayanBols = new Set(['Ga', 'Ge', 'Ghe', 'Ka', 'Kat', 'Ke']);
    if (!bayanBols.has(fileName)) {
      // Dayan: scale playbackRate so the sample's reference Sa lands on
      // the user's current Sa. All dayan bols in a set share one
      // reference frequency, so a single ratio applies uniformly.
      source.playbackRate.value = this.saFreq / this.referenceFreq;
    } else {
      source.playbackRate.value = 1.0;
    }

    // Gain envelope for velocity and optional fade-out. Scale by the
    // per-set loudness multiplier so quieter sample sets can be boosted.
    // Cap at 2.0 as a safety net; the downstream tabla bus compressor
    // will absorb any transient overs.
    const scaledVelocity = Math.max(0, Math.min(2, velocity * this.setGain));
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(scaledVelocity, now);

    // Connect: source → gain → tabla input on audio engine
    let destination;
    try {
      destination = audioEngine.getInputNode('tabla');
    } catch (e) {
      destination = ctx.destination;
    }

    source.connect(gainNode);
    gainNode.connect(destination);

    // Skip leading silence (MP3 encoder padding) for precise timing
    const sampleOffset = this.sampleOffsets[fileName] || 0;

    // Start playback from after the silence
    source.start(now, sampleOffset);

    // If maxDuration is specified and shorter than the sample, fade out and stop
    if (maxDuration && maxDuration > 0) {
      const fadeStart = now + maxDuration * 0.7;
      const fadeEnd = now + maxDuration;
      gainNode.gain.setValueAtTime(scaledVelocity, fadeStart);
      gainNode.gain.exponentialRampToValueAtTime(0.001, fadeEnd);
      try {
        source.stop(fadeEnd + 0.05);
      } catch (e) {
        // Ignore — sample may have already ended naturally
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

const tablaSamplePlayer = new TablaSamplePlayer();
export default tablaSamplePlayer;
