/**
 * @file config.js
 * @description Central configuration module for Swaradhana — a Hindustani Classical
 * Music practice app for bansuri (bamboo flute). All constants, default values, and
 * lookup tables live here. Other modules import from this file.
 *
 * This module has zero dependencies on other application modules.
 * Every exported value is deeply frozen via Object.freeze for immutability.
 */

// ---------------------------------------------------------------------------
// PRACTICE DEFAULTS
// ---------------------------------------------------------------------------

/**
 * Default values applied when a new user session starts or when settings are
 * reset. These cover the tanpura drone, tabla accompaniment, notation style,
 * practice targets, and pitch detection parameters.
 *
 * Defined in: practice_defaults.md
 *
 * @type {Readonly<{
 *   key: string,
 *   baseSaFreq: number,
 *   tempo: number,
 *   saptak: string,
 *   tanpuraVolumeA: number,
 *   tanpuraVolumeB: number,
 *   tablaVolume: number,
 *   swarVolume: number,
 *   tablaBassEQ: number,
 *   tablaTrebleEQ: number,
 *   tanpuraPattern: string,
 *   tanpuraOctave: string,
 *   tanpuraSpeed: number,
 *   tanpuraJivari: number,
 *   tanpuraVariance: number,
 *   tanpuraReverb: number,
 *   tanpuraConcertMode: boolean,
 *   fineTuning: number,
 *   laykari: string,
 *   notation: string,
 *   swarVoice: string,
 *   guideTrack: string,
 *   repetitions: number,
 *   dailyTargetMinutes: number,
 *   weeklyTargetHours: number,
 *   pitchTolerance: string
 * }>}
 */
export const PRACTICE_DEFAULTS = Object.freeze({
  /** Default flute key */
  key: 'E_low',
  /** Frequency of Sa in Hz for the default key (E3 — bass bansuri) */
  baseSaFreq: 164.81,
  /** Default tempo in beats per minute */
  tempo: 80,
  /** Default saptak (octave register) */
  saptak: 'MADHYA',
  /** Overall tanpura volume (0-100) — controlled by the main-page volume slider. */
  tanpuraVolumeOverall: 60,
  /** Concert-mode balance between Tanpura A and B (0=all A/left, 50=equal, 100=all B/right). */
  tanpuraBalance: 50,
  /** Small cents offset applied to Tanpura B in concert mode for natural beating. */
  tanpuraDetuneBCents: 4,
  /** Legacy per-bus volumes (kept for migration; no longer bound to UI). */
  tanpuraVolumeA: 60,
  tanpuraVolumeB: 50,
  /** Tabla accompaniment volume (0-100) */
  tablaVolume: 70,
  /** Swar (melodic) playback volume (0-100) */
  swarVolume: 70,
  /** Tabla bass EQ in dB (range -12 to +12) */
  tablaBassEQ: 0,
  /** Tabla treble EQ in dB (range -12 to +12) */
  tablaTrebleEQ: 0,
  /** Tanpura drone pattern — 'pa' (Pa-Sa-Sa-Sa), 'ma' (Ma-Sa-Sa-Sa), or 'ni' (Ni-Sa-Sa-Sa) */
  tanpuraPattern: 'pa',
  /** Tanpura octave register — 'LOW', 'MEDIUM', or 'HIGH' */
  tanpuraOctave: 'MEDIUM',
  /** Tanpura cycle speed as percentage (0=slow 6s cycle, 100=fast 0.5s cycle) */
  tanpuraSpeed: 30,
  /** Tanpura A jivari (buzz) intensity as percentage (range 0-100) */
  tanpuraJivariA: 65,
  /** Tanpura B jivari (buzz) intensity as percentage (range 0-100), used in concert mode */
  tanpuraJivariB: 60,
  /** Legacy single jivari value — kept for migration. */
  tanpuraJivari: 65,
  /** Tanpura pitch variance in cents for natural drift (range 0-10) */
  tanpuraVariance: 3,
  /** Tanpura reverb wet mix as percentage (range 0-100) */
  tanpuraReverb: 40,
  /** Whether tanpura uses concert-quality synthesis */
  tanpuraConcertMode: false,
  /** Fine tuning offset in cents (range -50 to +50) */
  fineTuning: 0,
  /** Default laykari (rhythmic subdivision) */
  laykari: 'ekgun',
  /** Default notation system — 'hindi' (Devanagari) or 'english' */
  notation: 'english',
  /** Default swar playback voice/instrument */
  swarVoice: 'harmonium',
  /** Guide track mode — 'demo-only', 'follow', or 'none' */
  guideTrack: 'demo-only',
  /** Number of pattern repetitions (intermediate default) */
  repetitions: 2,
  /** Daily practice target in minutes */
  dailyTargetMinutes: 60,
  /** Weekly practice target in hours */
  weeklyTargetHours: 10,
  /** Pitch detection tolerance level — 'beginner', 'intermediate', 'advanced', 'expert' */
  pitchTolerance: 'intermediate',
  /** Default taal (rhythmic cycle) */
  taal: 'teentaal',
  /** Default thaat (scale/mode) */
  thaat: 'bilawal',
  /** Default alankaar pattern — 'scale' = full aroha/avaroha */
  currentAlankaar: 'scale',
  /** Display name of the current alankaar */
  currentAlankaarLabel: 'Full Scale',
  /** Default practice mode */
  mode: 'demo',
  /** Tabla sound source — 'electronic' or a sample set folder name like 'tabla_e_1' */
  tablaSource: 'electronic',
  /** Tanpura engine — 'electronic' (synth) or a sample set folder name like 'tanpura_1' */
  tanpuraEngine: 'electronic',
});

