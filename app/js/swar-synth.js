/**
 * @fileoverview Melodic note playback engine for Swaradhana using WebAudioFont.
 *
 * Plays alankaar notes as harmonium (default) or strings instrument through
 * the shared {@link AudioEngine} signal chain. Notes are scheduled on the
 * Web Audio API timeline for sample-accurate timing.
 *
 * WebAudioFont presets are loaded dynamically at runtime from regular script
 * tags (not ES modules). The player, harmonium preset, and strings preset are
 * exposed as globals: `WebAudioFontPlayer`, `_tone_0210_FluidR3_GM_sf2_file`,
 * and `_tone_0480_Chaos_sf2_file`.
 *
 * @module swar-synth
 */

import audioEngine from './audio-engine.js';
import { SWAR_RATIOS } from './config.js';
import { getPositionFreq } from './music-engine.js';

// ---------------------------------------------------------------------------
// Script loader utility
// ---------------------------------------------------------------------------

/**
 * Dynamically loads an external script by appending a `<script>` element to
 * the document head. Skips loading if a script with the same `src` attribute
 * already exists in the DOM.
 *
 * @param {string} src - The script URL (relative or absolute).
 * @returns {Promise<void>} Resolves when the script has loaded, rejects on error.
 * @private
 */
function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) {
            resolve();
            return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// ---------------------------------------------------------------------------
// SwarSynth class
// ---------------------------------------------------------------------------

/**
 * Melodic note playback engine using WebAudioFont sample-based synthesis.
 *
 * Supports two voice presets:
 * - **harmonium** — warm reed organ timbre (GM program 21, FluidR3 soundfont)
 * - **strings** — bowed string ensemble (GM program 48, Chaos soundfont)
 *
 * All audio output is routed through the `swar` input node of the shared
 * {@link AudioEngine}, which applies gain, compression, and reverb.
 *
 * Usage:
 * ```js
 * import swarSynth from './swar-synth.js';
 *
 * await swarSynth.init();
 * swarSynth.setVoice('harmonium');
 *
 * const envelope = swarSynth.playNote(
 *     8, 'bilawal', 277.18,
 *     audioEngine.currentTime, 0.5, 0.7
 * );
 * ```
 */
class SwarSynth {
    constructor() {
        /**
         * WebAudioFontPlayer instance. Created during {@link init}.
         * @type {object|null}
         */
        this.player = null;

        /**
         * Map of voice name to WebAudioFont preset data.
         * @type {{ harmonium: object, strings: object }|null}
         */
        this.presets = null;

        /**
         * The currently active preset object (reference into {@link presets}).
         * @type {object|null}
         */
        this.activePreset = null;

        /**
         * Name of the currently selected voice.
         * @type {'harmonium'|'strings'}
         */
        this.currentVoice = 'harmonium';

        /**
         * Whether {@link init} has completed successfully.
         * @type {boolean}
         * @private
         */
        this._initialized = false;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /**
     * Loads the WebAudioFont library and instrument presets, then creates
     * the player and prepares both presets for playback.
     *
     * This method is idempotent -- calling it multiple times after the first
     * successful init is a no-op.
     *
     * Requires the {@link AudioEngine} to be initialized first so that
     * `audioEngine.audioCtx` is available for preset adjustment.
     *
     * @returns {Promise<void>}
     * @throws {Error} If any of the WebAudioFont scripts fail to load.
     */
    async init() {
        if (this._initialized) {
            return;
        }

        // 1. Load WebAudioFont scripts dynamically
        await loadScript('webaudiofont/WebAudioFontPlayer.js');
        await loadScript('webaudiofont/0210_FluidR3_GM_sf2_file.js');
        await loadScript('webaudiofont/0480_Chaos_sf2_file.js');
        await loadScript('webaudiofont/0240_Aspirin_sf2_file.js');
        await loadScript('webaudiofont/0000_FluidR3_GM_sf2_file.js');

        // 2. Create player
        if (typeof WebAudioFontPlayer === 'undefined') {
            console.warn('[SwarSynth] WebAudioFontPlayer not available after script load.');
            return;
        }
        this.player = new WebAudioFontPlayer();

        // 3. Load presets from globals — 3 built-in instruments
        this.presets = {
            harmonium: _tone_0210_FluidR3_GM_sf2_file,
            strings: _tone_0480_Chaos_sf2_file,
            guitar: _tone_0240_Aspirin_sf2_file,
            piano: _tone_0000_FluidR3_GM_sf2_file,
        };

        // 4. Adjust all presets — starts async decoding of Base64 audio data.
        if (audioEngine.audioCtx) {
            for (const [name, preset] of Object.entries(this.presets)) {
                this.player.adjustPreset(audioEngine.audioCtx, preset);
            }
            // Wait for all zone buffers to be decoded
            for (const [name, preset] of Object.entries(this.presets)) {
                await this._waitForBuffers(preset);
            }
            console.log('[SwarSynth] All preset buffers decoded (' + Object.keys(this.presets).length + ' instruments).');
        } else {
            console.warn('[SwarSynth] AudioEngine not initialized. Presets not adjusted.');
        }

        // 5. Set default voice(s) — supports multiple simultaneous instruments
        this.activeVoices = ['harmonium']; // array of active voice names
        this.activePreset = this.presets.harmonium; // primary (for backward compat)

        /** @type {Object<string, number>} Per-voice volume multiplier (0.0 - 1.0) */
        this.voiceVolumes = {};

        this._initialized = true;
    }

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------

    /**
     * Sets the active instrument voice(s).
     *
     * Accepts a single voice name OR an array of voice names for layered sound.
     * When multiple voices are active, playNote() plays through ALL of them
     * simultaneously, creating a rich layered effect.
     *
     * @param {string|string[]} voices - One or more voice names: 'harmonium', 'strings', 'guitar'
     * @example
     * swarSynth.setVoice('guitar');              // single instrument
     * swarSynth.setVoice(['harmonium','guitar']); // layered effect
     */
    setVoice(voices) {
        if (!this.presets) {
            console.warn('[SwarSynth] Cannot set voice before init().');
            return;
        }

        // Normalize to array
        const voiceList = Array.isArray(voices) ? voices : [voices];

        // Validate all voices
        for (const v of voiceList) {
            if (!this.presets[v]) {
                console.warn(`[SwarSynth] Unknown voice "${v}". Available: ${Object.keys(this.presets).join(', ')}`);
            }
        }

        this.activeVoices = voiceList.filter(v => this.presets[v]);
        // Keep backward compat — activePreset = first voice
        this.activePreset = this.presets[this.activeVoices[0]] || this.presets.harmonium;
        this.currentVoice = this.activeVoices.join('+');
        console.log('[SwarSynth] Active voices:', this.activeVoices.join(', '));
    }

    /**
     * Returns the list of all available instrument names.
     * @returns {string[]}
     */
    getAvailableVoices() {
        return Object.keys(this.presets || {});
    }

    /**
     * Sets the volume for a specific voice instrument.
     *
     * @param {string} voiceName - Voice name (e.g. 'harmonium', 'piano')
     * @param {number} volume - Volume from 0 to 100 (converted to 0.0-1.0 internally)
     */
    setVoiceVolume(voiceName, volume) {
        this.voiceVolumes[voiceName] = Math.max(0, Math.min(1, volume / 100));
    }

    // ------------------------------------------------------------------
    // Custom instrument management
    // ------------------------------------------------------------------

    /**
     * Loads a custom WebAudioFont preset from a URL. The JS file is fetched,
     * evaluated, and the preset variable is extracted. The preset is then
     * adjusted and ready for playback.
     *
     * @param {string} url - Full URL to the WebAudioFont JS file
     * @param {string} name - Display name for the instrument (e.g. 'Piccolo')
     * @returns {Promise<{varName: string, name: string}>}
     * @throws {Error} If fetch fails or no preset variable found
     */
    async loadCustomPreset(url, name) {
        if (!this.player) throw new Error('SwarSynth not initialized.');

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
        const jsCode = await response.text();

        // Execute to define the global preset variable
        new Function(jsCode)();

        // Auto-detect the variable name (starts with _tone_ or _drum_)
        const varMatch = jsCode.match(/var\s+(_tone_\w+|_drum_\w+)/);
        if (!varMatch) throw new Error('No WebAudioFont preset variable found in the file.');
        const varName = varMatch[1];
        const preset = window[varName];
        if (!preset) throw new Error(`Preset variable ${varName} not found after loading.`);

        // Generate a safe key from the name
        const key = name.toLowerCase().replace(/[^a-z0-9]/g, '_');

        // Adjust preset for playback
        if (audioEngine.audioCtx) {
            this.player.adjustPreset(audioEngine.audioCtx, preset);
            await this._waitForBuffers(preset);
        }

        // Register in presets
        this.presets[key] = preset;
        console.log(`[SwarSynth] Custom preset "${name}" loaded as "${key}" (${varName})`);

        return { varName, key, name };
    }

    /**
     * Removes a custom preset. Built-in presets cannot be removed.
     *
     * @param {string} key - The preset key to remove
     * @returns {boolean} True if removed
     */
    removeCustomPreset(key) {
        const builtIn = ['harmonium', 'strings', 'guitar', 'piano'];
        if (builtIn.includes(key)) return false;
        if (!this.presets[key]) return false;

        delete this.presets[key];
        delete this.voiceVolumes[key];

        // Remove from active voices if selected
        if (this.activeVoices.includes(key)) {
            this.activeVoices = this.activeVoices.filter(v => v !== key);
            if (this.activeVoices.length === 0) this.activeVoices = ['harmonium'];
            this.activePreset = this.presets[this.activeVoices[0]];
        }

        console.log(`[SwarSynth] Custom preset "${key}" removed`);
        return true;
    }

    // ------------------------------------------------------------------
    // Playback
    // ------------------------------------------------------------------

    /**
     * Schedules a melodic note for playback at the specified time.
     *
     * The note frequency is determined by the flute position, thaat, and base
     * Sa frequency using {@link getPositionFreq}. The frequency is then
     * converted to the nearest MIDI note number for WebAudioFont playback.
     *
     * @param {number} position - Flute position (1-15) identifying the swara.
     * @param {string} thaat - Thaat name (lowercase, e.g. 'bilawal', 'kalyan').
     * @param {number} baseSaFreq - The effective Sa frequency in Hz.
     * @param {number} startTime - AudioContext time (seconds) at which to begin.
     * @param {number} duration - Note duration in seconds.
     * @param {number} [velocity=0.7] - Playback velocity / gain (0.0 - 1.0).
     * @returns {object|null} The WebAudioFont envelope object (can be used to
     *   cancel the note), or `null` if the synth is not initialized.
     */
    playNote(position, thaat, baseSaFreq, startTime, duration, velocity = 0.7) {
        if (!this._initialized || !this.player || !this.activePreset) {
            console.warn(
                '[SwarSynth] playNote called before init(). Ignoring.'
            );
            return null;
        }

        if (!audioEngine.audioCtx) {
            console.warn(
                '[SwarSynth] AudioContext not available. Ignoring playNote.'
            );
            return null;
        }

        // 1. Get the frequency for this position, thaat, and Sa
        const freq = getPositionFreq(position, baseSaFreq, thaat);

        if (!Number.isFinite(freq) || freq <= 0) {
            console.warn(`[SwarSynth] Invalid frequency ${freq} for position ${position}. Skipping.`);
            return null;
        }

        // 2. Convert frequency to nearest MIDI note number
        const midiNote = Math.round(69 + 12 * Math.log2(freq / 440));

        if (!Number.isFinite(midiNote) || midiNote < 0 || midiNote > 127) {
            console.warn(`[SwarSynth] Invalid MIDI note ${midiNote} from freq ${freq}. Skipping.`);
            return null;
        }

        // 3. Get the destination node from the audio engine
        let destination;
        try {
            destination = audioEngine.getInputNode('swar');
        } catch (err) {
            console.warn('[SwarSynth] Could not get swar input node:', err.message);
            return null;
        }

        // 4. Queue the note via WebAudioFont — through ALL active voices
        //    When multiple instruments are selected, each plays the same note
        //    simultaneously, creating a layered sound effect.
        const envelopes = [];
        const voicesToPlay = this.activeVoices || [this.currentVoice || 'harmonium'];
        const baseVolume = velocity / Math.sqrt(voicesToPlay.length); // scale down to avoid clipping

        for (const voiceName of voicesToPlay) {
            const preset = this.presets[voiceName];
            if (!preset) continue;

            // Apply per-voice volume (0-1), default 1.0 if not set
            const voiceVol = this.voiceVolumes[voiceName] ?? 1.0;
            const volumePerVoice = baseVolume * voiceVol;

            const envelope = this.player.queueWaveTable(
                audioEngine.audioCtx,
                destination,
                preset,
                startTime,
                midiNote,
                duration,
                volumePerVoice
            );
            if (envelope) envelopes.push(envelope);
        }

        // 5. Return the envelopes so the caller can cancel if needed
        return envelopes.length === 1 ? envelopes[0] : envelopes;
    }

    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------

    /**
     * Immediately cancels all currently playing and queued notes.
     *
     * Useful when stopping a practice session or switching patterns to prevent
     * lingering sound from the previous sequence.
     */
    stopAll() {
        if (!this.player || !audioEngine.audioCtx) {
            return;
        }
        this.player.cancelQueue(audioEngine.audioCtx);
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * Waits for all zones in a preset to have their AudioBuffer decoded.
     *
     * WebAudioFont's adjustPreset() triggers async decodeAudioData() for each
     * zone but does NOT return a promise. We poll until all zone.buffer
     * properties are populated (or timeout after 10 seconds).
     *
     * @param {object} preset - A WebAudioFont preset object with a zones array.
     * @returns {Promise<void>}
     * @private
     */
    _waitForBuffers(preset) {
        return new Promise((resolve) => {
            if (!preset || !preset.zones || preset.zones.length === 0) {
                resolve();
                return;
            }

            let attempts = 0;
            const maxAttempts = 200; // 200 * 50ms = 10 seconds max

            const check = () => {
                attempts++;
                const allReady = preset.zones.every(z => z.buffer);
                if (allReady) {
                    resolve();
                } else if (attempts >= maxAttempts) {
                    console.warn('[SwarSynth] Timeout waiting for buffer decode. Some zones may not play.');
                    resolve(); // resolve anyway to not block forever
                } else {
                    setTimeout(check, 50);
                }
            };
            check();
        });
    }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Singleton instance of the swar (melodic note) synthesizer.
 *
 * Import this from any module that needs to play melodic notes:
 * ```js
 * import swarSynth from './swar-synth.js';
 * await swarSynth.init();
 * swarSynth.playNote(8, 'bilawal', 277.18, ctx.currentTime, 0.5);
 * ```
 *
 * @type {SwarSynth}
 */
const swarSynth = new SwarSynth();
export default swarSynth;
