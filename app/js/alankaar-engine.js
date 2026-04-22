/**
 * @file alankaar-engine.js
 * @description Alankaar (melodic pattern) generation engine for Swaradhana.
 * Takes a seed pattern expressed as relative offsets (e.g., [0, 1, 2, 1]) and
 * generates the full aroha (ascending) and avaroha (descending) progressions
 * across the playable bansuri range (positions 1-15).
 *
 * Boundary handling rules (from alankaars.md):
 * 1. A group is VALID only if ALL notes in the group fall within 1-15.
 * 2. Partial groups are NEVER generated -- every group must be complete.
 * 3. Avaroha starts from the highest position reached in the aroha.
 *
 * @module alankaar-engine
 */

import {
  FLUTE_POSITIONS,
  THAAT_DEFINITIONS,
  SWAR_RATIOS,
  TAAL_DEFINITIONS,
  LAYKARI_MULTIPLIERS,
} from './config.js';

import {
  getPositionSwara,
  getPositionLabel,
} from './music-engine.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @type {number} Lowest valid flute position */
const MIN_POSITION = 1;

/** @type {number} Highest valid flute position */
const MAX_POSITION = 15;

// ---------------------------------------------------------------------------
// Pattern parsing
// ---------------------------------------------------------------------------

/**
 * Parses a human-readable pattern string into an array of relative offsets.
 *
 * Accepted formats:
 * - "n, n+1, n+2, n+1"  => [0, 1, 2, 1]
 * - "n,n+2,n+1"          => [0, 2, 1]
 * - "n-1, n, n+1"        => [-1, 0, 1]
 * - "n+1, n, n+1, n+2"   => [1, 0, 1, 2]
 * - "n, n+3, n+2"        => [0, 3, 2]
 *
 * Each element must be of the form "n", "n+K", or "n-K" where K is an integer.
 * Whitespace around commas is ignored.
 *
 * @param {string} patternString - The pattern in "n+offset" notation.
 * @returns {number[]} Array of integer offsets.
 * @throws {Error} If any element cannot be parsed.
 *
 * @example
 * parsePattern("n, n+1, n+2, n+1")   // [0, 1, 2, 1]
 * parsePattern("n,n+2,n+1")           // [0, 2, 1]
 * parsePattern("n-1, n, n+1")         // [-1, 0, 1]
 * parsePattern("n+1, n, n+1, n+2")   // [1, 0, 1, 2]
 */
export function parsePattern(patternString) {
  const parts = patternString.split(',').map(s => s.trim());
  const offsets = [];

  for (const part of parts) {
    // Match patterns: "n", "n+3", "n-1", "n + 3", "n - 1"
    const match = part.match(/^n\s*([+-]\s*\d+)?$/i);
    if (!match) {
      throw new Error(
        `Cannot parse pattern element "${part}". Expected format: "n", "n+K", or "n-K".`
      );
    }

    if (match[1] === undefined) {
      // Bare "n" => offset 0
      offsets.push(0);
    } else {
      // Remove internal whitespace from the offset part (e.g., "+ 3" => "+3")
      const offsetStr = match[1].replace(/\s+/g, '');
      offsets.push(parseInt(offsetStr, 10));
    }
  }

  if (offsets.length === 0) {
    throw new Error('Pattern string produced no offsets.');
  }

  return offsets;
}

// ---------------------------------------------------------------------------
// Compact pattern parsing (vibhag-aware)
// ---------------------------------------------------------------------------

