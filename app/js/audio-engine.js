/**
 * @fileoverview Master audio engine for Swaradhana.
 *
 * Creates and manages the Web Audio API {@link AudioContext} and the full
 * signal chain.  Individual instrument modules (tanpura.js, tabla.js,
 * swar-synth.js, etc.) do NOT create their own contexts — they connect to
 * the nodes exposed here via {@link AudioEngine#getInputNode}.
 *
 * Signal chain (see docs/audio_engine.md):
 *
 *   Tanpura A -> GainA -> PanA -\
 *   Tanpura B -> GainB -> PanB --> Compressor -> Reverb -> MasterGain -> Destination
 *   Swar     -> SwarGain ------/
 *
 *   Tabla -> BassEQ -> TrebleEQ -> TablaGain -> DryMix -> MasterGain -> Destination
 *   Kartaal -> KartaalGain                   -> DryMix
 *
 *   Manjira  -> ManjiraGain  -> Reverb -> MasterGain
 *   Ghungroo -> GhungrooGain -> Reverb -> MasterGain
 *
 * @module audio-engine
 */

/**
 * Master audio engine — singleton.
 *
 * The constructor intentionally does **not** create an {@link AudioContext}
 * because browsers require a user gesture before audio can start.  Call
 * {@link AudioEngine#init} from within a click / tap handler.
 */
