/**
 * @fileoverview Master audio engine for Swaradhana.
 *
 * Owns the Web Audio `AudioContext` and the shared graph nodes every
 * instrument connects to. Instruments (tanpura engines, tabla, swar synth)
 * do NOT create their own contexts — they ask the engine for a destination
 * node and connect to it.
 *
 * ## Signal chain
 *
 * ```
 *                                 ┌── Compressor → Reverb ─┐
 * Swar synth ──── SwarGain ──────┤                        │
 * Manjira    ──── ManjiraGain  ──┤                        │
 * Ghungroo   ──── GhungrooGain ──┘                        │
 *                                                         ├──► MasterGain ──► destination
 * Tabla      ──── BassEQ → TrebleEQ → TablaGain → DryMix ─┤
 * Kartaal    ──── KartaalGain ───────────────────► DryMix ─┤
 *                                                         │
 * Tanpura (single mode)  ────────────────────────────────► │   (bypasses compressor + reverb + A/B bus;
 *                                                         │    per-engine outputGain connects directly
 *                                                         │    to MasterGain for lowest mobile CPU load)
 *                                                         │
 * Tanpura A  ── tanpuraGainA → panA ─┐                    │
 * Tanpura B  ── tanpuraGainB → panB ─┴── tanpuraBusGain ──┘   (concert mode only — two engines +
 *                                                              equal-power balance + wide pan)
 * ```
 *
 * ## Tanpura routing rules
 *
 * The tanpura bypasses the compressor + reverb on the master chain. The
 * drone is self-sustaining with controlled amplitude — neither node adds
 * much musically — and convolution reverb is the most expensive continuous
 * node in the graph on mobile CPUs. Keeping the tanpura path short is the
 * main win for battery-friendly mobile playback.
 *
 * In **single mode** (concert off) the active tanpura engine's outputGain
 * connects **directly to masterGain** — no A/B panning, no balance stage.
 *
 * In **concert mode** two engine instances play simultaneously and connect
 * to `tanpuraGainA` / `tanpuraGainB` respectively. Those buses go through
 * pan (±0.7), merge at `tanpuraBusGain`, and then hit masterGain.
 *
 * @module audio-engine
 */

/**
 * Singleton audio engine. The constructor does NOT create the
 * AudioContext — browsers require a user gesture before audio can start.
 * Call {@link AudioEngine#init} from a click/tap handler.
 */
class AudioEngine {
    constructor() {
        /** @type {AudioContext|null} */
        this.audioCtx = null;

        // Master chain
        /** @type {GainNode|null} */
        this.masterGain = null;
        /** @type {DynamicsCompressorNode|null} Used by swar + auxiliary percussion, NOT tanpura/tabla. */
        this.compressor = null;
        /** @type {ConvolverNode|null} Synthetic 1-second room IR; wet for compressor branch. */
        this.reverb = null;
        /** @type {GainNode|null} Dry bus for tabla/kartaal (bypasses reverb). */
        this.dryMix = null;

        // Tanpura — concert-mode A/B buses (see getInputNode('tanpuraA'|'tanpuraB'))
        /** @type {GainNode|null} */
        this.tanpuraGainA = null;
        /** @type {GainNode|null} */
        this.tanpuraGainB = null;
        /** @type {StereoPannerNode|null} */
        this.tanpuraPanA = null;
        /** @type {StereoPannerNode|null} */
        this.tanpuraPanB = null;
        /** @type {GainNode|null} Shared bus gain after balance stage. */
        this.tanpuraBusGain = null;

        // Tabla
        /** @type {GainNode|null} */
        this.tablaGain = null;
        /** @type {BiquadFilterNode|null} */
        this.tablaBassEQ = null;
        /** @type {BiquadFilterNode|null} */
        this.tablaTrebleEQ = null;

        // Swar synth
        /** @type {GainNode|null} */
        this.swarGain = null;

        // Auxiliary percussion
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
     * Create the AudioContext and wire up the shared graph. Must be called
     * from a user-gesture handler.
     *
     * @returns {Promise<void>}
     */
    async init() {
        if (this._initialized) return;

        // sampleRate 44100 matches every bundled MP3 — avoids continuous
        //   resampling of buffer sources at runtime.
        // latencyHint 'playback' asks the browser for larger audio buffers,
        //   trading a few ms of latency for better immunity to main-thread
        //   stalls on mobile. This is a practice app — real-time latency
        //   isn't critical.
        this.audioCtx = new AudioContext({
            sampleRate: 44100,
            latencyHint: 'playback',
        });

        this._buildMasterChain();
        this._buildTanpuraBuses();
        this._buildSwarBus();
        this._buildTablaBuses();
        this._buildAuxiliaryBuses();

        this._initialized = true;
    }

    /**
     * Resume the AudioContext if suspended. Safe to call from user-gesture
     * handlers. No-op if already running.
     */
    async resume() {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }
    }

    // ------------------------------------------------------------------
    // Chain builders (called once from init)
    // ------------------------------------------------------------------