// ---------------------------------------------------------------------------
// STORAGE KEYS
// ---------------------------------------------------------------------------

/**
 * localStorage key names used throughout the application. All keys are prefixed
 * with 'swaradhana_' to avoid collisions with other apps sharing the same origin.
 *
 * Defined in: storage_schema.md
 *
 * @type {Readonly<{
 *   SETTINGS: string,
 *   SESSIONS: string,
 *   PRESETS: string,
 *   CUSTOM_PATTERNS: string,
 *   CUSTOM_TAALS: string,
 *   TAAL_VARIATIONS: string,
 *   FLUTE_PROFILES: string,
 *   RAAG_DEFINITIONS: string,
 *   CUSTOM_SAMPLES: string,
 *   CUSTOM_INSTRUMENTS: string,
 *   PROFILE: string
 * }>}
 */
export const STORAGE_KEYS = Object.freeze({
  /** User settings and preferences */
  SETTINGS: 'swaradhana_settings',
  /** Practice session history */
  SESSIONS: 'swaradhana_sessions',
  /** Saved practice presets */
  PRESETS: 'swaradhana_presets',
  /** User-defined melodic patterns */
  CUSTOM_PATTERNS: 'swaradhana_custom_patterns',
  /** User-defined taal definitions */
  CUSTOM_TAALS: 'swaradhana_custom_taals',
  /** Variations of built-in taals */
  TAAL_VARIATIONS: 'swaradhana_taal_variations',
  /** Bansuri flute profiles (key, tuning, fingering maps) */
  FLUTE_PROFILES: 'swaradhana_flute_profiles',
  /** Custom raag definitions */
  RAAG_DEFINITIONS: 'swaradhana_raag_definitions',
  /** User-uploaded audio samples */
  CUSTOM_SAMPLES: 'swaradhana_custom_samples',
  /** Custom virtual instrument configurations */
  CUSTOM_INSTRUMENTS: 'swaradhana_custom_instruments',
  /** User profile (name, avatar, targets) */
  PROFILE: 'swaradhana_profile',
  /** Rolling activity log: daily (30d) → weekly (26w) → monthly (forever) */
  ACTIVITY: 'swaradhana_activity',
  /** Saved exercises (alankaars) */
  EXERCISES: 'swaradhana_exercises',
});

// ---------------------------------------------------------------------------
// PROFILE DEFAULTS
// ---------------------------------------------------------------------------

/**
 * Initial profile values. Merged with whatever the user has saved on load.
 * Targets can be overridden per-week via PROFILE.weeklyTargetOverrides.
 */
