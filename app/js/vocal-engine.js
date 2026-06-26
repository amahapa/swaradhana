/**
 * @file vocal-engine.js
 * @description Human-voice (sargam vocal) sample player for Swaradhana. Plays
 * the 15+ swaras as recorded vocal snippets, like a sustaining instrument.
 *
 * The catch with a sung note: after a short attack the vowel reaches a steady
 * state whose waveform repeats. So to hold a note for any duration we play the
 * attack once and then LOOP a stable region of the sustain — exactly what
 * Web Audio's AudioBufferSourceNode (loop / loopStart / loopEnd) does natively.
 *
 * Samples were recorded with madhya Sa = C#. They are played at their RECORDED
 * pitch — the vocal is deliberately NOT transposed to the user's key. Per note
 * we only choose which file to play, by the note's swara + octave (taken from
 * the notation), so komal/teevra/octave variants are sung correctly in every
 * thaat; playbackRate is always 1.0.
 *
 * @module vocal-engine
 */

import audioEngine from './audio-engine.js';
import { getPositionSwara } from './music-engine.js';

// NOTE: the vocal voice plays each sample at its RECORDED pitch — it is NOT
// transposed to the user's key (playbackRate stays 1.0). The only choice made
// per note is which file (swara + octave) to play, taken from the notation.

/** Loudness multiplier — the vocal recordings sit lower than the instruments. */
const VOCAL_GAIN_BOOST = 2.5;

/** Crossfade window (s) — each note's tail overlaps the next to blend them. */
const VOCAL_CROSSFADE = 0.05;

/** Seconds of attack/onset to preserve before the sustain loop begins. */
const ATTACK_KEEP = 0.2;
/** Length of the sustain region to loop (seconds, in original sample time). */
const LOOP_LEN = 0.1;

/** App swara abbreviation -> filename stem. (lowercase = komal, M = teevra) */
const SWARA_TO_STEM = {
  S: 'S', r: 'R_k', R: 'R', g: 'G_k', G: 'G', m: 'm',
  M: 'M_t', P: 'P', d: 'D_k', D: 'D', n: 'N_k', N: 'N',
};

/**
 * The recorded files: [filename (no extension), swara abbreviation, octave].
 * Covers the bansuri's range — mandra P/D/N, full chromatic madhya, taar up to
 * Pa — with komal/teevra variants. (`d_k_lower` is lowercase in the asset set.)
 */
const FILES = [
  ['P_lower', 'P', 'lower'], ['D_lower', 'D', 'lower'], ['d_k_lower', 'd', 'lower'],
  ['N_lower', 'N', 'lower'], ['N_k_lower', 'n', 'lower'],
  ['S_middle', 'S', 'middle'], ['R_middle', 'R', 'middle'], ['R_k_middle', 'r', 'middle'],
  ['G_middle', 'G', 'middle'], ['G_k_middle', 'g', 'middle'], ['m_middle', 'm', 'middle'],
  ['M_t_middle', 'M', 'middle'], ['P_middle', 'P', 'middle'], ['D_middle', 'D', 'middle'],
  ['D_k_middle', 'd', 'middle'], ['N_middle', 'N', 'middle'], ['N_k_middle', 'n', 'middle'],
  ['S_higher', 'S', 'higher'], ['R_higher', 'R', 'higher'], ['R_k_higher', 'r', 'higher'],
  ['G_higher', 'G', 'higher'], ['G_k_higher', 'g', 'higher'], ['m_higher', 'm', 'higher'],
  ['M_t_higher', 'M', 'higher'], ['P_higher', 'P', 'higher'],
];

class VocalEngine {
  constructor() {
    /** @type {Object<string, {buffer: AudioBuffer, loopStart: number, loopEnd: number}>} */
    this.samples = {};
    this.loaded = false;
    this.loading = null;
    this._warned = {};
  }

  /**
   * Find a stable sustain loop region: trim trailing silence, take the last
   * LOOP_LEN seconds before it, and snap both points to upward zero crossings
   * (channel 0) to minimise loop-boundary clicks.
   */
  _computeLoop(buffer) {
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const n = data.length;

    let end = n - 1;
    const thr = 0.02;
    while (end > 1 && Math.abs(data[end]) < thr) end--;

    let loopEnd = end / sr;
    let loopStart = Math.max(ATTACK_KEEP, loopEnd - LOOP_LEN);

    const snapUp = (t) => {
      let i = Math.round(t * sr);
      i = Math.max(1, Math.min(n - 1, i));
      const limit = Math.round(sr * 0.02); // search within ±20ms
      for (let k = 0; k < limit; k++) {
        const j = i - k;
        if (j > 0 && data[j - 1] <= 0 && data[j] > 0) return j / sr;
      }
      return i / sr;
    };

    loopStart = snapUp(loopStart);
    loopEnd = snapUp(loopEnd);
    if (loopEnd <= loopStart + 0.01) { loopStart = ATTACK_KEEP; loopEnd = end / sr; }
    return { loopStart, loopEnd };
  }