    _buildMasterChain() {
        // Master output — direct to destination, no limiter. With upstream
        // gain caps there's already enough headroom that a soft-clip isn't
        // needed, and a limiter adds continuous CPU load to the audio
        // thread on mobile.
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.value = 0.8;
        this.masterGain.connect(this.audioCtx.destination);

        // Compressor — used by swar synth + auxiliary percussion only.
        this.compressor = this.audioCtx.createDynamicsCompressor();
        this.compressor.threshold.value = -24;
        this.compressor.knee.value = 30;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.25;

        // Reverb — convolution with a synthetic room IR. 1-second tail
        // keeps convolution cost reasonable on mobile.
        this.reverb = this.audioCtx.createConvolver();
        this.reverb.buffer = this._generateReverbIR(1, 3);

        // Wet path: compressor → reverb → master
        this.compressor.connect(this.reverb);
        this.reverb.connect(this.masterGain);

        // Dry bus (tabla + kartaal bypass reverb).
        this.dryMix = this.audioCtx.createGain();
        this.dryMix.gain.value = 1.0;
        this.dryMix.connect(this.masterGain);
    }

    _buildTanpuraBuses() {
        // Per-bus A/B gains (concert-mode balance stage, equal-power law).
        const halfRoot = Math.SQRT1_2; // cos(π/4) = sin(π/4)

        this.tanpuraGainA = this.audioCtx.createGain();
        this.tanpuraGainA.gain.value = halfRoot;
        this.tanpuraPanA = this.audioCtx.createStereoPanner();
        this.tanpuraPanA.pan.value = 0;

        this.tanpuraGainB = this.audioCtx.createGain();
        this.tanpuraGainB.gain.value = halfRoot;
        this.tanpuraPanB = this.audioCtx.createStereoPanner();
        this.tanpuraPanB.pan.value = 0;

        // Shared bus gain after balance — main-page volume slider target.
        this.tanpuraBusGain = this.audioCtx.createGain();
        this.tanpuraBusGain.gain.value = 0.8;

        // Route: A → GainA → PanA → BusGain → masterGain
        //        B → GainB → PanB → BusGain → masterGain
        this.tanpuraGainA.connect(this.tanpuraPanA);
        this.tanpuraPanA.connect(this.tanpuraBusGain);
        this.tanpuraGainB.connect(this.tanpuraPanB);
        this.tanpuraPanB.connect(this.tanpuraBusGain);
        this.tanpuraBusGain.connect(this.masterGain);
        // In SINGLE mode the engine bypasses this entire chain and
        // connects its outputGain directly to masterGain — see getInputNode.
    }

    _buildSwarBus() {
        this.swarGain = this.audioCtx.createGain();
        this.swarGain.gain.value = 0.7;
        this.swarGain.connect(this.compressor);
    }

    _buildTablaBuses() {
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

        // Tabla → BassEQ → TrebleEQ → TablaGain → DryMix → master
        this.tablaBassEQ.connect(this.tablaTrebleEQ);
        this.tablaTrebleEQ.connect(this.tablaGain);
        this.tablaGain.connect(this.dryMix);
    }

    _buildAuxiliaryBuses() {
        this.manjiraGain = this.audioCtx.createGain();
        this.manjiraGain.gain.value = 0.5;
        this.manjiraGain.connect(this.reverb);

        this.ghungrooGain = this.audioCtx.createGain();
        this.ghungrooGain.gain.value = 0.4;
        this.ghungrooGain.connect(this.reverb);

        this.kartaalGain = this.audioCtx.createGain();
        this.kartaalGain.gain.value = 0.5;
        this.kartaalGain.connect(this.dryMix);
    }

    // ------------------------------------------------------------------
    // Read-only properties
    // ------------------------------------------------------------------

    /** High-resolution audio clock time in seconds. */
    get currentTime() {
        return this.audioCtx ? this.audioCtx.currentTime : 0;
    }

    /** Whether init() has completed. */
    get isInitialized() {
        return this._initialized;
    }

    // ------------------------------------------------------------------
    // Volume / balance / pan setters
    // ------------------------------------------------------------------

    setMasterVolume(value) {
        this._setGainSmooth(this.masterGain, value);
    }

    setTablaVolume(value) {
        this._setGainSmooth(this.tablaGain, value);
    }

