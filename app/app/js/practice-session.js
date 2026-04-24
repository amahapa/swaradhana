/**
 * @fileoverview Practice session orchestrator for Swaradhana.
 *
 * Coordinates the tanpura drone, tabla accompaniment, and melodic swar synth
 * during a practice session. Manages the full Start / Pause / Resume / Stop
 * lifecycle and fires callbacks so the UI can stay in sync with the audio.
 *
 * Three practice modes are supported:
 * - **demo**     — The app plays both tabla bols and melodic notes automatically.
 *                  The student listens and observes.
 * - **practice** — Tabla plays, but the student plays the notes themselves.
 *                  The app provides visual cues.
 * - **test**     — Tabla plays with minimal visual cues. The student's pitch
 *                  accuracy and timing are scored.
 *
 * @module practice-session
 */

import audioEngine from './audio-engine.js';
import tabla from './tabla.js';
import swarSynth from './swar-synth.js';
import { TaalEngine } from './taal-engine.js';
import { parsePattern, generateAlankaar, generateScale, fitToTaal } from './alankaar-engine.js';
import { getEffectiveSaFreq } from './music-engine.js';

// ---------------------------------------------------------------------------
// PracticeSession class
// ---------------------------------------------------------------------------

/**
 * Session orchestrator that manages the full lifecycle of a practice session.
 *
 * Coordinates:
 * - Audio engine initialization and context resumption
 * - Tanpura drone playback
 * - Tabla beat scheduling via {@link TaalEngine}
 * - Melodic note playback via {@link SwarSynth} (in demo mode)
 * - Timer tracking for session duration
 * - UI callbacks for beat highlighting and state changes
 *
 * Usage:
 * ```js
 * import practiceSession from './practice-session.js';
 *
 * practiceSession.configure(settings);
 * practiceSession.onStateChange = (state) => updateUI(state);
 * practiceSession.onBeat = (beatInfo) => highlightBeat(beatInfo);
 * await practiceSession.start();
 * ```
 */
class PracticeSession {
    constructor() {
        // ---- State ----

        /**
         * Current session state.
         * @type {'idle'|'playing'|'paused'}
         */
        this.state = 'idle';

        /**
         * Practice mode controlling how the session behaves.
         * - `demo`: app plays tabla + swar notes automatically
         * - `practice`: app plays tabla; student plays notes
         * - `test`: app plays tabla with minimal cues; student is scored
         * @type {'demo'|'practice'|'test'}
         */
        this.mode = 'demo';

        // ---- Engines ----

        /**
         * Beat scheduling engine instance. Created fresh per session.
         * @type {TaalEngine}
         */
        this.taalEngine = new TaalEngine();

        // ---- Alankaar data ----

        /**
         * The current alankaar/scale fitted to the taal structure.
         * Contains the note sequence mapped to matras and cycles.
         * @type {object|null}
         */
        this.currentAlankaar = null;

        // ---- Progress tracking ----

        /**
         * Current avartan (taal cycle) index, 0-based.
         * @type {number}
         */
        this.currentCycle = 0;

        /**
         * Current matra index within the cycle, 0-based.
         * @type {number}
         */
        this.currentMatra = 0;

        // ---- Timer ----

        /**
         * Session timer state.
         * - `startedAt`: timestamp (ms) when the session started or resumed
         * - `elapsed`: accumulated elapsed time (ms) before the current run
         * - `target`: target session duration in ms (0 = unlimited)
         * @type {{ startedAt: number, elapsed: number, target: number }}
         */
        this.timer = {
            startedAt: 0,
            elapsed: 0,
            target: 0,
        };

        // ---- Callbacks ----

        /**
         * Callback fired when the session state changes.
         * Receives the new state string as its argument.
         * @type {function('idle'|'playing'|'paused'): void|null}
         */
        this.onStateChange = null;

        /**
         * Callback fired on every beat (matra). Receives a beat info object
         * with metadata for UI updates (highlighting, note display, etc.).
         *
         * Beat info shape:
         * ```
         * {
         *   matraIndex: number,
         *   beatType: 'sam'|'tali'|'khali'|'filler',
         *   bol: string,
         *   swarNotes: Array|null,
         *   velocity: number,
         *   time: number
         * }
         * ```
         * @type {function(object): void|null}
         */
        this.onBeat = null;

        /**
         * Callback fired when a new taal cycle (avartan) begins.
         * Receives the cycle index (0-based).
         * @type {function(number): void|null}
         */
        this.onCycleChange = null;

        // Tabla playback is handled entirely by the UI layer (ui-controller.js)
        // via the onBeat callback, ensuring the correct tabla mode is always used.

        // ---- Internal settings cache ----

        /**
         * Cached settings from the last {@link configure} call.
         * @type {object|null}
         * @private
         */
        this._settings = null;

        /**
         * Effective Sa frequency computed from key + fineTuning.
         * @type {number}
         * @private
         */
        this._saFreq = 0;
    }

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------