/**
 * Parses a compact user input string into a validated, vibhag-aware beat
 * structure for exercise generation.
 *
 * Format:
 *   - Digits 1-9: relative note positions within the phrase
 *   - `.`: rest / empty beat (no note played)
 *   - `_`: continue previous note (tie/sustain — no new attack)
 *   - Space: vibhag separator
 *   - `[...]`: multiple notes in one beat (dugun=2, tingun=3, chaugun=4)
 *
 * Examples for Teentaal (4+4+4+4):
 *   "1234 2345 3456 4567"              — ekgun throughout
 *   "12_3 23_4 34_5 45_6"             — note 2 sustained across 2 beats
 *   "1234 2345 [34][45][56][67] [45][56][67][78]" — V3-V4 dugun
 *
 * Examples for Rupak (3+2+2):
 *   "123 23 23"                        — ekgun
 *   "123 [22][33] [33][44]"            — V1 ekgun, V2-V3 dugun
 *   "1.3 .2 .3"                        — with rests
 *   "12_ _3 23"                        — note 2 sustained across vibhag boundary
 *
 * @param {string} input - The compact pattern string.
 * @param {string} taalId - Taal ID from TAAL_DEFINITIONS for vibhag validation.
 * @returns {{
 *   vibhags: Array<Array<Array<number|null>>>,
 *   flat: Array<number|null>,
 *   beatStructure: number[],
 *   baseDigit: number,
 *   offsets: number[],
 *   error: string|null
 * }}
 *   - vibhags: [vibhag][beat][noteIndex] — each note is a digit (1-9) or null (rest)
 *   - flat: all notes flattened into a single sequence
 *   - beatStructure: number of notes per beat (e.g., [1,1,1,2,2,2,2])
 *   - baseDigit: the lowest non-rest digit in the input (used for offset calculation)
 *   - offsets: flat sequence converted to offsets from baseDigit
 *   - error: null if valid, or a descriptive error string
 */
export function parseCompactPattern(input, taalId) {
  const result = {
    vibhags: [],
    flat: [],
    beatStructure: [],
    baseDigit: 1,
    offsets: [],
    error: null,
  };

  // Validate taal
  const taalDef = TAAL_DEFINITIONS[taalId];
  if (!taalDef) {
    result.error = `Unknown taal "${taalId}".`;
    return result;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    result.error = 'Pattern is empty.';
    return result;
  }

  // Check for invalid characters
  const invalidMatch = trimmed.match(/[^1-9._\[\] ]/);
  if (invalidMatch) {
    result.error = `Invalid character '${invalidMatch[0]}' — use digits 1-9, '.' for rest, '_' for sustain, [] for grouping, space for vibhag separator.`;
    return result;
  }

  // Split by spaces into vibhag groups
  const groups = trimmed.split(/\s+/);
  const expectedVibhags = taalDef.vibhag.length;

  if (groups.length !== expectedVibhags) {
    const vibhagStr = taalDef.vibhag.join('+');
    result.error = `Expected ${expectedVibhags} vibhags for ${taalDef.name} (${vibhagStr}), got ${groups.length}.`;
    return result;
  }

  // Parse each vibhag group
  for (let v = 0; v < groups.length; v++) {
    const group = groups[v];
    const expectedBeats = taalDef.vibhag[v];
    const beats = [];

    let i = 0;
    while (i < group.length) {
      if (group[i] === '[') {
        // Bracket group — multiple notes in one beat
        const closeIdx = group.indexOf(']', i);
        if (closeIdx === -1) {
          result.error = `Unclosed bracket in vibhag ${v + 1}.`;
          return result;
        }
        const inner = group.substring(i + 1, closeIdx);
        if (inner.length < 2 || inner.length > 4) {
          result.error = `Bracket group [${inner}] in vibhag ${v + 1} has ${inner.length} notes — need 2-4 per beat.`;
          return result;
        }
        // Parse each character inside bracket
        const beatNotes = [];
        for (const ch of inner) {
          if (ch === '.') {
            beatNotes.push(null);
          } else if (ch === '_') {
            beatNotes.push('_');
          } else if (ch >= '1' && ch <= '9') {
            beatNotes.push(parseInt(ch, 10));
          } else {
            result.error = `Invalid character '${ch}' inside brackets in vibhag ${v + 1}.`;
            return result;
          }
        }
        beats.push(beatNotes);
        i = closeIdx + 1;
      } else if (group[i] === '.') {
        // Rest beat
        beats.push([null]);
        i++;
      } else if (group[i] === '_') {
        // Continue previous note
        beats.push(['_']);
        i++;
      } else if (group[i] >= '1' && group[i] <= '9') {
        // Single note beat (ekgun)
        beats.push([parseInt(group[i], 10)]);
        i++;
      } else {
        result.error = `Unexpected character '${group[i]}' in vibhag ${v + 1}.`;
        return result;
      }
    }

    if (beats.length !== expectedBeats) {
      result.error = `Vibhag ${v + 1} needs ${expectedBeats} beats, got ${beats.length} — check your pattern.`;
      return result;
    }

    result.vibhags.push(beats);
  }

  // Validate: _ cannot be the very first note
  const firstVibhag = result.vibhags[0];
  if (firstVibhag && firstVibhag[0] && firstVibhag[0][0] === '_') {
    result.error = `'_' (sustain) cannot be the first note — there is no previous note to continue.`;
    return result;
  }

  // Build flat sequence, beat structure, and find base digit
  let minDigit = 9;
  for (const vibhag of result.vibhags) {
    for (const beat of vibhag) {
      result.beatStructure.push(beat.length);
      for (const note of beat) {
        result.flat.push(note);
        if (note !== null && note !== '_' && note < minDigit) minDigit = note;
      }
    }
  }
  result.baseDigit = minDigit;

  // Calculate offsets from base digit ('_' stays as '_', null stays as null)
  result.offsets = result.flat.map(n => {
    if (n === '_') return '_';
    if (n === null) return null;
    return n - minDigit;
  });

  return result;
}