class AudioEngine {
    constructor() {
        /** @type {AudioContext|null} */
        this.audioCtx = null;

        // ---- Master chain ----
        /** @type {GainNode|null} */
        this.masterGain = null;
        /** @type {DynamicsCompressorNode|null} */
        this.compressor = null;
        /** @type {ConvolverNode|null} */
        this.reverb = null;
        /** @type {GainNode|null} — dry path bypassing reverb */
        this.dryMix = null;

        // ---- Tanpura ----
        /** @type {GainNode|null} */
        this.tanpuraGainA = null;
        /** @type {GainNode|null} */
        this.tanpuraGainB = null;
        /** @type {StereoPannerNode|null} */
        this.tanpuraPanA = null;
        /** @type {StereoPannerNode|null} */
        this.tanpuraPanB = null;

        // ---- Tabla ----
        /** @type {GainNode|null} */
        this.tablaGain = null;
        /** @type {BiquadFilterNode|null} */
        this.tablaBassEQ = null;
        /** @type {BiquadFilterNode|null} */
        this.tablaTrebleEQ = null;

        // ---- Swar synth ----
        /** @type {GainNode|null} */
        this.swarGain = null;

        // ---- Auxiliary percussion ----
        /** @type {GainNode|null} */
        this.manjiraGain = null;
        /** @type {GainNode|null} */
        this.ghungrooGain = null;
        /** @type {GainNode|null} */
        this.kartaalGain = null;

        /** @private */
        this._initialized = false;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Create the {@link AudioContext} and wire up the full signal chain.
     *
     * Must be called from inside a user-gesture handler (click / tap) to
     * satisfy the browser autoplay policy.
     *
     * @returns {Promise<void>}
     */
    async init() {
        if (this._initialized) {
            return;
        }

        this.audioCtx = new AudioContext({
            sampleRate: 48000,
            latencyHint: 'interactive',
        });

        // ---- Master output ----
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.value = 0.8;

        // Master soft-clip limiter. Per-bus limiters (tabla, tanpura)
        // clamp *their* peaks to ±0.98 each, but when multiple buses play
        // simultaneously the sum at master can still exceed ±1.0 and
        // clip audibly — especially on mobile speakers, which have less
        // headroom than laptop outputs. A gentle tanh curve here catches
        // the summed peaks.
        this.masterLimiter = this.audioCtx.createWaveShaper();
        this.masterLimiter.curve = this._buildTanhLimiterCurve(1.0);
        this.masterLimiter.oversample = '2x';

        this.masterGain.connect(this.masterLimiter);
        this.masterLimiter.connect(this.audioCtx.destination);

        // ---- Compressor ----
        this.compressor = this.audioCtx.createDynamicsCompressor();
        this.compressor.threshold.value = -24;
        this.compressor.knee.value = 30;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.25;

        // ---- Reverb (convolution with synthetic IR) ----
        this.reverb = this.audioCtx.createConvolver();
        this.reverb.buffer = this._generateReverbIR(2, 3);

        // Wet path: Compressor -> Reverb -> MasterGain
        this.compressor.connect(this.reverb);
        this.reverb.connect(this.masterGain);

        // ---- Dry mix bus ---- (Tabla + Kartaal bypass reverb)
        this.dryMix = this.audioCtx.createGain();
        this.dryMix.gain.value = 1.0;
        this.dryMix.connect(this.masterGain);

        // ================================================================
        //  Tanpura nodes
        // ================================================================

        // Per-bus A/B: acts as the concert-mode balance stage.
        // Default equal-power balance @ 50%.
        const halfRoot = Math.SQRT1_2; // cos(π/4) = sin(π/4)
        this.tanpuraGainA = this.audioCtx.createGain();
        this.tanpuraGainA.gain.value = halfRoot;
        this.tanpuraPanA = this.audioCtx.createStereoPanner();
        this.tanpuraPanA.pan.value = 0;

        this.tanpuraGainB = this.audioCtx.createGain();
        this.tanpuraGainB.gain.value = halfRoot;
        this.tanpuraPanB = this.audioCtx.createStereoPanner();
        this.tanpuraPanB.pan.value = 0;

        // Shared bus gain controls the overall tanpura loudness (main-page
        // volume slider target).
        this.tanpuraBusGain = this.audioCtx.createGain();
        this.tanpuraBusGain.gain.value = 0.8;

        // Per-bus limiter removed for mobile CPU headroom. The master
        // limiter downstream catches any remaining peaks from the summed
        // bus. The compressor + reverb also smooth tanpura-specific peaks.

        // A -> GainA -> PanA -> BusGain -> Compressor
        this.tanpuraGainA.connect(this.tanpuraPanA);
        this.tanpuraPanA.connect(this.tanpuraBusGain);

        // B -> GainB -> PanB -> BusGain -> Compressor
        this.tanpuraGainB.connect(this.tanpuraPanB);
        this.tanpuraPanB.connect(this.tanpuraBusGain);

        this.tanpuraBusGain.connect(this.compressor);

        // ================================================================
        //  Swar synth node
        // ================================================================

        this.swarGain = this.audioCtx.createGain();
        this.swarGain.gain.value = 0.7;
        // Swar -> SwarGain -> Compressor (-> Reverb -> Master)
        this.swarGain.connect(this.compressor);

        // ================================================================
        //  Tabla nodes
        // ================================================================

        this.tablaBassEQ = this.audioCtx.createBiquadFilter();
        this.tablaBassEQ.type = 'lowshelf';
        this.tablaBassEQ.frequency.value = 200;
        this.tablaBassEQ.gain.value = 0;

        this.tablaTrebleEQ = this.audioCtx.createBiquadFilter();
        this.tablaTrebleEQ.type = 'highshelf';
        this.tablaTrebleEQ.frequency.value = 2000;
        this.tablaTrebleEQ.gain.value = 0;

        this.tablaGain = this.audioCtx.createGain();
        this.tablaGain.gain.value = 0.7;

        // Per-bus limiter removed for mobile CPU headroom. Tabla peaks
        // are handled by the master limiter downstream. To keep peaks
        // well below clipping, the per-set GAIN_BY_SET multipliers in
        // tabla-samples.js are kept ≤ 1.2 so velocity × setGain rarely
        // exceeds 1.0 on typical bols.

        // Tabla -> BassEQ -> TrebleEQ -> TablaGain -> DryMix -> Master
        this.tablaBassEQ.connect(this.tablaTrebleEQ);
        this.tablaTrebleEQ.connect(this.tablaGain);
        this.tablaGain.connect(this.dryMix);

        // ================================================================
        //  Auxiliary percussion nodes
        // ================================================================

        // Manjira -> ManjiraGain -> Reverb -> Master
        this.manjiraGain = this.audioCtx.createGain();
        this.manjiraGain.gain.value = 0.5;
        this.manjiraGain.connect(this.reverb);

        // Ghungroo -> GhungrooGain -> Reverb -> Master
        this.ghungrooGain = this.audioCtx.createGain();
        this.ghungrooGain.gain.value = 0.4;
        this.ghungrooGain.connect(this.reverb);

        // Kartaal -> KartaalGain -> DryMix -> Master
        this.kartaalGain = this.audioCtx.createGain();
        this.kartaalGain.gain.value = 0.5;
        this.kartaalGain.connect(this.dryMix);

        this._initialized = true;

        // Follow the system default output (speaker / Bluetooth) so that
        // connecting a BT device mid-session migrates Web Audio too.
        // AudioContext.setSinkId is the only reliable way to force that
        // rebinding on mobile Chrome — otherwise the context stays latched
        // to the output that was default when it was created, and audio
        // keeps coming out of the phone speaker after BT connects.
        await this._bindSinkToDefault();
        if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
            // Debounce: some browsers fire devicechange repeatedly on a
            // single real event; rebinding the sink on each call causes
            // audible clicks.
            let t = null;
            navigator.mediaDevices.addEventListener('devicechange', () => {
                clearTimeout(t);
                t = setTimeout(() => this._bindSinkToDefault(), 500);
            });
        }
    }

