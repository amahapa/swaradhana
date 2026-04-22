/**
 * @file taal-engine.js
 * @description Beat scheduling engine for Swaradhana. Manages the taal clock --
 * keeps track of which matra is current, fires callbacks on each beat, and
 * handles tempo changes. Uses the Web Audio API's high-precision clock for
 * timing rather than relying on setTimeout/setInterval alone.
 *
 * @module taal-engine
 */

import {
  TAAL_DEFINITIONS,
  VELOCITY_SCALING,
  LAYKARI_MULTIPLIERS,
} from './config.js';

// ---------------------------------------------------------------------------
// TaalEngine class
// ---------------------------------------------------------------------------

/**
 * Beat scheduling engine that drives taal playback. Maintains the current
 * matra position within a taal cycle, schedules beats ahead of time using
 * the Web Audio API clock, and invokes registered callbacks on each beat
 * with structural metadata (sam/tali/khali/filler, bol, velocity).
 *
 * Usage:
 * ```js
 * const engine = new TaalEngine();
 * engine.setTaal('teentaal');
 * engine.setTempo(80);
 * engine.onBeat((matraIndex, beatType, bol, velocity) => {
 *   console.log(`Beat ${matraIndex}: ${beatType} - ${bol} @ ${velocity}`);
 * });
 * engine.start(audioContext);
 * ```
 */
export class TaalEngine {
  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * Initializes TaalEngine state. No taal is loaded and no audio context is
   * bound until `setTaal()` and `start()` are called.
   */
  constructor() {
    /** @type {string|null} ID of the currently loaded taal */
    this.currentTaal = null;

    /** @type {number} Current matra index (0-based) within the taal cycle */
    this.currentMatra = 0;

    /** @type {number} Tempo in beats per minute (default 80) */
    this.bpm = 80;

    /** @type {boolean} Whether the scheduler is actively running */
    this.isPlaying = false;

    /** @type {boolean} Whether playback is paused (matra position retained) */
    this._isPaused = false;

    /** @type {string} Current laykari level */
    this.laykari = 'ekgun';

    /** @type {Array<Function>} Registered onBeat callback functions */
    this.callbacks = [];

    // -- Taal definition data (populated by setTaal) --

    /** @type {number} Total matras (beats) in one cycle */
    this._beats = 0;

    /** @type {ReadonlyArray<number>} Vibhag groupings */
    this._vibhag = [];

    /** @type {ReadonlyArray<string>} Bol syllables per matra */
    this._bols = [];

    /** @type {ReadonlyArray<string>} Tali/khali markers per vibhag */
    this._tpiSequence = [];

    // -- Scheduler internals --

    /** @type {AudioContext|null} Web Audio context for timing */
    this._audioContext = null;

    /** @type {number|null} setInterval handle for the scheduler pump */
    this._intervalId = null;

    /**
     * How far ahead (in seconds) to schedule beats. A larger value provides
     * more resilience against garbage-collection pauses but adds latency.
     * @type {number}
     */
    this._scheduleAheadTime = 0.2; // 200ms lookahead

    /**
     * How often (in ms) the scheduler pump fires to check whether new beats
     * need to be scheduled.
     * @type {number}
     */
    this._pumpInterval = 50; // 50ms

    /**
     * The audioContext.currentTime at which the next beat is scheduled.
     * @type {number}
     */
    this._nextBeatTime = 0;
  }

  // -------------------------------------------------------------------------
  // Configuration methods
  // -------------------------------------------------------------------------

  /**
   * Loads a taal definition by ID (from TAAL_DEFINITIONS) or as a custom
   * taal object. Resets the current matra to 0.
   *
   * A custom taal object must have the shape:
   * ```
   * { id, name, beats, vibhag, tpiSequence, bols }
   * ```
   *
   * @param {string|object} taalId - A key in TAAL_DEFINITIONS (e.g. 'teentaal')
   *   or a custom taal definition object.
   * @throws {Error} If the taalId string is not found in TAAL_DEFINITIONS and
   *   is not a valid custom taal object.
   */
  setTaal(taalId) {
    let taalDef;

    if (typeof taalId === 'string') {
      taalDef = TAAL_DEFINITIONS[taalId];
      if (!taalDef) {
        throw new Error(
          `Unknown taal "${taalId}". Valid taals: ${Object.keys(TAAL_DEFINITIONS).join(', ')}`
        );
      }
    } else if (typeof taalId === 'object' && taalId !== null) {
      if (!taalId.beats || !taalId.vibhag || !taalId.tpiSequence || !taalId.bols) {
        throw new Error(
          'Custom taal object must have: beats, vibhag, tpiSequence, bols'
        );
      }
      taalDef = taalId;
    } else {
      throw new Error('setTaal expects a taal ID string or a custom taal object.');
    }

    // If currently playing, defer the switch to the start of the next cycle
    if (this.isPlaying) {
      this._pendingTaal = taalDef;
      console.log('[TaalEngine] Taal change to', taalDef.name || taalDef.id, 'deferred to next cycle');
      return;
    }

    this._applyTaal(taalDef);
  }

