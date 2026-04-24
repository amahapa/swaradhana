/**
 * @fileoverview Tanpura controller — pluggable engine facade + concert
 * mode.
 *
 * Exposes a singleton controller that dispatches playback + config to an
 * active engine type (electronic synth or recorded samples). Each engine
 * type owns **two** instances, A and B; in single mode only A plays
 * and bypasses the A/B balance stage by routing directly to
 * `audioEngine.tanpuraBusGain`. In concert mode both A and B play,
 * routed through `tanpuraGainA`/`tanpuraGainB` → pan → bus gain.
 *
 * ## Public API (used by ui-controller.js)
 *
 * ```
 *   isPlaying: boolean
 *   start(saFreq, fineTuningCents): Promise<void>
 *   stop(): void
 *   updateConfig(partial): void                    — pattern, octave, etc.
 *   setJivari(percent, bus = 'A'): void            — per-bus jivari
 *   setBalance(percent): void                      — L/R balance (concert)
 *   setVolume(percent): void                       — overall tanpura loudness
 *   setConcertMode(on): Promise<void>              — toggle dual tanpura
 *   setDetuneBCents(cents): void                   — A-vs-B cents drift
 *   setEngine(id): Promise<void>                   — 'electronic' | 'sample'
 *   listEngines(): Array<{ id, label, capabilities }>
 *   getCapabilities(id?): capabilities
 *   onEngineChange(cb): () => void                 — UI listens to re-skin
 * ```
 *
 * Engines conform to the shared interface documented in
 * `tanpura-electronic-engine.js` / `tanpura-sample-engine.js`. The
 * controller calls `engine.setDestination(node)` before starting and on
 * every concert-mode toggle.
 *
 * @module tanpura
 */

import audioEngine from './audio-engine.js';
import { PRACTICE_DEFAULTS } from './config.js';
import { ElectronicTanpuraEngine } from './tanpura-electronic-engine.js';
import { SampleTanpuraEngine } from './tanpura-sample-engine.js';

// Crossfade length when swapping engines while playing.
const CROSSFADE_MS = 600;
// Default pattern when the active engine doesn't support the user's choice.
const DEFAULT_PATTERN = 'pa';
// Fixed A-vs-B detune in cents for concert mode. Small value (≈4) gives a
// natural slow beat between the two coherent sources without sounding
// detuned; larger values drift audibly.
const DEFAULT_DETUNE_B_CENTS = 4;
// Pan magnitude for concert mode (A to -amt, B to +amt).
const DEFAULT_PAN_INTENSITY = 0.7;
// Headroom multiplier applied when mapping the 0..100 volume slider to
// tanpuraBusGain. 1.2 gives a modest +1.6 dB ceiling over unity while
// still staying below the point where summed peaks would clip.
const OVERALL_VOLUME_CEILING = 1.2;

const ENGINE_CLASSES = [ElectronicTanpuraEngine, SampleTanpuraEngine];

class TanpuraController {
    constructor() {
        /**
         * Two instances per registered engine type. A is the always-on
         * instance; B is used only in concert mode.
         *
         * @type {Record<string, {A: object, B: object}>}
         */
        this.engines = {};
        for (const Cls of ENGINE_CLASSES) {
            this.engines[Cls.id] = { A: new Cls(), B: new Cls() };
        }

        this.activeId = PRACTICE_DEFAULTS.tanpuraEngine || 'electronic';
        this.isPlaying = false;

        // Shared playback state kept by the controller.
        this._saFreq = PRACTICE_DEFAULTS.baseSaFreq;
        this._fineTuningCents = 0;
        this._concertMode = !!PRACTICE_DEFAULTS.tanpuraConcertMode;
        this._detuneBCents = PRACTICE_DEFAULTS.tanpuraDetuneBCents ?? DEFAULT_DETUNE_B_CENTS;
        this._balance = PRACTICE_DEFAULTS.tanpuraBalance ?? 50;
        this._volume = (PRACTICE_DEFAULTS.tanpuraVolumeOverall ?? 60) / 100;
        this._config = {
            pattern: PRACTICE_DEFAULTS.tanpuraPattern,
            octave: PRACTICE_DEFAULTS.tanpuraOctave,
            speed: PRACTICE_DEFAULTS.tanpuraSpeed,
            jivariA: PRACTICE_DEFAULTS.tanpuraJivariA ?? PRACTICE_DEFAULTS.tanpuraJivari ?? 65,
            jivariB: PRACTICE_DEFAULTS.tanpuraJivariB ?? PRACTICE_DEFAULTS.tanpuraJivari ?? 65,
            variance: PRACTICE_DEFAULTS.tanpuraVariance,
            reverb: PRACTICE_DEFAULTS.tanpuraReverb,
            string2Note: "Sa'",
        };

        /** @type {Array<(detail: object) => void>} */
        this._onEngineChange = [];
    }

    // ------------------------------------------------------------------
    // Registry helpers
    // ------------------------------------------------------------------

    listEngines() {
        return ENGINE_CLASSES.map(Cls => ({
            id: Cls.id,
            label: Cls.label,
            capabilities: Cls.capabilities,
        }));
    }