    /**
     * Resume the {@link AudioContext} if it is in a suspended state.
     *
     * Browsers suspend the context until a user gesture occurs.  Call this
     * from a click / tap handler to ensure audio playback can begin.
     *
     * @returns {Promise<void>}
     */
    async resume() {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }
        // Also re-bind the sink after resume — the default output may have
        // changed while the context was suspended (e.g. user connected BT
        // while the tab was hidden).
        await this._bindSinkToDefault();
    }

    /**
     * Rebind the AudioContext's output sink to the current system default.
     * No-op on browsers that don't implement `AudioContext.setSinkId`.
     *
     * Pass empty string `''` per the spec to mean "follow default output".
     * Failures are logged but not thrown — the context continues to work
     * on whichever sink it was already bound to.
     *
     * @private
     */
    /**
     * Build a tanh-based soft-clip curve for a bus limiter.
     * - Below ~0.7 input, output is nearly linear (no change to normal hits).
     * - Above that, output curves asymptotically toward ±1 (peaks rounded
     *   off gently instead of hard-clipping).
     * - Output clamped to ±0.98 so the OS mixer never hits 0 dB, leaving
     *   a sliver of headroom.
     *
     * @param {number} [k=1.5] - Curve stiffness. Higher = harder knee, more
     *   audible colouration but tighter peak control. 1.2 is gentle
     *   (tanpura — smoother transients); 1.5 is firmer (tabla — hard hits).
     * @private
     */
    _buildTanhLimiterCurve(k = 1.5) {
        const N = 2048;
        const curve = new Float32Array(N);
        const scale = Math.tanh(k);
        for (let i = 0; i < N; i++) {
            const x = (i / (N - 1)) * 2 - 1; // -1..+1
            curve[i] = Math.tanh(k * x) / scale * 0.98;
        }
        return curve;
    }

    async _bindSinkToDefault() {
        if (!this.audioCtx) return;
        if (typeof this.audioCtx.setSinkId !== 'function') return;
        try {
            await this.audioCtx.setSinkId('');
            console.log('[audio-engine] Bound output to system default sink');
        } catch (e) {
            console.warn('[audio-engine] setSinkId failed:', e?.message || e);
        }
    }

    // ------------------------------------------------------------------
    // Read-only properties
    // ------------------------------------------------------------------

    /**
     * The high-resolution audio clock time, in seconds.
     *
     * @type {number}
     */
    get currentTime() {
        return this.audioCtx ? this.audioCtx.currentTime : 0;
    }

    /**
     * Whether {@link init} has been called successfully.
     *
     * @type {boolean}
     */
    get isInitialized() {
        return this._initialized;
    }

    // ------------------------------------------------------------------
    // Volume / EQ setters
    // ------------------------------------------------------------------

    /**
     * Set the master output volume.
     *
     * @param {number} value - Gain value in the range 0 – 1.
     */
    setMasterVolume(value) {
        if (this.masterGain) {
            this.masterGain.gain.setTargetAtTime(
                Math.max(0, Math.min(1, value)),
                this.audioCtx.currentTime,
                0.02
            );
        }
    }

    /**
     * Set the tabla bus volume.
     *
     * @param {number} value - Gain value in the range 0 – 1.
     */
    setTablaVolume(value) {
        if (this.tablaGain) {
            this.tablaGain.gain.setTargetAtTime(
                Math.max(0, Math.min(1, value)),
                this.audioCtx.currentTime,
                0.02
            );
        }
    }

    /**
     * Adjust the tabla low-shelf (bass) EQ.
     *
     * @param {number} dB - Gain in decibels, clamped to -12 .. +12.
     */
    setTablaBassEQ(dB) {
        if (this.tablaBassEQ) {
            this.tablaBassEQ.gain.setTargetAtTime(
                Math.max(-12, Math.min(12, dB)),
                this.audioCtx.currentTime,
                0.02
            );
        }
    }

    /**
     * Adjust the tabla high-shelf (treble) EQ.
     *
     * @param {number} dB - Gain in decibels, clamped to -12 .. +12.
     */
    setTablaTrebleEQ(dB) {
        if (this.tablaTrebleEQ) {
            this.tablaTrebleEQ.gain.setTargetAtTime(
                Math.max(-12, Math.min(12, dB)),
                this.audioCtx.currentTime,
                0.02
            );
        }
    }

    /**
     * Overall tanpura bus volume — the master knob surfaced on the
     * main-page volume slider. Applies to both A and B equally.
     *
     * Accepts values above 1.0 for headroom — the tanpura bus sits
     * before the compressor and reverb, both of which attenuate the
     * signal further, so unity at the gain node still ends up quieter
     * than the tabla bus (which bypasses the reverb wet send).
     *
     * @param {number} value - Gain value in the range 0 – 2.
     */
    setTanpuraBusVolume(value) {
        if (!this.tanpuraBusGain || !this.audioCtx) return;
        const clamped = Math.max(0, Math.min(2, value));
        this.tanpuraBusGain.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.02);
    }

    /**
     * Concert-mode balance between Tanpura A and B, using an equal-power
     * law so centre (50) keeps overall loudness unchanged.
     *
     * @param {number} percent - 0 = all A (left), 50 = equal, 100 = all B (right).
     */
    setTanpuraBalance(percent) {
        if (!this.tanpuraGainA || !this.tanpuraGainB || !this.audioCtx) return;
        const p = Math.max(0, Math.min(100, percent)) / 100;
        const t = this.audioCtx.currentTime;
        // Equal-power crossfade: A = cos, B = sin of (p * π/2).
        const a = Math.cos(p * Math.PI / 2);
        const b = Math.sin(p * Math.PI / 2);
        this.tanpuraGainA.gain.setTargetAtTime(a, t, 0.02);
        this.tanpuraGainB.gain.setTargetAtTime(b, t, 0.02);
    }

    /**
     * Legacy: set Tanpura A and B independently. Kept for backward
     * compatibility; the UI now uses {@link setTanpuraBusVolume} and
     * {@link setTanpuraBalance}.
     */
    setTanpuraVolume(a, b) {
        const t = this.audioCtx ? this.audioCtx.currentTime : 0;
        if (this.tanpuraGainA) {
            this.tanpuraGainA.gain.setTargetAtTime(Math.max(0, Math.min(1, a)), t, 0.02);
        }
        if (this.tanpuraGainB) {
            this.tanpuraGainB.gain.setTargetAtTime(Math.max(0, Math.min(1, b)), t, 0.02);
        }
    }

    /**
     * Configure tanpura stereo panning for concert or single mode.
     *
     * In concert mode A is panned left and B right so the two tanpuras
     * flank the singer/flute. In single mode A is centred.
     *
     * @param {boolean} concert - `true` for concert mode panning.
     * @param {number} [intensity=0.7] - Pan magnitude (0..1).
     */
    setTanpuraPan(concert, intensity = 0.7) {
        if (this.tanpuraPanA && this.tanpuraPanB && this.audioCtx) {
            const t = this.audioCtx.currentTime;
            const amt = Math.max(0, Math.min(1, intensity));
            if (concert) {
                this.tanpuraPanA.pan.setTargetAtTime(-amt, t, 0.02);
                this.tanpuraPanB.pan.setTargetAtTime(+amt, t, 0.02);
            } else {
                this.tanpuraPanA.pan.setTargetAtTime(0, t, 0.02);
                this.tanpuraPanB.pan.setTargetAtTime(0, t, 0.02);
            }
        }
    }

    /**
     * Set the melodic swar synth volume.
     *
     * @param {number} value - Gain value in the range 0 – 1.
     */
    setSwarVolume(value) {
        if (this.swarGain) {
            this.swarGain.gain.setTargetAtTime(
                Math.max(0, Math.min(1, value)),
                this.audioCtx.currentTime,
                0.02
            );
        }
    }

    // ------------------------------------------------------------------
    // Instrument connection point
    // ------------------------------------------------------------------

    /**
     * Return the {@link AudioNode} that an instrument module should
     * connect its output to.
     *
     * @param {'tanpuraA'|'tanpuraB'|'tabla'|'swar'|'manjira'|'ghungroo'|'kartaal'} instrument
     *   Identifier of the instrument requesting a destination node.
     * @returns {AudioNode} The appropriate input node for the instrument.
     * @throws {Error} If the engine has not been initialised or the
     *   instrument identifier is unknown.
     */
    getInputNode(instrument) {
        if (!this._initialized) {
            throw new Error(
                '[AudioEngine] Not initialised. Call init() first.'
            );
        }

        switch (instrument) {
            case 'tanpuraA':
                return this.tanpuraGainA;
            case 'tanpuraB':
                return this.tanpuraGainB;
            case 'tabla':
                return this.tablaBassEQ;
            case 'swar':
                return this.swarGain;
            case 'manjira':
                return this.manjiraGain;
            case 'ghungroo':
                return this.ghungrooGain;
            case 'kartaal':
                return this.kartaalGain;
            default:
                throw new Error(
                    `[AudioEngine] Unknown instrument: "${instrument}"`
                );
        }
    }

    // ------------------------------------------------------------------
    // Synthetic impulse-response generation
    // ------------------------------------------------------------------

    /**
     * Generate a synthetic stereo room impulse response for the
     * {@link ConvolverNode}.
     *
     * The IR simulates a warm practice room with early reflections in the
     * first 50 ms followed by an exponentially decaying reverb tail.
     * No external audio file is loaded.
     *
     * @private
     * @param {number} [duration=2]  - Length of the IR in seconds.
     * @param {number} [decay=3]     - Exponential decay factor (higher = faster decay).
     * @returns {AudioBuffer} A stereo {@link AudioBuffer} containing the IR.
     */
    _generateReverbIR(duration = 2, decay = 3) {
        const sampleRate = this.audioCtx.sampleRate;
        const length = Math.floor(sampleRate * duration);
        const buffer = this.audioCtx.createBuffer(2, length, sampleRate);
        const channelL = buffer.getChannelData(0);
        const channelR = buffer.getChannelData(1);

        // Number of samples in the first 50 ms (early-reflection zone).
        const earlyReflectionSamples = Math.floor(sampleRate * 0.05);

        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;

            // --- Late reverb: exponentially decaying noise ---
            const envelope = Math.exp(-decay * t);
            let sampleL = (Math.random() * 2 - 1) * envelope;
            let sampleR = (Math.random() * 2 - 1) * envelope;

            // --- Early reflections: louder random impulses in first 50 ms ---
            if (i < earlyReflectionSamples) {
                const earlyGain = 0.5;
                sampleL += (Math.random() * 2 - 1) * earlyGain;
                sampleR += (Math.random() * 2 - 1) * earlyGain;
            }

            // --- Subtle modulation for warmth ---
            const modulation = 1 + 0.02 * Math.sin(2 * Math.PI * 0.5 * t);
            sampleL *= modulation;
            sampleR *= modulation;

            channelL[i] = sampleL;
            channelR[i] = sampleR;
        }

        return buffer;
    }
}

/**
 * Singleton instance of the audio engine.
 *
 * Import this from any module that needs access to the audio graph:
 * ```js
 * import audioEngine from './audio-engine.js';
 * await audioEngine.init();
 * const dest = audioEngine.getInputNode('tabla');
 * ```
 *
 * @type {AudioEngine}
 */
const audioEngine = new AudioEngine();
export default audioEngine;