export const PROFILE_DEFAULTS = Object.freeze({
  /** Display name */
  name: 'Practitioner',
  /** ISO timestamp when the profile was first created */
  createdAt: null,
  /** Optional emoji or image data URL */
  avatar: null,
  /** Default practice targets applied each week unless overridden */
  targets: Object.freeze({
    dailyMinutes: 30,
    weeklyHours: 3,
  }),
  /**
   * Per-ISO-week target overrides, keyed by "YYYY-Www".
   * Example: { "2026-W17": { dailyMinutes: 45, weeklyHours: 4 } }
   */
  weeklyTargetOverrides: Object.freeze({}),
});

// ---------------------------------------------------------------------------
// SWAR (NOTE) SYSTEM
// ---------------------------------------------------------------------------

/**
 * Just intonation frequency ratios for all 12 swaras of the Hindustani chromatic
 * scale relative to Sa (=1). Multiply by the Sa frequency to obtain the absolute
 * frequency of any swara.
 *
 * Defined in: frequency_mapping.md
 *
 * @type {Readonly<{
 *   S: number, r: number, R: number, g: number, G: number, m: number,
 *   M: number, P: number, d: number, D: number, n: number, N: number
 * }>}
 */
export const SWAR_RATIOS = Object.freeze({
  /** Sa — tonic (unison) */
  S: 1,
  /** Komal Re (minor second) — 256/243 */
  r: 256 / 243,
  /** Shuddha Re (major second) — 9/8 */
  R: 9 / 8,
  /** Komal Ga (minor third) — 32/27 */
  g: 32 / 27,
  /** Shuddha Ga (major third) — 5/4 */
  G: 5 / 4,
  /** Shuddha Ma (perfect fourth) — 4/3 */
  m: 4 / 3,
  /** Teevra Ma (augmented fourth) — 45/32 */
  M: 45 / 32,
  /** Pa (perfect fifth) — 3/2 */
  P: 3 / 2,
  /** Komal Dha (minor sixth) — 128/81 */
  d: 128 / 81,
  /** Shuddha Dha (major sixth) — 5/3 */
  D: 5 / 3,
  /** Komal Ni (minor seventh) — 16/9 */
  n: 16 / 9,
  /** Shuddha Ni (major seventh) — 15/8 */
  N: 15 / 8,
});

/**
 * Ordered array of all 12 swara abbreviations (shuddha + vikrut) in ascending
 * chromatic order from Sa to Ni. Lowercase letters denote komal (flat) or teevra
 * (sharp) variants; uppercase denotes shuddha (natural) variants — except 'S'
 * (Sa) and 'P' (Pa), which have no variants.
 *
 * Defined in: frequency_mapping.md
 *
 * @type {ReadonlyArray<string>}
 */
export const SWAR_LIST = Object.freeze([
  'S', 'r', 'R', 'g', 'G', 'm', 'M', 'P', 'd', 'D', 'n', 'N',
]);

/**
 * Hindi (Devanagari) display labels for each swara. Used when the notation
 * preference is set to 'hindi'. A nukta (subscript dot) marks komal swaras;
 * an upper dot marks teevra Ma.
 *
 * Defined in: notation_spec.md
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SWAR_LABELS = Object.freeze({
  /** Sa */
  S: '\u0938\u093E',          // सा
  /** Komal Re */
  r: '\u0930\u0947\u0952',    // रे॒
  /** Shuddha Re */
  R: '\u0930\u0947',          // रे
  /** Komal Ga */
  g: '\u0917\u0952',          // ग॒
  /** Shuddha Ga */
  G: '\u0917',                // ग
  /** Shuddha Ma */
  m: '\u092E',                // म
  /** Teevra Ma */
  M: '\u092E\u0951',          // म॑
  /** Pa */
  P: '\u092A',                // प
  /** Komal Dha */
  d: '\u0927\u0952',          // ध॒
  /** Shuddha Dha */
  D: '\u0927',                // ध
  /** Komal Ni */
  n: '\u0928\u093F\u0952',    // नि॒
  /** Shuddha Ni */
  N: '\u0928\u093F',          // नि
});

