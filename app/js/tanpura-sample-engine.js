/**
 * @fileoverview Sample-based tanpura engine (tanpura_1).
 *
 * Plays pre-recorded tanpura drone MP3s (sourced from Rāga Junglism; see
 * `assets/audio/tanpura/tanpura_1/CREDITS.md`) with a real-time jivari
 * DSP chain layered on top of the dry signal. Implements the shared
 * tanpura engine interface consumed by the controller (`js/tanpura.js`):
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
 * Signal graph inside the engine:
 *
 * ```
 *   BufferSource ──┬── dryGain ──────────────────────────────────┐
 *                  │                                             ├─► outputGain ─► destination
 *                  └── [3-band BiquadBP] ─► combDelay ─► shaper ─► wetGain ┘
 * ```
 *
 * `destination` is set by the controller via {@link setDestination}:
 *   - single mode:   `audioEngine.masterGain` (bypasses the A/B bus)
 *   - concert mode:  `audioEngine.tanpuraGainA` or `tanpuraGainB`
 *
 * Jivari slider drives `wetGain` (0..0.55), bandpass Q, and comb feedback
 * together. Bandpass filters are retuned on every key change to track
 * harmonics 2×, 3×, 5× of the current Sa.
 *
 * @module tanpura-sample-engine
 */

import audioEngine from './audio-engine.js';
import { PRACTICE_DEFAULTS, KEY_FREQUENCIES } from './config.js';

/** Frequency → key-name lookup used to resolve asset filenames. */
const FREQ_TO_KEY_FILE = Object.freeze({
    'C':  'c',  'C#': 'db', 'D':  'd',  'D#': 'eb',
    'E':  'e',  'F':  'f',  'F#': 'gb', 'G':  'g',
    'G#': 'ab', 'A':  'a',  'A#': 'bb', 'B':  'b',
    // Bansuri-specific aliases (same pitch class as above).
    'E_low':  'e',
    'E_high': 'e',
});

/**
 * Resolve the closest key-file name for an arbitrary Sa frequency.
 * Returns something like 'c', 'db', … 'b'.
 */
