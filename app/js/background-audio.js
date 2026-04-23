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
// Silent WAV generator — 30-second stereo 16-bit at 44.1 kHz.
// A longer loop reduces loop-boundary glitches on mobile (~once every
// 30 s instead of once per second). 16-bit @ 44.1 kHz stereo is the
// most compatible format across browsers + BT codecs.
// ~5 MB Blob but held only in memory; released by revokeObjectURL on
// deactivate if needed.
// ------------------------------------------------------------------
function _buildSilentWavUrl() {
    const sampleRate = 44100;
    const channels = 2;
    const bitsPerSample = 16;
    const seconds = 30;
    const blockAlign = channels * bitsPerSample / 8; // 4 bytes per frame
    const dataBytes = sampleRate * seconds * blockAlign;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // PCM format
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // byte rate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);
    // 16-bit signed PCM silent = 0; ArrayBuffer already zero-initialised.
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

let _deviceChangeTimer = null;
function _debouncedRebindSink(audio) {
    // Browsers sometimes fire devicechange multiple times rapidly. Coalesce
    // to a single setSinkId call ~500ms after the last event to avoid
    // audible glitches from repeated rebinds.
    clearTimeout(_deviceChangeTimer);
    _deviceChangeTimer = setTimeout(() => {
        if (typeof audio.setSinkId === 'function') {
            audio.setSinkId('').catch(() => {});
        }
    }, 500);
}

function _ensureSilentAudio() {
    if (_silentAudioEl) return _silentAudioEl;
    _silentUrl = _buildSilentWavUrl();
    const audio = document.createElement('audio');
    audio.loop = true;
    audio.src = _silentUrl;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', ''); // iOS requirement
    audio.muted = true;                    // belt + suspenders — inaudible even if volume slips
    audio.volume = 0;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    _silentAudioEl = audio;

    // Follow system-default output so Bluetooth connect/disconnect migrates
    // this stream. Debounced to avoid chattering on stray devicechange events.
    if (typeof audio.setSinkId === 'function') {
        audio.setSinkId('').catch(() => {});
    }
    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
        navigator.mediaDevices.addEventListener('devicechange', () => _debouncedRebindSink(audio));
    }
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
 * Start/stop the silent keep-alive track based on tab visibility + active
 * sources. Rules:
 *   - Silent loop plays ONLY when (tab is hidden) AND (at least one source
 *     is registered). Chrome doesn't suspend visible tabs, so the silent
 *     loop is unnecessary during foreground use — and on some phone
 *     speakers, a continuously-active-but-silent audio stream creates
 *     faint switching/crackle in the class-D amp.
 *   - Wake Lock is held whenever a source is registered, regardless of
 *     visibility — it's what keeps the screen from sleeping mid-practice.
 *   - MediaSession state mirrors the "any source active?" flag.
 */
function _syncSilentPlayback() {
    const shouldPlay = _activeSources.size > 0 && document.visibilityState === 'hidden';
    if (shouldPlay) {
        const audio = _ensureSilentAudio();
        _if (audio.paused) audio.play().catch(() => {});
    } else if (_silentAudioEl && !_silentAudioEl.paused) {
        try {
            _silentAudioEl.pause();
            _silentAudioEl.currentTime = 0;
        } catch (_) {}
    }
}

/**
 * Register a playing source. Wake Lock + MediaSession kick in immediately.
 * The silent keep-alive track only starts if the tab is currently hidden.
 */
async function activate(source = 'generic') {
    const wasEmpty = _activeSources.size === 0;
    _activeSources.add(source);
    if (!wasEmpty) return; // already active

    _setupMediaSession();
    await _requestWakeLock();
}

/**
 * Balance an earlier `activate(source)`.
 */
async function deactivate(source = 'generic') {
    _activeSources.delete(source);
    if (_activeSources.size > 0) { _syncSilentPlayback(); return; }

    _syncSilentPlayback();           // will stop the loop (no active sources)
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
// React to visibility changes:
//   hidden  → start silent keep-alive (if any source is active) to prevent
//             Chrome from suspending the tab.
//   visible → re-acquire wake lock, stop silent keep-alive so the phone
//             speaker isn't driven by a dummy stream during foreground use.
// ------------------------------------------------------------------
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        if (_activeSources.size > 0) await _requestWakeLock();
    }
    _syncSilentPlayback();
});

const backgroundAudio = { activate, deactivate, setTitle };
export default backgroundAudio;
