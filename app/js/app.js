/**
 * @file app.js
 * @description Entry point for Swaradhana — a Hindustani Classical Music
 * practice app for bansuri. Loaded by index.html via
 * `<script type="module" src="js/app.js">`.
 *
 * Responsibilities:
 *  1. Load saved settings (or fall back to PRACTICE_DEFAULTS).
 *  2. Bootstrap the UI via initUI().
 *  3. Initialise the Web Audio engine on first user gesture.
 *  4. Wire up collapsible sections.
 *
 * All domain logic lives in other modules — this file is intentionally short.
 *
 * @author Arun Mahapatro
 * @license MIT
 * @module app
 */

import audioEngine from './audio-engine.js';
import { initUI } from './ui-controller.js';
import { load } from './storage.js';
import { PRACTICE_DEFAULTS, STORAGE_KEYS } from './config.js';
import practiceTracker from './practice-tracker.js';

// Practice session loaded separately — don't let it block the UI
let practiceSession = null;
import('./practice-session.js')
  .then(mod => { practiceSession = mod.default; console.log('[app] practice-session loaded'); })
  .catch(err => { console.error('[app] practice-session failed to load:', err); });

document.addEventListener('DOMContentLoaded', () => {
  // ------------------------------------------------------------------
  // 1. Load persisted settings (or use defaults for first-time users)
  // ------------------------------------------------------------------
  const settings = load(STORAGE_KEYS.SETTINGS, { ...PRACTICE_DEFAULTS });

  // ------------------------------------------------------------------
  // 2. Bind all UI elements to the settings object
  // ------------------------------------------------------------------
  initUI(settings);

  // ------------------------------------------------------------------
  // 3. Audio initialisation — handled automatically on first user click.
  //    Browsers require a user gesture before AudioContext can run.
  //    We silently init on the first click anywhere (no banner needed).
  //    The Start button also triggers init via practice-session.js.
  // ------------------------------------------------------------------
  const initAudioOnce = async () => {
    try {
      if (!audioEngine.isInitialized) {
        await audioEngine.init();
      }
      await audioEngine.resume();
      document.removeEventListener('click', initAudioOnce, true);
      document.removeEventListener('touchstart', initAudioOnce, true);
    } catch (err) {
      console.error('[app] Audio init failed:', err);
    }
  };

  document.addEventListener('click', initAudioOnce, true);
  document.addEventListener('touchstart', initAudioOnce, true);

  // ------------------------------------------------------------------
  // 4. Collapsible sections (e.g. "Advanced" in tanpura card)
  // ------------------------------------------------------------------
  document.querySelectorAll('.collapsible-header').forEach((header) => {
    header.addEventListener('click', () => {
      const section = header.closest('.collapsible');
      if (section) {
        const isExpanding = !section.classList.contains('expanded');
        section.classList.toggle('expanded');

        // When collapsing, also collapse all nested collapsibles inside
        if (!isExpanding) {
          section.querySelectorAll('.collapsible.expanded').forEach((child) => {
            child.classList.remove('expanded');
          });
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // 5. Practice tracker — records app time + exercise time, streak
  // ------------------------------------------------------------------
  practiceTracker.startAppSession();

  // Any real user input counts as activity (extends the idle window).
  ['pointerdown', 'touchstart', 'keydown', 'scroll'].forEach(ev => {
    document.addEventListener(ev, () => practiceTracker.noteActivity(), { passive: true, capture: true });
  });

  // Flush the heartbeat when the tab goes background, and resume when foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') practiceTracker.endAppSession();
    else practiceTracker.startAppSession();
  });
  window.addEventListener('beforeunload', () => practiceTracker.endAppSession());

  // ------------------------------------------------------------------
  // Done
  // ------------------------------------------------------------------
  console.log('Swaradhana initialized');
});