/**
 * Converts a parsed compact pattern back to the compact string format.
 * Useful for displaying the current pattern in the edit field.
 *
 * @param {Array<Array<Array<number|null>>>} vibhags - The vibhag beat structure
 * @returns {string} Compact pattern string
 */
export function compactPatternToString(vibhags) {
  return vibhags.map(vibhag => {
    return vibhag.map(beat => {
      if (beat.length === 1) {
        if (beat[0] === null) return '.';
        if (beat[0] === '_') return '_';
        return String(beat[0]);
      }
      const inner = beat.map(n => {
        if (n === null) return '.';
        if (n === '_') return '_';
        return String(n);
      }).join('');
      return `[${inner}]`;
    }).join('');
  }).join(' ');
}

/**
 * Generates full aroha + avaroha cycles from a parsed compact pattern.
 * Increments all digits by 1 for each subsequent cycle until the range
 * boundary is exceeded.
 *
 * @param {Object} options
 * @param {Object} parsed - Output from parseCompactPattern
 * @param {number} [rangeStart=4] - Starting flute position (maps to digit baseDigit)
 * @param {number} [rangeEnd=11] - Ending flute position
 * @returns {{
 *   arohaCycles: Array<{beats: Array<{positions: Array<number|null>}>}>,
 *   avarohaCycles: Array<{beats: Array<{positions: Array<number|null>}>}>,
 *   beatStructure: number[],
 *   compactNotation: string
 * }}
 */
export function generateFromCompactPattern(options) {
  const { parsed, rangeStart = 4, rangeEnd = 11 } = options;

  if (parsed.error) {
    return { arohaCycles: [], avarohaCycles: [], beatStructure: parsed.beatStructure, compactNotation: '' };
  }

  const beatStructure = parsed.beatStructure;

  // Map digit to flute position: digit d -> rangeStart + (d - baseDigit)
  // '_' (sustain) passes through as '_'
  function digitToPosition(digit, increment) {
    if (digit === null) return null;
    if (digit === '_') return '_';
    return rangeStart + (digit - parsed.baseDigit) + increment;
  }

  // Check if all positions in a cycle are within valid range (skip nulls and '_')
  function cycleInRange(increment) {
    for (const note of parsed.flat) {
      if (note === null || note === '_') continue;
      const pos = digitToPosition(note, increment);
      if (pos < MIN_POSITION || pos > MAX_POSITION) return false;
      if (pos > rangeEnd + 3) return false; // allow slight overshoot for wide patterns
    }
    return true;
  }

  // Build one cycle of beats from the parsed vibhag structure with an increment
  function buildCycle(increment, reversed) {
    const sourceFlat = reversed ? [...parsed.flat].reverse() : parsed.flat;
    const beats = [];
    let flatIdx = 0;
    for (const notesInBeat of beatStructure) {
      const positions = [];
      for (let s = 0; s < notesInBeat; s++) {
        const note = sourceFlat[flatIdx];
        positions.push(digitToPosition(note, increment));
        flatIdx++;
      }
      beats.push({ positions });
    }
    return { beats };
  }

  // Generate aroha cycles
  const arohaCycles = [];
  let maxPosReached = rangeStart;
  for (let inc = 0; inc < 50; inc++) { // safety limit
    if (!cycleInRange(inc)) break;
    const cycle = buildCycle(inc, false);
    arohaCycles.push(cycle);
    // Track highest position
    for (const note of parsed.flat) {
      if (note !== null) {
        const pos = digitToPosition(note, inc);
        if (pos > maxPosReached) maxPosReached = pos;
      }
    }
  }

  // Generate avaroha cycles (mirror: reversed flat, decrementing)
  const avarohaCycles = [];
  // Find the highest increment used in aroha
  const lastArohaInc = arohaCycles.length > 0 ? arohaCycles.length - 1 : 0;

  for (let inc = lastArohaInc; inc >= 0; inc--) {
    // Check if reversed cycle is in range
    let valid = true;
    for (const note of parsed.flat) {
      if (note === null) continue;
      const pos = digitToPosition(note, inc);
      if (pos < MIN_POSITION || pos > MAX_POSITION) { valid = false; break; }
    }
    if (!valid) continue;
    const cycle = buildCycle(inc, true);
    avarohaCycles.push(cycle);
  }

  return {
    arohaCycles,
    avarohaCycles,
    beatStructure,
    compactNotation: compactPatternToString(parsed.vibhags),
  };
}