    /**
     * Prepares the session with the given settings. Must be called before
     * {@link start}. Can be called again while idle to reconfigure.
     *
     * This method:
     * 1. Computes the effective Sa frequency from key + fine tuning
     * 2. Configures the taal engine (taal, tempo, laykari)
     * 3. Generates or parses the alankaar pattern
     * 4. Fits the alankaar to the taal structure
     * 5. Stores settings for use during playback
     *
     * @param {object} settings - Full settings object containing:
     * @param {string} settings.key - Flute key (e.g. 'G', 'C#', 'E_low').
     * @param {number} settings.fineTuning - Fine tuning offset in cents.
     * @param {string} settings.taal - Taal ID (e.g. 'teentaal', 'keherwa').
     * @param {number} settings.tempo - Tempo in BPM.
     * @param {string} settings.laykari - Laykari level ('ekgun', 'dugun', etc.).
     * @param {string} settings.thaat - Thaat name (lowercase).
     * @param {string} settings.notation - Notation system ('hindi' or 'english').
     * @param {string} settings.currentAlankaar - Alankaar ID or 'scale'.
     * @param {string} [settings.mode='demo'] - Practice mode.
     * @param {number} [settings.repetitions=2] - Number of cycle repetitions.
     * @param {string} [settings.swarVoice='harmonium'] - Swar voice preset.
     */
    configure(settings) {
        this._settings = { ...settings };

        // 1. Calculate effective Sa frequency (default fineTuning to 0)
        const fineTuning = settings.fineTuning || 0;
        this._saFreq = getEffectiveSaFreq(settings.key || 'E_low', fineTuning);
        console.log('[PracticeSession] Sa frequency:', this._saFreq, 'Hz');

        // 2. Set up taal engine
        const taal = settings.taal || 'teentaal';
        const tempo = settings.tempo || 80;
        const laykari = settings.laykari || 'ekgun';
        this.taalEngine.setTaal(taal);
        this.taalEngine.setTempo(tempo);
        this.taalEngine.setLaykari(laykari);
        console.log('[PracticeSession] Taal:', taal, 'Tempo:', tempo, 'Laykari:', laykari);

        // 3. Generate the alankaar
        const thaat = settings.thaat || 'bilawal';
        const notation = settings.notation || 'hindi';
        let alankaar;
        try {
            if (!settings.currentAlankaar || settings.currentAlankaar === 'scale') {
                alankaar = generateScale(thaat, notation);
                console.log('[PracticeSession] Generated scale alankaar for thaat:', thaat);
            } else {
                // Parse pattern string into offset array, then generate
                const offsets = parsePattern(settings.currentAlankaar);
                alankaar = generateAlankaar(offsets, thaat, notation);
                console.log('[PracticeSession] Generated alankaar from pattern:', settings.currentAlankaar);
            }
        } catch (err) {
            console.error('[PracticeSession] Alankaar generation failed:', err.message, '— falling back to scale');
            alankaar = generateScale(thaat, notation);
        }

        // 4. Fit to taal
        try {
            this.currentAlankaar = fitToTaal(alankaar, taal, laykari);
            console.log('[PracticeSession] Fitted to taal. Cycles:', this.currentAlankaar?.length);
        } catch (err) {
            console.error('[PracticeSession] fitToTaal failed:', err.message);
            this.currentAlankaar = null;
        }

        // 5. Set mode
        this.mode = settings.mode || 'demo';

        // 6. Configure tabla Sa frequency (for tuned bols)
        if (typeof tabla.setSaFreq === 'function') {
            tabla.setSaFreq(this._saFreq);
        }

        console.log('[PracticeSession] Configuration complete.');
    }

    // ------------------------------------------------------------------
    // Playback control
    // ------------------------------------------------------------------