// ---------------------------------------------------------------------------
// FLUTE POSITIONS
// ---------------------------------------------------------------------------

/**
 * Default fingering-position-to-swara mapping for a bansuri in Bilawal thaat
 * (natural major scale). Positions 1-3 are mandra saptak (lower octave, marked
 * with trailing comma), 4-10 are madhya saptak (middle), and 11-15 are taar
 * saptak (upper, marked with trailing apostrophe).
 *
 * Defined in: flute_fingering.md
 *
 * @type {ReadonlyArray<Readonly<{position: number, swara: string}>>}
 */
export const FLUTE_POSITIONS = Object.freeze([
  Object.freeze({ position: 1,  swara: 'P,' }),
  Object.freeze({ position: 2,  swara: 'D,' }),
  Object.freeze({ position: 3,  swara: 'N,' }),
  Object.freeze({ position: 4,  swara: 'S' }),
  Object.freeze({ position: 5,  swara: 'R' }),
  Object.freeze({ position: 6,  swara: 'G' }),
  Object.freeze({ position: 7,  swara: 'm' }),
  Object.freeze({ position: 8,  swara: 'P' }),
  Object.freeze({ position: 9,  swara: 'D' }),
  Object.freeze({ position: 10, swara: 'N' }),
  Object.freeze({ position: 11, swara: "S'" }),
  Object.freeze({ position: 12, swara: "R'" }),
  Object.freeze({ position: 13, swara: "G'" }),
  Object.freeze({ position: 14, swara: "m'" }),
  Object.freeze({ position: 15, swara: "P'" }),
]);

// ---------------------------------------------------------------------------
// SAPTAK (OCTAVE REGISTERS)
// ---------------------------------------------------------------------------

/**
 * Octave register multiplier exponents. To compute a frequency in a given saptak:
 *   freq = baseSaFreq * swarRatio * Math.pow(2, SAPTAK[register])
 *
 * Defined in: frequency_mapping.md
 *
 * @type {Readonly<{MANDRA: number, MADHYA: number, TAAR: number}>}
 */
export const SAPTAK = Object.freeze({
  /** Mandra saptak — one octave below middle */
  MANDRA: -1,
  /** Madhya saptak — middle octave (reference) */
  MADHYA: 0,
  /** Taar saptak — one octave above middle */
  TAAR: 1,
});

// ---------------------------------------------------------------------------
// THAAT DEFINITIONS
// ---------------------------------------------------------------------------

/**
 * All 10 thaats (parent scales) of the Hindustani music system. Bilawal thaat
 * uses all shuddha (natural) swaras and has no alterations. Other thaats specify
 * which flute positions deviate from Bilawal by substituting komal/teevra
 * variants.
 *
 * The `alterations` object maps FLUTE_POSITIONS position numbers to the swara
 * that replaces the Bilawal default at that position. Positions appear in
 * pairs (madhya + taar saptak) where the same swara changes in both octaves.
 *
 * Defined in: thaat_definitions.md
 *
 * @type {Readonly<Record<string, Readonly<{
 *   name: string,
 *   nameHindi: string,
 *   alterations: Readonly<Record<number, string>>
 * }>>>}
 */