  /**
   * Internal — applies a taal definition immediately.
   * @private
   */
  _applyTaal(taalDef) {
    this.currentTaal = taalDef.id || 'custom';
    this._beats = taalDef.beats;
    this._vibhag = taalDef.vibhag;
    this._bols = taalDef.bols;
    this._tpiSequence = taalDef.tpiSequence;
    this.currentMatra = 0;
  }

  /**
   * Sets the playback tempo. Recalculates beat duration internally.
   *
   * @param {number} bpm - Tempo in beats per minute. Clamped to 30-500.
   */
  setTempo(bpm) {
    const newBpm = Math.max(30, Math.min(500, bpm));
    if (this.isPlaying) {
      // Defer tempo change to the start of the next cycle (Sam / matra 0)
      this._pendingBpm = newBpm;
    } else {
      this.bpm = newBpm;
    }
  }

  /**
   * Sets the laykari (rhythmic subdivision) level. Affects how many swar
   * notes are played per matra — the beat engine itself fires at the matra
   * level, but consumers use `getSubBeatDuration()` to subdivide.
   *
   * @param {string} level - One of 'ekgun', 'dugun', 'tigun', 'chaugun'.
   * @throws {Error} If level is not a valid laykari key.
   */
  setLaykari(level) {
    if (!LAYKARI_MULTIPLIERS[level]) {
      throw new Error(
        `Unknown laykari "${level}". Valid levels: ${Object.keys(LAYKARI_MULTIPLIERS).join(', ')}`
      );
    }
    this.laykari = level;
  }

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  /**
   * Returns the duration of one matra (beat) in seconds at the current BPM.
   *
   * Formula: 60 / bpm
   *
   * @returns {number} Seconds per matra.
   */
  getBeatDuration() {
    return 60 / this.bpm;
  }

  /**
   * Returns the duration of one sub-beat in seconds. A sub-beat is one
   * matra divided by the laykari multiplier.
   *
   * At ekgun (1x), sub-beat = beat.
   * At dugun (2x), sub-beat = beat / 2.
   * At chaugun (4x), sub-beat = beat / 4.
   *
   * @returns {number} Seconds per sub-beat.
   */
  getSubBeatDuration() {
    const multiplier = LAYKARI_MULTIPLIERS[this.laykari] || 1;
    return this.getBeatDuration() / multiplier;
  }

  /**
   * Returns the 0-based index of the current matra within the taal cycle.
   *
   * @returns {number} Current matra index (0 to beats-1).
   */
  getCurrentMatra() {
    return this.currentMatra;
  }

  /**
   * Determines the structural role of a given matra within the taal cycle.
   *
   * Beat type logic:
   * - Matra 0 is always 'sam' (the first beat, marked X).
   * - For each vibhag, check its tpiSequence marker:
   *   - 'X' = sam vibhag (first matra is sam, rest are filler)
   *   - '0' = khali vibhag (ALL matras in this vibhag are khali)
   *   - Any number = tali vibhag (first matra is tali, rest are filler)
   * - Everything else defaults to 'filler'.
   *
   * @param {number} matraIndex - 0-based matra index within the cycle.
   * @returns {'sam'|'tali'|'khali'|'filler'} The beat type.
   */
  getBeatType(matraIndex) {
    // Matra 0 is always sam
    if (matraIndex === 0) {
      return 'sam';
    }

    // Walk through vibhag sections to find which vibhag this matra belongs to
    let matraOffset = 0;
    for (let v = 0; v < this._vibhag.length; v++) {
      const vibhagSize = this._vibhag[v];
      const vibhagStart = matraOffset;
      const vibhagEnd = matraOffset + vibhagSize; // exclusive

      if (matraIndex >= vibhagStart && matraIndex < vibhagEnd) {
        const marker = this._tpiSequence[v];

        // Khali vibhag: ALL matras in this section are khali
        if (marker === '0') {
          return 'khali';
        }

        // Sam vibhag (X): matra 0 already handled above, rest are filler
        if (marker === 'X') {
          return 'filler';
        }

        // Tali vibhag (numbered): first matra of the vibhag is tali
        if (matraIndex === vibhagStart) {
          return 'tali';
        }

        // Other matras in a tali vibhag are filler
        return 'filler';
      }

      matraOffset += vibhagSize;
    }

    // Fallback (should not reach here for valid indices)
    return 'filler';
  }

  /**
   * Returns the gain (velocity) multiplier for a given matra. Uses
   * VELOCITY_SCALING.practice or .concert based on the concertMode flag.
   *
   * For 'filler' beats, applies humanization by adding a small random
   * offset to the gain for natural-sounding dynamics.
   *
   * @param {number} matraIndex - 0-based matra index.
   * @param {boolean} [concertMode=false] - Use concert velocity profile.
   * @returns {number} Gain multiplier (0.0 - 1.1+).
   */
  getVelocity(matraIndex, concertMode = false) {
    const beatType = this.getBeatType(matraIndex);
    const profile = concertMode ? VELOCITY_SCALING.concert : VELOCITY_SCALING.practice;
    const baseGain = profile[beatType] || profile.filler;

    // Humanization removed — all cycles must sound identical for practice timing.

    return baseGain;
  }