    getCapabilities(engineId = this.activeId) {
        const Cls = ENGINE_CLASSES.find(c => c.id === engineId);
        return Cls ? Cls.capabilities : null;
    }

    getActiveId() {
        return this.activeId;
    }

    onEngineChange(cb) {
        this._onEngineChange.push(cb);
        return () => { this._onEngineChange = this._onEngineChange.filter(f => f !== cb); };
    }

    _emitEngineChange(detail) {
        for (const cb of this._onEngineChange) {
            try { cb(detail); } catch (e) {
                console.error('[tanpura] engine-change listener threw:', e);
            }
        }
    }

    // ------------------------------------------------------------------
    // Playback lifecycle
    // ------------------------------------------------------------------

    /**
     * Start the tanpura. In single mode only engine A runs; in concert
     * mode both A and B run on their respective buses.
     */
    async start(saFreq, fineTuningCents = 0) {
        this._saFreq = saFreq;
        this._fineTuningCents = fineTuningCents;

        const pair = this.engines[this.activeId];
        if (!pair) {
            console.error('[tanpura] No active engine registered.');
            return;
        }

        await this._ensureAudioReady();

        // Apply shared audio-engine state (pan + balance + volume) before
        // engines connect so there's no transient jump.
        audioEngine.setTanpuraPan(this._concertMode, DEFAULT_PAN_INTENSITY);
        audioEngine.setTanpuraBalance(this._balance);
        audioEngine.setTanpuraBusVolume(this._volume * OVERALL_VOLUME_CEILING);

        // Route + start A.
        pair.A.setDestination(this._destinationFor('A'));
        const cfgA = this._buildEngineConfig(pair.A, 'A');
        pair.A.updateConfig(cfgA);
        await pair.A.start(saFreq, fineTuningCents);
        pair.A.setOutputGain(1);

        // Route + start B only in concert mode.
        if (this._concertMode) {
            pair.B.setDestination(this._destinationFor('B'));
            const cfgB = this._buildEngineConfig(pair.B, 'B');
            pair.B.updateConfig(cfgB);
            await pair.B.start(saFreq, fineTuningCents);
            pair.B.setOutputGain(1);
        }

        this.isPlaying = true;
    }

    /** Stop every engine instance (both A and B of every registered type). */
    stop() {
        this.isPlaying = false;
        for (const pair of Object.values(this.engines)) {
            for (const engine of [pair.A, pair.B]) {
                try { engine.stop(); } catch (_) { /* not running */ }
            }
        }
    }

    async _ensureAudioReady() {
        if (!audioEngine.isInitialized) await audioEngine.init();
        await audioEngine.resume();
    }

    /**
     * Pick the right `audioEngine` input node for an engine instance
     * based on current mode:
     *   - single mode, A:       `audioEngine.tanpuraBusGain` (direct, no A/B pan)
     *   - concert mode, A or B: `audioEngine.tanpuraGainA` / `tanpuraGainB`
     *
     * @param {'A'|'B'} bus
     * @returns {AudioNode}
     */
    _destinationFor(bus) {
        if (!this._concertMode && bus === 'A') {
            return audioEngine.getInputNode('tanpura'); // tanpuraBusGain
        }
        return audioEngine.getInputNode(bus === 'B' ? 'tanpuraB' : 'tanpuraA');
    }

    // ------------------------------------------------------------------
    // Config propagation
    // ------------------------------------------------------------------

    /**
     * Merge shared config update and fan out to the active pair. Engine
     * may coerce unsupported pattern to a supported one per its
     * capabilities.
     */
    updateConfig(partial) {
        for (const [key, value] of Object.entries(partial)) {
            if (this._config[key] !== undefined) this._config[key] = value;
        }
        // Back-compat: legacy `{ jivari }` applies to A.
        if (partial.jivari !== undefined) {
            this._config.jivariA = Number(partial.jivari) || 0;
        }
        const pair = this.engines[this.activeId];
        if (!pair) return;

        pair.A.updateConfig(this._buildEngineConfig(pair.A, 'A', partial));
        if (this._concertMode) {
            pair.B.updateConfig(this._buildEngineConfig(pair.B, 'B', partial));
        }
    }

    setJivari(percent, bus = 'A') {
        const v = Math.max(0, Math.min(100, Number(percent) || 0));
        const pair = this.engines[this.activeId];
        if (bus === 'B') {
            this._config.jivariB = v;
            if (pair && this._concertMode) pair.B.setJivari(v);
        } else {
            this._config.jivariA = v;
            if (pair) pair.A.setJivari(v);
        }
    }

    setBalance(percent) {
        this._balance = Math.max(0, Math.min(100, Number(percent) || 0));
        if (audioEngine.isInitialized) audioEngine.setTanpuraBalance(this._balance);
    }

    setVolume(percent) {
        this._volume = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
        if (audioEngine.isInitialized) {
            audioEngine.setTanpuraBusVolume(this._volume * OVERALL_VOLUME_CEILING);
        }
    }