export const THAAT_DEFINITIONS = Object.freeze({
  bilawal: Object.freeze({
    name: 'Bilawal',
    nameHindi: 'बिलावल',
    alterations: Object.freeze({}),
  }),
  kalyan: Object.freeze({
    name: 'Kalyan',
    nameHindi: 'कल्याण',
    alterations: Object.freeze({ 7: 'M', 14: 'M' }),
  }),
  khamaj: Object.freeze({
    name: 'Khamaj',
    nameHindi: 'खमाज',
    alterations: Object.freeze({ 3: 'n', 10: 'n' }),
  }),
  bhairav: Object.freeze({
    name: 'Bhairav',
    nameHindi: 'भैरव',
    alterations: Object.freeze({ 5: 'r', 12: 'r', 2: 'd', 9: 'd' }),
  }),
  bhairavi: Object.freeze({
    name: 'Bhairavi',
    nameHindi: 'भैरवी',
    alterations: Object.freeze({ 5: 'r', 12: 'r', 6: 'g', 13: 'g', 2: 'd', 9: 'd', 3: 'n', 10: 'n' }),
  }),
  kafi: Object.freeze({
    name: 'Kafi',
    nameHindi: 'काफी',
    alterations: Object.freeze({ 6: 'g', 13: 'g', 3: 'n', 10: 'n' }),
  }),
  asavari: Object.freeze({
    name: 'Asavari',
    nameHindi: 'आसावरी',
    alterations: Object.freeze({ 6: 'g', 13: 'g', 2: 'd', 9: 'd', 3: 'n', 10: 'n' }),
  }),
  todi: Object.freeze({
    name: 'Todi',
    nameHindi: 'तोड़ी',
    alterations: Object.freeze({ 5: 'r', 12: 'r', 6: 'g', 13: 'g', 7: 'M', 14: 'M', 2: 'd', 9: 'd' }),
  }),
  purvi: Object.freeze({
    name: 'Purvi',
    nameHindi: 'पूर्वी',
    alterations: Object.freeze({ 5: 'r', 12: 'r', 7: 'M', 14: 'M', 2: 'd', 9: 'd' }),
  }),
  marwa: Object.freeze({
    name: 'Marwa',
    nameHindi: 'मारवा',
    alterations: Object.freeze({ 5: 'r', 12: 'r', 7: 'M', 14: 'M' }),
  }),
});

// ---------------------------------------------------------------------------
// TAAL DEFINITIONS
// ---------------------------------------------------------------------------

/**
 * All 10 built-in taal (rhythmic cycle) definitions used for tabla accompaniment.
 * Each taal specifies the total number of beats (matras), the vibhag (section)
 * groupings, the sam/tali/khali markers, the bol sequence, and a human-readable
 * theka string.
 *
 * - `vibhag`: array of integers indicating how many matras per section
 * - `tpiSequence`: per-vibhag marker — 'X' for sam, '0' for khali, or a tali number
 * - `bols`: array of bol syllables (one per matra); 'x' denotes a rest
 * - `theka`: human-readable theka with '|' section separators
 *
 * Defined in: tabla_and_taals.md
 *
 * @type {Readonly<Record<string, Readonly<{
 *   id: string,
 *   name: string,
 *   nameHindi: string,
 *   beats: number,
 *   vibhag: ReadonlyArray<number>,
 *   sam: number,
 *   tpiSequence: ReadonlyArray<string>,
 *   bols: ReadonlyArray<string>,
 *   theka: string
 * }>>>}
 */