// ---------------------------------------------------------------------------
// Alankaar generation
// ---------------------------------------------------------------------------

/**
 * Generates the full aroha + avaroha alankaar from a pattern of relative
 * offsets. The pattern is applied starting at position 1 (mandra Pa) and
 * advanced by +1 for each group until the range limit is reached.
 *
 * Boundary rules:
 * - A group is valid ONLY if ALL resulting positions fall within 1-15.
 * - Partial groups are NEVER generated.
 * - Aroha stops when the next starting position would push any note above 15.
 * - Avaroha uses the reversed pattern, starting from the highest position
 *   reached during the aroha, and decrements until any note would go below 1.
 *
 * @param {number[]} pattern - Array of relative offsets, e.g., [0, 1, 2, 1].
 * @param {string} [thaat='bilawal'] - Thaat name for swara lookups.
 * @param {string} [notation='hindi'] - 'hindi' or 'english' for display labels.
 * @returns {{
 *   aroha: Array<{startPos: number, notes: Array<{position: number, swara: string, label: string}>}>,
 *   avaroha: Array<{startPos: number, notes: Array<{position: number, swara: string, label: string}>}>,
 *   totalGroups: number,
 *   totalNotes: number,
 *   patternLength: number
 * }}
 *
 * @example
 * // Simple triplet: ascending 3-note groups
 * const result = generateAlankaar([0, 1, 2], 'bilawal', 'english');
 * // result.aroha[0] = { startPos: 1, notes: [{position:1, swara:'P', label:'P,'},
 * //                                          {position:2, swara:'D', label:'D,'},
 * //                                          {position:3, swara:'N', label:'N,'}] }
 */
