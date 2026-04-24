/**
 * @fileoverview Electronic (synthesized) tanpura engine.
 *
 * Additive synthesis via Web Audio `PeriodicWave`. Each string is a pair
 * of slightly-detuned oscillators sharing one envelope gain; the jivari
 * slider controls harmonic count (2 → 32 harmonics) via a live
 * `setPeriodicWave` call.
 *
 * Implements the shared tanpura engine interface consumed by the
 * controller (`js/tanpura.js`):
 *
 * ```
 *   static id, static label, static capabilities
 *
 *   isPlaying: boolean
 *   start(saFreq, fineTuningCents):  Promise<void>
 *   stop():                          void
 *   updateConfig(partial):           void
 *   setJivari(percent):              void
 *   setDetuneCents(cents):           void
 *   setDestination(audioNode):       void   // controller picks routing
 *   setOutputGain(value, rampSec=0): void   // crossfade helper
 * ```
 *
 * Signal flow per string:
 *
 * ```
 *   oscA -\
 *          > envelope ──► outputGain ──► (destination set by controller)
 *   oscB -/
 * ```
 *
 * The controller calls `setDestination()` with either `audioEngine.masterGain`
 * (single mode — direct, bypasses the A/B balance chain) or
 * `audioEngine.tanpuraGainA` / `tanpuraGainB` (concert mode).
 *
 * @module tanpura-electronic-engine
 */

import audioEngine from './audio-engine.js';
import { SWAR_RATIOS, PRACTICE_DEFAULTS } from './config.js';
import { getEffectiveSaFreq } from './music-engine.js';

// Relaxed on mobile — the electronic tanpura has its own pluck scheduler
// separate from the taal engine's. 100ms pump + 250ms lookahead gives the
// audio thread far more headroom to survive main-thread stalls (which
// cause audible pauses in the drone) at negligible cost to pluck timing.
const SCHEDULER_INTERVAL_MS = 100;
const SCHEDULE_AHEAD_S = 0.25;
const ATTACK_TIME = 0.03;
const PLUCK_OFFSETS = Object.freeze([0.0, 0.15, 0.30, 0.50]);
const HUMANIZE_MAX_S = 0.03;

function speedToCycleDuration(speedPercent) {
    const pct = Math.max(0, Math.min(100, speedPercent));
    return 6.0 - (pct / 100) * 5.5;
}

function createTanpuraWave(audioCtx, harmonicCount) {
    const real = new Float32Array(harmonicCount + 1);
    const imag = new Float32Array(harmonicCount + 1);
    real[0] = 0;
    imag[0] = 0;
    for (let n = 1; n <= harmonicCount; n++) {
        imag[n] = Math.pow(0.5, n - 1) * (1 / n);
    }
    return audioCtx.createPeriodicWave(real, imag);
}

function jivariToHarmonics(jivariPercent) {
    if (jivariPercent <= 20) return 2;
    if (jivariPercent <= 50) return 4;
    if (jivariPercent <= 80) return 16;
    return 32;
}

function humanizeOffset() {
    return (Math.random() * 2 - 1) * HUMANIZE_MAX_S;
}

function parseSwarNote(note) {
    const isTaar = note.endsWith("'");
    const clean = note.replace("'", '').trim();
    const nameToKey = {
        Sa: 'S', Re: 'R', Ga: 'G', Ma: 'm',
        Pa: 'P', Dha: 'D', Ni: 'N',
    };
    const ratioKey = nameToKey[clean];
    if (!ratioKey) {
        if (SWAR_RATIOS[clean] !== undefined) {
            return { ratioKey: clean, octaveMultiplier: isTaar ? 2 : 1 };
        }
        throw new Error(`[ElectronicTanpura] Unknown swara note: "${note}"`);
    }
    return { ratioKey, octaveMultiplier: isTaar ? 2 : 1 };
}

export class ElectronicTanpuraEngine {
    static id = 'electronic';
    static label = 'Electronic';
    static capabilities = Object.freeze({ patterns: ['pa', 'ma', 'ni'] });