    /**
     * Starts the practice session. Initializes the audio engine if needed,
     * starts the tanpura drone, registers beat callbacks, and begins the
     * taal engine scheduler.
     *
     * If the session is paused, use {@link resume} instead.
     *
     * @returns {Promise<void>}
     * @throws {Error} If {@link configure} has not been called.
     */
    async start() {
        if (!this._settings) {
            throw new Error(
                '[PracticeSession] configure() must be called before start().'
            );
        }

        try {
            // 1. Initialize audio engine if needed
            if (!audioEngine.isInitialized) {
                await audioEngine.init();
            }
            await audioEngine.resume();

            // 2. Initialize swar synth
            await swarSynth.init();

            // Set voice if specified
            if (this._settings.swarVoice) {
                swarSynth.setVoice(this._settings.swarVoice);
            }

            // 3. Tanpura is managed entirely by the UI layer (ui-controller.js).
            //    The Start button in the UI starts tanpura if not already playing.

            // 4. Register taal engine onBeat callback
            this.taalEngine.callbacks = []; // clear previous callbacks
            this.currentCycle = 0;
            this.currentMatra = 0;

            this.taalEngine.onBeat((matraIndex, beatType, bol, velocity, scheduledTime) => {
                this.currentMatra = matraIndex;

                // Detect new cycle (sam beat after first beat)
                if (matraIndex === 0 && this.state === 'playing') {
                    if (this._previousMatra !== undefined && this._previousMatra > 0) {
                        this.currentCycle++;
                        if (this.onCycleChange) {
                            try {
                                this.onCycleChange(this.currentCycle);
                            } catch (err) {
                                console.error('[PracticeSession] onCycleChange error:', err);
                            }
                        }
                    }
                }
                this._previousMatra = matraIndex;

                // Use the precise scheduled time from the taal engine
                const now = scheduledTime;

                // a. Tabla playback is handled by the UI layer via the onBeat callback.
                //    This ensures the correct tabla mode (electronic vs samples)
                //    is always respected from the global settings.

                // b. In demo mode, play the swar note for this matra
                let swarNotes = null;
                if (this.mode === 'demo' && this.currentAlankaar) {
                    swarNotes = this._getSwarNotesForMatra(matraIndex);
                    if (swarNotes && swarNotes.length > 0) {
                        const subBeatDuration = this.taalEngine.getSubBeatDuration();
                        for (let i = 0; i < swarNotes.length; i++) {
                            const note = swarNotes[i];
                            const noteTime = now + (i * subBeatDuration);
                            try {
                                swarSynth.playNote(
                                    note.position,
                                    this._settings.thaat,
                                    this._saFreq,
                                    noteTime,
                                    subBeatDuration * 0.9,
                                    velocity * 0.8
                                );
                            } catch (err) {
                                console.error('[PracticeSession] Swar playback error:', err);
                            }
                        }
                    }
                }

                // c. Fire onBeat callback for UI updates
                if (this.onBeat) {
                    try {
                        this.onBeat({
                            matraIndex,
                            beatType,
                            bol,
                            swarNotes,
                            velocity,
                            time: now,
                        });
                    } catch (err) {
                        console.error('[PracticeSession] onBeat callback error:', err);
                    }
                }
            });

            // 5. Start taal engine
            this.taalEngine.start(audioEngine.audioCtx);

            // 6. Start timer
            this.timer.startedAt = Date.now();
            this.timer.elapsed = 0;

            // 7. Set state
            this._previousMatra = undefined;
            this._setState('playing');

        } catch (err) {
            console.error('[PracticeSession] Failed to start session:', err);
            this._setState('idle');
            throw err;
        }
    }

    /**
     * Pauses the session. The taal engine, tanpura, and timer are suspended
     * but retain their positions so that {@link resume} can continue
     * seamlessly.
     */
    pause() {
        if (this.state !== 'playing') {
            return;
        }

        // Pause taal engine
        this.taalEngine.pause();

        // Tanpura pause/resume is handled by the UI layer

        // Stop swar notes
        swarSynth.stopAll();

        // Pause timer — accumulate elapsed time
        this.timer.elapsed += Date.now() - this.timer.startedAt;

        this._setState('paused');
    }

    /**
     * Resumes a paused session. Restarts the taal engine from the current
     * matra position and resumes the tanpura drone and timer.
     */
    resume() {
        if (this.state !== 'paused') {
            return;
        }

        // Resume taal engine
        this.taalEngine.resume();

        // Tanpura pause/resume is handled by the UI layer

        // Resume timer
        this.timer.startedAt = Date.now();

        this._setState('playing');
    }

    /**
     * Stops the session completely. All audio is halted, the taal engine is
     * reset, and the state returns to idle.
     *
     * @returns {object} Final session statistics:
     *   - `elapsedMs` {number} — total session duration in milliseconds
     *   - `elapsedFormatted` {string} — formatted as "MM:SS"
     *   - `cyclesCompleted` {number} — number of full taal cycles completed
     *   - `mode` {string} — the practice mode used
     */
    stop() {
        // Stop taal engine
        this.taalEngine.stop();

        // Tanpura stop is handled by the UI layer

        // Stop all swar notes
        swarSynth.stopAll();

        // Calculate final elapsed time
        if (this.state === 'playing') {
            this.timer.elapsed += Date.now() - this.timer.startedAt;
        }

        // Gather stats
        const stats = {
            elapsedMs: this.timer.elapsed,
            elapsedFormatted: this.getElapsedTime(),
            cyclesCompleted: this.currentCycle,
            mode: this.mode,
        };

        // Reset state
        this.currentCycle = 0;
        this.currentMatra = 0;
        this.timer = { startedAt: 0, elapsed: 0, target: 0 };
        this._previousMatra = undefined;

        this._setState('idle');

        return stats;
    }

