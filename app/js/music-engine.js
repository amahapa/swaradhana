/**
 * music-engine.js — Music Theory Engine for Swaradhana
 *
 * Pure functions for swara calculations, thaat transformations, and
 * frequency mappings in Hindustani Classical Music. No audio playback,
 * no DOM manipulation, no side effects.
 *
 * All frequency math uses Just Intonation ratios (not equal temperament).
 * Flute positions 1-15 map to a 2.5-octave range on the Bansuri:
 *   1-3  = Mandra saptak  (lower octave, freq / 2)
 *   4-10 = Madhya saptak  (middle octave, freq * 1)
 *   11-15 = Taar saptak   (upper octave, freq * 2)
 *
 * @module music-engine
 */

import {
  KEY_FREQUENCIES,
  SWAR_RATIOS,
  FLUTE_POSITIONS,
  THAAT_DEFINITIONS,
  LAYA_RANGES,
  SWAR_LABELS,
} from './config.js';

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * Returns the octave multiplier for a given flute position.
 * Positions 1-3 are mandra (0.5), 4-10 are madhya (1), 11-15 are taar (2).
 *
 * @param {number} position - Flute position (1-15)
 * @returns {number} Octave multiplier (0.5, 1, or 2)
 */
function _octaveMultiplier(position) {
  if (position >= 1 && position <= 3) return 0.5;
  if (position >= 4 && position <= 10) return 1;
  if (position >= 11 && position <= 15) return 2;
  throw new RangeError(`Invalid flute position: ${position}. Must be 1-15.`);
}

/**
 * Returns the octave suffix for display labels.
 *
 * @param {number} position - Flute position (1-15)
 * @returns {string} ',' for mandra, '' for madhya, "'" for taar
 */