    constructor() {
        this.isPlaying = false;
        this.config = {
            pattern: PRACTICE_DEFAULTS.tanpuraPattern,
            octave: PRACTICE_DEFAULTS.tanpuraOctave,
            speed: PRACTICE_DEFAULTS.tanpuraSpeed,
            jivari: PRACTICE_DEFAULTS.tanpuraJivari ?? PRACTICE_DEFAULTS.tanpuraJivariA ?? 65,
            variance: PRACTICE_DEFAULTS.tanpuraVariance,
            reverb: PRACTICE_DEFAULTS.tanpuraReverb,
            string2Note: "Sa'",
            detuneCents: 0,
        };
        this.strings = [];
        this.pluckTimerId = null;
        this._cycleStartTime = 0;
        this._scheduledPlucks = new Set();
        this._baseSaFreq = PRACTICE_DEFAULTS.baseSaFreq;
        this._fineTuningCents = 0;
        /** @type {GainNode|null} */
        this._outputGain = null;
        /** @type {AudioNode|null} destination set by the controller. */
        this._destination = null;
    }

    /**
     * Point this engine at a destination node. Called by the controller
     * before {@link start}, and again whenever concert-mode toggles
     * re-route us between `masterGain` and `tanpuraGainA`/`B`.
     *
     * Safe to call while playing — existing connections are dropped and
     * the outputGain is re-wired without restarting oscillators.
     *
     * @param {AudioNode} node
     */
    setDestination(node) {
        if (!node) return;
        this._destination = node;
        if (this._outputGain) {
            try { this._outputGain.disconnect(); } catch (_) {}
            this._outputGain.connect(node);
        }
    }

    async start(baseSaFreq, fineTuningCents = 0) {
        if (!audioEngine.isInitialized) {
            await audioEngine.init();
        }
        await audioEngine.resume();

        if (this.isPlaying) {
            this._teardown();
        }

        this._baseSaFreq = baseSaFreq;
        this._fineTuningCents = fineTuningCents;

        this._ensureOutputGain();

        const matchedKey = this._keyFromFreq(baseSaFreq);
        const effectiveSa = matchedKey
            ? getEffectiveSaFreq(matchedKey, fineTuningCents)
            : baseSaFreq * Math.pow(2, fineTuningCents / 1200);

        const stringFreqs = this._computeStringFrequencies(effectiveSa);
        this._createStrings(stringFreqs);
        this._startScheduler();
        this.isPlaying = true;
    }

    stop() {
        if (!this.isPlaying) return;
        this._teardown();
        this.isPlaying = false;
    }

    updateConfig(newConfig) {
        let needsRestart = false;

        for (const [key, value] of Object.entries(newConfig)) {
            if (this.config[key] === undefined || this.config[key] === value) continue;
            this.config[key] = value;
            // Jivari is applied live by setJivari() — no restart.
            if (['pattern', 'octave', 'variance', 'string2Note'].includes(key)) {
                needsRestart = true;
            }
            // detuneCents can be applied live via osc.detune.
            if (key === 'detuneCents') {
                this._applyDetuneLive();
            }
        }

        if (newConfig.jivari !== undefined) {
            this.setJivari(newConfig.jivari);
        }

        if (needsRestart && this.isPlaying) {
            this.start(this._baseSaFreq, this._fineTuningCents);
        }
    }

    setDetuneCents(cents) {
        this.config.detuneCents = Number(cents) || 0;
        this._applyDetuneLive();
    }

    _applyDetuneLive() {
        if (!audioEngine.audioCtx) return;
        const ctx = audioEngine.audioCtx;
        for (const s of this.strings) {
            if (s.oscA) s.oscA.detune.setTargetAtTime(this.config.detuneCents, ctx.currentTime, 0.05);
            if (s.oscB) s.oscB.detune.setTargetAtTime(this.config.detuneCents, ctx.currentTime, 0.05);
        }
    }