export function generateAlankaar(pattern, thaat = 'bilawal', notation = 'hindi') {
  if (!Array.isArray(pattern) || pattern.length === 0) {
    throw new Error('Pattern must be a non-empty array of numeric offsets.');
  }

  const aroha = [];
  const avaroha = [];
  let highestPositionReached = MIN_POSITION;

  // --- Aroha (ascending) ---
  // Start at position 1 and increment by 1 each step.
  for (let startPos = MIN_POSITION; startPos <= MAX_POSITION; startPos++) {
    const positions = pattern.map(offset => startPos + offset);

    // Check ALL positions are within valid range
    const allValid = positions.every(p => p >= MIN_POSITION && p <= MAX_POSITION);
    if (!allValid) {
      break; // Stop -- do not generate partial groups
    }

    const notes = positions.map(pos => ({
      position: pos,
      swara: getPositionSwara(pos, thaat),
      label: getPositionLabel(pos, thaat, notation),
    }));

    aroha.push({ startPos, notes });

    // Track the highest position reached across all notes
    const maxInGroup = Math.max(...positions);
    if (maxInGroup > highestPositionReached) {
      highestPositionReached = maxInGroup;
    }
  }

  // --- Avaroha (descending) ---
  // Reverse the pattern offsets. The avaroha reversal means the note order
  // within each group is reversed. The starting position is derived from
  // the highest position reached: we want the first note of the reversed
  // pattern (which is the last offset of the original) to equal the highest
  // position.
  const reversedPattern = [...pattern].reverse();

  // Find the starting position such that the FIRST note of the reversed
  // pattern lands on the highest position reached.
  // reversedPattern[0] is the last element of the original pattern.
  // startPos + reversedPattern[0] = highestPositionReached
  const avarohaFirstStart = highestPositionReached - reversedPattern[0];

  for (let startPos = avarohaFirstStart; startPos >= MIN_POSITION; startPos--) {
    const positions = reversedPattern.map(offset => startPos + offset);

    // Check ALL positions are within valid range
    const allValid = positions.every(p => p >= MIN_POSITION && p <= MAX_POSITION);
    if (!allValid) {
      break; // Stop -- do not generate partial groups
    }

    const notes = positions.map(pos => ({
      position: pos,
      swara: getPositionSwara(pos, thaat),
      label: getPositionLabel(pos, thaat, notation),
    }));

    avaroha.push({ startPos, notes });
  }

  const totalGroups = aroha.length + avaroha.length;
  const totalNotes = totalGroups * pattern.length;

  return {
    aroha,
    avaroha,
    totalGroups,
    totalNotes,
    patternLength: pattern.length,
  };
}

// ---------------------------------------------------------------------------
// Exercise-oriented alankaar generation
// ---------------------------------------------------------------------------

/**
 * Built-in pattern presets by type and notes-per-phrase.
 * Each returns an offset array suitable for generateAlankaar.
 */
const PATTERN_PRESETS = {
  sequential: {
    2: [0, 1],
    3: [0, 1, 2],
    4: [0, 1, 2, 3],
    6: [0, 1, 2, 3, 4, 5],
    7: [0, 1, 2, 3, 4, 5, 6],
    8: [0, 1, 2, 3, 4, 5, 6, 7],
  },
  reverse: {
    2: [1, 0],
    3: [2, 1, 0],
    4: [3, 2, 1, 0],
    6: [5, 4, 3, 2, 1, 0],
    7: [6, 5, 4, 3, 2, 1, 0],
    8: [7, 6, 5, 4, 3, 2, 1, 0],
  },
  zigzag: {
    3: [0, 2, 1],
    4: [0, 2, 1, 3],
    6: [0, 2, 1, 3, 2, 4],
    7: [0, 1, 2, 3, 2, 1, 0],
    8: [0, 1, 2, 3, 4, 3, 2, 1],
  },
  jumping: {
    3: [0, 2, 4],
    4: [0, 3, 1, 2],
    6: [0, 2, 4, 1, 3, 5],
    8: [0, 1, 2, 3, 4, 3, 2, 1],
  },
};

/**
 * Gets a pattern preset by type and desired phrase length.
 * Falls back to the nearest available length if exact match not found.
 *
 * @param {string} patternType - 'sequential', 'reverse', 'zigzag', 'jumping'
 * @param {number} notesPerPhrase - Desired notes per phrase (2-8)
 * @returns {number[]} Offset array
 */
export function getPatternPreset(patternType, notesPerPhrase) {
  const presets = PATTERN_PRESETS[patternType];
  if (!presets) {
    return PATTERN_PRESETS.sequential[notesPerPhrase] || [0, 1, 2];
  }
  if (presets[notesPerPhrase]) return presets[notesPerPhrase];
  // Fallback to nearest available
  const available = Object.keys(presets).map(Number).sort((a, b) => a - b);
  const closest = available.reduce((prev, curr) =>
    Math.abs(curr - notesPerPhrase) < Math.abs(prev - notesPerPhrase) ? curr : prev
  );
  return presets[closest];
}

