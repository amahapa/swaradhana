/**
 * @fileoverview Entry point. Loads settings, bootstraps UI, and wires up
 * gesture-gated audio init and practice-tracker lifecycle.
 *
 * @module app
 */

import audioEngine from './audio-engine.js';
import { initUI } from './ui-controller.js';
import { load } from './storage.js';
import { PRACTICE_DEFAULTS, STORAGE_KEYS } from './config.js';
import practiceTracker from './practice-tracker.js';

// Lazy-load to avoid blocking the UI on a transient parse/network error.
import('./practice-session.js')
  .then(() => console.log('[app] practice-session loaded'))
  .catch(err => console.error('[app] practice-session failed to load:', err));

document.addEventListener('DOMContentLoaded', () => {
  const settings = load(STORAGE_KEYS.SETTINGS, { ...PRACTICE_DEFAULTS });
  initUI(settings);

  // Browsers require a user gesture before AudioContext.resume() succeeds.
  const initAudioOnce = async () => {
    try {
      if (!audioEngine.isInitialized) await audioEngine.init();
      await audioEngine.resume();
      document.removeEventListener('click', initAudioOnce, true);
      document.removeEventListener('touchstart', initAudioOnce, true);
    } catch (err) {
      console.error('[app] Audio init failed:', err);
    }
  };
  document.addEventListener('click', initAudioOnce, true);
  document.addEventListener('touchstart', initAudioOnce, true);

  document.querySelectorAll('.collapsible-header').forEach((header) => {
    header.addEventListener('click', () => {
      const section = header.closest('.collapsible');
      if (!section) return;
      const isExpanding = !section.classList.contains('expanded');
      section.classList.toggle('expanded');
      if (!isExpanding) {
        section.querySelectorAll('.collapsible.expanded').forEach((child) => {
          child.classList.remove('expanded');
        });
      }
    });
  });

  practiceTracker.startAppSession();
  ['pointerdown', 'touchstart', 'keydown', 'scroll'].forEach(ev => {
    document.addEventListener(ev, () => practiceTracker.noteActivity(), { passive: true, capture: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') practiceTracker.endAppSession();
    else practiceTracker.startAppSession();
  });
  window.addEventListener('beforeunload', () => practiceTracker.endAppSession());

  console.log('Swaradhana initialized');
});
