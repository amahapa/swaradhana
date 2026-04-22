/**
 * @fileoverview Keep-audio-alive helper for mobile background playback.
 *
 * Mobile browsers aggressively suspend tabs (stopping Web Audio) when the
 * screen is locked or the user switches apps, unless the tab is classified
 * as "playing media". This module makes the tab look like a media player:
 *
 *   1. Loops a short silent WAV in an HTMLAudioElement so the OS sees the
 *      tab as an active audio producer — awards audio focus.
 *   2. Sets navigator.mediaSession metadata + action handlers so the OS
 *      shows a lock-screen / notification media control.
 *   3. Requests a screen Wake Lock to prevent the screen from dimming off
 *      in the first place (while the page is visible).
 *
 * Activate from any "started playing" path (tanpura start, tabla start,
 * exercise start). Deactivate from the matching "stopped" path. The module
 * reference-counts sources, so the silent track only stops once all
 * sources have deactivated.
 *
 * Platform notes:
 *   - Android Chrome (especially installed as a PWA): works reliably.
 *   - iOS Safari: best-effort; Apple still suspends audio after a short
 *     grace period when the screen locks. No workaround exists.
 *
 * @module background-audio
 */

const DEFAULT_METADATA = Object.freeze({
    title: 'Swaradhana',
    artist: 'Practice session',
    album: 'Hindustani practice',
});

let _silentAudioEl = null;
let _silentUrl = null;
let _wakeLock = null;
const _activeSources = new Set();

// ------------------------------------------------------------------
// Silent WAV generator — ~8 KB, one second, mono 8-bit PCM at 8 kHz.
// Mime-typed so the <audio> element accepts it.
// ------------------------------------------------------------------
function _buildSilentWavUrl() {
    const sampleRate = 8000;
    const numSamples = sampleRate; // 1 second
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // PCM format
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);  // byte rate (sr * blockAlign)
    view.setUint16(32, 1, true);           // block align
    view.setUint16(34, 8, true);           // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, numSamples, true);
    // Samples are all zero (silent) — ArrayBuffer defaults to zeros.
    // 8-bit unsigned PCM silent is actually 128; fill that in.
    const data = new Uint8Array(buffer, 44);
    data.fill(128);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function _ensureSilentAudio() {
    if (_silentAudioEl) return _silentAudioEl;
    _silentUrl = _buildSilentWavUrl();
    const audio = document.createElement('audio');
    audio.loop = true;
    audio.src = _silentUrl;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', ''); // iOS requirement
    audio.volume = 0.001;                  // effectively silent, still active
    audio.style.display = 'none';
    document.body.appendChild(audio);
    _silentAudioEl = audio;
    return audio;
}

function _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = new window.MediaMetadata(DEFAULT_METADATA);
    } catch (_) { /* MediaMetadata may not exist on older Safari */ }
    const noop = () => {};
    try {
        navigator.mediaSession.setActionHandler('play', noop);
        navigator.mediaSession.setActionHandler('pause', noop);
        navigator.mediaSession.setActionHandler('stop', noop);
    } catch (_) { /* handlers may be unsupported */ }
    try { navigator.mediaSession.playbackState = 'playing'; } catch (_) {}
}

async function _requestWakeLock() {
    if (!('wakeLock' in navigator) || _wakeLock) return;
    try {
        _wakeLock = await navigator.wakeLock.request('screen');
        _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    } catch (e) {
        console.warn('[background-audio] Wake lock request failed:', e?.message || e);
    }
}

async function _releaseWakeLock() {
    if (!_wakeLock) return;
    try { await _wakeLock.release(); } catch (_) {}
    _wakeLock = null;
}

/**
 * Register a playing source. The silent track starts on the first activate
 * and keeps running until every activate has been balanced by a deactivate.
 *
 * @param {string} source - Stable key for the caller ('tanpura' | 'tabla' | 'exercise' | ...)
 */
async function activate(source = 'generic') {
    const wasEmpty = _activeSources.size === 0;
    _activeSources.add(source);
    if (!wasEmpty) return; // already active

    const audio = _ensureSilentAudio();
    try {
        await audio.play();
    } catch (e) {
        console.warn('[background-audio] Silent audio play() rejected:', e?.message || e);
    }
    _setupMediaSession();
    await _requestWakeLock();
}

/**
 * Balance an earlier `activate(source)`. Silent track + wake lock stay
 * active if any other source is still registered.
 */
async function deactivate(source = 'generic') {
    _activeSources.delete(source);
    if (_activeSources.size > 0) return;

    if (_silentAudioEl) {
        try { _silentAudioEl.pause(); } catch (_) {}
    }
    if ('mediaSession' in navigator) {
        try { navigator.mediaSession.playbackState = 'none'; } catch (_) {}
    }
    await _releaseWakeLock();
}

/**
 * Override the lock-screen media-control title. Handy to reflect the
 * current exercise name, e.g. "Swaradhana — teentaal_b1".
 */
function setTitle(title, extras = {}) {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = new window.MediaMetadata({
            ...DEFAULT_METADATA,
            ...extras,
            title: title || DEFAULT_METADATA.title,
        });
    } catch (_) {}
}

// ------------------------------------------------------------------
// Re-acquire wake lock + resume silent audio when the tab becomes visible
// again (wake locks are auto-released on hide, silent audio may be paused).
// ------------------------------------------------------------------
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (_activeSources.size === 0) return;
    await _requestWakeLock();
    if (_silentAudioEl && _silentAudioEl.paused) {
        try { await _silentAudioEl.play(); } catch (_) {}
    }
});

const backgroundAudio = { activate, deactivate, setTitle };
export default backgroundAudio;
