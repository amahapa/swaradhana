/**
 * @fileoverview Tanpura controller — pluggable engine facade + concert-mode pair.
 *
 * Exposes a singleton controller that dispatches to the active engine type.
 * Each engine type owns **two** instances, routed to the A and B stereo
 * buses respectively. When concert mode is off, only A plays. When on, both
 * play — A panned left, B panned right, each with its own jivari level and
 * a fixed small detune so they beat naturally.
 *
 * Public API (consumers in ui-controller.js, practice-session.js, etc.):
 *
 *   - isPlaying: boolean
 *   - start(saFreq, fineTuningCents): Promise<void>
 *   - stop(): void
 *   - updateConfig(partial): void                    // shared settings
 *   - setJivari(percent, bus = 'A'): void            // per-bus jivari
 *   - setBalance(percent): void                      // L/R balance (0..100)
 *   - setVolume(percent): void                       // overall tanpura loudness
 *   - setConcertMode(bool): Promise<void>            // dual-tanpura on/off
 *   - setDetuneBCents(cents): void                   // small A-vs-B cents drift
 *   - setEngine(id): Promise<void>                   // electronic | sample
 *   - listEngines(): Array<{ id, label, capabilities }>
 *   - getCapabilities(id?): capabilities
 *   - onEngineChange(cb): () => void
 *
 * @module tanpura
 */

import audioEngine from './audio-engine.js';
import { PRACTICE_DEFAULTS } from './config.js';
import { ElectronicTanpuraEngine } from './tanpura-electronic-engine.js';
import { SampleTanpuraEngine } from './tanpura-sample-engine.js';

const CROSSFADE_MS = 600;
const DEFAULT_PATTERN = 'pa';
const DEFAULT_DETUNE_B_CENTS = 4;
const DEFAULT_PAN_INTENSITY = 0.7;
/**
 * Ceiling applied when mapping the 0..100 UI slider to the tanpura bus
 * gain. Values above 1 provide headroom to compensate for the compressor
 * + reverb losses the tanpura bus incurs (the tabla bus bypasses reverb).
 * 1.2 at 100% ≈ +1.6 dB over unity — modest boost that stays well under
 * the clipping threshold when concert-mode sums two correlated engines.
 */
const OVERALL_VOLUME_CEILING = 1.2;

const ENGINE_CLASSES = [ElectronicTanpuraEngine, SampleTanpuraEngine];