/**
 * Generates a complete exercise alankaar with custom start/end range.
 * Supports all pattern types. Returns aroha + avaroha as arrays of phrase
 * groups, where each group contains positions (not resolved to swaras — the
 * thaat resolves them at display/playback time).
 *
 * @param {Object} options
 * @param {number[]} options.pattern - Offset array, e.g. [0,1,2]
 * @param {number} [options.rangeStart=4] - Starting position (default S=4)
 * @param {number} [options.rangeEnd=11] - Ending position (default S'=11)
 * @param {boolean} [options.mirrorAvaroha=true] - Reverse pattern for avaroha
 * @returns {{
 *   aroha: Array<{startPos: number, positions: number[]}>,
 *   avaroha: Array<{startPos: number, positions: number[]}>,
 *   highestPos: number,
 *   lowestPos: number
 * }}
 */
export function generateExerciseAlankaar(options) {
  const {
    pattern,
    rangeStart = 4,
    rangeEnd = 11,
    mirrorAvaroha = true,
  } = options;

  if (!Array.isArray(pattern) || pattern.length === 0) {
    throw new Error('Pattern must be a non-empty array of offsets.');
  }

  const aroha = [];
  let highestPos = rangeStart;

  // Aroha: start from rangeStart, increment by 1 each step
  for (let startPos = rangeStart; startPos <= rangeEnd; startPos++) {
    const positions = pattern.map(offset => startPos + offset);

    // All positions must be within range
    if (positions.some(p => p < MIN_POSITION || p > MAX_POSITION)) break;
    // At least the last note should not exceed rangeEnd (for clean boundary)
    if (positions.some(p => p > rangeEnd + pattern.length - 1)) break;

    aroha.push({ startPos, positions: [...positions] });

    const maxInGroup = Math.max(...positions);
    if (maxInGroup > highestPos) highestPos = maxInGroup;
  }

  // Avaroha: mirror pattern, descend from highest position
  const avaroha = [];
  const avaPattern = mirrorAvaroha ? [...pattern].reverse() : pattern;

  // Start such that the first note of avaroha pattern = highestPos
  const avaStartFirst = highestPos - avaPattern[0];

  for (let startPos = avaStartFirst; startPos >= MIN_POSITION; startPos--) {
    const positions = avaPattern.map(offset => startPos + offset);

    if (positions.some(p => p < MIN_POSITION || p > MAX_POSITION)) break;
    // Stop when we've descended back to or below rangeStart
    if (startPos + avaPattern[0] < rangeStart) break;

    avaroha.push({ startPos, positions: [...positions] });
  }

  return {
    aroha,
    avaroha,
    highestPos,
    lowestPos: rangeStart,
  };
}

/**
 * Fits an exercise alankaar into taal cycles, producing beat-by-beat data.
 * Each beat contains an array of position numbers (1-15). The thaat resolves
 * these to swara names at display time.
 *
 * For uniform taals (all vibhags same size): phrases flow continuously.
 * For non-uniform taals: phrases are sectioned per vibhag boundaries.
 *
 * @param {Object} options
 * @param {{aroha: Array, avaroha: Array}} options.alankaar - From generateExerciseAlankaar
 * @param {string} options.taalId - Taal ID from TAAL_DEFINITIONS
 * @param {string} [options.laykari='ekgun'] - Notes per beat
 * @returns {{
 *   aroha: Array<{cycle: number, beats: Array<{positions: number[]}>}>,
 *   avaroha: Array<{cycle: number, beats: Array<{positions: number[]}>}>,
 *   phraseLength: number,
 *   beatsPerPhrase: number
 * }}
 */