    setDetuneBCents(cents) {
        this._detuneBCents = Number(cents) || 0;
        const pair = this.engines[this.activeId];
        if (pair && this._concertMode && typeof pair.B.setDetuneCents === 'function') {
            pair.B.setDetuneCents(this._detuneBCents);
        }
    }

    /**
     * Toggle concert mode. Re-routes the live A engine and starts/stops
     * the B engine with a short crossfade.
     */
    async setConcertMode(on) {
        const wantOn = !!on;
        if (wantOn === this._concertMode) return;
        this._concertMode = wantOn;

        if (audioEngine.isInitialized) {
            audioEngine.setTanpuraPan(this._concertMode, DEFAULT_PAN_INTENSITY);
        }

        if (!this.isPlaying) return;

        const pair = this.engines[this.activeId];
        if (!pair) return;

        // Re-route the live A engine.
        pair.A.setDestination(this._destinationFor('A'));

        if (this._concertMode) {
            // Start B on its own bus and fade it in.
            await this._ensureAudioReady();
            pair.B.setDestination(this._destinationFor('B'));
            pair.B.updateConfig(this._buildEngineConfig(pair.B, 'B'));
            await pair.B.start(this._saFreq, this._fineTuningCents);
            pair.B.setOutputGain(0);
            pair.B.setOutputGain(1, 0.5);
        } else {
            // Fade B out then stop it.
            pair.B.setOutputGain(0, 0.4);
            setTimeout(() => {
                try { pair.B.stop(); } catch (_) { /* already stopped */ }
            }, 500);
        }
    }

    // ------------------------------------------------------------------
    // Engine selection
    // ------------------------------------------------------------------

    /**
     * Swap the active engine type. If playing, does a short crossfade
     * from old → new. Coerces the current pattern to one the new engine
     * supports (and remembers the original so we can restore if swapping
     * back to a more-capable engine).
     */
    async setEngine(id, { crossfadeMs = CROSSFADE_MS } = {}) {
        if (!this.engines[id]) {
            console.warn(`[tanpura] Unknown engine id: "${id}".`);
            return;
        }
        const fromId = this.activeId;
        if (id === fromId) return;

        const prev = this.engines[fromId];
        const next = this.engines[id];
        const Cls = ENGINE_CLASSES.find(c => c.id === id);
        const supportedPatterns = Cls ? Cls.capabilities.patterns.slice() : ['pa', 'ma', 'ni'];

        // Coerce pattern if the new engine doesn't support it.
        const originalPattern = this._config.pattern;
        if (!supportedPatterns.includes(originalPattern)) {
            this._previousPattern = originalPattern;
            this._config.pattern = supportedPatterns.includes(DEFAULT_PATTERN)
                ? DEFAULT_PATTERN
                : supportedPatterns[0];
        } else if (this._previousPattern === originalPattern) {
            this._previousPattern = null;
        }
        const coercedPattern = this._config.pattern;

        this.activeId = id;

        const detail = {
            fromId, toId: id,
            coercedPattern, originalPattern, supportedPatterns,
        };

        if (!this.isPlaying) {
            this._emitEngineChange(detail);
            return;
        }

        // Start the new engine pair silently, ramp up.
        const rampSec = crossfadeMs / 1000;
        next.A.setDestination(this._destinationFor('A'));
        next.A.updateConfig(this._buildEngineConfig(next.A, 'A'));
        await next.A.start(this._saFreq, this._fineTuningCents);
        next.A.setOutputGain(0);
        next.A.setOutputGain(1, rampSec);

        if (this._concertMode) {
            next.B.setDestination(this._destinationFor('B'));
            next.B.updateConfig(this._buildEngineConfig(next.B, 'B'));
            await next.B.start(this._saFreq, this._fineTuningCents);
            next.B.setOutputGain(0);
            next.B.setOutputGain(1, rampSec);
        }

        // Fade old pair out, then stop.
        if (prev) {
            prev.A.setOutputGain(0, rampSec);
            prev.B.setOutputGain(0, rampSec);
            setTimeout(() => {
                try { prev.A.stop(); } catch (_) {}
                try { prev.B.stop(); } catch (_) {}
            }, crossfadeMs + 150);
        }

        this._emitEngineChange(detail);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /**
     * Project shared controller config + caller overrides onto the
     * per-engine config shape. Also coerces pattern per the engine's
     * `capabilities.patterns` and applies the B-bus detune offset.
     */
    _buildEngineConfig(engine, bus, overrides = null) {
        const merged = { ...this._config, ...(overrides || {}) };
        const supported = (engine.constructor.capabilities?.patterns) || ['pa', 'ma', 'ni'];
        if (!supported.includes(merged.pattern)) {
            merged.pattern = supported.includes(DEFAULT_PATTERN)
                ? DEFAULT_PATTERN
                : supported[0];
        }
        return {
            pattern: merged.pattern,
            octave: merged.octave,
            speed: merged.speed,
            jivari: bus === 'B' ? (merged.jivariB ?? merged.jivariA) : merged.jivariA,
            variance: merged.variance,
            reverb: merged.reverb,
            string2Note: merged.string2Note,
            detuneCents: bus === 'B' ? this._detuneBCents : 0,
        };
    }
}

const controller = new TanpuraController();
export default controller;