class TanpuraController {
    constructor() {
        /** @type {Record<string, {A: object, B: object}>} */
        this.engines = {};
        for (const Cls of ENGINE_CLASSES) {
            this.engines[Cls.id] = {
                A: new Cls('A'),
                B: new Cls('B'),
            };
        }

        this.activeId = PRACTICE_DEFAULTS.tanpuraEngine || 'electronic';
        this.isPlaying = false;

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

    /** Active A engine (always) and B engine if concert-mode is on. */
    _activePair() {
        const pair = this.engines[this.activeId] || null;
        return {
            A: pair ? pair.A : null,
            B: pair && this._concertMode ? pair.B : null,
        };
    }

    onEngineChange(cb) {
        this._onEngineChange.push(cb);
        return () => { this._onEngineChange = this._onEngineChange.filter(f => f !== cb); };
    }

    _emitEngineChange(detail) {
        for (const cb of this._onEngineChange) {
            try { cb(detail); } catch (e) { console.error('[tanpura] engine-change listener threw:', e); }
        }
    }

    // ------------------------------------------------------------------
    // Playback
    // ------------------------------------------------------------------

    async start(saFreq, fineTuningCents = 0) {
        this._saFreq = saFreq;
        this._fineTuningCents = fineTuningCents;

        const pair = this.engines[this.activeId];
        if (!pair) {
            console.error('[tanpura] No active engine registered.');
            return;
        }

        // Ensure the audio engine bus is in the right state before the
        // engines connect to it.
        await this._ensureAudioReady();
        audioEngine.setTanpuraPan(this._concertMode, DEFAULT_PAN_INTENSITY);
        audioEngine.setTanpuraBalance(this._balance);
        audioEngine.setTanpuraBusVolume(this._volume * OVERALL_VOLUME_CEILING);

        // Start A.
        const cfgA = this._busConfig(pair.A, 'A');
        pair.A.updateConfig(cfgA);
        await pair.A.start(saFreq, fineTuningCents);
        pair.A.setOutputGain(1);

        // Start B if concert.
        if (this._concertMode) {
            const cfgB = this._busConfig(pair.B, 'B');
            pair.B.updateConfig(cfgB);
            await pair.B.start(saFreq, fineTuningCents);
            pair.B.setOutputGain(1);
        }

        this.isPlaying = true;
    }

    stop() {
        this.isPlaying = false;
        for (const pair of Object.values(this.engines)) {
            for (const engine of [pair.A, pair.B]) {
                try { engine.stop(); } catch (e) { /* not running */ }
            }
        }
    }

    async _ensureAudioReady() {
        if (!audioEngine.isInitialized) {
            await audioEngine.init();
        }
        await audioEngine.resume();
    }

    // ------------------------------------------------------------------
    // Config propagation
    // ------------------------------------------------------------------

    updateConfig(partial) {
        for (const [key, value] of Object.entries(partial)) {
            if (this._config[key] !== undefined) this._config[key] = value;
        }
        // Backward compat: allow `{ jivari: n }` → applies to A.
        if (partial.jivari !== undefined) {
            this._config.jivariA = Number(partial.jivari) || 0;
        }
        const pair = this.engines[this.activeId];
        if (!pair) return;

        const cfgA = this._busConfig(pair.A, 'A', partial);
        pair.A.updateConfig(cfgA);
        if (this._concertMode) {
            const cfgB = this._busConfig(pair.B, 'B', partial);
            pair.B.updateConfig(cfgB);
        }
    }

    setJivari(percent, bus = 'A') {
        const v = Math.max(0, Math.min(100, Number(percent) || 0));
        if (bus === 'B') {
            this._config.jivariB = v;
            const pair = this.engines[this.activeId];
            if (pair && this._concertMode) pair.B.setJivari(v);
        } else {
            this._config.jivariA = v;
            const pair = this.engines[this.activeId];
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

    async setConcertMode(on) {
        const wantOn = !!on;
        if (wantOn === this._concertMode) return;
        this._concertMode = wantOn;

        // Pan first — the audio engine applies pan to both buses regardless
        // of whether an engine is sending signal yet.
        if (audioEngine.isInitialized) {
            audioEngine.setTanpuraPan(this._concertMode, DEFAULT_PAN_INTENSITY);
        }

        if (!this.isPlaying) return;

        const pair = this.engines[this.activeId];
        if (!pair) return;

        if (this._concertMode) {
            // Start B and fade it in.
            await this._ensureAudioReady();
            const cfgB = this._busConfig(pair.B, 'B');
            pair.B.updateConfig(cfgB);
            await pair.B.start(this._saFreq, this._fineTuningCents);
            pair.B.setOutputGain(0);
            pair.B.setOutputGain(1, 0.5);
        } else {
            // Fade B out, stop after ramp completes.
            pair.B.setOutputGain(0, 0.4);
            setTimeout(() => {
                try { pair.B.stop(); } catch (e) { /* already stopped */ }
            }, 500);
        }
    }

    // ------------------------------------------------------------------
    // Engine selection
    // ------------------------------------------------------------------

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

        const originalPattern = this._config.pattern;
        if (!supportedPatterns.includes(originalPattern)) {
            this._previousPattern = originalPattern;
            this._config.pattern = supportedPatterns.includes(DEFAULT_PATTERN) ? DEFAULT_PATTERN : supportedPatterns[0];
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

        const rampSec = crossfadeMs / 1000;

        // Bring new A (and B if concert) up at 0 gain, ramp to 1.
        const nextCfgA = this._busConfig(next.A, 'A');
        next.A.updateConfig(nextCfgA);
        await next.A.start(this._saFreq, this._fineTuningCents);
        next.A.setOutputGain(0);
        next.A.setOutputGain(1, rampSec);

        if (this._concertMode) {
            const nextCfgB = this._busConfig(next.B, 'B');
            next.B.updateConfig(nextCfgB);
            await next.B.start(this._saFreq, this._fineTuningCents);
            next.B.setOutputGain(0);
            next.B.setOutputGain(1, rampSec);
        }

        // Fade old pair out, stop after ramp.
        if (prev) {
            prev.A.setOutputGain(0, rampSec);
            prev.B.setOutputGain(0, rampSec);
            setTimeout(() => {
                try { prev.A.stop(); } catch (e) { /* already stopped */ }
                try { prev.B.stop(); } catch (e) { /* already stopped */ }
            }, crossfadeMs + 150);
        }

        this._emitEngineChange(detail);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /**
     * Build a per-bus config, projecting shared controller state plus
     * optional caller overrides onto what the individual engine expects.
     */
    _busConfig(engine, bus, overrides = null) {
        const merged = { ...this._config };
        if (overrides) {
            for (const [k, v] of Object.entries(overrides)) {
                if (merged[k] !== undefined) merged[k] = v;
            }
        }
        // Pattern coercion per engine capability.
        const caps = engine.constructor.capabilities || {};
        const supported = caps.patterns || ['pa', 'ma', 'ni'];
        if (!supported.includes(merged.pattern)) {
            merged.pattern = supported.includes(DEFAULT_PATTERN) ? DEFAULT_PATTERN : supported[0];
        }
        // Strip shared-only keys the engine doesn't know about.
        const engineCfg = {
            pattern: merged.pattern,
            octave: merged.octave,
            speed: merged.speed,
            jivari: bus === 'B' ? (merged.jivariB ?? merged.jivariA) : merged.jivariA,
            variance: merged.variance,
            reverb: merged.reverb,
            string2Note: merged.string2Note,
            detuneCents: bus === 'B' ? this._detuneBCents : 0,
        };
        return engineCfg;
    }
}

const controller = new TanpuraController();
export default controller;