export const TAAL_DEFINITIONS = Object.freeze({
  teentaal: Object.freeze({
    id: 'teentaal',
    name: 'Teentaal',
    nameHindi: 'तीनताल',
    beats: 16,
    vibhag: Object.freeze([4, 4, 4, 4]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '2', '0', '3']),
    bols: Object.freeze([
      'Dha', 'Dhin', 'Dhin', 'Dha',
      'Dha', 'Dhin', 'Dhin', 'Dha',
      'Dha', 'Tin',  'Tin',  'Ta',
      'Ta',  'Dhin', 'Dhin', 'Dha',
    ]),
    theka: 'Dha Dhin Dhin Dha | Dha Dhin Dhin Dha | Dha Tin Tin Ta | Ta Dhin Dhin Dha',
  }),
  ektal: Object.freeze({
    id: 'ektal',
    name: 'Ektal',
    nameHindi: 'एकताल',
    beats: 12,
    vibhag: Object.freeze([2, 2, 2, 2, 2, 2]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '0', '2', '0', '3', '4']),
    bols: Object.freeze([
      'Dhin', 'Dhin',
      'DhaGe', 'TiRaKiTa',
      'Tu',   'Na',
      'Kat',  'Ta',
      'DhaGe', 'TiRaKiTa',
      'Dhin', 'Na',
    ]),
    theka: 'Dhin Dhin | DhaGe TiRaKiTa | Tu Na | Kat Ta | DhaGe TiRaKiTa | Dhin Na',
  }),
  keherwa: Object.freeze({
    id: 'keherwa',
    name: 'Keherwa',
    nameHindi: 'कहरवा',
    beats: 8,
    vibhag: Object.freeze([4, 4]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '0']),
    bols: Object.freeze([
      'Dha', 'Ge', 'Na', 'Ti',
      'Na',  'Ke', 'Dhi', 'Na',
    ]),
    theka: 'Dha Ge Na Ti | Na Ke Dhi Na',
  }),
  deepchandi: Object.freeze({
    id: 'deepchandi',
    name: 'Deepchandi',
    nameHindi: 'दीपचंदी',
    beats: 14,
    vibhag: Object.freeze([3, 4, 3, 4]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '2', '0', '3']),
    bols: Object.freeze([
      'Dha', 'Dhin', 'x',
      'Dha', 'Dha', 'Tin', 'x',
      'Ta',  'Tin',  'x',
      'Dha', 'Dha', 'Dhin', 'x',
    ]),
    theka: 'Dha Dhin x | Dha Dha Tin x | Ta Tin x | Dha Dha Dhin x',
  }),
  rupak: Object.freeze({
    id: 'rupak',
    name: 'Rupak',
    nameHindi: 'रूपक',
    beats: 7,
    vibhag: Object.freeze([3, 2, 2]),
    sam: 1,
    tpiSequence: Object.freeze(['0', '2', '3']),
    bols: Object.freeze([
      'Tin', 'Tin', 'Na',
      'Dhin', 'Na',
      'Dhin', 'Na',
    ]),
    theka: 'Tin Tin Na | Dhin Na | Dhin Na',
  }),
  bhajani: Object.freeze({
    id: 'bhajani',
    name: 'Bhajani',
    nameHindi: 'भजनी',
    beats: 8,
    vibhag: Object.freeze([4, 4]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '0']),
    bols: Object.freeze([
      'Dha', 'Dhi', 'Na', 'Dha',
      'Tin', 'Tin', 'Na', 'Dha',
    ]),
    theka: 'Dha Dhi Na Dha | Tin Tin Na Dha',
  }),
  khemta: Object.freeze({
    id: 'khemta',
    name: 'Khemta',
    nameHindi: 'खेमटा',
    beats: 6,
    vibhag: Object.freeze([3, 3]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '0']),
    bols: Object.freeze([
      'Dha', 'x', 'Tin',
      'Na',  'x', 'Dhin',
    ]),
    theka: 'Dha x Tin | Na x Dhin',
  }),
  dadra: Object.freeze({
    id: 'dadra',
    name: 'Dadra',
    nameHindi: 'दादरा',
    beats: 6,
    vibhag: Object.freeze([3, 3]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '0']),
    bols: Object.freeze([
      'Dha', 'Dhin', 'Na',
      'Dha', 'Tin',  'Na',
    ]),
    theka: 'Dha Dhin Na | Dha Tin Na',
  }),
  jhumra: Object.freeze({
    id: 'jhumra',
    name: 'Jhumra',
    nameHindi: 'झूमरा',
    beats: 14,
    vibhag: Object.freeze([3, 4, 3, 4]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '2', '0', '3']),
    bols: Object.freeze([
      'Dhin', 'x', 'Dha',
      'Dhin', 'Dhin', 'DhaGe', 'TiRaKiTa',
      'Tin',  'x',   'Ta',
      'Dhin', 'Dhin', 'DhaGe', 'TiRaKiTa',
    ]),
    theka: 'Dhin x Dha | Dhin Dhin DhaGe TiRaKiTa | Tin x Ta | Dhin Dhin DhaGe TiRaKiTa',
  }),
  dhamar: Object.freeze({
    id: 'dhamar',
    name: 'Dhamar',
    nameHindi: 'धमार',
    beats: 14,
    vibhag: Object.freeze([5, 2, 3, 4]),
    sam: 1,
    tpiSequence: Object.freeze(['X', '2', '0', '3']),
    bols: Object.freeze([
      'Ka', 'Dhi', 'Ta', 'Dhi', 'Ta',
      'Dha', 'x',
      'Ti',  'Ta', 'x',
      'Ta',  'Dhi', 'Ta', 'Dhi',
    ]),
    theka: 'Ka Dhi Ta Dhi Ta | Dha x | Ti Ta x | Ta Dhi Ta Dhi',
  }),
});