function _octaveSuffix(position) {
  if (position >= 1 && position <= 3) return ',';
  if (position >= 4 && position <= 10) return '';
  if (position >= 11 && position <= 15) return "'";
  throw new RangeError(`Invalid flute position: ${position}. Must be 1-15.`);
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Returns the effective Sa frequency after applying a fine-tuning cents offset.
 *
 * Used for temperature compensation — bamboo flutes go sharp in heat and flat
 * in cold. The fine-tuning slider adjusts all pitches by a few cents so the
 * tanpura, tabla, and swar synth match the flute's actual pitch.
 *
 * Formula: KEY_FREQUENCIES[key] * 2^(fineTuningCents / 1200)
 *
 * @param {string} key - The flute key (e.g., 'G', 'C', 'A', 'Bb', 'C#', 'E low', 'E high')
 * @param {number} fineTuningCents - Cents offset, typically -50 to +50
 * @returns {number} The effective Sa frequency in Hz
 * @throws {Error} If the key is not found in KEY_FREQUENCIES
 *
 * @example
 * getEffectiveSaFreq('G', 0)   // 196.00
 * getEffectiveSaFreq('G', 8)   // ~196.91
 * getEffectiveSaFreq('C', -10) // ~260.12
 */
export function getEffectiveSaFreq(key, fineTuningCents) {
  const baseFreq = KEY_FREQUENCIES[key];
  if (baseFreq === undefined) {
    throw new Error(`Unknown key "${key}". Valid keys: ${Object.keys(KEY_FREQUENCIES).join(', ')}`);
  }
  return baseFreq * Math.pow(2, fineTuningCents / 1200);
}

/**
 * Returns the frequency for a swara given its ratio key, the base Sa
 * frequency, and an octave shift.
 *
 * The ratio key is the single-letter swara code used in SWAR_RATIOS:
 *   S, r, R, g, G, m, M, P, d, D, n, N
 *
 * Octave shift: 0 = madhya saptak, -1 = mandra, +1 = taar.
 *
 * Formula: baseSaFreq * SWAR_RATIOS[swarRatioKey] * 2^octaveShift
 *
 * @param {string} swarRatioKey - Swara letter (e.g., 'P', 'G', 'r', 'M')
 * @param {number} baseSaFreq - The Sa frequency in Hz
 * @param {number} [octaveShift=0] - Octave offset (-1, 0, or +1)
 * @returns {number} Frequency in Hz
 * @throws {Error} If the swarRatioKey is not found in SWAR_RATIOS
 *
 * @example
 * getSwarFreq('P', 277.18, 0)   // 415.77  (Pa in madhya saptak)
 * getSwarFreq('P', 277.18, -1)  // 207.89  (Pa in mandra saptak)
 * getSwarFreq('S', 277.18, 1)   // 554.36  (Sa in taar saptak)
 */
export function getSwarFreq(swarRatioKey, baseSaFreq, octaveShift = 0) {
  const ratio = SWAR_RATIOS[swarRatioKey];
  if (ratio === undefined) {
    throw new Error(
      `Unknown swara ratio key "${swarRatioKey}". Valid keys: ${Object.keys(SWAR_RATIOS).join(', ')}`
    );
  }
  return baseSaFreq * ratio * Math.pow(2, octaveShift);
}

/**
 * Returns the frequency for a flute position (1-15) given the base Sa
 * frequency and thaat.
 *
 * The function resolves the swara at the given position (accounting for thaat
 * alterations), looks up its just-intonation ratio, and applies the octave
 * multiplier for the position's saptak.
 *
 * Octave logic:
 *   Positions 1-3:   mandra saptak (frequency / 2)
 *   Positions 4-10:  madhya saptak (frequency * 1)
 *   Positions 11-15: taar saptak   (frequency * 2)
 *
 * @param {number} position - Flute position (1-15)
 * @param {number} baseSaFreq - The Sa frequency in Hz
 * @param {string} [thaat='bilawal'] - Thaat name (lowercase)
 * @returns {number} Frequency in Hz
 * @throws {RangeError} If position is outside 1-15
 *
 * @example
 * getPositionFreq(1, 277.18, 'bilawal')  // 207.89  (P, — mandra Pa)
 * getPositionFreq(4, 277.18, 'bilawal')  // 277.18  (S — madhya Sa)
 * getPositionFreq(11, 277.18, 'bilawal') // 554.36  (S' — taar Sa)
 * getPositionFreq(3, 277.18, 'khamaj')   // 246.38  (n, — komal Ni in mandra)
 */
export function getPositionFreq(position, baseSaFreq, thaat = 'bilawal') {
  const swarKey = getPositionSwara(position, thaat);
  const ratio = SWAR_RATIOS[swarKey];

  if (ratio === undefined) {
    console.error(`[getPositionFreq] No ratio found for swara "${swarKey}" at position ${position}, thaat "${thaat}". SWAR_RATIOS keys:`, Object.keys(SWAR_RATIOS));
    return baseSaFreq; // fallback to Sa frequency to avoid NaN
  }

  const multiplier = _octaveMultiplier(position);
  const freq = baseSaFreq * ratio * multiplier;

  if (!Number.isFinite(freq)) {
    console.error(`[getPositionFreq] Non-finite frequency: baseSa=${baseSaFreq}, ratio=${ratio}, mult=${multiplier}, swar="${swarKey}"`);
    return baseSaFreq;
  }

  return freq;
}

/**
 * Returns the swara name (ratio key letter) for a flute position in a
 * given thaat.
 *
 * In Bilawal (default), uses the FLUTE_POSITIONS array directly.
 * For other thaats, checks THAAT_DEFINITIONS[thaat].alterations for
 * overrides at this position and substitutes accordingly.
 *
 * @param {number} position - Flute position (1-15)
 * @param {string} [thaat='bilawal'] - Thaat name (lowercase)
 * @returns {string} Swara letter (e.g., 'P', 'G', 'r', 'M', 'n')
 * @throws {RangeError} If position is outside 1-15
 * @throws {Error} If thaat is not found in THAAT_DEFINITIONS
 *
 * @example
 * getPositionSwara(6, 'bilawal')  // 'G'  (Shuddha Gandhar)
 * getPositionSwara(6, 'kafi')     // 'g'  (Komal Gandhar)
 * getPositionSwara(7, 'kalyan')   // 'M'  (Tivra Madhyam)
 * getPositionSwara(5, 'bhairav')  // 'r'  (Komal Rishabh)
 */
export function getPositionSwara(position, thaat = 'bilawal') {
  if (position < 1 || position > 15) {
    throw new RangeError(`Invalid flute position: ${position}. Must be 1-15.`);
  }

  // FLUTE_POSITIONS is a 15-element array of {position, swara} objects, indexed 0-14.
  // The swara field may include octave markers ('P,', "S'") — strip them to get the ratio key.
  const entry = FLUTE_POSITIONS[position - 1];
  const defaultSwara = entry.swara.replace(/[,']/g, '');

  if (thaat === 'bilawal') {
    return defaultSwara;
  }

  const thaatDef = THAAT_DEFINITIONS[thaat];
  if (!thaatDef) {
    throw new Error(
      `Unknown thaat "${thaat}". Valid thaats: ${Object.keys(THAAT_DEFINITIONS).join(', ')}`
    );
  }

  // Check if this position has an alteration in the given thaat
  const alterations = thaatDef.alterations;
  if (alterations && alterations[position] !== undefined) {
    return alterations[position];
  }

  return defaultSwara;
}

/**
 * Returns the display label for a flute position, with appropriate octave
 * markers and notation language.
 *
 * Octave markers:
 *   Positions 1-3:   comma suffix   (e.g., 'P,' or 'प,')
 *   Positions 4-10:  no suffix      (e.g., 'G' or 'ग')
 *   Positions 11-15: apostrophe     (e.g., "S'" or "सा'")
 *
 * Notation languages:
 *   'hindi'   — uses SWAR_LABELS mapping (Devanagari: सा, रे, ग, etc.)
 *   'english' — uses the swara ratio key letter (S, R, G, m, etc.)
 *
 * @param {number} position - Flute position (1-15)
 * @param {string} [thaat='bilawal'] - Thaat name (lowercase)
 * @param {string} [notation='hindi'] - 'hindi' or 'english'
 * @returns {string} Display label with octave marker
 *
 * @example
 * getPositionLabel(1, 'bilawal', 'hindi')    // 'प,'
 * getPositionLabel(1, 'bilawal', 'english')  // 'P,'
 * getPositionLabel(6, 'bilawal', 'hindi')    // 'ग'
 * getPositionLabel(11, 'bilawal', 'hindi')   // "सा'"
 * getPositionLabel(3, 'khamaj', 'english')   // 'n,'
 */
export function getPositionLabel(position, thaat = 'bilawal', notation = 'hindi') {
  const swarKey = getPositionSwara(position, thaat);
  const suffix = _octaveSuffix(position);

  if (notation === 'hindi') {
    const hindiLabel = SWAR_LABELS[swarKey];
    return hindiLabel + suffix;
  }

  // English notation — use the swara letter directly
  return swarKey + suffix;
}

/**
 * Returns a pre-computed position table for a given thaat — an array of 15
 * objects, one per flute position, containing position number, swara key,
 * display label (Hindi), and frequency at the default Sa.
 *
 * Uses the default Sa frequency from KEY_FREQUENCIES (key 'C#' = 277.18 Hz)
 * to match the reference tables in frequency_mapping.md and
 * thaats_and_raags.md.
 *
 * @param {string} thaat - Thaat name (lowercase, e.g., 'bilawal', 'kalyan')
 * @returns {Array<{position: number, swara: string, label: string, freq: number}>}
 *   Array of 15 position objects
 *
 * @example
 * getTheatPositionTable('bilawal')
 * // [
 * //   { position: 1,  swara: 'P', label: 'प,',  freq: 207.89 },
 * //   { position: 2,  swara: 'D', label: 'ध,',  freq: 230.98 },
 * //   ...
 * //   { position: 15, swara: 'P', label: "प'",   freq: 831.53 },
 * // ]
 *
 * getTheatPositionTable('khamaj')
 * // Position 3 becomes { position: 3, swara: 'n', label: 'नि,', freq: 246.38 }
 */
export function getTheatPositionTable(thaat) {
  // The reference tables in the docs use Sa = 277.18 Hz (C# key)
  const defaultSaFreq = KEY_FREQUENCIES['C#'];

  const table = [];
  for (let pos = 1; pos <= 15; pos++) {
    const swara = getPositionSwara(pos, thaat);
    const label = getPositionLabel(pos, thaat, 'hindi');
    const freq = parseFloat(getPositionFreq(pos, defaultSaFreq, thaat).toFixed(2));
    table.push({ position: pos, swara, label, freq });
  }
  return table;
}

/**
 * Returns an object mapping flute positions 1-15 to their frequencies for
 * a given base Sa frequency and thaat.
 *
 * This is the primary lookup used by the audio engine to know what frequency
 * each position should produce. The keys are position numbers (as integers),
 * the values are frequencies in Hz.
 *
 * @param {number} baseSaFreq - The Sa frequency in Hz
 * @param {string} [thaat='bilawal'] - Thaat name (lowercase)
 * @returns {Object<number, number>} Map of position (1-15) to frequency (Hz)
 *
 * @example
 * const freqs = getAllPositionFreqs(277.18, 'bilawal');
 * freqs[1]  // 207.89  (P,)
 * freqs[4]  // 277.18  (S)
 * freqs[8]  // 415.77  (P)
 * freqs[11] // 554.36  (S')
 */
export function getAllPositionFreqs(baseSaFreq, thaat = 'bilawal') {
  const freqs = {};
  for (let pos = 1; pos <= 15; pos++) {
    freqs[pos] = getPositionFreq(pos, baseSaFreq, thaat);
  }
  return freqs;
}

/**
 * Converts a frequency in Hz to the nearest MIDI note number.
 *
 * MIDI note 69 = A4 = 440 Hz. Each semitone is one MIDI number.
 * Formula: Math.round(69 + 12 * log2(freq / 440))
 *
 * This is useful for mapping detected pitches to keyboard notes or for
 * interfacing with WebAudioFont (which uses MIDI note numbers).
 *
 * @param {number} freq - Frequency in Hz (must be positive)
 * @returns {number} Nearest MIDI note number (integer)
 * @throws {RangeError} If freq is not positive
 *
 * @example
 * freqToMidi(440)    // 69  (A4)
 * freqToMidi(261.63) // 60  (C4, Middle C)
 * freqToMidi(277.18) // 61  (C#4)
 * freqToMidi(196.00) // 55  (G3)
 */
export function freqToMidi(freq) {
  if (freq <= 0) {
    throw new RangeError(`Frequency must be positive. Got: ${freq}`);
  }
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

/**
 * Returns the cents difference between a played frequency and a target
 * frequency.
 *
 * Formula: 1200 * log2(playedFreq / targetFreq)
 *
 * A positive result means the played note is sharp (higher than target).
 * A negative result means it is flat (lower than target).
 *
 * One cent = 1/100 of a semitone. Typical pitch tolerance for grading:
 *   Beginner:     +/- 30 cents
 *   Intermediate: +/- 20 cents
 *   Advanced:     +/- 10 cents
 *   Expert:       +/-  5 cents
 *
 * @param {number} playedFreq - The detected frequency in Hz
 * @param {number} targetFreq - The expected frequency in Hz
 * @returns {number} Cents difference (positive = sharp, negative = flat)
 * @throws {RangeError} If either frequency is not positive
 *
 * @example
 * freqToCents(442, 440)   // ~7.85 cents sharp
 * freqToCents(438, 440)   // ~-7.89 cents flat
 * freqToCents(440, 440)   // 0 (perfectly in tune)
 * freqToCents(277.18, 277.18) // 0
 */
export function freqToCents(playedFreq, targetFreq) {
  if (playedFreq <= 0) {
    throw new RangeError(`Played frequency must be positive. Got: ${playedFreq}`);
  }
  if (targetFreq <= 0) {
    throw new RangeError(`Target frequency must be positive. Got: ${targetFreq}`);
  }
  return 1200 * Math.log2(playedFreq / targetFreq);
}

/**
 * Classifies a BPM tempo value into one of the five Hindustani laya
 * categories using the LAYA_RANGES table from config.
 *
 * Laya ranges (from written_music.md):
 *   Ati-Vilambit (very slow):   30-50 BPM
 *   Vilambit (slow):            50-80 BPM
 *   Madhya (medium):            80-140 BPM
 *   Drut (fast):                140-240 BPM
 *   Ati-Drut (very fast):       240+ BPM
 *
 * At boundary values the higher category takes precedence (e.g., 50 BPM
 * is Vilambit, 80 BPM is Madhya, 140 BPM is Drut, 240 BPM is Ati-Drut).
 *
 * @param {number} bpm - Tempo in beats per minute
 * @returns {string} Laya classification: 'Ati-Vilambit', 'Vilambit',
 *   'Madhya', 'Drut', or 'Ati-Drut'
 * @throws {RangeError} If bpm is not a positive number
 *
 * @example
 * classifyLaya(40)   // 'Ati-Vilambit'
 * classifyLaya(65)   // 'Vilambit'
 * classifyLaya(100)  // 'Madhya'
 * classifyLaya(180)  // 'Drut'
 * classifyLaya(300)  // 'Ati-Drut'
 */
export function classifyLaya(bpm) {
  if (bpm <= 0 || !Number.isFinite(bpm)) {
    throw new RangeError(`BPM must be a positive finite number. Got: ${bpm}`);
  }

  // LAYA_RANGES is an object: { atiVilambit: [30,50], vilambit: [50,80], ... }
  // Display labels for each key
  const labels = {
    atiVilambit: 'Ati-Vilambit',
    vilambit: 'Vilambit',
    madhya: 'Madhya',
    drut: 'Drut',
    atiDrut: 'Ati-Drut',
  };

  for (const [key, [min, max]] of Object.entries(LAYA_RANGES)) {
    if (bpm >= min && bpm < max) {
      return labels[key] || key;
    }
  }

  // If bpm exceeds all defined ranges, return the fastest category
  return 'Ati-Drut';
}

/**
 * Returns the recommended tanpura voicing ('male' or 'female') based on
 * the selected flute key.
 *
 * From the Global Pitch Synchronization spec (features.md):
 *   Keys C through E (lower register / bass flutes) -> 'male' (deep voicing,
 *     lower filter cutoff ~700 Hz, warm bass emphasis)
 *   Keys F through B (higher register flutes) -> 'female' (bright voicing,
 *     higher filter cutoff ~1200 Hz, crisper overtones)
 *
 * The key ordering follows the chromatic scale: C, C#, D, E (low), E (high)
 * are all bass/male; F, G, A, Bb, B are all female/bright.
 *
 * @param {string} key - The flute key (e.g., 'G', 'C', 'E low', 'Bb')
 * @returns {string} 'male' or 'female'
 *
 * @example
 * getTanpuraVoicing('C')      // 'male'
 * getTanpuraVoicing('C#')     // 'male'
 * getTanpuraVoicing('D')      // 'male'
 * getTanpuraVoicing('E low')  // 'male'
 * getTanpuraVoicing('E high') // 'male'
 * getTanpuraVoicing('F')      // 'female'
 * getTanpuraVoicing('G')      // 'female'
 * getTanpuraVoicing('Bb')     // 'female'
 */
export function getTanpuraVoicing(key) {
  // Male/deep voicing keys: C, C#, D, E low, E high
  const maleKeys = ['C', 'C#', 'D', 'E low', 'E high'];
  if (maleKeys.includes(key)) {
    return 'male';
  }
  return 'female';
}

/**
 * Returns the just intonation ratio for a flute position in a given thaat.
 *
 * This combines the position-to-swara lookup (which accounts for thaat
 * alterations) with the SWAR_RATIOS table. The returned ratio is the
 * multiplier relative to Sa — to get the actual frequency, multiply by
 * the base Sa frequency and the octave multiplier for the position.
 *
 * @param {number} position - Flute position (1-15)
 * @param {string} [thaat='bilawal'] - Thaat name (lowercase)
 * @returns {number} Just intonation ratio (e.g., 1.5 for Pa, 1.25 for Shuddha Ga)
 * @throws {RangeError} If position is outside 1-15
 *
 * @example
 * getSwarRatioForPosition(1, 'bilawal')   // 1.5     (Pa = 3/2)
 * getSwarRatioForPosition(4, 'bilawal')   // 1       (Sa = 1/1)
 * getSwarRatioForPosition(6, 'bilawal')   // 1.25    (Shuddha Ga = 5/4)
 * getSwarRatioForPosition(6, 'kafi')      // 1.185...(Komal Ga = 32/27)
 * getSwarRatioForPosition(7, 'kalyan')    // 1.40625 (Tivra Ma = 45/32)
 */
export function getSwarRatioForPosition(position, thaat = 'bilawal') {
  const swarKey = getPositionSwara(position, thaat);
  return SWAR_RATIOS[swarKey];
}

// ---------------------------------------------------------------------------
// Unit Test Examples
// ---------------------------------------------------------------------------
/*
 * ========================================================================
 * UNIT TEST VERIFICATION EXAMPLES
 * ========================================================================
 * These calculations can be verified manually using the formulas and
 * reference tables from frequency_mapping.md and thaats_and_raags.md.
 *
 * All reference frequencies use Sa = 277.18 Hz (C# key) unless noted.
 *
 * ---- getEffectiveSaFreq ----
 *
 * Test 1: No fine-tuning
 *   getEffectiveSaFreq('G', 0) = 196.00
 *   => KEY_FREQUENCIES['G'] * 2^(0/1200) = 196.00 * 1 = 196.00
 *
 * Test 2: Positive cents
 *   getEffectiveSaFreq('G', 8) = 196.00 * 2^(8/1200) = 196.00 * 1.004626 = ~196.91
 *
 * Test 3: Negative cents
 *   getEffectiveSaFreq('C', -10) = 261.63 * 2^(-10/1200) = 261.63 * 0.99424 = ~260.12
 *
 * ---- getSwarFreq ----
 *
 * Test 4: Pa in madhya saptak
 *   getSwarFreq('P', 277.18, 0) = 277.18 * (3/2) * 2^0 = 277.18 * 1.5 = 415.77
 *
 * Test 5: Pa in mandra saptak
 *   getSwarFreq('P', 277.18, -1) = 277.18 * 1.5 * 0.5 = 207.885 = ~207.89
 *
 * Test 6: Sa in taar saptak
 *   getSwarFreq('S', 277.18, 1) = 277.18 * 1 * 2 = 554.36
 *
 * Test 7: Komal Re
 *   getSwarFreq('r', 277.18, 0) = 277.18 * (256/243) = 277.18 * 1.05350 = ~291.94
 *
 * ---- getPositionFreq ----
 *
 * Test 8: Position 1 (P,) in Bilawal
 *   getPositionFreq(1, 277.18, 'bilawal')
 *   = 277.18 * SWAR_RATIOS['P'] * 0.5
 *   = 277.18 * 1.5 * 0.5 = 207.885 = ~207.89
 *
 * Test 9: Position 4 (S) in Bilawal
 *   getPositionFreq(4, 277.18, 'bilawal')
 *   = 277.18 * SWAR_RATIOS['S'] * 1
 *   = 277.18 * 1 * 1 = 277.18
 *
 * Test 10: Position 11 (S') in Bilawal
 *   getPositionFreq(11, 277.18, 'bilawal')
 *   = 277.18 * SWAR_RATIOS['S'] * 2
 *   = 277.18 * 1 * 2 = 554.36
 *
 * Test 11: Position 3 in Khamaj (n, instead of N,)
 *   getPositionFreq(3, 277.18, 'khamaj')
 *   = 277.18 * SWAR_RATIOS['n'] * 0.5
 *   = 277.18 * (16/9) * 0.5
 *   = 277.18 * 1.77778 * 0.5 = 246.382 = ~246.38
 *
 * Test 12: Position 7 in Kalyan (M instead of m)
 *   getPositionFreq(7, 277.18, 'kalyan')
 *   = 277.18 * SWAR_RATIOS['M'] * 1
 *   = 277.18 * (45/32) = 277.18 * 1.40625 = 389.691 = ~389.69
 *
 * ---- getPositionSwara ----
 *
 * Test 13: Bilawal positions (all shuddha)
 *   getPositionSwara(1, 'bilawal')  = 'P'
 *   getPositionSwara(5, 'bilawal')  = 'R'
 *   getPositionSwara(7, 'bilawal')  = 'm'
 *   getPositionSwara(10, 'bilawal') = 'N'
 *
 * Test 14: Kalyan alterations (tivra Ma at positions 7, 14)
 *   getPositionSwara(7, 'kalyan')   = 'M'
 *   getPositionSwara(14, 'kalyan')  = 'M'
 *   getPositionSwara(6, 'kalyan')   = 'G'  (unchanged)
 *
 * Test 15: Bhairavi (maximum alterations: r, g, d, n)
 *   getPositionSwara(5, 'bhairavi')  = 'r'
 *   getPositionSwara(6, 'bhairavi')  = 'g'
 *   getPositionSwara(2, 'bhairavi')  = 'd'
 *   getPositionSwara(3, 'bhairavi')  = 'n'
 *   getPositionSwara(7, 'bhairavi')  = 'm'  (unchanged)
 *
 * Test 16: Todi (r, g, M, d)
 *   getPositionSwara(5, 'todi')   = 'r'
 *   getPositionSwara(6, 'todi')   = 'g'
 *   getPositionSwara(7, 'todi')   = 'M'
 *   getPositionSwara(2, 'todi')   = 'd'
 *   getPositionSwara(3, 'todi')   = 'N'  (unchanged — Nishad is shuddha in Todi)
 *
 * ---- getPositionLabel ----
 *
 * Test 17: Mandra with Hindi
 *   getPositionLabel(1, 'bilawal', 'hindi') = 'प,'   (Pa + comma)
 *
 * Test 18: Madhya with English
 *   getPositionLabel(6, 'bilawal', 'english') = 'G'  (no suffix)
 *
 * Test 19: Taar with Hindi
 *   getPositionLabel(11, 'bilawal', 'hindi') = "सा'"  (Sa + apostrophe)
 *
 * Test 20: Khamaj position 3 in English
 *   getPositionLabel(3, 'khamaj', 'english') = 'n,'  (komal Ni + comma)
 *
 * ---- getTheatPositionTable ----
 *
 * Test 21: Bilawal table, verify a few entries (Sa = 277.18 Hz)
 *   table[0]  = { position: 1,  swara: 'P', label: 'प,',  freq: 207.89 }
 *   table[3]  = { position: 4,  swara: 'S', label: 'सा',  freq: 277.18 }
 *   table[7]  = { position: 8,  swara: 'P', label: 'प',   freq: 415.77 }
 *   table[14] = { position: 15, swara: 'P', label: "प'",  freq: 831.53 }
 *
 * Test 22: Khamaj table, position 3 should be komal Ni
 *   table[2]  = { position: 3,  swara: 'n', label: 'नि,', freq: 246.38 }
 *
 * ---- getAllPositionFreqs ----
 *
 * Test 23: Bilawal at Sa = 277.18 Hz
 *   freqs[1]  = 207.89  (P, = 277.18 * 3/2 * 0.5)
 *   freqs[4]  = 277.18  (S  = 277.18 * 1 * 1)
 *   freqs[8]  = 415.77  (P  = 277.18 * 3/2 * 1)
 *   freqs[11] = 554.36  (S' = 277.18 * 1 * 2)
 *   freqs[15] = 831.54  (P' = 277.18 * 3/2 * 2)
 *
 * ---- freqToMidi ----
 *
 * Test 24: Standard reference pitches
 *   freqToMidi(440)    = 69   (A4)
 *   freqToMidi(261.63) = 60   (C4 — Middle C)
 *   freqToMidi(277.18) = 61   (C#4)
 *   freqToMidi(196.00) = 55   (G3)
 *   freqToMidi(523.25) = 72   (C5)
 *
 * Test 25: Edge cases
 *   freqToMidi(27.5)   = 21   (A0 — lowest piano key)
 *   freqToMidi(4186)   = 108  (C8 — highest piano key)
 *
 * ---- freqToCents ----
 *
 * Test 26: Sharp and flat
 *   freqToCents(442, 440) = 1200 * log2(442/440) = 1200 * 0.006536 = ~7.85 cents
 *   freqToCents(438, 440) = 1200 * log2(438/440) = 1200 * (-0.006579) = ~-7.89 cents
 *
 * Test 27: Perfect match
 *   freqToCents(277.18, 277.18) = 0
 *
 * Test 28: One semitone difference
 *   freqToCents(293.66, 277.18) = 1200 * log2(293.66/277.18) = ~100 cents
 *
 * Test 29: One octave
 *   freqToCents(554.36, 277.18) = 1200 * log2(2) = 1200 cents
 *
 * ---- classifyLaya ----
 *
 * Test 30: Each range
 *   classifyLaya(30)  = 'Ati-Vilambit'
 *   classifyLaya(40)  = 'Ati-Vilambit'
 *   classifyLaya(50)  = 'Vilambit'     (boundary — higher category)
 *   classifyLaya(65)  = 'Vilambit'
 *   classifyLaya(80)  = 'Madhya'       (boundary)
 *   classifyLaya(100) = 'Madhya'
 *   classifyLaya(140) = 'Drut'         (boundary)
 *   classifyLaya(180) = 'Drut'
 *   classifyLaya(240) = 'Ati-Drut'     (boundary)
 *   classifyLaya(300) = 'Ati-Drut'
 *
 * ---- getTanpuraVoicing ----
 *
 * Test 31: Male (bass) keys
 *   getTanpuraVoicing('C')      = 'male'
 *   getTanpuraVoicing('C#')     = 'male'
 *   getTanpuraVoicing('D')      = 'male'
 *   getTanpuraVoicing('E low')  = 'male'
 *   getTanpuraVoicing('E high') = 'male'
 *
 * Test 32: Female (bright) keys
 *   getTanpuraVoicing('F')  = 'female'
 *   getTanpuraVoicing('G')  = 'female'
 *   getTanpuraVoicing('A')  = 'female'
 *   getTanpuraVoicing('Bb') = 'female'
 *   getTanpuraVoicing('B')  = 'female'
 *
 * ---- getSwarRatioForPosition ----
 *
 * Test 33: Bilawal ratios
 *   getSwarRatioForPosition(1, 'bilawal')  = 3/2   = 1.5      (Pa)
 *   getSwarRatioForPosition(4, 'bilawal')  = 1/1   = 1        (Sa)
 *   getSwarRatioForPosition(5, 'bilawal')  = 9/8   = 1.125    (Shuddha Re)
 *   getSwarRatioForPosition(6, 'bilawal')  = 5/4   = 1.25     (Shuddha Ga)
 *   getSwarRatioForPosition(7, 'bilawal')  = 4/3   = 1.3333   (Shuddha Ma)
 *
 * Test 34: Thaat alterations
 *   getSwarRatioForPosition(6, 'kafi')     = 32/27 = 1.18519  (Komal Ga)
 *   getSwarRatioForPosition(7, 'kalyan')   = 45/32 = 1.40625  (Tivra Ma)
 *   getSwarRatioForPosition(5, 'bhairav')  = 256/243 = 1.05350 (Komal Re)
 *   getSwarRatioForPosition(2, 'bhairav')  = 128/81 = 1.58025 (Komal Dha)
 *
 * ========================================================================
 * CROSS-FUNCTION CONSISTENCY CHECKS
 * ========================================================================
 *
 * Check A: Position frequency via two paths should agree.
 *   Path 1: getPositionFreq(8, 277.18, 'bilawal')
 *   Path 2: getSwarFreq(getPositionSwara(8, 'bilawal'), 277.18, 0)
 *   Both should return 415.77 (Pa in madhya)
 *
 * Check B: getAllPositionFreqs should equal individual getPositionFreq calls.
 *   const all = getAllPositionFreqs(277.18, 'bilawal');
 *   for (let p = 1; p <= 15; p++) {
 *     assert(all[p] === getPositionFreq(p, 277.18, 'bilawal'));
 *   }
 *
 * Check C: getTheatPositionTable frequencies should match getAllPositionFreqs
 *   at Sa = 277.18 (C# key).
 *   const table = getTheatPositionTable('bilawal');
 *   const all = getAllPositionFreqs(277.18, 'bilawal');
 *   for (const entry of table) {
 *     assert(Math.abs(entry.freq - all[entry.position]) < 0.01);
 *   }
 *
 * Check D: Octave relationship — position 4 (S) and 11 (S') should be
 *   exactly one octave apart.
 *   const f4  = getPositionFreq(4, 277.18, 'bilawal');   // 277.18
 *   const f11 = getPositionFreq(11, 277.18, 'bilawal');  // 554.36
 *   assert(Math.abs(f11 / f4 - 2) < 0.001);             // ratio = 2
 *   assert(freqToCents(f11, f4) === 1200);               // exactly 1200 cents
 *
 * Check E: Pa (position 1 mandra) and Pa (position 8 madhya) should be
 *   exactly one octave apart.
 *   const f1 = getPositionFreq(1, 277.18, 'bilawal');   // 207.89
 *   const f8 = getPositionFreq(8, 277.18, 'bilawal');   // 415.77
 *   assert(Math.abs(f8 / f1 - 2) < 0.001);
 *
 * Check F: MIDI round-trip — Sa at C# should map to MIDI 61.
 *   freqToMidi(277.18) === 61  (C#4)
 *
 * Check G: getSwarRatioForPosition * octaveMultiplier * baseSa should
 *   equal getPositionFreq.
 *   const ratio = getSwarRatioForPosition(6, 'bilawal');  // 1.25 (G)
 *   const freq  = 277.18 * ratio * 1;                     // 346.475
 *   const freq2 = getPositionFreq(6, 277.18, 'bilawal');  // 346.475
 *   assert(Math.abs(freq - freq2) < 0.01);
 */