function saFreqToKeyFile(saFreq) {
    // First check direct key-name matches (covers the twelve standard keys
    // and the two bansuri aliases).
    for (const [keyName, fileKey] of Object.entries(FREQ_TO_KEY_FILE)) {
        const ref = KEY_FREQUENCIES[keyName];
        if (ref !== undefined && Math.abs(ref - saFreq) < 0.5) {
            return fileKey;
        }
    }
    // Fallback: compute nearest chromatic pitch class against the C4 grid.
    // Semitone distance from A4 (440 Hz) in equal temperament.
    const midi = 69 + 12 * Math.log2(saFreq / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    // Match the lowercase flat naming scheme used by the sample set.
    const table = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
    return table[pc];
}

const BUFFER_CACHE = new Map();

// The source MP3s carry a fade-in at the head (~1.5 s) and a fade-out at
// the tail (~3 s). Looping the full buffer produces a volume dip every
// cycle. Use loopStart / loopEnd to restrict the loop to the steady body.
const HEAD_TRIM_S = 1.5;
const TAIL_TRIM_S = 3.0;
const MIN_LOOP_BODY_S = 2.0;

export class SampleTanpuraEngine {
    static id = 'sample';
    static label = 'Recorded (tanpura_1)';
    static capabilities = Object.freeze({ patterns: ['pa', 'ma'] });

    static ASSET_PREFIX = 'assets/audio/tanpura/tanpura_1';

    constructor() {
        this.isPlaying = false;
        /** @type {AudioNode|null} set by controller via setDestination. */
        this._destination = null;
        this.config = {
            pattern: PRACTICE_DEFAULTS.tanpuraPattern,
            // octave / speed / variance / string2Note are ignored by this
            // engine (the recordings baked those choices in), but we keep
            // the shape uniform so the controller can pass the full config.
            octave: PRACTICE_DEFAULTS.tanpuraOctave,
            speed: PRACTICE_DEFAULTS.tanpuraSpeed,
            jivari: PRACTICE_DEFAULTS.tanpuraJivari ?? PRACTICE_DEFAULTS.tanpuraJivariA ?? 65,
            variance: PRACTICE_DEFAULTS.tanpuraVariance,
            reverb: PRACTICE_DEFAULTS.tanpuraReverb,
            string2Note: "Sa'",
            detuneCents: 0,
        };
        this._saFreq = PRACTICE_DEFAULTS.baseSaFreq;
        this._fineTuningCents = 0;

        /** @type {AudioBufferSourceNode|null} */
        this._source = null;
        /** @type {GainNode|null} */
        this._dryGain = null;
        /** @type {GainNode|null} */
        this._wetGain = null;
        /** @type {Array<BiquadFilterNode>} */
        this._bandpass = [];
        /** @type {GainNode|null} */
        this._bandpassMix = null;
        /** @type {DelayNode|null} */
        this._combDelay = null;
        /** @type {GainNode|null} */
        this._combFeedback = null;
        /** @type {WaveShaperNode|null} */
        this._waveshaper = null;
        /** @type {GainNode|null} */
        this._outputGain = null;
    }

    async start(saFreq, fineTuningCents = 0) {
        if (!audioEngine.isInitialized) {
            await audioEngine.init();
        }
        await audioEngine.resume();

        this._saFreq = saFreq;
        this._fineTuningCents = fineTuningCents;

        if (this.isPlaying) {
            this._teardownSource();
        }

        this._ensureGraph();
        await this._attachNewSource();

        this.isPlaying = true;
    }

    stop() {
        if (!this.isPlaying) return;
        this._teardownSource();
        this.isPlaying = false;
    }

    updateConfig(partial) {
        let needsNewSource = false;
        for (const [key, value] of Object.entries(partial)) {
            if (this.config[key] === undefined || this.config[key] === value) continue;
            this.config[key] = value;
            if (key === 'pattern') needsNewSource = true;
            if (key === 'detuneCents') this._applyDetuneLive();
        }
        if (partial.jivari !== undefined) this.setJivari(partial.jivari);
        if (needsNewSource && this.isPlaying) {
            this._crossfadeToNewSource();
        }
    }

    setDetuneCents(cents) {
        this.config.detuneCents = Number(cents) || 0;
        this._applyDetuneLive();
    }

    _applyDetuneLive() {
        if (this._source && this._source.detune && audioEngine.audioCtx) {
            this._source.detune.setTargetAtTime(
                this.config.detuneCents || 0,
                audioEngine.audioCtx.currentTime,
                0.05
            );
        }
    }

    setJivari(percent) {
        this.config.jivari = Math.max(0, Math.min(100, percent));
        if (!audioEngine.audioCtx || !this._wetGain) return;
        const ctx = audioEngine.audioCtx;
        // Max wet contribution — keeps things from getting abrasive.
        const wetScale = 0.55;
        const targetWet = (this.config.jivari / 100) * wetScale;
        // Dry stays at 1.0; jivari is additive shimmer on top of the baked
        // drone, not a wet/dry crossfade.
        const now = ctx.currentTime;
        this._wetGain.gain.cancelScheduledValues(now);
        this._wetGain.gain.setTargetAtTime(targetWet, now, 0.05);

        // Also scale filter Q and feedback with jivari for a more dramatic
        // shimmer at higher settings.
        const qScale = 15 + (this.config.jivari / 100) * 35; // 15..50
        for (const bp of this._bandpass) {
            bp.Q.setTargetAtTime(qScale, now, 0.05);
        }
        if (this._combFeedback) {
            const fb = 0.55 + (this.config.jivari / 100) * 0.3; // 0.55..0.85
            this._combFeedback.gain.setTargetAtTime(fb, now, 0.05);
        }
    }

    setOutputGain(value, rampSeconds = 0) {
        this._ensureGraph();
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

    /**
     * Point this engine at a destination node. Called by the controller
     * before {@link start}, and whenever concert-mode toggles re-route us
     * between `masterGain` and `tanpuraGainA/B`. Safe to call while
     * playing — the outputGain is rewired without stopping the source.
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

    // ------------------------------------------------------------------
    // Internals — graph construction
    // ------------------------------------------------------------------

    _ensureGraph() {
        if (this._outputGain || !audioEngine.audioCtx) return;

        const ctx = audioEngine.audioCtx;
        this._outputGain = ctx.createGain();
        this._outputGain.gain.value = 1.0;
        // Controller sets _destination before start(); fall back to
        // masterGain if not, so we still produce sound.
        const dest = this._destination || audioEngine.masterGain;
        this._outputGain.connect(dest);

        this._dryGain = ctx.createGain();
        this._dryGain.gain.value = 1.0;
        this._dryGain.connect(this._outputGain);

        // Wet path: bandpass bank → comb delay → waveshaper → wetGain → output.
        this._wetGain = ctx.createGain();
        this._wetGain.gain.value = 0; // set by setJivari()
        this._wetGain.connect(this._outputGain);

        this._waveshaper = ctx.createWaveShaper();
        this._waveshaper.curve = buildSoftClipCurve(1.8);
        this._waveshaper.oversample = '2x';
        this._waveshaper.connect(this._wetGain);

        this._combDelay = ctx.createDelay(0.02);
        this._combDelay.delayTime.value = 0.004; // ~250 Hz comb
        this._combFeedback = ctx.createGain();
        this._combFeedback.gain.value = 0.7;
        this._combDelay.connect(this._combFeedback);
        this._combFeedback.connect(this._combDelay);
        this._combDelay.connect(this._waveshaper);

        this._bandpassMix = ctx.createGain();
        this._bandpassMix.gain.value = 0.8;
        this._bandpassMix.connect(this._combDelay);

        // Five parallel bandpass filters tuned on each _attachNewSource call.
        this._bandpass = [2, 3, 5].map(() => {
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.Q.value = 25;
            bp.connect(this._bandpassMix);
            return bp;
        });

        // Apply current jivari so subsequent changes to Q / feedback are
        // coherent with the initial graph.
        this.setJivari(this.config.jivari);
    }

    _retuneBandpass() {
        if (!audioEngine.audioCtx || !this._bandpass.length) return;
        const ctx = audioEngine.audioCtx;
        const harmonics = [2, 3, 5];
        const now = ctx.currentTime;
        this._bandpass.forEach((bp, i) => {
            const f = this._saFreq * harmonics[i];
            // Keep filters in a sane audible range.
            const clamped = Math.min(Math.max(f, 80), 12000);
            bp.frequency.setTargetAtTime(clamped, now, 0.05);
        });
    }

    _assetUrlFor(pattern) {
        const tuning = pattern === 'ma' ? 'ma_sa' : 'pa_sa';
        const keyFile = saFreqToKeyFile(this._saFreq);
        return `${SampleTanpuraEngine.ASSET_PREFIX}/${tuning}_${keyFile}.mp3`;
    }

    async _loadBuffer(url) {
        if (BUFFER_CACHE.has(url)) return BUFFER_CACHE.get(url);
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`[SampleTanpura] Failed to fetch ${url}: ${resp.status}`);
        }
        const arrayBuf = await resp.arrayBuffer();
        const audioBuf = await audioEngine.audioCtx.decodeAudioData(arrayBuf);
        BUFFER_CACHE.set(url, audioBuf);
        return audioBuf;
    }

    async _attachNewSource() {
        const ctx = audioEngine.audioCtx;
        const url = this._assetUrlFor(this.config.pattern);
        const buffer = await this._loadBuffer(url);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.detune.value = this.config.detuneCents || 0;
        // Trim the baked fade-in / fade-out so the loop stays at steady
        // level. For very short buffers (<5 s, shouldn't happen) keep the
        // full range as a safety fallback.
        const dur = buffer.duration;
        if (dur > HEAD_TRIM_S + TAIL_TRIM_S + MIN_LOOP_BODY_S) {
            source.loopStart = HEAD_TRIM_S;
            source.loopEnd = dur - TAIL_TRIM_S;
        }
        // Branch to both dry and wet paths.
        source.connect(this._dryGain);
        for (const bp of this._bandpass) {
            source.connect(bp);
        }
        // Start playback *inside* the loop region so the first pass also
        // skips the fade-in.
        const startOffset = source.loopStart > 0 ? source.loopStart : 0;
        source.start(ctx.currentTime, startOffset);

        this._source = source;
        this._retuneBandpass();
    }

    async _crossfadeToNewSource() {
        const ctx = audioEngine.audioCtx;
        if (!ctx) return;

        const oldSource = this._source;
        const oldDry = this._dryGain;
        const oldWet = this._wetGain;
        const oldBp = this._bandpass;
        const oldBpMix = this._bandpassMix;
        const oldComb = this._combDelay;
        const oldCombFb = this._combFeedback;
        const oldShaper = this._waveshaper;

        // Build a fresh parallel graph for the incoming buffer so the old
        // one can ramp down without starving the new one.
        this._outputGain = this._outputGain; // keep shared output gain
        this._dryGain = null;
        this._wetGain = null;
        this._bandpass = [];
        this._bandpassMix = null;
        this._combDelay = null;
        this._combFeedback = null;
        this._waveshaper = null;

        // Ramp old dry + wet down to 0 ahead of disconnect.
        const now = ctx.currentTime;
        const ramp = 0.5;
        if (oldDry) { oldDry.gain.cancelScheduledValues(now); oldDry.gain.setTargetAtTime(0, now, ramp / 3); }
        if (oldWet) { oldWet.gain.cancelScheduledValues(now); oldWet.gain.setTargetAtTime(0, now, ramp / 3); }

        // Build new sub-graph sharing the same outputGain.
        this._rebuildWetDryIntoOutput();
        await this._attachNewSource();
        const nowNew = ctx.currentTime;
        if (this._dryGain) {
            this._dryGain.gain.setValueAtTime(0, nowNew);
            this._dryGain.gain.linearRampToValueAtTime(1, nowNew + ramp);
        }
        if (this._wetGain) {
            const wetScale = 0.55;
            const targetWet = (this.config.jivari / 100) * wetScale;
            this._wetGain.gain.setValueAtTime(0, nowNew);
            this._wetGain.gain.linearRampToValueAtTime(targetWet, nowNew + ramp);
        }

        setTimeout(() => {
            try { if (oldSource) oldSource.stop(); } catch { /* already stopped */ }
            const toClose = [oldSource, oldDry, oldWet, oldBpMix, oldComb, oldCombFb, oldShaper, ...(oldBp || [])];
            for (const n of toClose) {
                try { n && n.disconnect(); } catch { /* noop */ }
            }
        }, ramp * 1000 + 200);
    }

    _rebuildWetDryIntoOutput() {
        const ctx = audioEngine.audioCtx;
        this._dryGain = ctx.createGain();
        this._dryGain.gain.value = 1.0;
        this._dryGain.connect(this._outputGain);

        this._wetGain = ctx.createGain();
        this._wetGain.gain.value = 0;
        this._wetGain.connect(this._outputGain);

        this._waveshaper = ctx.createWaveShaper();
        this._waveshaper.curve = buildSoftClipCurve(1.8);
        this._waveshaper.oversample = '2x';
        this._waveshaper.connect(this._wetGain);

        this._combDelay = ctx.createDelay(0.02);
        this._combDelay.delayTime.value = 0.004;
        this._combFeedback = ctx.createGain();
        this._combFeedback.gain.value = 0.7;
        this._combDelay.connect(this._combFeedback);
        this._combFeedback.connect(this._combDelay);
        this._combDelay.connect(this._waveshaper);

        this._bandpassMix = ctx.createGain();
        this._bandpassMix.gain.value = 0.8;
        this._bandpassMix.connect(this._combDelay);

        this._bandpass = [2, 3, 5].map(() => {
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.Q.value = 25;
            bp.connect(this._bandpassMix);
            return bp;
        });

        this.setJivari(this.config.jivari);
    }

    _teardownSource() {
        if (this._source) {
            try { this._source.stop(); } catch { /* already stopped */ }
            try { this._source.disconnect(); } catch { /* noop */ }
            this._source = null;
        }
    }
}

/**
 * Build a soft-clip waveshaper curve: tanh(k * x), normalised to [-1, 1].
 */
function buildSoftClipCurve(k = 2) {
    const N = 2048;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * 2 - 1;
        curve[i] = Math.tanh(k * x);
    }
    return curve;
}