// ---------------------------------------------------------------------------
// VELOCITY SCALING
// ---------------------------------------------------------------------------

/**
 * Default gain multipliers applied to tabla bol samples based on the beat's
 * structural role within a taal cycle. Separate profiles exist for practice
 * and concert modes. `humanizationRange` adds a random +/- offset to simulate
 * natural dynamics.
 *
 * Defined in: audio_engine_spec.md
 *
 * @type {Readonly<{
 *   practice: Readonly<{sam: number, tali: number, filler: number, khali: number}>,
 *   concert: Readonly<{sam: number, tali: number, filler: number, khali: number}>,
 *   humanizationRange: Readonly<{practice: number, concert: number}>
 * }>}
 */
export const VELOCITY_SCALING = Object.freeze({
  /** Gain multipliers for practice mode */
  practice: Object.freeze({
    sam: 1.0,
    tali: 0.85,
    filler: 0.65,
    khali: 0.5,
  }),
  /** Gain multipliers for concert mode */
  concert: Object.freeze({
    sam: 1.1,
    tali: 0.85,
    filler: 0.65,
    khali: 0.4,
  }),
  /** Random gain variance (+/-) applied per beat for humanized dynamics */
  humanizationRange: Object.freeze({
    practice: 0.05,
    concert: 0.08,
  }),
});

// ---------------------------------------------------------------------------
// PITCH TOLERANCE
// ---------------------------------------------------------------------------

/**
 * Pitch detection tolerance thresholds in cents for each proficiency level.
 * A detected pitch within this many cents of the target swara frequency is
 * considered correct.
 *
 * Defined in: pitch_detection_spec.md
 *
 * @type {Readonly<{beginner: number, intermediate: number, advanced: number, expert: number}>}
 */
export const PITCH_TOLERANCE = Object.freeze({
  /** Beginner: 30 cents tolerance */
  beginner: 30,
  /** Intermediate: 20 cents tolerance */
  intermediate: 20,
  /** Advanced: 10 cents tolerance */
  advanced: 10,
  /** Expert: 5 cents tolerance */
  expert: 5,
});

// ---------------------------------------------------------------------------
// LAYA RANGES
// ---------------------------------------------------------------------------

/**
 * Tempo (BPM) ranges for each laya (speed) category in Hindustani music.
 * Each value is a [min, max] tuple (inclusive).
 *
 * Defined in: laya_system.md
 *
 * @type {Readonly<{
 *   atiVilambit: ReadonlyArray<number>,
 *   vilambit: ReadonlyArray<number>,
 *   madhya: ReadonlyArray<number>,
 *   drut: ReadonlyArray<number>,
 *   atiDrut: ReadonlyArray<number>
 * }>}
 */
export const LAYA_RANGES = Object.freeze({
  /** Ati-vilambit (very slow): 30-50 BPM */
  atiVilambit: Object.freeze([30, 50]),
  /** Vilambit (slow): 50-80 BPM */
  vilambit: Object.freeze([50, 80]),
  /** Madhya (medium): 80-140 BPM */
  madhya: Object.freeze([80, 140]),
  /** Drut (fast): 140-240 BPM */
  drut: Object.freeze([140, 240]),
  /** Ati-drut (very fast): 240-400 BPM */
  atiDrut: Object.freeze([240, 400]),
});

// ---------------------------------------------------------------------------
// LAYKARI MULTIPLIERS
// ---------------------------------------------------------------------------

/**
 * Rhythmic subdivision multipliers. Laykari determines how many notes are
 * played per matra (beat). Ekgun = 1 note per beat, dugun = 2, etc.
 *
 * Defined in: laya_system.md
 *
 * @type {Readonly<{ekgun: number, dugun: number, tigun: number, chaugun: number}>}
 */
export const LAYKARI_MULTIPLIERS = Object.freeze({
  /** Ekgun — single speed (1 note per beat) */
  ekgun: 1,
  /** Dugun — double speed (2 notes per beat) */
  dugun: 2,
  /** Tigun — triple speed (3 notes per beat) */
  tigun: 3,
  /** Chaugun — quadruple speed (4 notes per beat) */
  chaugun: 4,
});

