/**
 * @fileoverview Tabla bol synthesis engine for Swaradhana.
 *
 * Generates realistic tabla sounds using Web Audio API oscillators, noise
 * generators, and filters.  No external audio samples are required --- every
 * bol is constructed on the fly from a bass oscillator (Bayan), a treble
 * oscillator (Dayan), and/or a shaped noise burst.
 *
 * The Dayan (treble) frequencies track the current Sa frequency so that the
 * tabla pitch stays in tune with the tanpura drone.  The Bayan (bass) uses a
 * fixed low frequency (~80--100 Hz) that does not change with the key.
 *
 * Signal chain connection:
 *   All generated nodes connect to {@link audioEngine.getInputNode('tabla')}
 *   which feeds into the tabla EQ -> TablaGain -> DryMix -> MasterGain path
 *   defined in {@link module:audio-engine}.
 *
 * @module tabla
 */

import audioEngine from './audio-engine.js';

// tabla-samples.js is loaded dynamically on demand (not statically)
// to prevent import chain failures from breaking this module.
let tablaSamplePlayer = null;

// ---------------------------------------------------------------------------
// Bol-to-ASCII name mapping (Devanagari -> ASCII)
// ---------------------------------------------------------------------------

/**
 * Maps Devanagari bol names (as they might appear in Hindi notation mode) to
 * their canonical ASCII equivalents used as keys in {@link BOL_PARAMS}.
 *
 * @type {Readonly<Record<string, string>>}
 */
const BOL_MAP = Object.freeze({
    '\u0927\u093E':                         'Dha',      // धा
    '\u0927\u093F\u0902':                   'Dhin',     // धिं
    '\u0924\u093E':                         'Ta',       // ता
    '\u0928\u093E':                         'Na',       // ना
    '\u0924\u093F\u0902':                   'Tin',      // तिं
    '\u0924\u0940':                         'Ti',       // ती
    '\u0917\u0947':                         'Ge',       // गे
    '\u0915':                               'Ke',       // क
    '\u0924\u0942':                         'Tu',       // तू
    '\u0930\u0947':                         'Re',       // रे
    '\u0924\u093F\u0930\u0915\u093F\u091F': 'Tirkita',  // तिरकिट
    '\u0927\u093E\u0917\u0947':             'Dhage',    // धागे
    '\u0915\u0924':                         'Ka',       // कत
    '\u0917':                               'Ga',       // ग
    'x':                                    'x',        // rest
});

// ---------------------------------------------------------------------------
// Per-bol synthesis parameters
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BassParams
 * @property {number}  freq   - Fundamental frequency in Hz.
 * @property {number}  decay  - Amplitude envelope decay time in seconds.
 * @property {boolean} [muted] - If true the frequency ramps down by 50 %
 *   over the decay period, simulating a muted (damped) Bayan stroke.
 */

/**
 * @typedef {Object} TrebleParams
 * @property {number}  freq      - Base frequency in Hz (scaled to Sa).
 * @property {number}  decay     - Amplitude envelope decay time in seconds.
 * @property {boolean} [sustained] - If true, apply a slower decay and add a
 *   slight vibrato (frequency LFO +/-5 Hz at 6 Hz).
 * @property {boolean} [muted]   - If true the treble is quickly damped.
 */

/**
 * @typedef {Object} NoiseParams
 * @property {number}  gain       - Peak gain multiplier for the noise burst.
 * @property {number}  decay      - Noise envelope decay time in seconds.
 * @property {boolean} [filtered] - If true, route through a bandpass filter.
 * @property {number}  [filterFreq] - Centre frequency for the bandpass filter.
 */

/**
 * @typedef {Object} BolSynthParams
 * @property {BassParams|null}   bass   - Bayan (bass drum) component.
 * @property {TrebleParams|null} treble - Dayan (treble drum) component.
 * @property {NoiseParams|null}  noise  - Transient noise component.
 */

/**
 * Synthesis parameter lookup for each atomic bol.  Compound bols (DhaGe,
 * TiRaKiTa, etc.) are not listed here; they are decomposed into sub-bols at
 * playback time.
 *
 * Design notes:
 * - **Dha** -- heavy resonant stroke combining open Bayan + Dayan.
 * - **Ta** -- sharp, dry Dayan stroke with no bass (crisp attack).
 * - **Ge** -- deep Bayan thud, no treble.
 * - **Ke** -- filtered noise tap (rim sound), no pitched component.
 *
 * @type {Readonly<Record<string, BolSynthParams>>}
 */