  /** Fetch + decode all vocal files. Idempotent; returns the in-flight promise. */
  async load(basePath = 'assets/audio/vocal') {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const ctx = audioEngine.audioCtx;
      if (!ctx) { this.loading = null; return; }
      const missing = [];
      await Promise.all(FILES.map(async ([file, swara, octave]) => {
        try {
          const resp = await fetch(`${basePath}/${file}.wav`);
          if (!resp.ok) { missing.push(`${file}.wav (HTTP ${resp.status})`); return; }
          const buffer = await ctx.decodeAudioData(await resp.arrayBuffer());
          const loop = this._computeLoop(buffer);
          this.samples[`${swara}_${octave}`] = {
            buffer,
            loopStart: loop.loopStart,
            loopEnd: loop.loopEnd,
          };
        } catch (e) {
          missing.push(`${file}.wav (${e && e.message})`);
        }
      }));
      this.loaded = true;
      console.log(`[VocalEngine] Loaded ${Object.keys(this.samples).length}/${FILES.length} vocal samples:`,
        Object.keys(this.samples).sort().join(', '));
      if (missing.length) console.warn('[VocalEngine] MISSING/failed files:', missing.join(' | '));
    })();
    return this.loading;
  }

  /**
   * Play one swara as vocal, stretching it to `duration` via the sustain loop.
   * Mirrors SwarSynth.playNote's inputs so it is a drop-in for the swar bus.
   *
   * The sample is played at its RECORDED pitch (playbackRate 1.0) — NOT
   * transposed to the user's key. Only the file (swara + octave) is chosen, from
   * the note's notation (octave marker), so the right swara/octave is sung.
   *
   * @param {number} position        flute position (1-15)
   * @param {string} thaat
   * @param {number} baseSaFreq       (unused — kept for interface parity)
   * @param {number} startTime        audio-context time to start
   * @param {number} duration         note length (s)
   * @param {number} [velocity=0.7]   0-1 gain
   * @param {AudioNode} destination   node to connect to (the swar bus)
   * @returns {{source: AudioBufferSourceNode, gain: GainNode}|null}
   */
  playNote(position, thaat, baseSaFreq, startTime, duration, velocity = 0.7, destination) {
    const ctx = audioEngine.audioCtx;
    if (!ctx || !destination) return null;
    if (!Number.isInteger(position) || position < 1 || position > 15) return null;
    if (!this.loaded) { this.load(); return null; } // first use kicks off async load

    // getPositionSwara returns the swara abbreviation WITHOUT octave markers
    // (komal/teevra honoured per thaat), so the octave comes from the position:
    // 1-3 = mandra (lower), 4-10 = madhya (middle), 11-15 = taar (higher).
    const swara = (getPositionSwara(position, thaat) || '').replace(/[,']/g, '');
    if (!SWARA_TO_STEM[swara]) return null;

    let octave = 'middle';
    if (position <= 3) octave = 'lower';
    else if (position >= 11) octave = 'higher';

    // The exact file; if that octave wasn't recorded/loaded, fall back to one
    // that was (and warn — a missing octave is why a note can sound an octave off).
    let best = this.samples[`${swara}_${octave}`];
    if (!best) {
      for (const oc of ['middle', 'higher', 'lower']) {
        if (this.samples[`${swara}_${oc}`]) { best = this.samples[`${swara}_${oc}`]; break; }
      }
      if (best && !this._warned[`${swara}_${octave}`]) {
        this._warned[`${swara}_${octave}`] = true;
        console.warn(`[VocalEngine] No "${swara}_${octave}" sample loaded — substituting another octave (pos ${position}). It will sound in the wrong octave.`);
      }
    }
    if (!best) return null;

    const source = ctx.createBufferSource();
    source.buffer = best.buffer;
    source.playbackRate.value = 1.0; // recorded pitch — no transposition
    if (best.loopEnd > best.loopStart + 0.02) {
      source.loop = true;
      source.loopStart = best.loopStart;
      source.loopEnd = best.loopEnd;
    }

    const gain = ctx.createGain();
    // Vocal samples are quieter than the WebAudioFont instruments, so boost.
    const v = Math.max(0, velocity) * VOCAL_GAIN_BOOST;
    // Crossfade: fade IN over VOCAL_CROSSFADE, hold to the note's nominal end,
    // then fade OUT over VOCAL_CROSSFADE *past* that end. Because the next note
    // starts at this note's nominal end (and fades in over the same window), the
    // two overlap and blend instead of switching abruptly.
    const fin = Math.min(VOCAL_CROSSFADE, Math.max(0.005, duration * 0.5));
    const nominalEnd = startTime + Math.max(duration, fin + 0.005);
    const fadeOutEnd = nominalEnd + VOCAL_CROSSFADE;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(v, startTime + fin);
    gain.gain.setValueAtTime(v, nominalEnd);
    gain.gain.linearRampToValueAtTime(0, fadeOutEnd);

    source.connect(gain);
    gain.connect(destination);
    source.start(startTime);
    source.stop(fadeOutEnd + 0.02);
    return { source, gain };
  }
}

const vocalEngine = new VocalEngine();
export default vocalEngine;