// ---------------------------------------------------------------------------
// KEY FREQUENCIES
// ---------------------------------------------------------------------------

/**
 * Mapping of bansuri flute keys to their Sa (tonic) frequency in Hz. These
 * are the standard reference frequencies for commercially available bansuri
 * flutes. Values correspond to the lower (bass) octave of each key, which
 * is standard for bansuri notation.
 *
 * Defined in: frequency_mapping.md
 *
 * @type {Readonly<Record<string, number>>}
 */
export const KEY_FREQUENCIES = Object.freeze({
  /** E low bass bansuri — 164.81 Hz */
  'E_low': 164.81,
  /** F bansuri — 174.61 Hz */
  'F': 174.61,
  /** F# bansuri — 185.00 Hz */
  'F#': 185.00,
  /** G bansuri (most common) — 196.00 Hz (G3) */
  'G': 196.00,
  /** G# bansuri — 207.65 Hz */
  'G#': 207.65,
  /** A bansuri — 220.00 Hz (A3) */
  'A': 220.00,
  /** A# / Bb bansuri — 233.08 Hz */
  'A#': 233.08,
  /** B bansuri — 246.94 Hz */
  'B': 246.94,
  /** C bansuri — 261.63 Hz (C4, middle C) */
  'C': 261.63,
  /** C# bansuri — 277.18 Hz */
  'C#': 277.18,
  /** D bansuri — 293.66 Hz */
  'D': 293.66,
  /** D# / Eb bansuri — 311.13 Hz */
  'D#': 311.13,
  /** E high bansuri — 329.63 Hz */
  'E_high': 329.63,
});

// ---------------------------------------------------------------------------
// SCORE INTERPRETATION
// ---------------------------------------------------------------------------

/**
 * Score-to-proficiency-level mapping for practice session evaluation. After a
 * session, the numerical score (0-100) is mapped to a human-readable level
 * and meaning string for display in the results summary.
 *
 * Defined in: scoring_spec.md
 *
 * @type {ReadonlyArray<Readonly<{min: number, max: number, level: string, meaning: string}>>}
 */
export const SCORE_INTERPRETATION = Object.freeze([
  Object.freeze({ min: 95, max: 100, level: 'Maestro',       meaning: 'Exceptional mastery — near-perfect intonation and rhythm' }),
  Object.freeze({ min: 85, max: 94,  level: 'Advanced',      meaning: 'Strong command of the material with minor deviations' }),
  Object.freeze({ min: 70, max: 84,  level: 'Intermediate',  meaning: 'Good grasp with room for refinement in pitch and timing' }),
  Object.freeze({ min: 50, max: 69,  level: 'Developing',    meaning: 'Emerging understanding — focus on slow, deliberate practice' }),
  Object.freeze({ min: 30, max: 49,  level: 'Beginner',      meaning: 'Early stage — building foundational awareness of pitch and rhythm' }),
  Object.freeze({ min: 0,  max: 29,  level: 'Struggling',    meaning: 'Significant difficulty — consider revisiting basics with a guide' }),
]);

// ---------------------------------------------------------------------------
// COMPETENCY MILESTONES
// ---------------------------------------------------------------------------

/**
 * Long-term competency milestones based on cumulative progress score (0-100).
 * Used in the user profile to show overall growth trajectory across many
 * sessions, as opposed to SCORE_INTERPRETATION which evaluates a single session.
 *
 * Defined in: progress_tracking_spec.md
 *
 * @type {ReadonlyArray<Readonly<{min: number, max: number, label: string}>>}
 */
export const COMPETENCY_MILESTONES = Object.freeze([
  Object.freeze({ min: 0,  max: 20,  label: 'Beginner' }),
  Object.freeze({ min: 21, max: 40,  label: 'Developing' }),
  Object.freeze({ min: 41, max: 60,  label: 'Intermediate' }),
  Object.freeze({ min: 61, max: 80,  label: 'Advanced' }),
  Object.freeze({ min: 81, max: 100, label: 'Expert Practitioner' }),
]);