    setJivari(percent) {
        this.config.jivari = Math.max(0, Math.min(100, percent));
        if (!this.isPlaying || !audioEngine.audioCtx) return;

        const harmonicCount = jivariToHarmonics(this.config.jivari);
        const wave = createTanpuraWave(audioEngine.audioCtx, harmonicCount);
        for (const s of this.strings) {
            if (s.oscA) s.oscA.setPeriodicWave(wave);
            if (s.oscB) s.oscB.setPeriodicWave(wave);
        }
    }

    /**
     * Crossfade support: set the engine-level output gain.
     * @param {number} value - Target gain (0..1).
     * @param {number} [rampSeconds=0] - Linear ramp duration; 0 = instant.
     */
    setOutputGain(value, rampSeconds = 0) {
        this._ensureOutputGain();
        if (!this._outputGain || !audioEngine.audioCtx) return;
        const ctx = audioEngine.audioCtx;
        const g = this._outputGain.gain;
        const now = ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        if (rampSeconds > 0) {
            g.linearRampToValueAtTime(Math.max(0, Math.min(1, value)), now + rampSeconds);
        } else {
            g.setValueAtTime(Math.max(0, Math.min(1, value)), now);
        }
    }

    _ensureOutputGain() {
        if (this._outputGain || !audioEngine.audioCtx) return;
        const ctx = audioEngine.audioCtx;
        this._outputGain = ctx.createGain();
        this._outputGain.gain.value = 1.0;
        // Controller should have called setDestination before start; fall
        // back to masterGain so we at least produce sound if not.
        const dest = this._destination || audioEngine.masterGain;
        this._outputGain.connect(dest);
    }

    _computeStringFrequencies(effectiveSa) {
        const octaveMultiplier = this._octaveMultiplier();
        const sa = effectiveSa * octaveMultiplier;

        let patternRatioKey, patternLabel;
        switch (this.config.pattern) {
            case 'ma': patternRatioKey = 'm'; patternLabel = 'Ma'; break;
            case 'ni': patternRatioKey = 'N'; patternLabel = 'Ni'; break;
            case 'pa':
            default:   patternRatioKey = 'P'; patternLabel = 'Pa'; break;
        }

        // First string: Pa/Ma/Ni of *mandra* saptak — one octave below Sa.
        const patternFreq = (sa / 2) * SWAR_RATIOS[patternRatioKey];
        // Strings 2 & 3: Sa of *madhya* saptak (reference Sa).
        const saMadhyaFreq = sa;
        // String 4: Sa of *mandra* saptak — one octave below.
        const saMandraFreq = sa / 2;

        let string2Freq, string2Label;
        try {
            const parsed = parseSwarNote(this.config.string2Note);
            string2Freq = sa * SWAR_RATIOS[parsed.ratioKey] * parsed.octaveMultiplier;
            string2Label = this.config.string2Note;
        } catch {
            string2Freq = saMadhyaFreq;
            string2Label = 'Sa';
        }

        // Pluck order: string 4 (Sa mandra) → string 1 (pattern note)
        // → string 2 (Sa madhya / configurable) → string 3 (Sa madhya).
        return [
            { freq: saMandraFreq, label: 'Sa,' },
            { freq: patternFreq, label: patternLabel + ',' },
            { freq: string2Freq, label: string2Label },
            { freq: saMadhyaFreq, label: 'Sa' },
        ];
    }

    _octaveMultiplier() {
        switch (this.config.octave) {
            case 'LOW':    return 0.5;
            case 'HIGH':   return 2;
            case 'MEDIUM':
            default:       return 1;
        }
    }

    _createStrings(stringFreqs) {
        const ctx = audioEngine.audioCtx;
        const harmonicCount = jivariToHarmonics(this.config.jivari);
        const wave = createTanpuraWave(ctx, harmonicCount);
        const destination = this._outputGain;
        const variance = this.config.variance;

        const detune = this.config.detuneCents || 0;

        this.strings = stringFreqs.map(({ freq, label }) => {
            const envelope = ctx.createGain();
            envelope.gain.value = 0;
            envelope.connect(destination);

            const oscA = ctx.createOscillator();
            oscA.frequency.value = freq * (1 + variance / 20000);
            oscA.detune.value = detune;
            oscA.setPeriodicWave(wave);
            oscA.connect(envelope);
            oscA.start();

            const oscB = ctx.createOscillator();
            oscB.frequency.value = freq * (1 - variance / 20000);
            oscB.detune.value = detune;
            oscB.setPeriodicWave(wave);
            oscB.connect(envelope);
            oscB.start();

            return { oscA, oscB, envelope, freq, label };
        });
    }