export function fitExerciseToTaal(options) {
  const { alankaar, taalId, laykari = 'ekgun' } = options;

  const taalDef = TAAL_DEFINITIONS[taalId];
  if (!taalDef) throw new Error(`Unknown taal: ${taalId}`);

  const multiplier = LAYKARI_MULTIPLIERS[laykari] || 1;
  const totalBeats = taalDef.beats;

  // Flatten all positions from phrase groups
  function flattenSection(groups) {
    const allPositions = [];
    for (const group of groups) {
      allPositions.push(...group.positions);
    }
    return allPositions;
  }

  // Convert a flat list of positions into cycles of beats
  function buildCycles(flatPositions) {
    const cycles = [];
    let posIndex = 0;
    let cycleNum = 1;

    while (posIndex < flatPositions.length) {
      const beats = [];
      for (let b = 0; b < totalBeats; b++) {
        const notesForBeat = [];
        for (let s = 0; s < multiplier; s++) {
          if (posIndex < flatPositions.length) {
            notesForBeat.push(flatPositions[posIndex]);
            posIndex++;
          } else {
            notesForBeat.push(null); // rest
          }
        }
        beats.push({ positions: notesForBeat });
      }
      cycles.push({ cycle: cycleNum, beats });
      cycleNum++;
    }
    return cycles;
  }

  const arohaFlat = flattenSection(alankaar.aroha);
  const avarohaFlat = flattenSection(alankaar.avaroha);

  const phraseLength = alankaar.aroha.length > 0 ? alankaar.aroha[0].positions.length : 0;
  const beatsPerPhrase = Math.ceil(phraseLength / multiplier);

  return {
    aroha: buildCycles(arohaFlat),
    avaroha: buildCycles(avarohaFlat),
    phraseLength,
    beatsPerPhrase,
  };
}

// ---------------------------------------------------------------------------
// Scale generation
// ---------------------------------------------------------------------------

/**
 * Generates a simple ascending (positions 4-11) and descending (positions
 * 11-4) scale for the given thaat. The scale covers madhya saptak Sa to taar
 * saptak Sa, which is the standard one-octave range used for basic scale
 * practice.
 *
 * Returns the same format as generateAlankaar, with each "group" containing
 * a single note.
 *
 * @param {string} [thaat='bilawal'] - Thaat name for swara lookups.
 * @param {string} [notation='hindi'] - 'hindi' or 'english' for display labels.
 * @returns {{
 *   aroha: Array<{startPos: number, notes: Array<{position: number, swara: string, label: string}>}>,
 *   avaroha: Array<{startPos: number, notes: Array<{position: number, swara: string, label: string}>}>,
 *   totalGroups: number,
 *   totalNotes: number,
 *   patternLength: number
 * }}
 *
 * @example
 * const scale = generateScale('bilawal', 'english');
 * // scale.aroha: positions 4,5,6,7,8,9,10,11 (S R G m P D N S')
 * // scale.avaroha: positions 11,10,9,8,7,6,5,4 (S' N D P m G R S)
 */
export function generateScale(thaat = 'bilawal', notation = 'hindi') {
  const SCALE_LOW = 4;   // Madhya Sa
  const SCALE_HIGH = 11; // Taar Sa

  const aroha = [];
  const avaroha = [];

  // Ascending: 4 -> 11
  for (let pos = SCALE_LOW; pos <= SCALE_HIGH; pos++) {
    aroha.push({
      startPos: pos,
      notes: [{
        position: pos,
        swara: getPositionSwara(pos, thaat),
        label: getPositionLabel(pos, thaat, notation),
      }],
    });
  }

  // Descending: 11 -> 4
  for (let pos = SCALE_HIGH; pos >= SCALE_LOW; pos--) {
    avaroha.push({
      startPos: pos,
      notes: [{
        position: pos,
        swara: getPositionSwara(pos, thaat),
        label: getPositionLabel(pos, thaat, notation),
      }],
    });
  }

  const totalGroups = aroha.length + avaroha.length;

  return {
    aroha,
    avaroha,
    totalGroups,
    totalNotes: totalGroups, // 1 note per group
    patternLength: 1,
  };
}

// ---------------------------------------------------------------------------
// Taal fitting
// ---------------------------------------------------------------------------