const BOL_PARAMS = Object.freeze({
    Dha: {
        bass:   { freq: 100, decay: 0.3 },
        treble: { freq: 350, decay: 0.25 },
        noise:  { gain: 0.15, decay: 0.05 },
    },
    Dhin: {
        bass:   { freq: 100, decay: 0.4 },
        treble: { freq: 400, decay: 0.4, sustained: true },
        noise:  { gain: 0.12, decay: 0.05 },
    },
    Ta: {
        bass:   null,
        treble: { freq: 500, decay: 0.12 },
        noise:  null,
    },
    Na: {
        bass:   null,
        treble: { freq: 450, decay: 0.15 },
        noise:  null,
    },
    Tin: {
        bass:   null,
        treble: { freq: 400, decay: 0.25, sustained: true },
        noise:  null,
    },
    Ti: {
        bass:   null,
        treble: { freq: 380, decay: 0.2, sustained: true },
        noise:  null,
    },
    Ge: {
        bass:   { freq: 85, decay: 0.3 },
        treble: null,
        noise:  { gain: 0.08, decay: 0.03 },
    },
    Ke: {
        bass:   null,
        treble: null,
        noise:  { gain: 0.25, decay: 0.04, filtered: true, filterFreq: 150 },
    },
    Ka: {
        bass:   { freq: 90, decay: 0.08, muted: true },
        treble: null,
        noise:  { gain: 0.1, decay: 0.03 },
    },
    Re: {
        bass:   null,
        treble: { freq: 600, decay: 0.04 },
        noise:  null,
    },
    Tu: {
        bass:   { freq: 100, decay: 0.12 },
        treble: { freq: 400, decay: 0.12 },
        noise:  null,
    },
    Ddhi: {
        bass:   { freq: 95, decay: 0.1, muted: true },
        treble: { freq: 400, decay: 0.1, muted: true },
        noise:  { gain: 0.08, decay: 0.03 },
    },
    Ga: {
        bass:   { freq: 90, decay: 0.15 },
        treble: null,
        noise:  null,
    },
});

// ---------------------------------------------------------------------------
// Compound bol decomposition
// ---------------------------------------------------------------------------

/**
 * Maps compound bol names to their constituent atomic bols.  During playback
 * the available duration is divided equally among the sub-bols.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const COMPOUND_BOLS = Object.freeze({
    Tirkita:  Object.freeze(['Ti', 'Re', 'Ke', 'Ta']),
    TiRaKiTa: Object.freeze(['Ti', 'Re', 'Ke', 'Ta']),
    Dhage:    Object.freeze(['Dha', 'Ge']),
    DhaGe:    Object.freeze(['Dha', 'Ge']),
    DhaTin:   Object.freeze(['Dha', 'Tin']),
    DhinNa:   Object.freeze(['Dhin', 'Na']),
    Katataka: Object.freeze(['Ka', 'Ta', 'Ta', 'Ka']),
    Kat:      Object.freeze(['Ka', 'Ta']),
    Dhi:      Object.freeze(['Dha', 'Ti']),  // light Dhi approximated as Dha + Ti
});

/**
 * Reference frequency (Hz) used to normalise treble pitch scaling.  A G3
 * bansuri is the most common key; its Sa sits at 196 Hz.  When the user
 * selects a different key, treble frequencies are scaled proportionally:
 *
 *   actualFreq = paramFreq * (currentSaFreq / SA_REFERENCE_FREQ)
 *
 * @constant {number}
 */
const SA_REFERENCE_FREQ = 196;

// =========================================================================
// TablaSynth class
// =========================================================================

/**
 * Tabla bol synthesis engine.
 *
 * Instantiate once as a singleton (exported at bottom of module).  All
 * sound-generating methods schedule audio nodes via the shared
 * {@link AudioContext} owned by {@link module:audio-engine}.
 */