    setTablaBassEQ(dB) {
        if (!this.tablaBassEQ) return;
        const clamped = Math.max(-12, Math.min(12, dB));
        this.tablaBassEQ.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.02);
    }

    setTablaTrebleEQ(dB) {
        if (!this.tablaTrebleEQ) return;
        const clamped = Math.max(-12, Math.min(12, dB));
        this.tablaTrebleEQ.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.02);
    }

    setSwarVolume(value) {
        this._setGainSmooth(this.swarGain, value);
    }

    /**
     * Overall tanpura loudness — target of the main-page volume slider.
     * Accepts values above 1.0 for headroom (capped at 2.0).
     *
     * Applies to the concert-mode A/B bus. In single mode, the engine
     * connects directly to masterGain and this gain is unused; the
     * controller reduces the engine's own outputGain instead.
     */
    setTanpuraBusVolume(value) {
        if (!this.tanpuraBusGain || !this.audioCtx) return;
        const clamped = Math.max(0, Math.min(2, value));
        this.tanpuraBusGain.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.02);
    }

    /**
     * Concert-mode balance — equal-power L↔R fade between Tanpura A and B.
     * Center (50) preserves overall loudness.
     *
     * @param {number} percent - 0 = all A (left), 50 = equal, 100 = all B (right).
     */
    setTanpuraBalance(percent) {
        if (!this.tanpuraGainA || !this.tanpuraGainB || !this.audioCtx) return;
        const p = Math.max(0, Math.min(100, percent)) / 100;
        const t = this.audioCtx.currentTime;
        this.tanpuraGainA.gain.setTargetAtTime(Math.cos(p * Math.PI / 2), t, 0.02);
        this.tanpuraGainB.gain.setTargetAtTime(Math.sin(p * Math.PI / 2), t, 0.02);
    }

    /**
     * Configure tanpura stereo panning. In concert mode A sits left and B
     * right; in single mode both pans are centered (single mode also
     * bypasses the A/B chain so pan doesn't affect audio anyway).
     *
     * @param {boolean} concert - true = wide stereo placement
     * @param {number}  [intensity=0.7] - pan magnitude (0..1)
     */
    setTanpuraPan(concert, intensity = 0.7) {
        if (!this.tanpuraPanA || !this.tanpuraPanB || !this.audioCtx) return;
        const t = this.audioCtx.currentTime;
        const amt = concert ? Math.max(0, Math.min(1, intensity)) : 0;
        this.tanpuraPanA.pan.setTargetAtTime(-amt, t, 0.02);
        this.tanpuraPanB.pan.setTargetAtTime(+amt, t, 0.02);
    }

    _setGainSmooth(node, value) {
        if (!node || !this.audioCtx) return;
        const clamped = Math.max(0, Math.min(1, value));
        node.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.02);
    }

    // ------------------------------------------------------------------
    // Instrument connection points
    // ------------------------------------------------------------------

    /**
     * Return the AudioNode an instrument should connect to. The tanpura
     * controller picks the right identifier based on whether concert mode
     * is on.
     *
     * @param {'tanpura' | 'tanpuraA' | 'tanpuraB'
     *       | 'tabla' | 'swar'
     *       | 'manjira' | 'ghungroo' | 'kartaal'} id
     * @returns {AudioNode}
     */
    getInputNode(id) {
        if (!this._initialized) {
            throw new Error('[AudioEngine] init() must be called first.');
        }
        switch (id) {
            // Single mode — skip the A/B pan/gain stage, but still go
            // through tanpuraBusGain so the main-page volume slider
            // continues to work.
            case 'tanpura':  return this.tanpuraBusGain;
            // Concert mode — A/B balance + wide pan stage.
            case 'tanpuraA': return this.tanpuraGainA;
            case 'tanpuraB': return this.tanpuraGainB;
            case 'tabla':    return this.tablaBassEQ;
            case 'swar':     return this.swarGain;
            case 'manjira':  return this.manjiraGain;
            case 'ghungroo': return this.ghungrooGain;
            case 'kartaal':  return this.kartaalGain;
            default:
                throw new Error(`[AudioEngine] Unknown input id: "${id}"`);
        }
    }

    // ------------------------------------------------------------------
    // Synthetic impulse-response generation
    // ------------------------------------------------------------------

    /**
     * Build a stereo impulse response at runtime — no external audio file.
     * Simulates a warm practice room: loud-ish random early reflections in
     * the first 50 ms, exponentially-decaying noise tail, gentle 0.5 Hz
     * modulation for a non-static feel.
     *
     * @private
     * @param {number} [duration=1] seconds
     * @param {number} [decay=3]    exponential decay factor
     * @returns {AudioBuffer}
     */
    _generateReverbIR(duration = 1, decay = 3) {
        const sampleRate = this.audioCtx.sampleRate;
        const length = Math.floor(sampleRate * duration);
        const buffer = this.audioCtx.createBuffer(2, length, sampleRate);
        const channelL = buffer.getChannelData(0);
        const channelR = buffer.getChannelData(1);
        const earlyReflectionSamples = Math.floor(sampleRate * 0.05);

        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const envelope = Math.exp(-decay * t);
            let sampleL = (Math.random() * 2 - 1) * envelope;
            let sampleR = (Math.random() * 2 - 1) * envelope;
            if (i < earlyReflectionSamples) {
                const earlyGain = 0.5;
                sampleL += (Math.random() * 2 - 1) * earlyGain;
                sampleR += (Math.random() * 2 - 1) * earlyGain;
            }
            const modulation = 1 + 0.02 * Math.sin(2 * Math.PI * 0.5 * t);
            channelL[i] = sampleL * modulation;
            channelR[i] = sampleR * modulation;
        }
        return buffer;
    }
}

/**
 * Singleton instance. Import from any module:
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