  // -------------------------------------------------------------------------
  // Callback registration
  // -------------------------------------------------------------------------

  /**
   * Registers a callback function that will be invoked on every beat.
   *
   * The callback receives:
   * - `matraIndex` {number} — 0-based matra position in the cycle
   * - `beatType` {'sam'|'tali'|'khali'|'filler'} — structural role
   * - `bol` {string} — the tabla bol syllable for this matra
   * - `velocity` {number} — gain multiplier for this beat
   *
   * @param {Function} callback - `fn(matraIndex, beatType, bol, velocity)`
   */
  onBeat(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('onBeat expects a function callback.');
    }
    this.callbacks.push(callback);
  }

  // -------------------------------------------------------------------------
  // Playback control
  // -------------------------------------------------------------------------

  /**
   * Starts the lookahead scheduler. Uses the provided AudioContext's
   * high-precision `currentTime` clock to schedule beats 100ms ahead.
   * A setInterval pump running at 25ms checks whether upcoming beats
   * need to be scheduled and fires registered callbacks.
   *
   * If the engine is already playing, this is a no-op.
   *
   * @param {AudioContext} audioContext - A Web Audio API AudioContext instance.
   * @throws {Error} If no taal has been loaded via `setTaal()`.
   */
  start(audioContext) {
    if (this.isPlaying) {
      return;
    }

    if (!this._beats || !this._bols.length) {
      throw new Error('No taal loaded. Call setTaal() before start().');
    }

    this._audioContext = audioContext;
    this.isPlaying = true;
    this._isPaused = false;
    this.currentMatra = 0;
    this._nextBeatTime = audioContext.currentTime;

    this._startPump();
  }

  /**
   * Stops the scheduler and resets the matra position to 0.
   */
  stop() {
    this._stopPump();
    this.isPlaying = false;
    this._isPaused = false;
    this.currentMatra = 0;
  }

  /**
   * Pauses the scheduler without resetting the matra position. The engine
   * remembers where it left off so that `resume()` can continue from the
   * same point.
   */
  pause() {
    if (!this.isPlaying) {
      return;
    }
    this._stopPump();
    this.isPlaying = false;
    this._isPaused = true;
  }

  /**
   * Resumes playback from the current matra position after a `pause()`.
   * If the engine was stopped (not paused), this is a no-op.
   */
  resume() {
    if (!this._isPaused || !this._audioContext) {
      return;
    }

    this.isPlaying = true;
    this._isPaused = false;
    this._nextBeatTime = this._audioContext.currentTime;

    this._startPump();
  }

  // -------------------------------------------------------------------------
  // Internal scheduler
  // -------------------------------------------------------------------------

  /**
   * Starts the setInterval pump that drives the lookahead scheduler.
   * @private
   */
  _startPump() {
    this._intervalId = setInterval(() => {
      this._scheduleBeets();
    }, this._pumpInterval);
  }

  /**
   * Stops the setInterval pump.
   * @private
   */
  _stopPump() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * The core scheduling loop. Called by the pump interval every 25ms. Checks
   * whether any upcoming beats fall within the lookahead window
   * (currentTime + scheduleAheadTime) and if so, fires callbacks and
   * advances the matra counter.
   *
   * This "lookahead" pattern is the standard approach for precise Web Audio
   * scheduling, as described in Chris Wilson's "A Tale of Two Clocks":
   * https://www.html5rocks.com/en/tutorials/audio/scheduling/
   *
   * @private
   */
  _scheduleBeets() {
    if (!this._audioContext) {
      return;
    }

    const currentTime = this._audioContext.currentTime;

    while (this._nextBeatTime < currentTime + this._scheduleAheadTime) {
      // Gather beat metadata
      const matraIndex = this.currentMatra;
      const beatType = this.getBeatType(matraIndex);
      const bol = this._bols[matraIndex] || '';
      const velocity = this.getVelocity(matraIndex);

      // Fire all registered callbacks with the precise scheduled time
      const scheduledTime = this._nextBeatTime;
      for (const cb of this.callbacks) {
        try {
          cb(matraIndex, beatType, bol, velocity, scheduledTime);
        } catch (err) {
          console.error('[TaalEngine] onBeat callback error:', err);
        }
      }

      // Advance to the next matra (wrap around at cycle end)
      this.currentMatra = (this.currentMatra + 1) % this._beats;

      // Apply pending changes at the start of a new cycle (Sam)
      if (this.currentMatra === 0) {
        if (this._pendingBpm !== undefined) {
          this.bpm = this._pendingBpm;
          this._pendingBpm = undefined;
          console.log('[TaalEngine] Tempo changed to', this.bpm, 'BPM at cycle start');
        }
        if (this._pendingTaal) {
          this._applyTaal(this._pendingTaal);
          this._pendingTaal = undefined;
          console.log('[TaalEngine] Taal changed to', this.currentTaal, 'at cycle start');
        }
      }

      // Schedule the next beat
      this._nextBeatTime += this.getBeatDuration();
    }
  }
}