class TablaSynth {
    constructor() {
        /**
         * Current Sa frequency in Hz, used to scale Dayan (treble) pitch.
         * Updated via {@link TablaSynth#setSaFreq}.
         * @private
         * @type {number}
         */
        this._saFreq = 196;

        /**
         * Cached white-noise {@link AudioBuffer}.  Created lazily on first
         * use and reused for every subsequent noise burst.
         * @private
         * @type {AudioBuffer|null}
         */
        this._noiseBuffer = null;

        /**
         * Tabla mode: 'electronic' (synthesized) or a sample set path
         * (e.g., 'assets/audio/tabla/tabla_e_1').
         * @type {string}
         */
        this.mode = 'electronic';

        /**
         * Whether sample loading is in progress.
         * @private
         * @type {boolean}
         */
        this._loadingSamples = false;
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    /**
     * Set the base Sa frequency for Dayan pitch tracking.
     *
     * Call this whenever the user changes the flute key so that the treble
     * drum stays in tune with the tanpura drone.
     *
     * @param {number} freq - Sa frequency in Hz (e.g. 196 for G key).
     */
    setSaFreq(freq) {
        if (typeof freq === 'number' && freq > 0) {
            this._saFreq = freq;
            if (tablaSamplePlayer) tablaSamplePlayer.setSaFreq(freq);
        }
    }

    /**
     * Inject an externally-loaded sample player and set the mode.
     * This avoids dynamic import issues inside the class methods.
     *
     * @param {object} player - The TablaSamplePlayer singleton
     * @param {string} modePath - Sample set path (e.g., 'assets/audio/tabla/tabla_e_1')
     */
    useSamplePlayer(player, modePath) {
        tablaSamplePlayer = player;
        this.mode = modePath;
        console.log('[TablaSynth] Sample player injected. Mode:', modePath);
    }

    /**
     * Switch between electronic (synthesized) and sample-based tabla.
     *
     * @param {string} mode - 'electronic' or a sample set path (e.g., 'assets/audio/tabla/tabla_e_1')
     * @returns {Promise<void>}
     */
    async setMode(mode) {
        console.log('[TablaSynth] setMode called with:', mode);

        if (mode === 'electronic') {
            this.mode = 'electronic';
            console.log('[TablaSynth] Mode set to: electronic (synthesized)');
            return;
        }

        // Sample mode — dynamically load tabla-samples.js and then the sample set
        this._loadingSamples = true;
        try {
            // Lazy-load the sample player module
            if (!tablaSamplePlayer) {
                const mod = await import('./tabla-samples.js');
                tablaSamplePlayer = mod.default;
                console.log('[TablaSynth] tabla-samples.js loaded dynamically');
            }

            console.log('[TablaSynth] Loading samples from:', mode);
            await tablaSamplePlayer.loadSampleSet(mode);
            tablaSamplePlayer.setSaFreq(this._saFreq);
            this.mode = mode; // Only set mode AFTER successful load
            console.log('[TablaSynth] Mode set to: samples from', mode, '| isLoaded:', tablaSamplePlayer.isLoaded, '| buffers:', Object.keys(tablaSamplePlayer.buffers).length);
        } catch (err) {
            console.error('[TablaSynth] Failed to load samples, staying electronic:', err);
            this.mode = 'electronic';
        }
        this._loadingSamples = false;
    }

    /**
     * Schedule a tabla bol to be played at the given audio-context time.
     *
     * Handles both atomic bols (Dha, Ta, Ge ...) and compound bols
     * (Tirkita, DhaGe ...).  Devanagari names are transparently mapped to
     * their ASCII equivalents before synthesis.
     *
     * @param {string} bolName   - Bol name in ASCII or Devanagari.
     * @param {number} time      - Scheduled start time in audio-context
     *   seconds ({@link AudioContext#currentTime}).
     * @param {number} [velocity=0.8] - Gain multiplier (0--1) controlling
     *   how hard the stroke is struck.
     * @param {number} [duration=0.5] - Total available duration in seconds
     *   for this beat slot.  Only relevant for compound bols, which divide
     *   the duration among their sub-bols.
     */
    playBolAtTime(bolName, time, velocity = 0.8, duration = 0.5) {
        if (!audioEngine.isInitialized) {
            console.warn('[TablaSynth] AudioEngine not initialised; ignoring playBolAtTime.');
            return;
        }

        // If in sample mode and samples are loaded, use the sample player
        if (this.mode !== 'electronic' && tablaSamplePlayer && tablaSamplePlayer.isLoaded) {
            tablaSamplePlayer.playBol(bolName, time, velocity, duration);
            return;
        }

        // Resolve Devanagari to ASCII if needed.
        const ascii = BOL_MAP[bolName] || bolName;

        // Rest — do nothing.
        if (ascii === 'x') {
            return;
        }

        // Compound bol — split into sub-bols.
        if (COMPOUND_BOLS[ascii]) {
            const subBols = COMPOUND_BOLS[ascii];
            const subDuration = duration / subBols.length;
            for (let i = 0; i < subBols.length; i++) {
                this._playBol(subBols[i], time + i * subDuration, velocity, this._saFreq);
            }
            return;
        }

        // Atomic bol.
        this._playBol(ascii, time, velocity, this._saFreq);
    }

    // -----------------------------------------------------------------
    // Core synthesis (private)
    // -----------------------------------------------------------------

    /**
     * Synthesise and schedule a single atomic bol.
     *
     * The bol is built from up to three layers:
     * 1. **Bass** (Bayan) -- sine oscillator at a fixed low frequency.
     * 2. **Treble** (Dayan) -- triangle oscillator pitched relative to Sa.
     * 3. **Noise** -- shaped white-noise burst for the attack transient.
     *
     * Each layer is independently enveloped and connected to the tabla
     * input node of the audio engine.
     *
     * @private
     * @param {string} bolName    - ASCII bol name (must exist in BOL_PARAMS).
     * @param {number} time       - Scheduled start time (audio-context seconds).
     * @param {number} velocity   - Gain multiplier (0--1).
     * @param {number} baseSaFreq - Current Sa frequency for treble scaling.
     */
    _playBol(bolName, time, velocity, baseSaFreq) {
        const params = BOL_PARAMS[bolName];
        if (!params) {
            console.warn(`[TablaSynth] Unknown bol "${bolName}"; skipping.`);
            return;
        }

        const ctx = audioEngine.audioCtx;
        const destination = audioEngine.getInputNode('tabla');

        // Clamp velocity to a safe range.
        const vel = Math.max(0, Math.min(1, velocity));

        // ---- BASS component (Bayan) ----
        if (params.bass) {
            this._synthBass(ctx, destination, params.bass, time, vel);
        }

        // ---- TREBLE component (Dayan) ----
        if (params.treble) {
            this._synthTreble(ctx, destination, params.treble, time, vel, baseSaFreq);
        }

        // ---- NOISE component (attack transient) ----
        if (params.noise) {
            this._synthNoise(ctx, destination, params.noise, time, vel);
        }
    }

    /**
     * Create and schedule the bass (Bayan) oscillator layer.
     *
     * Uses a sine oscillator at a fixed low frequency.  If the `muted` flag
     * is set, the frequency ramps down by 50 % over the decay period to
     * simulate the hand damping the drum head.
     *
     * @private
     * @param {AudioContext}  ctx         - The shared audio context.
     * @param {AudioNode}     destination - Node to connect output to.
     * @param {BassParams}    params      - Bass synthesis parameters.
     * @param {number}        time        - Scheduled start time.
     * @param {number}        velocity    - Gain multiplier (0--1).
     */
    _synthBass(ctx, destination, params, time, velocity) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(params.freq, time);

        // Muted strokes: ramp frequency down by 50 % for a damped thud.
        if (params.muted) {
            osc.frequency.exponentialRampToValueAtTime(
                params.freq * 0.5,
                time + params.decay
            );
        }

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(velocity * 0.8, time);
        // Use exponentialRamp (target must be > 0; use a tiny floor).
        gain.gain.exponentialRampToValueAtTime(0.001, time + params.decay);

        osc.connect(gain);
        gain.connect(destination);

        osc.start(time);
        osc.stop(time + params.decay + 0.05);
    }