/**
 * Maps an alankaar's notes onto taal matra positions, producing an array of
 * avartan (rhythmic cycle) objects.
 *
 * At Ekgun: 1 note per matra.
 * At Dugun: 2 notes per matra.
 * At Tigun: 3 notes per matra.
 * At Chaugun: 4 notes per matra.
 *
 * Total matras per cycle = taal.beats. When notes run out mid-cycle, remaining
 * matras are filled with null (rest).
 *
 * @param {{aroha: Array, avaroha: Array}} alankaar - Output from generateAlankaar.
 * @param {string} taalId - A key in TAAL_DEFINITIONS (e.g., 'teentaal').
 * @param {string} [laykari='ekgun'] - Laykari level.
 * @returns {Array<{
 *   cycle: number,
 *   matras: Array<{
 *     matra: number,
 *     notes: Array<string|null>,
 *     bol: string
 *   }>
 * }>}
 *
 * @example
 * const alankaar = generateAlankaar([0, 1, 2], 'bilawal', 'english');
 * const fitted = fitToTaal(alankaar, 'teentaal', 'ekgun');
 * // fitted[0].cycle = 1
 * // fitted[0].matras[0] = { matra: 0, notes: ['P,'], bol: 'Dha' }
 */
export function fitToTaal(alankaar, taalId, laykari = 'ekgun') {
  const taalDef = TAAL_DEFINITIONS[taalId];
  if (!taalDef) {
    throw new Error(
      `Unknown taal "${taalId}". Valid taals: ${Object.keys(TAAL_DEFINITIONS).join(', ')}`
    );
  }

  const multiplier = LAYKARI_MULTIPLIERS[laykari];
  if (!multiplier) {
    throw new Error(
      `Unknown laykari "${laykari}". Valid levels: ${Object.keys(LAYKARI_MULTIPLIERS).join(', ')}`
    );
  }

  const totalBeats = taalDef.beats;
  const bols = taalDef.bols;

  // Flatten all notes from aroha + avaroha into a single sequence.
  // Each entry preserves both label (for display) and position (for audio).
  const allNotes = [];
  for (const group of alankaar.aroha) {
    for (const note of group.notes) {
      allNotes.push({ label: note.label, position: note.position });
    }
  }
  for (const group of alankaar.avaroha) {
    for (const note of group.notes) {
      allNotes.push({ label: note.label, position: note.position });
    }
  }

  // Build avartan cycles
  const cycles = [];
  let noteIndex = 0;
  let cycleNumber = 1;

  while (noteIndex < allNotes.length) {
    const matras = [];

    for (let m = 0; m < totalBeats; m++) {
      // Each matra holds `multiplier` notes at the given laykari level
      const notesForMatra = [];

      for (let s = 0; s < multiplier; s++) {
        if (noteIndex < allNotes.length) {
          notesForMatra.push(allNotes[noteIndex]); // {label, position}
          noteIndex++;
        } else {
          notesForMatra.push(null); // rest
        }
      }

      matras.push({
        matra: m,
        notes: notesForMatra,
        bol: bols[m] || '',
      });
    }

    cycles.push({
      cycle: cycleNumber,
      matras,
    });

    cycleNumber++;
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable formatted string of an alankaar, with pipe (|)
 * characters separating groups.
 *
 * Example output for [0,1,2] in Bilawal (English notation):
 * "P, D, N, | D, N, S | S R G | R G m | ... || N, D, P, | S N, D, | ..."
 *
 * The aroha and avaroha sections are separated by "||".
 *
 * @param {{aroha: Array, avaroha: Array}} alankaar - Output from generateAlankaar.
 * @param {string} [notation='hindi'] - Unused (labels are already baked into
 *   the alankaar data), but accepted for API symmetry. The labels used are
 *   whatever notation was passed to generateAlankaar.
 * @returns {string} Formatted display string.
 *
 * @example
 * const a = generateAlankaar([0, 1, 2], 'bilawal', 'english');
 * getAlankaarDisplayText(a);
 * // "P, D, N, | D, N, S | S R G | R G m | ... || N, D, P, | ..."
 */
export function getAlankaarDisplayText(alankaar, notation = 'hindi') {
  /**
   * Formats a single section (aroha or avaroha) into a pipe-separated string.
   * @param {Array} groups - Array of group objects with .notes[].label
   * @returns {string}
   */
  function formatSection(groups) {
    return groups
      .map(group => group.notes.map(n => n.label).join(' '))
      .join(' | ');
  }

  const arohaText = formatSection(alankaar.aroha);
  const avarohaText = formatSection(alankaar.avaroha);

  if (avarohaText) {
    return `${arohaText} || ${avarohaText}`;
  }

  return arohaText;
}