    // ------------------------------------------------------------------
    // Query methods
    // ------------------------------------------------------------------

    /**
     * Returns the elapsed session time as a formatted "MM:SS" string.
     *
     * Accounts for paused intervals by using the accumulated elapsed time
     * plus any currently running segment.
     *
     * @returns {string} Formatted time string (e.g. "03:45").
     */
    getElapsedTime() {
        let totalMs = this.timer.elapsed;
        if (this.state === 'playing') {
            totalMs += Date.now() - this.timer.startedAt;
        }

        const totalSeconds = Math.floor(totalMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    /**
     * Returns the current progress within the practice session.
     *
     * @returns {{
     *   currentCycle: number,
     *   totalCycles: number,
     *   currentMatra: number,
     *   phase: 'aroha'|'avaroha'
     * }} Progress info object.
     */
    getProgress() {
        const totalCycles = this._settings
            ? (this._settings.repetitions || 2)
            : 0;

        // Determine phase based on position in the alankaar
        let phase = 'aroha';
        if (this.currentAlankaar && this.currentAlankaar.phases) {
            // If the fitted alankaar provides phase info, use it
            const phases = this.currentAlankaar.phases;
            if (phases[this.currentMatra]) {
                phase = phases[this.currentMatra];
            }
        } else if (this.currentAlankaar && this.currentAlankaar.totalNotes) {
            // Heuristic: first half is aroha, second half is avaroha
            const midpoint = Math.floor(this.currentAlankaar.totalNotes / 2);
            const globalPosition = this.currentMatra;
            phase = globalPosition < midpoint ? 'aroha' : 'avaroha';
        }

        return {
            currentCycle: this.currentCycle,
            totalCycles,
            currentMatra: this.currentMatra,
            phase,
        };
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * Retrieves the swar note(s) that should be played at a given matra
     * index within the current alankaar.
     *
     * The fitted alankaar contains a `notes` array (or nested structure)
     * mapping each matra to one or more note positions.
     *
     * @param {number} matraIndex - 0-based matra index in the taal cycle.
     * @returns {Array<{ position: number }>|null} Array of note objects with
     *   flute position numbers, or null if no notes for this matra.
     * @private
     */
    /**
     * Gets the swar notes for a given matra in the current cycle.
     *
     * The fitted alankaar is an array of cycle objects:
     * [ { cycle:1, matras: [{matra:0, notes:['S','R',...], bol:'Dha'}, ...] }, ... ]
     *
     * Notes are label strings. We need to return objects with .position
     * for swarSynth.playNote(). We map label→position using a simple lookup.
     *
     * @param {number} matraIndex - 0-based matra within the current cycle
     * @returns {Array<{position:number}>|null}
     * @private
     */
    _getSwarNotesForMatra(matraIndex) {
        if (!this.currentAlankaar || !Array.isArray(this.currentAlankaar)) {
            return null;
        }

        // Get current cycle (wrap around if needed)
        const cycleIndex = this.currentCycle % this.currentAlankaar.length;
        const cycle = this.currentAlankaar[cycleIndex];
        if (!cycle || !cycle.matras || !cycle.matras[matraIndex]) {
            return null;
        }

        const matraData = cycle.matras[matraIndex];
        const notes = matraData.notes;
        if (!notes || !Array.isArray(notes)) {
            return null;
        }

        // Notes are objects {label, position} or null (rest).
        // Filter nulls and return those with valid positions.
        return notes
            .filter(n => n !== null && n.position !== undefined);
    }

    /**
     * Updates the session state and fires the {@link onStateChange} callback.
     *
     * @param {'idle'|'playing'|'paused'} newState - The new state.
     * @private
     */
    _setState(newState) {
        this.state = newState;
        if (this.onStateChange) {
            try {
                this.onStateChange(newState);
            } catch (err) {
                console.error('[PracticeSession] onStateChange callback error:', err);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Singleton instance of the practice session orchestrator.
 *
 * Import this from any module that needs to control practice playback:
 * ```js
 * import practiceSession from './practice-session.js';
 *
 * practiceSession.configure(settings);
 * practiceSession.onBeat = (info) => updateBeatHighlight(info);
 * await practiceSession.start();
 * ```
 *
 * @type {PracticeSession}
 */
const practiceSession = new PracticeSession();
export default practiceSession;