    /**
     * Create and schedule the treble (Dayan) oscillator layer.
     *
     * Uses a triangle oscillator whose frequency is scaled proportionally
     * to the current Sa frequency:
     *
     *   freq = paramFreq * (baseSaFreq / 196)
     *
     * For *sustained* bols (Dhin, Tin, Ti), a gentle vibrato LFO is added
     * (+/-5 Hz at 6 Hz) and the decay is inherently longer.
     *
     * @private
     * @param {AudioContext}  ctx         - The shared audio context.
     * @param {AudioNode}     destination - Node to connect output to.
     * @param {TrebleParams}  params      - Treble synthesis parameters.
     * @param {number}        time        - Scheduled start time.
     * @param {number}        velocity    - Gain multiplier (0--1).
     * @param {number}        baseSaFreq  - Current Sa frequency in Hz.
     */
    _synthTreble(ctx, destination, params, time, velocity, baseSaFreq) {
        const scaledFreq = params.freq * (baseSaFreq / SA_REFERENCE_FREQ);

        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(scaledFreq, time);

        // Sustained bols get a vibrato LFO for a ringing quality.
        if (params.sustained) {
            const lfo = ctx.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.setValueAtTime(6, time);   // 6 Hz vibrato rate

            const lfoGain = ctx.createGain();
            lfoGain.gain.setValueAtTime(5, time);     // +/- 5 Hz depth

            lfo.connect(lfoGain);
            lfoGain.connect(osc.frequency);

            lfo.start(time);
            lfo.stop(time + params.decay + 0.05);
        }

        // For muted treble, use a shorter effective decay.
        const effectiveDecay = params.muted ? params.decay * 0.5 : params.decay;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(velocity * 0.6, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + effectiveDecay);

        osc.connect(gain);
        gain.connect(destination);

        osc.start(time);
        osc.stop(time + effectiveDecay + 0.05);
    }