    _startScheduler() {
        const ctx = audioEngine.audioCtx;
        this._cycleStartTime = ctx.currentTime + 0.05;
        this._scheduledPlucks = new Set();
        this.pluckTimerId = setInterval(() => this._schedulerTick(), SCHEDULER_INTERVAL_MS);
    }

    _schedulerTick() {
        if (!audioEngine.audioCtx) return;
        const ctx = audioEngine.audioCtx;
        const now = ctx.currentTime;
        const cycleDuration = speedToCycleDuration(this.config.speed);

        for (let i = 0; i < 4; i++) {
            if (this._scheduledPlucks.has(i)) continue;
            const idealTime = this._cycleStartTime + cycleDuration * PLUCK_OFFSETS[i] + humanizeOffset();
            const pluckTime = Math.max(idealTime, now + 0.005);
            if (pluckTime <= now + SCHEDULE_AHEAD_S + cycleDuration) {
                this._schedulePluck(i, pluckTime, cycleDuration);
                this._scheduledPlucks.add(i);
            }
        }

        if (this._scheduledPlucks.size === 4) {
            const cycleEnd = this._cycleStartTime + cycleDuration;
            if (now >= cycleEnd - SCHEDULE_AHEAD_S) {
                this._cycleStartTime = cycleEnd;
                this._scheduledPlucks = new Set();
            }
        }
    }

    _schedulePluck(stringIndex, pluckTime, cycleDuration) {
        const s = this.strings[stringIndex];
        if (!s || !s.envelope) return;

        const peakGain = 0.25;
        const ringDuration = cycleDuration * 1.2;
        const sustainEnd = pluckTime + ATTACK_TIME + ringDuration * 0.5;
        const releaseEnd = pluckTime + ATTACK_TIME + ringDuration;

        const gain = s.envelope.gain;
        gain.cancelScheduledValues(pluckTime);
        gain.setValueAtTime(0.001, pluckTime);
        gain.linearRampToValueAtTime(peakGain, pluckTime + ATTACK_TIME);
        gain.linearRampToValueAtTime(peakGain * 0.7, sustainEnd);
        gain.exponentialRampToValueAtTime(0.005, releaseEnd);
        gain.setValueAtTime(0, releaseEnd + 0.01);
    }

    _teardown() {
        if (this.pluckTimerId !== null) {
            clearInterval(this.pluckTimerId);
            this.pluckTimerId = null;
        }

        const ctx = audioEngine.audioCtx;
        const now = ctx ? ctx.currentTime : 0;

        for (const s of this.strings) {
            if (s.envelope && ctx) {
                s.envelope.gain.cancelScheduledValues(now);
                s.envelope.gain.setValueAtTime(s.envelope.gain.value, now);
                s.envelope.gain.linearRampToValueAtTime(0, now + 0.05);
            }
            const stopTime = now + 0.06;
            try { if (s.oscA) s.oscA.stop(stopTime); } catch { /* already stopped */ }
            try { if (s.oscB) s.oscB.stop(stopTime); } catch { /* already stopped */ }
        }

        this.strings = [];
        this._scheduledPlucks = new Set();
    }

    _keyFromFreq(freq) {
        const keys = {
            164.81: 'E_low', 174.61: 'F', 185.00: 'F#', 196.00: 'G',
            207.65: 'G#', 220.00: 'A', 233.08: 'A#', 246.94: 'B',
            261.63: 'C', 277.18: 'C#', 293.66: 'D', 311.13: 'D#',
            329.63: 'E_high',
        };
        for (const [f, key] of Object.entries(keys)) {
            if (Math.abs(parseFloat(f) - freq) < 0.5) return key;
        }
        return null;
    }
}