    /**
     * Create and schedule the noise burst layer (attack transient).
     *
     * Plays a short segment of cached white noise through an amplitude
     * envelope.  If the `filtered` flag is set, a bandpass filter is
     * inserted before the gain node to isolate a specific spectral band
     * (used for the Ke rim sound).
     *
     * @private
     * @param {AudioContext}  ctx         - The shared audio context.
     * @param {AudioNode}     destination - Node to connect output to.
     * @param {NoiseParams}   params      - Noise synthesis parameters.
     * @param {number}        time        - Scheduled start time.
     * @param {number}        velocity    - Gain multiplier (0--1).
     */
    _synthNoise(ctx, destination, params, time, velocity) {
        const buffer = this._getNoiseBuffer(ctx);

        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(velocity * params.gain, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + params.decay);

        if (params.filtered) {
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.setValueAtTime(params.filterFreq || 150, time);
            filter.Q.setValueAtTime(2, time);

            source.connect(filter);
            filter.connect(gain);
        } else {
            source.connect(gain);
        }

        gain.connect(destination);

        source.start(time);
        source.stop(time + params.decay + 0.02);
    }

    // -----------------------------------------------------------------
    // Noise buffer helper
    // -----------------------------------------------------------------

    /**
     * Return a cached white-noise {@link AudioBuffer}.  The buffer is
     * created lazily on first call (0.1 seconds of mono white noise) and
     * reused for every subsequent noise burst to avoid redundant allocation.
     *
     * @private
     * @param {AudioContext} audioCtx - The shared audio context.
     * @returns {AudioBuffer} A mono buffer filled with uniformly distributed
     *   random samples in the range [-1, 1].
     */
    _getNoiseBuffer(audioCtx) {
        if (this._noiseBuffer) {
            return this._noiseBuffer;
        }
        this._noiseBuffer = this._createNoiseBuffer(audioCtx, 0.1);
        return this._noiseBuffer;
    }

    /**
     * Generate a white-noise {@link AudioBuffer}.
     *
     * @private
     * @param {AudioContext} audioCtx - The audio context whose sample rate
     *   determines the buffer length.
     * @param {number} [duration=0.1] - Buffer duration in seconds.
     * @returns {AudioBuffer} A mono buffer of uniformly distributed random
     *   samples in the range [-1, 1].
     */
    _createNoiseBuffer(audioCtx, duration = 0.1) {
        const length = Math.floor(audioCtx.sampleRate * duration);
        const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        return buffer;
    }
}

// =========================================================================
// Singleton export
// =========================================================================

/**
 * Singleton instance of the tabla synthesis engine.
 *
 * Usage:
 * ```js
 * import tablaSynth from './tabla.js';
 *
 * // Set the Sa frequency to match the selected flute key.
 * tablaSynth.setSaFreq(196);  // G key
 *
 * // Schedule a bol at audio-context time.
 * tablaSynth.playBolAtTime('Dha', audioEngine.currentTime, 0.9);
 * ```
 *
 * @type {TablaSynth}
 */
const tablaSynth = new TablaSynth();
export default tablaSynth;
