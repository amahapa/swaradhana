/**
 * @file ui-controller.js
 * @description UI binding module for Swaradhana. Connects HTML elements to the
 * application state object. Contains zero audio logic — only DOM manipulation
 * and event handling. The audio engine is called through its public API
 * (volume / EQ setters) but never accessed at the AudioNode level.
 *
 * Imports:
 *  - config.js   — TAAL_DEFINITIONS, THAAT_DEFINITIONS, KEY_FREQUENCIES,
 *                   LAYA_RANGES, PRACTICE_DEFAULTS, STORAGE_KEYS
 *  - music-engine.js — classifyLaya (tempo -> laya label)
 *  - storage.js  — save() for persisting settings after every change
 *  - audio-engine.js — singleton for volume / EQ / pan setters
 *
 * @module ui-controller
 */

import {
  TAAL_DEFINITIONS,
  THAAT_DEFINITIONS,
  KEY_FREQUENCIES,
  LAYA_RANGES,
  PRACTICE_DEFAULTS,
  STORAGE_KEYS,
} from './config.js';

import { classifyLaya, getPositionLabel } from './music-engine.js';
import { parsePattern, generateExerciseAlankaar, fitExerciseToTaal, getPatternPreset, parseCompactPattern, compactPatternToString, generateFromCompactPattern } from './alankaar-engine.js';
import { save, exportAllData, importAllData, clearAllData } from './storage.js';
import audioEngine from './audio-engine.js';
import practiceTracker from './practice-tracker.js';
import profile from './profile.js';
import backgroundAudio from './background-audio.js';

// Lazy-load heavy modules — don't let import errors block the entire UI
let practiceSession = null;
let tanpura = null;
import('./practice-session.js').then(m => { practiceSession = m.default; }).catch(e => console.error('[UI] practice-session load failed:', e));
import('./tanpura.js').then(m => { tanpura = m.default; }).catch(e => console.error('[UI] tanpura load failed:', e));

// ---------------------------------------------------------------------------
// Module-level references (populated once during initUI)
// ---------------------------------------------------------------------------

/** @type {Object|null} The live settings object shared with the rest of the app. */
let _settings = null;

/** @type {Object|null} Separate TaalEngine instance for exercise playback. */
let exerciseTaalEngine = null;

// ---------------------------------------------------------------------------
// Helper: toggleButtonGroup
// ---------------------------------------------------------------------------

/**
 * Deactivate every button in a group, then activate the clicked one.
 *
 * @param {NodeList|Array<HTMLElement>} buttons - All buttons in the group.
 * @param {HTMLElement} activeButton - The button that should receive the
 *   `btn-active` class.
 */
function toggleButtonGroup(buttons, activeButton) {
  buttons.forEach((btn) => btn.classList.remove('btn-active'));
  activeButton.classList.add('btn-active');
}

// ---------------------------------------------------------------------------
// Helper: updateSettingsSummary
// ---------------------------------------------------------------------------

/**
 * Refresh every span in the Settings Summary Bar to reflect the current
 * settings values.
 *
 * Expected DOM ids:
 *  - #summary-key
 *  - #summary-thaat
 *  - #summary-taal
 *  - #summary-tempo
 *  - #summary-laya
 *
 * @param {Object} settings - The current settings object.
 */
function updateSettingsSummary(settings) {
  // Update all display elements on the main screen
  const keyDisplay     = document.getElementById('key-display');
  const fineTuneDisp   = document.getElementById('fine-tune-display');
  const saptakDisplay  = document.getElementById('saptak-display');
  const tempoDisplay   = document.getElementById('tempo-display');
  const thaatDisplay   = document.getElementById('thaat-display');
  const taalDisplay    = document.getElementById('taal-display');
  const tanpuraDisplay = document.getElementById('tanpura-display');
  const lessonSwaras   = document.getElementById('lesson-swaras');
  const lessonTaalName = document.getElementById('lesson-taal-name');

  // Key — strip suffix for clean display (E_low → E, F# → F#)
  if (keyDisplay) keyDisplay.textContent = (settings.key || 'E_low').replace('_low','').replace('_high','');

  // Fine tuning
  if (fineTuneDisp) {
    const ft = settings.fineTuning || 0;
    fineTuneDisp.textContent = ft >= 0 ? `+${ft}` : `${ft}`;
  }

  // Saptak
  // Saptak is now an inline dropdown — sync its value
  const saptakDropdown = document.getElementById('saptak-select');
  if (saptakDropdown) saptakDropdown.value = settings.saptak || 'MADHYA';

  // Tempo
  if (tempoDisplay) {
    tempoDisplay.textContent = settings.tempo || 80;
    const defaultBpm = PRACTICE_DEFAULTS.tempo || 80;
    tempoDisplay.style.color = (settings.tempo !== defaultBpm) ? 'var(--accent)' : '';
  }

  // Thaat
  if (thaatDisplay) {
    const thaatDef = THAAT_DEFINITIONS[settings.thaat];
    thaatDisplay.textContent = thaatDef ? thaatDef.name : (settings.thaat || 'Bilawal');
  }

  // Taal
  if (taalDisplay) {
    const taalDef = TAAL_DEFINITIONS[settings.taal];
    taalDisplay.textContent = taalDef ? taalDef.name : (settings.taal || 'Teentaal');
  }
  if (lessonTaalName) {
    const taalDef = TAAL_DEFINITIONS[settings.taal];
    lessonTaalName.textContent = taalDef ? taalDef.name : (settings.taal || 'Teentaal');
  }

  // Tanpura tuning display — short-letter notation, mandra marker (trailing ',').
  if (tanpuraDisplay) {
    const patterns = { pa: 'P,-S-S-S,', ma: 'm,-S-S-S,', ni: 'N,-S-S-S,' };
    tanpuraDisplay.textContent = patterns[settings.tanpuraPattern] || patterns.pa;
  }

  // Lesson swaras
  if (lessonSwaras) {
    const thaat = settings.thaat || 'bilawal';
    const positions = [4,5,6,7,8,9,10,11];
    lessonSwaras.textContent = positions.map(p => getPositionLabel(p, thaat, 'english')).join('');
  }

  // Also sync BPM panel displays if they exist
  const bpmDisp = document.getElementById('bpm-display');
  const bpmLaya = document.getElementById('bpm-laya-label');
  if (bpmDisp) bpmDisp.textContent = settings.tempo;
  if (bpmLaya) bpmLaya.textContent = getLayaLabel(settings.tempo);
}

// ---------------------------------------------------------------------------
// Helper: getLayaLabel
// ---------------------------------------------------------------------------

/**
 * Classify a tempo (BPM) into a Hindustani laya category name.
 *
 * Uses the LAYA_RANGES lookup from config.js. Each range is a
 * [min, max] tuple. At boundary values the higher category wins
 * (e.g. 80 BPM -> Madhya, not Vilambit).
 *
 * @param {number} bpm - Tempo in beats per minute.
 * @returns {string} Human-readable laya label.
 */
function getLayaLabel(bpm) {
  // Walk through LAYA_RANGES object in order from slowest to fastest.
  const entries = [
    { name: 'Ati-Vilambit', range: LAYA_RANGES.atiVilambit },
    { name: 'Vilambit',     range: LAYA_RANGES.vilambit },
    { name: 'Madhya',       range: LAYA_RANGES.madhya },
    { name: 'Drut',         range: LAYA_RANGES.drut },
    { name: 'Ati-Drut',     range: LAYA_RANGES.atiDrut },
  ];

  for (const { name, range } of entries) {
    if (bpm >= range[0] && bpm < range[1]) {
      return name;
    }
  }

  // If bpm exceeds all ranges, return the fastest category.
  return 'Ati-Drut';
}

// ---------------------------------------------------------------------------
// Helper: formatEQ
// ---------------------------------------------------------------------------

/**
 * Format a decibel value for display (e.g. "0 dB", "+6 dB", "-3 dB").
 *
 * @param {number} dB - Decibel value.
 * @returns {string} Formatted string with sign and "dB" suffix.
 */
function formatEQ(dB) {
  const n = Number(dB);
  if (n > 0) return `+${n} dB`;
  if (n < 0) return `${n} dB`;
  return '0 dB';
}

// ---------------------------------------------------------------------------
// Helper: persistSettings
// ---------------------------------------------------------------------------

/**
 * Save the current settings object to localStorage.
 * Called after every setting mutation.
 */
function persistSettings() {
  if (_settings) {
    save(STORAGE_KEYS.SETTINGS, _settings);
  }
}

// ---------------------------------------------------------------------------
// Beat Grid Renderer
// ---------------------------------------------------------------------------

/**
 * Render the beat grid for a given taal.
 *
 * Creates one `.beat-cell` div per matra (beat) inside the `#beat-grid`
 * container. Each cell receives contextual classes:
 *  - `.sam`   — the first beat (Sam, beat 1)
 *  - `.tali`  — the first beat of a Tali vibhag
 *  - `.khali` — every beat inside a Khali vibhag
 *
 * Vibhag boundaries are indicated by a thicker right-border on the last
 * beat of each vibhag.
 *
 * @param {string} taalId - Key into TAAL_DEFINITIONS (e.g. 'teentaal').
 */
function renderBeatGrid(taalId) {
  const container = document.getElementById('beat-grid');
  if (!container) return;

  const taal = TAAL_DEFINITIONS[taalId];
  if (!taal) {
    container.innerHTML = '';
    return;
  }

  // Clear existing content.
  container.innerHTML = '';

  // Pre-compute which matra indices start each vibhag and what kind it is.
  // vibhagStarts[i] = { startMatra, marker }
  const vibhagStarts = [];
  let runningMatra = 0;
  for (let v = 0; v < taal.vibhag.length; v++) {
    vibhagStarts.push({
      startMatra: runningMatra,
      endMatra: runningMatra + taal.vibhag[v] - 1,
      marker: taal.tpiSequence[v],
    });
    runningMatra += taal.vibhag[v];
  }

  // Build a per-matra lookup: { vibhagIndex, isFirstInVibhag, isLastInVibhag, marker }
  const matraInfo = [];
  for (let v = 0; v < vibhagStarts.length; v++) {
    const vs = vibhagStarts[v];
    for (let m = vs.startMatra; m <= vs.endMatra; m++) {
      matraInfo.push({
        vibhagIndex: v,
        isFirstInVibhag: m === vs.startMatra,
        isLastInVibhag: m === vs.endMatra,
        marker: vs.marker,
      });
    }
  }

  // Create beat cells.
  for (let i = 0; i < taal.beats; i++) {
    const cell = document.createElement('div');
    cell.classList.add('beat-cell');

    const info = matraInfo[i];

    // --- Apply contextual classes ---

    // Beat 1 is always Sam.
    if (i === 0) {
      cell.classList.add('sam');
    } else if (info.marker === '0') {
      // Khali vibhag — all beats get the khali class.
      cell.classList.add('khali');
    } else if (info.isFirstInVibhag) {
      // First beat of a numbered Tali vibhag.
      cell.classList.add('tali');
    } else {
      cell.classList.add('filler');
    }

    // --- Vibhag separator (thicker right-border on last beat of each vibhag) ---
    if (info.isLastInVibhag && i < taal.beats - 1) {
      cell.style.borderRight = '3px solid var(--border-color)';
    }

    // --- Marker label (X, 2, 0, 3 etc.) ---
    if (info.isFirstInVibhag) {
      const markerEl = document.createElement('span');
      markerEl.classList.add('beat-marker');
      markerEl.textContent = info.marker;
      cell.appendChild(markerEl);
    }

    // --- Bol text ---
    const bolEl = document.createElement('span');
    bolEl.classList.add('beat-bol');
    bolEl.textContent = taal.bols[i] || '';
    cell.appendChild(bolEl);

    container.appendChild(cell);
  }
}

// ---------------------------------------------------------------------------
// Taal Search Filter
// ---------------------------------------------------------------------------

/**
 * Filter the taal `<select>` dropdown based on user input.
 *
 * Behaviour:
 *  - If the input is empty, show all options and optgroups.
 *  - If the input is a number, show only options whose taal beat count
 *    matches that number. Hide non-matching options and empty optgroups.
 *  - If the input is text, show only options whose text content includes
 *    the search string (case-insensitive). Hide non-matching options and
 *    empty optgroups.
 *
 * @param {string} query - The raw search string from #taal-search.
 * @param {HTMLSelectElement} selectEl - The taal <select> element.
 */
function filterTaalDropdown(query, selectEl) {
  const trimmed = query.trim();
  const options  = selectEl.querySelectorAll('option');
  const optgroups = selectEl.querySelectorAll('optgroup');

  // If empty, show everything.
  if (!trimmed) {
    options.forEach((opt) => { opt.hidden = false; });
    optgroups.forEach((og) => { og.hidden = false; });
    return;
  }

  const isNumeric = /^\d+$/.test(trimmed);
  const numQuery = isNumeric ? parseInt(trimmed, 10) : NaN;
  const textQuery = trimmed.toLowerCase();

  // Filter individual options.
  options.forEach((opt) => {
    const taalId = opt.value;
    const taalDef = TAAL_DEFINITIONS[taalId];

    if (!taalDef) {
      // Placeholder or unknown option — hide during filtering.
      opt.hidden = true;
      return;
    }

    if (isNumeric) {
      // Match by beat count.
      opt.hidden = taalDef.beats !== numQuery;
    } else {
      // Match by name substring (case-insensitive).
      const nameMatch = (opt.textContent || '').toLowerCase().includes(textQuery);
      opt.hidden = !nameMatch;
    }
  });

  // Hide optgroups that have zero visible children.
  optgroups.forEach((og) => {
    const visibleChildren = og.querySelectorAll('option:not([hidden])');
    og.hidden = visibleChildren.length === 0;
  });
}

// ---------------------------------------------------------------------------
// initUI  (main export)
// ---------------------------------------------------------------------------

/**
 * Initialise all UI bindings. Called once from app.js after settings are
 * loaded from storage.
 *
 * This function wires up:
 *  1. Settings Summary Bar
 *  2. Settings Modal (open / close)
 *  3. Key, Tempo, Thaat, Taal dropdowns and sliders
 *  4. Taal search filter
 *  5. Laykari and Notation button groups
 *  6. Tanpura controls (strings, octave, speed, volumes, concert mode, advanced)
 *  7. Tabla controls (volume, bass EQ, treble EQ)
 *  8. Swar Voice controls (dropdown, volume)
 *  9. Transport controls (Start / Pause / Stop state machine)
 * 10. Beat grid renderer
 *
 * @param {Object} settings - The live settings object (mutated in place).
 */
export function initUI(settings) {
  _settings = settings;

  // ========================================================================
  // 1. Main Screen Display + Page Navigation
  // ========================================================================
  updateSettingsSummary(settings);

  // -- Page open/close helper --
  function _openPage(id) { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
  function _closePage(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

  // -- Setting tile clicks → open pages --
  const tileActions = {
    'btn-open-key':       () => _openPage('key-page'),
    'btn-settings':       () => _openPage('settings-page'),
    'btn-customize-tabla':   () => { _closePage('settings-page'); _openPage('tabla-page'); },
    'btn-customize-tanpura': () => { _closePage('settings-page'); _openPage('tanpura-page'); },
    'btn-customize-swara':   () => { _closePage('settings-page'); _openPage('swara-page'); },
    'btn-open-tempo':     null, // handled by BPM panel below
    'btn-open-taal-list': () => { _buildTaalList(); _openPage('taal-list-page'); },
    'btn-open-volume':    () => _openPage('volume-page'),
    'btn-open-tanpura':   () => _openPage('tanpura-page'),
    'btn-edit-lesson':    () => _openPage('alankaar-editor-page'),
    'btn-open-exercise-library': () => { _buildExerciseList(); _openPage('exercise-library-page'); },
    'btn-help':              () => _openPage('help-page'),
  };

  for (const [id, action] of Object.entries(tileActions)) {
    const el = document.getElementById(id);
    if (el && action) el.addEventListener('click', action);
  }

  // -- Data Management (Settings page) --
  const btnExportData = document.getElementById('btn-export-data');
  if (btnExportData) {
    btnExportData.addEventListener('click', () => {
      const data = exportAllData();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `swaradhana_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  const btnImportData = document.getElementById('btn-import-data');
  const importFileInput = document.getElementById('import-file-input');
  if (btnImportData && importFileInput) {
    btnImportData.addEventListener('click', () => importFileInput.click());
    importFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data || typeof data !== 'object') throw new Error('Invalid format');
          if (!confirm('This will overwrite your current settings, exercises, and variations. Continue?')) return;
          importAllData(data);
          alert('Data imported successfully. The app will reload.');
          location.reload();
        } catch (err) {
          alert('Failed to import: ' + err.message);
        }
      };
      reader.readAsText(file);
      importFileInput.value = ''; // reset so same file can be re-imported
    });
  }

  const btnClearAllData = document.getElementById('btn-clear-all-data');
  if (btnClearAllData) {
    btnClearAllData.addEventListener('click', () => {
      if (!confirm('This will permanently delete ALL your settings, exercises, taal variations, and preferences. This cannot be undone.\n\nAre you sure?')) return;
      clearAllData();
      alert('All data cleared. The app will reload.');
      location.reload();
    });
  }

  // -- Back buttons on all pages --
  // Back buttons that go to main screen (close the full-page)
  ['btn-back-key', 'btn-back-volume', 'btn-back-taal-list', 'btn-back-taal-variations', 'btn-back-settings-page', 'btn-back-exercise-library', 'btn-back-exercise-designer', 'btn-back-exercise-player', 'btn-back-exercise-edit', 'btn-back-help'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => {
      // Close the closest full-page ancestor
      const page = btn.closest('.full-page');
      if (page) page.classList.add('hidden');
    });
  });

  // Back buttons that go to Settings page (not main screen)
  ['btn-back-tabla-page', 'btn-back-tanpura', 'btn-back-swara-page'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => {
      const page = btn.closest('.full-page');
      if (page) page.classList.add('hidden');
      _openPage('settings-page');
    });
  });

  // -- Saptak dropdown (inline in settings grid) --
  const saptakSelect = document.getElementById('saptak-select');
  if (saptakSelect) {
    saptakSelect.value = settings.saptak || 'MADHYA';
    saptakSelect.addEventListener('change', () => {
      settings.saptak = saptakSelect.value;
      // Update tanpura octave to match
      settings.tanpuraOctave = saptakSelect.value;
      // If tanpura is playing, restart with new octave
      if (tanpura && tanpura.isPlaying) {
        tanpura.updateConfig({ octave: settings.saptak });
      }
      persistSettings();
      console.log('[UI] Saptak changed to:', settings.saptak);
    });
  }

  // -- Quick toggle buttons on main screen tiles --

  // Helper: sync all tanpura button visuals to current playing state
  function _syncTanpuraButtons() {
    const playing = tanpura && tanpura.isPlaying;
    const quickBtn = document.getElementById('btn-tanpura-quick-toggle');
    const pageBtn = document.getElementById('btn-tanpura-play');
    if (quickBtn) {
      if (playing) {
        quickBtn.textContent = '■';
        quickBtn.style.fontSize = '1.2rem';
        quickBtn.style.background = 'var(--accent)';
        quickBtn.style.color = 'var(--bg-primary)';
        quickBtn.style.borderColor = 'var(--accent)';
      } else {
        quickBtn.textContent = '▶';
        quickBtn.style.fontSize = '0.9rem';
        quickBtn.style.background = 'transparent';
        quickBtn.style.color = 'var(--accent)';
        quickBtn.style.borderColor = 'var(--accent)';
      }
    }
    if (pageBtn) {
      if (playing) {
        pageBtn.textContent = '⏹ Stop Tanpura';
        pageBtn.classList.remove('btn-primary');
        pageBtn.classList.add('btn-danger');
      } else {
        pageBtn.textContent = '▶ Play Tanpura';
        pageBtn.classList.remove('btn-danger');
        pageBtn.classList.add('btn-primary');
      }
    }
  }

  // Helper: start tanpura with current global settings (if not already playing)
  async function _startTanpura() {
    // Wait for tanpura module if not yet loaded
    if (!tanpura) {
      try {
        const mod = await import('./tanpura.js');
        tanpura = mod.default;
      } catch (e) {
        console.error('[UI] Failed to load tanpura:', e);
        return;
      }
    }
    if (tanpura.isPlaying) {
      _syncTanpuraButtons(); // still sync icons even if already playing
      return;
    }
    if (!audioEngine.isInitialized) await audioEngine.init();
    await audioEngine.resume();
    const saFreq = KEY_FREQUENCIES[settings.key] || 164.81;
    tanpura.updateConfig({
      pattern: settings.tanpuraPattern || 'pa',
      octave: settings.tanpuraOctave || settings.saptak || 'MEDIUM',
      speed: settings.tanpuraSpeed || 30,
      jivariA: settings.tanpuraJivariA ?? settings.tanpuraJivari ?? 65,
      jivariB: settings.tanpuraJivariB ?? settings.tanpuraJivari ?? 60,
      variance: settings.tanpuraVariance || 3,
    });
    tanpura.start(saFreq, settings.fineTuning || 0);
    backgroundAudio.activate('tanpura');
    _syncTanpuraButtons();
  }

  // Helper: stop tanpura
  function _stopTanpura() {
    if (tanpura && tanpura.isPlaying) {
      tanpura.stop();
    }
    backgroundAudio.deactivate('tanpura');
    _syncTanpuraButtons();
  }

  // Tanpura quick toggle (on the Tanpura tile)
  const btnTanpuraQuickToggle = document.getElementById('btn-tanpura-quick-toggle');
  if (btnTanpuraQuickToggle) {
    btnTanpuraQuickToggle.addEventListener('click', async () => {
      if (tanpura && tanpura.isPlaying) {
        // Stop tanpura — same pattern as tabla toggle
        _stopTanpura();
        btnTanpuraQuickToggle.innerHTML = '<span style="font-size:1.1rem;">▶</span>';
        btnTanpuraQuickToggle.style.background = 'transparent';
        btnTanpuraQuickToggle.style.color = 'var(--accent)';
      } else {
        // Start tanpura — same pattern as tabla toggle
        await _startTanpura();
        btnTanpuraQuickToggle.innerHTML = '<span style="font-size:1.1rem;">■</span>';
        btnTanpuraQuickToggle.style.background = 'var(--accent)';
        btnTanpuraQuickToggle.style.color = 'var(--bg-primary)';
      }
    });
  }

  // Tabla quick toggle (on the Tempo/BPM tile)
  const btnTablaQuickToggle = document.getElementById('btn-tabla-quick-toggle');
  let tablaPlaying = false;
  let tablaTaalEngine = null;

  if (btnTablaQuickToggle) {
    btnTablaQuickToggle.addEventListener('click', async () => {
      // If a practice session is running, the quick toggle controls that session's tabla
      if (transportState === 'playing' || transportState === 'paused') {
        console.log('[UI] Tabla toggle ignored — practice session is active');
        return;
      }
      if (tablaPlaying && tablaTaalEngine) {
        // Stop tabla
        tablaTaalEngine.stop();
        tablaPlaying = false;
        backgroundAudio.deactivate('tabla-quick');
        btnTablaQuickToggle.innerHTML = '<span style="font-size:1.1rem;">▶</span>';
        btnTablaQuickToggle.style.background = 'transparent';
        btnTablaQuickToggle.style.color = 'var(--accent)';
      } else {
        // Start tabla
        if (!audioEngine.isInitialized) await audioEngine.init();
        await audioEngine.resume();
        try {
          await _ensureTablaMode();
          const { TaalEngine } = await import('./taal-engine.js');
          const tabla = (await import('./tabla.js')).default;
          if (!tablaTaalEngine) tablaTaalEngine = new TaalEngine();
          tablaTaalEngine.setTaal(settings.taal || 'teentaal');
          tablaTaalEngine.setTempo(settings.tempo || 80);
          tablaTaalEngine.callbacks = [];
          const saFreq = KEY_FREQUENCIES[settings.key] || 164.81;
          tabla.setSaFreq(saFreq);
          tablaTaalEngine.onBeat((matraIndex, beatType, bol, velocity, scheduledTime) => {
            const activeBols = _getActiveBols(settings.taal);
            const bolsForMatra = activeBols[matraIndex] || [bol];
            const beatDuration = tablaTaalEngine.getBeatDuration();
            const subDuration = beatDuration / bolsForMatra.length;
            bolsForMatra.forEach((subBol, i) => {
              _playTablaBol(subBol, scheduledTime + i * subDuration, velocity, subDuration);
            });
          });
          tablaTaalEngine.start(audioEngine.audioCtx);
          tablaPlaying = true;
          backgroundAudio.activate('tabla-quick');
          btnTablaQuickToggle.innerHTML = '<span style="font-size:1.1rem;">■</span>';
          btnTablaQuickToggle.style.background = 'var(--accent)';
          btnTablaQuickToggle.style.color = 'var(--bg-primary)';
        } catch (err) {
          console.error('[UI] Tabla quick start failed:', err);
        }
      }
    });
  }

  // -- Tabla source selection (on Tabla page) --
  const tablaSourceSelect = document.getElementById('tabla-source-select');
  if (tablaSourceSelect) {
    // Restore saved selection
    tablaSourceSelect.value = settings.tablaSource || 'electronic';

    // -- Tabla sound customization sliders --
    const tablaBalance = document.getElementById('tabla-balance');
    const tablaBalanceVal = document.getElementById('tabla-balance-val');
    const tablaTimber = document.getElementById('tabla-timber');
    const tablaTimberVal = document.getElementById('tabla-timber-val');
    const tablaBassCustom = document.getElementById('tabla-bass-custom');
    const tablaBassCustomVal = document.getElementById('tabla-bass-custom-val');
    const tablaReverb = document.getElementById('tabla-reverb');
    const tablaReverbVal = document.getElementById('tabla-reverb-val');

    // Balance: 0=all Bayan, 50=neutral, 100=all Dayan
    // Maps to: bass EQ gain (inverse) and treble EQ gain
    if (tablaBalance) {
      tablaBalance.value = settings.tablaBalance || 50;
      if (tablaBalanceVal) tablaBalanceVal.textContent = (settings.tablaBalance || 50) + '%';
      tablaBalance.addEventListener('input', () => {
        const val = parseInt(tablaBalance.value, 10);
        settings.tablaBalance = val;
        if (tablaBalanceVal) tablaBalanceVal.textContent = val + '%';
        // Map 0-100 to EQ: at 50 both are 0dB, at 0 bass=+8 treble=-8, at 100 bass=-8 treble=+8
        const offset = ((val - 50) / 50) * 8; // -8 to +8
        if (audioEngine.isInitialized) {
          audioEngine.setTablaBassEQ(-offset + (settings.tablaBassEQ || 0));
          audioEngine.setTablaTrebleEQ(offset);
        }
        persistSettings();
      });
    }

    // Timber: 0=dark/muted, 100=bright/cutting
    // Maps to: treble EQ shelf frequency (800Hz to 4000Hz)
    if (tablaTimber) {
      tablaTimber.value = settings.tablaTimber || 50;
      if (tablaTimberVal) tablaTimberVal.textContent = (settings.tablaTimber || 50) + '%';
      tablaTimber.addEventListener('input', () => {
        const val = parseInt(tablaTimber.value, 10);
        settings.tablaTimber = val;
        if (tablaTimberVal) tablaTimberVal.textContent = val + '%';
        // Map 0-100 to frequency: 800Hz (dark) to 4000Hz (bright)
        if (audioEngine.isInitialized && audioEngine.tablaTrebleEQ) {
          const freq = 800 + (val / 100) * 3200;
          audioEngine.tablaTrebleEQ.frequency.setTargetAtTime(freq, audioEngine.audioCtx.currentTime, 0.02);
        }
        persistSettings();
      });
    }

    // Bass (Bayan): -12 to +12 dB
    if (tablaBassCustom) {
      tablaBassCustom.value = settings.tablaBassCustom || 0;
      if (tablaBassCustomVal) tablaBassCustomVal.textContent = (settings.tablaBassCustom || 0) + ' dB';
      tablaBassCustom.addEventListener('input', () => {
        const val = parseInt(tablaBassCustom.value, 10);
        settings.tablaBassCustom = val;
        settings.tablaBassEQ = val; // sync with main bass EQ setting
        if (tablaBassCustomVal) tablaBassCustomVal.textContent = (val > 0 ? '+' : '') + val + ' dB';
        if (audioEngine.isInitialized) {
          audioEngine.setTablaBassEQ(val);
        }
        persistSettings();
      });
    }

    // Reverb: 0=fully dry, 100=fully wet
    // Uses a single persistent wet-send GainNode between tablaGain and reverb.
    let _tablaWetGain = null;
    if (tablaReverb) {
      tablaReverb.value = settings.tablaReverb || 20;
      if (tablaReverbVal) tablaReverbVal.textContent = (settings.tablaReverb || 20) + '%';
      tablaReverb.addEventListener('input', () => {
        const val = parseInt(tablaReverb.value, 10);
        settings.tablaReverb = val;
        if (tablaReverbVal) tablaReverbVal.textContent = val + '%';
        if (audioEngine.isInitialized && audioEngine.tablaGain && audioEngine.reverb) {
          const now = audioEngine.audioCtx.currentTime;
          const wetLevel = (val / 100) * 0.5; // 0 to 0.5

          // Create the wet send node once, reuse it
          if (!_tablaWetGain) {
            _tablaWetGain = audioEngine.audioCtx.createGain();
            _tablaWetGain.gain.value = 0;
            audioEngine.tablaGain.connect(_tablaWetGain);
            _tablaWetGain.connect(audioEngine.reverb);
          }

          // Just adjust the wet gain — 0 = fully dry, 0.5 = max wet
          _tablaWetGain.gain.setTargetAtTime(wetLevel, now, 0.02);
        }
        persistSettings();
      });
    }

    tablaSourceSelect.addEventListener('change', async () => {
      const source = tablaSourceSelect.value;
      settings.tablaSource = source;
      persistSettings();

      // Apply immediately
      if (source === 'electronic') {
        _tablaSampleMode = false;
        console.log('[UI] Tabla switched to electronic — immediate');
      } else {
        // Load samples now so the switch is instant
        try {
          if (!audioEngine.isInitialized) await audioEngine.init();
          await audioEngine.resume();
          await _ensureTablaMode();
          console.log('[UI] Tabla switched to samples — immediate');
        } catch (err) {
          console.error('[UI] Immediate tabla switch failed:', err);
        }
      }
    });
  }

  /**
   * Ensure the tabla module is in the correct mode (electronic or sample)
   * before playback. Called before any tabla playback starts.
   * This is the single reliable place to switch modes.
   */
  // Module-level sample player reference — shared across all tabla playback
  let _tablaSamplePlayer = null;
  let _tablaSampleMode = false;

  async function _ensureTablaMode() {
    const source = settings.tablaSource || 'electronic';
    if (source === 'electronic') {
      _tablaSampleMode = false;
      return;
    }

    try {
      if (!audioEngine.isInitialized) await audioEngine.init();
      await audioEngine.resume();

      // Load the sample player module directly
      if (!_tablaSamplePlayer) {
        const mod = await import('./tabla-samples.js');
        _tablaSamplePlayer = mod.default;
      }

      // Load samples if not already loaded for this set
      const samplePath = `assets/audio/tabla/${source}`;
      if (!_tablaSamplePlayer.isLoaded || _tablaSamplePlayer.loadedSet !== samplePath) {
        console.log('[UI] Loading tabla samples from:', samplePath);
        await _tablaSamplePlayer.loadSampleSet(samplePath);
        const saFreq = KEY_FREQUENCIES[settings.key] || 164.81;
        _tablaSamplePlayer.setSaFreq(saFreq);
      }

      _tablaSampleMode = true;
      console.log('[UI] Tabla sample mode ready. Buffers:', Object.keys(_tablaSamplePlayer.buffers).length);
    } catch (err) {
      console.error('[UI] _ensureTablaMode failed:', err);
      _tablaSampleMode = false;
    }
  }

  /**
   * Play a tabla bol — uses samples if sample mode is active, otherwise electronic.
   * Call this instead of tabla.playBolAtTime() to respect the user's tabla source setting.
   */
  function _playTablaBol(bol, time, velocity, duration) {
    if (!bol || bol === 'x') return;
    if (_tablaSampleMode && _tablaSamplePlayer && _tablaSamplePlayer.isLoaded) {
      _tablaSamplePlayer.playBol(bol, time, velocity, duration);
    } else {
      // Fall back to electronic — use dynamic import (cached after first call)
      import('./tabla.js').then(mod => {
        mod.default.playBolAtTime(bol, time, velocity, duration);
      }).catch(() => {});
    }
  }
  // Expose for debugging
  window._debugTablaMode = () => ({ _tablaSampleMode, playerLoaded: _tablaSamplePlayer?.isLoaded, source: settings.tablaSource });

  // -- Tanpura Play/Stop toggle button (on Tanpura page) --
  const btnTanpuraPlay = document.getElementById('btn-tanpura-play');
  if (btnTanpuraPlay) {
    btnTanpuraPlay.addEventListener('click', async () => {
      if (tanpura && tanpura.isPlaying) {
        _stopTanpura();
      } else {
        await _startTanpura();
      }
    });
  }

  /**
   * Restart any playing instruments with the current key + fine tuning.
   * Called after key change or fine tuning change.
   */
  function _restartPlayingInstruments() {
    const saFreq = KEY_FREQUENCIES[settings.key] || 164.81;
    const ft = settings.fineTuning || 0;
    const effectiveSa = saFreq * Math.pow(2, ft / 1200);

    // Restart tanpura if playing
    if (tanpura && tanpura.isPlaying) {
      tanpura.updateConfig({
        pattern: settings.tanpuraPattern || 'pa',
        octave: settings.tanpuraOctave || settings.saptak || 'MEDIUM',
        speed: settings.tanpuraSpeed || 30,
        jivariA: settings.tanpuraJivariA ?? settings.tanpuraJivari ?? 65,
        jivariB: settings.tanpuraJivariB ?? settings.tanpuraJivari ?? 60,
        variance: settings.tanpuraVariance || 3,
      });
      tanpura.start(saFreq, ft);
    }

    // Update tabla Sa frequency — both electronic and sample player
    import('./tabla.js').then(mod => {
      if (mod.default && mod.default.setSaFreq) {
        mod.default.setSaFreq(effectiveSa);
      }
    }).catch(() => {});

    // Update sample player Sa frequency (for real tabla samples)
    if (_tablaSamplePlayer) {
      _tablaSamplePlayer.setSaFreq(effectiveSa);
      console.log('[UI] Tabla sample player Sa updated to:', effectiveSa.toFixed(2), 'Hz');
    }
  }

  // -- Key page: pitch grid --
  document.querySelectorAll('.pitch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pitch-btn').forEach(b => b.classList.remove('btn-active'));
      btn.classList.add('btn-active');
      settings.key = btn.dataset.key;
      const freq = KEY_FREQUENCIES[settings.key];
      if (freq !== undefined) settings.baseSaFreq = freq;
      updateSettingsSummary(settings);
      persistSettings();
      _restartPlayingInstruments();
    });
  });
  // Initialize active pitch button
  document.querySelectorAll('.pitch-btn').forEach(btn => {
    btn.classList.toggle('btn-active', btn.dataset.key === settings.key);
  });

  // -- Key page: Fine Tuning slider + step buttons --
  const fineTuneSlider = document.getElementById('fine-tune');
  const fineTuneVal    = document.getElementById('fine-tune-val');
  const fineTuneDisp   = document.getElementById('fine-tune-display');
  const fineTuneMinus  = document.getElementById('fine-tune-minus');
  const fineTunePlus   = document.getElementById('fine-tune-plus');

  function _applyFineTune(cents) {
    cents = Math.max(-50, Math.min(50, Math.round(cents)));
    settings.fineTuning = cents;
    if (fineTuneSlider) fineTuneSlider.value = cents;
    const label = cents > 0 ? `+${cents}` : `${cents}`;
    if (fineTuneVal) fineTuneVal.textContent = `${label} cents`;
    if (fineTuneDisp) fineTuneDisp.textContent = label;
    if (fineTuneDisp) fineTuneDisp.style.color = cents !== 0 ? 'var(--accent)' : 'var(--text-secondary)';
    persistSettings();
    _restartPlayingInstruments();
  }

  // Initialize
  _applyFineTune(settings.fineTuning || 0);

  if (fineTuneSlider) {
    fineTuneSlider.value = settings.fineTuning || 0;
    fineTuneSlider.addEventListener('input', () => {
      _applyFineTune(parseInt(fineTuneSlider.value, 10));
    });
  }

  if (fineTuneMinus) {
    fineTuneMinus.addEventListener('click', () => {
      _applyFineTune((settings.fineTuning || 0) - 1);
    });
  }

  if (fineTunePlus) {
    fineTunePlus.addEventListener('click', () => {
      _applyFineTune((settings.fineTuning || 0) + 1);
    });
  }

  // -- Key page: saptak (on the key page as tanpura octave buttons) --
  // Already handled by tanpura controls section below

  // -- Initialize taalVariation setting --
  if (!settings.taalVariation) settings.taalVariation = 'default';

  // -- Compound bol splitter: converts flat bol string to array of sub-bols --
  function _splitBol(bol) {
    if (bol === 'DhaGe') return ['Dha', 'Ge'];
    if (bol === 'TiRaKiTa') return ['Ti', 'Ra', 'Ki', 'Ta'];
    return [bol];
  }

  // -- Convert default theka bols to array-of-arrays format --
  function _thekaToArrayFormat(bols) {
    return bols.map(bol => _splitBol(bol));
  }

  // -- Get active bols for current taal as array-of-arrays --
  function _getActiveBols(taalId) {
    const taalDef = TAAL_DEFINITIONS[taalId];
    if (!taalDef) return [];
    const varId = settings.taalVariation || 'default';
    if (varId === 'default') {
      return _thekaToArrayFormat(taalDef.bols);
    }
    const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
    const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
    const variation = allVars.find(v => v.id === varId && v.taalId === taalId);
    if (variation && variation.bols) {
      return variation.bols;
    }
    return _thekaToArrayFormat(taalDef.bols);
  }

  // -- Variation switcher (‹ D ›) on main screen taal tile --
  // Builds the ordered list of variation IDs for the current taal: ['default', 'id1', 'id2', ...]
  function _getVariationList(taalId) {
    const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
    const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
    const forTaal = allVars.filter(v => v.taalId === taalId);
    return [{ id: 'default', name: 'Default' }, ...forTaal];
  }

  function _populateVariationDropdown(taalId) {
    const switcher = document.getElementById('taal-var-switcher');
    const label = document.getElementById('taal-var-label');
    if (!switcher || !label) return;

    const varList = _getVariationList(taalId);

    if (varList.length <= 1) {
      // Only Default — hide switcher
      switcher.style.display = 'none';
      settings.taalVariation = 'default';
      return;
    }

    switcher.style.display = 'flex';

    // Find the current index
    const currentId = settings.taalVariation || 'default';
    const idx = varList.findIndex(v => v.id === currentId);
    if (idx < 0) {
      settings.taalVariation = 'default';
    }

    // Update label: "D" for default, or extract the suffix number from the name
    _updateVarLabel();
  }

  function _updateVarLabel() {
    const label = document.getElementById('taal-var-label');
    if (!label) return;
    const currentId = settings.taalVariation || 'default';
    if (currentId === 'default') {
      label.textContent = 'D';
      return;
    }
    const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
    const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
    const variation = allVars.find(v => v.id === currentId);
    if (variation) {
      // Extract trailing number from name, e.g., "Teentaal 3" → "3"
      const match = variation.name.match(/(\d+)\s*$/);
      label.textContent = match ? match[1] : variation.name.slice(0, 3);
    } else {
      label.textContent = 'D';
      settings.taalVariation = 'default';
    }
  }

  function _switchVariation(direction) {
    const taalId = settings.taal;
    const varList = _getVariationList(taalId);
    if (varList.length <= 1) return;

    const currentId = settings.taalVariation || 'default';
    let idx = varList.findIndex(v => v.id === currentId);
    if (idx < 0) idx = 0;

    idx += direction;
    if (idx < 0) idx = varList.length - 1;       // wrap around
    if (idx >= varList.length) idx = 0;           // wrap around

    settings.taalVariation = varList[idx].id;
    persistSettings();
    _updateVarLabel();
  }

  // Wire up ‹ › buttons
  const btnVarPrev = document.getElementById('btn-var-prev');
  const btnVarNext = document.getElementById('btn-var-next');
  if (btnVarPrev) btnVarPrev.addEventListener('click', (e) => { e.stopPropagation(); _switchVariation(-1); });
  if (btnVarNext) btnVarNext.addEventListener('click', (e) => { e.stopPropagation(); _switchVariation(1); });

  // Populate on init
  _populateVariationDropdown(settings.taal);

  // -- Taal list builder --
  // Favorite taals stored as an array of taal IDs
  if (!settings.favoriteTaals) settings.favoriteTaals = [];

  function _buildTaalList() {
    const container = document.getElementById('taal-list-container');
    if (!container) return;
    container.innerHTML = '';

    const favorites = settings.favoriteTaals || [];
    const taals = Object.entries(TAAL_DEFINITIONS);

    // Sort: favorites first (alphabetical), then non-favorites (alphabetical)
    taals.sort((a, b) => {
      const aFav = favorites.includes(a[0]);
      const bFav = favorites.includes(b[0]);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      return a[1].name.localeCompare(b[1].name);
    });

    // Section headers
    const hasFavorites = taals.some(([id]) => favorites.includes(id));
    let inFavSection = hasFavorites;

    if (hasFavorites) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:0.75rem; color:var(--text-dim); padding:8px 0 4px; text-transform:uppercase; letter-spacing:0.05em;';
      header.textContent = 'Favorites';
      container.appendChild(header);
    }

    for (const [id, taal] of taals) {
      const isFav = favorites.includes(id);
      const isSelected = settings.taal === id;

      // Add "All Taals" header when transitioning from favorites to non-favorites
      if (inFavSection && !isFav) {
        inFavSection = false;
        const header = document.createElement('div');
        header.style.cssText = 'font-size:0.75rem; color:var(--text-dim); padding:16px 0 4px; text-transform:uppercase; letter-spacing:0.05em;';
        header.textContent = 'All Taals';
        container.appendChild(header);
      }

      const item = document.createElement('div');
      item.style.cssText = `display:flex; align-items:center; padding:12px 10px; border-bottom:1px solid var(--border); cursor:pointer; border-radius:8px; margin-bottom:2px; ${isSelected ? 'background:var(--accent-glow, rgba(245,166,35,0.15)); border-left:3px solid var(--accent);' : ''}`;

      // Favorite star — toggle on click
      const star = document.createElement('span');
      star.style.cssText = `font-size:1.3rem; margin-right:12px; cursor:pointer; color:${isFav ? 'var(--accent)' : 'var(--text-dim)'};`;
      star.textContent = isFav ? '★' : '☆';
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isFav) {
          // Remove from favorites
          settings.favoriteTaals = favorites.filter(f => f !== id);
        } else {
          // Add to favorites
          settings.favoriteTaals = [...favorites, id];
        }
        persistSettings();
        _buildTaalList(); // rebuild to re-sort
      });

      // Taal info
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;';
      info.innerHTML = `<div style="font-weight:${isSelected ? '700' : '500'}; color:${isSelected ? 'var(--accent)' : 'var(--text-primary)'};">${taal.name}</div>
        <div style="font-size:0.8rem; color:var(--text-dim);">${taal.beats} beats (${taal.vibhag.join('+')})</div>`;

      // Variation count + chevron
      const right = document.createElement('div');
      right.style.cssText = 'display:flex; align-items:center; gap:8px; color:var(--text-secondary); font-size:0.85rem;';
      const varKey = STORAGE_KEYS.TAAL_VARIATIONS || 'swaradhana_taal_variations';
      const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
      const varCount = allVars.filter(v => v.taalId === id).length;
      right.innerHTML = `${varCount > 0 ? varCount + ' var' : ''} <span style="font-size:1.1rem;">›</span>`;

      item.appendChild(star);
      item.appendChild(info);
      item.appendChild(right);

      // Click taal row → select this taal
      item.addEventListener('click', () => {
        settings.taal = id;
        settings.taalVariation = 'default'; // reset variation on taal change
        _populateVariationDropdown(id);
        updateSettingsSummary(settings);
        renderBeatGrid(id);
        persistSettings();
        // Apply to playing taal engines (deferred to next cycle start)
        if (tablaTaalEngine && tablaPlaying) tablaTaalEngine.setTaal(id);
        import('./practice-session.js').then(mod => {
          if (mod.default && mod.default.taalEngine && mod.default.state === 'playing') {
            mod.default.taalEngine.setTaal(id);
          }
        }).catch(() => {});
        _buildTaalList(); // rebuild to update highlight
      });

      // Double-tap or chevron → open detail/variations page
      right.addEventListener('click', (e) => {
        e.stopPropagation();
        settings.taal = id;
        updateSettingsSummary(settings);
        renderBeatGrid(id);
        persistSettings();
        _populateVariationDropdown(id);
        _buildTaalDetail(id, taal.name);
        _openPage('taal-variations-page');
      });

      container.appendChild(item);
    }
  }

  // -- Bol palette list --
  const BOL_PALETTE = ['Dha','Dhin','Dhi','Ta','Na','Tin','Ti','Ge','Ke','Ka','Kat','Tu','Ga','Ghe','Te','R','x'];

  // -- Render vibhag-aware taal table into a container --
  // bolsArrayOfArrays: each element is an array of sub-bols for that matra
  // options: { editable: bool, onCellClick: fn(matraIndex), selectedMatra: number|null }
  function _renderTaalTable(containerId, taalId, bolsArrayOfArrays, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const taalDef = TAAL_DEFINITIONS[taalId];
    if (!taalDef) return;

    const { editable = false, onCellClick = null, selectedMatra = null } = options;

    let matraIndex = 0;
    for (let v = 0; v < taalDef.vibhag.length; v++) {
      const vibhagSize = taalDef.vibhag[v];
      const marker = taalDef.tpiSequence[v];

      const row = document.createElement('div');
      row.classList.add('taal-table-row');

      // Vibhag marker
      const markerEl = document.createElement('div');
      markerEl.classList.add('vibhag-marker');
      if (marker === 'X') {
        markerEl.classList.add('sam');
        markerEl.textContent = 'X';
      } else if (marker === '0') {
        markerEl.classList.add('khali');
        markerEl.textContent = '0';
      } else {
        markerEl.classList.add('tali');
        markerEl.textContent = marker;
      }
      row.appendChild(markerEl);

      // Matra cells
      for (let m = 0; m < vibhagSize; m++) {
        const idx = matraIndex;
        const cell = document.createElement('div');
        cell.classList.add('matra-cell');
        if (editable) cell.classList.add('editable');
        if (selectedMatra === idx) cell.classList.add('selected');

        // Beat type tint: first cell of Sam/Tali vibhag, ALL cells of Khali vibhag
        if (marker === 'X' && m === 0) cell.classList.add('beat-sam');
        else if (marker === '0') cell.classList.add('beat-khali');
        else if (marker !== 'X' && marker !== '0' && m === 0) cell.classList.add('beat-tali');

        // Matra number
        const numSpan = document.createElement('span');
        numSpan.classList.add('matra-num');
        numSpan.textContent = idx + 1;
        cell.appendChild(numSpan);

        // Bols display
        const bolsSpan = document.createElement('span');
        const bolArr = bolsArrayOfArrays[idx] || [''];
        bolsSpan.classList.add('matra-bols');
        if (bolArr.length >= 2) bolsSpan.classList.add(`multi-${Math.min(bolArr.length, 4)}`);
        bolsSpan.textContent = bolArr.join(' ');
        cell.appendChild(bolsSpan);

        if (editable && onCellClick) {
          cell.addEventListener('click', () => onCellClick(idx));
        }

        row.appendChild(cell);
        matraIndex++;
      }

      container.appendChild(row);
    }
  }

  // -- Currently displayed detail taal --
  let _detailTaalId = null;
  let _detailSelectedVarId = 'default';

  // -- Build the taal detail page (replaces _buildTaalVariations) --
  function _buildTaalDetail(taalId, taalName) {
    _detailTaalId = taalId;
    _detailSelectedVarId = settings.taalVariation || 'default';

    const title = document.getElementById('taal-variations-title');
    if (title) title.textContent = taalName;

    // Render the table for the currently selected variation
    _renderDetailTable(taalId, _detailSelectedVarId);

    // Build variation list
    _renderVariationList(taalId);
  }

  function _renderDetailTable(taalId, varId) {
    let bolsArr;
    if (varId === 'default') {
      const taalDef = TAAL_DEFINITIONS[taalId];
      if (!taalDef) return;
      bolsArr = _thekaToArrayFormat(taalDef.bols);
    } else {
      const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
      const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
      const variation = allVars.find(v => v.id === varId && v.taalId === taalId);
      if (variation && variation.bols) {
        bolsArr = variation.bols;
      } else {
        const taalDef = TAAL_DEFINITIONS[taalId];
        bolsArr = taalDef ? _thekaToArrayFormat(taalDef.bols) : [];
      }
    }
    _renderTaalTable('taal-detail-table', taalId, bolsArr);
  }

  function _renderVariationList(taalId) {
    const container = document.getElementById('taal-variations-container');
    if (!container) return;
    container.innerHTML = '';

    const taalDef = TAAL_DEFINITIONS[taalId];
    if (!taalDef) return;

    const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
    const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
    const forTaal = allVars.filter(v => v.taalId === taalId);

    // Default theka item
    const defaultItem = document.createElement('div');
    defaultItem.classList.add('variation-item');
    if (_detailSelectedVarId === 'default') defaultItem.classList.add('active');

    const defaultDot = document.createElement('span');
    defaultDot.style.cssText = 'margin-right:8px; color:var(--accent);';
    defaultDot.textContent = '\u25CF';

    const defaultName = document.createElement('span');
    defaultName.classList.add('var-name');
    defaultName.textContent = 'Default';

    const defaultActions = document.createElement('div');
    defaultActions.classList.add('var-actions');
    const copyDefaultBtn = document.createElement('button');
    copyDefaultBtn.className = 'btn btn-sm btn-ghost';
    copyDefaultBtn.textContent = 'Copy';
    copyDefaultBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openVarEditor(taalId, null, 'copy-default');
    });
    defaultActions.appendChild(copyDefaultBtn);

    defaultItem.appendChild(defaultDot);
    defaultItem.appendChild(defaultName);
    defaultItem.appendChild(defaultActions);
    defaultItem.addEventListener('click', () => {
      _detailSelectedVarId = 'default';
      settings.taalVariation = 'default';
      persistSettings();
      _populateVariationDropdown(taalId);
      _renderDetailTable(taalId, 'default');
      _renderVariationList(taalId);
    });
    container.appendChild(defaultItem);

    // User variations
    forTaal.forEach(v => {
      const item = document.createElement('div');
      item.classList.add('variation-item');
      if (_detailSelectedVarId === v.id) item.classList.add('active');

      const nameSpan = document.createElement('span');
      nameSpan.classList.add('var-name');
      nameSpan.textContent = v.name;

      const actions = document.createElement('div');
      actions.classList.add('var-actions');

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-ghost';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _openVarEditor(taalId, v.id, 'edit');
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-sm btn-danger';
      delBtn.textContent = '\u2715';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete variation "${v.name}"?`)) {
          const updated = allVars.filter(x => x.id !== v.id);
          localStorage.setItem(varKey, JSON.stringify(updated));
          if (settings.taalVariation === v.id) {
            settings.taalVariation = 'default';
            persistSettings();
          }
          _populateVariationDropdown(taalId);
          _renderDetailTable(taalId, _detailSelectedVarId);
          _renderVariationList(taalId);
        }
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      item.appendChild(nameSpan);
      item.appendChild(actions);

      item.addEventListener('click', () => {
        _detailSelectedVarId = v.id;
        settings.taalVariation = v.id;
        persistSettings();
        _populateVariationDropdown(taalId);
        _renderDetailTable(taalId, v.id);
        _renderVariationList(taalId);
      });

      container.appendChild(item);
    });

    // + New Variation button
    const newBtn = document.createElement('button');
    newBtn.className = 'btn btn-sm btn-primary';
    newBtn.style.cssText = 'margin-top:12px; width:100%;';
    newBtn.textContent = '+ New Variation';
    newBtn.addEventListener('click', () => {
      _openVarEditor(taalId, null, 'new');
    });
    container.appendChild(newBtn);
  }

  // ========================================================================
  // Variation Editor
  // ========================================================================
  let _editorTaalId = null;
  let _editorVarId = null; // null for new, string for existing
  let _editorBols = []; // array-of-arrays, working copy
  let _editorSelectedMatra = null;
  let _editorMode = 'new'; // 'new', 'edit', 'copy-default'

  function _openVarEditor(taalId, varId, mode) {
    _editorTaalId = taalId;
    _editorVarId = varId;
    _editorMode = mode;
    _editorSelectedMatra = null;

    const taalDef = TAAL_DEFINITIONS[taalId];
    if (!taalDef) return;

    const titleEl = document.getElementById('taal-var-editor-title');
    const nameInput = document.getElementById('var-editor-name');
    const deleteBtn = document.getElementById('btn-var-delete');

    if (mode === 'edit' && varId) {
      // Load existing variation
      const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
      const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
      const variation = allVars.find(v => v.id === varId);
      if (!variation) return;
      _editorBols = variation.bols.map(b => [...b]);
      if (titleEl) titleEl.textContent = `Editing: ${variation.name}`;
      if (nameInput) nameInput.value = variation.name;
      if (deleteBtn) deleteBtn.style.display = '';
    } else if (mode === 'copy-default') {
      // Copy from default theka
      _editorBols = _thekaToArrayFormat(taalDef.bols);
      const count = _getVariationCount(taalId);
      const autoName = `${taalDef.name} ${count + 1}`;
      if (titleEl) titleEl.textContent = `Editing: ${autoName}`;
      if (nameInput) nameInput.value = autoName;
      if (deleteBtn) deleteBtn.style.display = 'none';
      _editorVarId = null;
    } else {
      // New blank variation (start from default theka)
      _editorBols = _thekaToArrayFormat(taalDef.bols);
      const count = _getVariationCount(taalId);
      const autoName = `${taalDef.name} ${count + 1}`;
      if (titleEl) titleEl.textContent = `Editing: ${autoName}`;
      if (nameInput) nameInput.value = autoName;
      if (deleteBtn) deleteBtn.style.display = 'none';
    }

    // Render the editable table
    _renderEditorTable();

    // Render the bol palette
    _renderBolPalette();

    // Clear chips
    _renderEditorChips();

    _openPage('taal-var-editor-page');
  }

  function _getVariationCount(taalId) {
    const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
    const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
    return allVars.filter(v => v.taalId === taalId).length;
  }

  function _renderEditorTable() {
    _renderTaalTable('var-editor-table', _editorTaalId, _editorBols, {
      editable: true,
      selectedMatra: _editorSelectedMatra,
      onCellClick: (idx) => {
        _editorSelectedMatra = idx;
        _renderEditorTable();
        _renderEditorChips();
      }
    });
  }

  function _renderEditorChips() {
    const chipsContainer = document.getElementById('var-editor-chips');
    if (!chipsContainer) return;
    chipsContainer.innerHTML = '';

    if (_editorSelectedMatra === null || _editorSelectedMatra === undefined) {
      chipsContainer.innerHTML = '<span style="color:var(--text-dim); font-size:0.8rem;">Tap a matra cell above</span>';
      return;
    }

    const bolArr = _editorBols[_editorSelectedMatra] || [];
    if (bolArr.length === 0) {
      chipsContainer.innerHTML = '<span style="color:var(--text-dim); font-size:0.8rem;">Empty — tap a bol below to add</span>';
      return;
    }

    bolArr.forEach((bol, i) => {
      const chip = document.createElement('span');
      chip.classList.add('bol-chip');
      chip.innerHTML = `${bol} <span class="chip-remove">\u2715</span>`;
      chip.addEventListener('click', () => {
        _editorBols[_editorSelectedMatra].splice(i, 1);
        _renderEditorTable();
        _renderEditorChips();
      });
      chipsContainer.appendChild(chip);
    });
  }

  function _renderBolPalette() {
    const palette = document.getElementById('var-editor-palette');
    if (!palette) return;
    palette.innerHTML = '';

    BOL_PALETTE.forEach(bol => {
      const btn = document.createElement('button');
      btn.classList.add('bol-btn');
      btn.textContent = bol;
      btn.addEventListener('click', () => {
        if (_editorSelectedMatra === null || _editorSelectedMatra === undefined) return;
        if (!_editorBols[_editorSelectedMatra]) _editorBols[_editorSelectedMatra] = [];
        if (_editorBols[_editorSelectedMatra].length >= 4) return; // max 4
        _editorBols[_editorSelectedMatra].push(bol);
        _renderEditorTable();
        _renderEditorChips();
      });
      palette.appendChild(btn);
    });
  }

  // Clear matra button
  const btnClearMatra = document.getElementById('btn-var-clear-matra');
  if (btnClearMatra) {
    btnClearMatra.addEventListener('click', () => {
      if (_editorSelectedMatra === null || _editorSelectedMatra === undefined) return;
      _editorBols[_editorSelectedMatra] = [];
      _renderEditorTable();
      _renderEditorChips();
    });
  }

  // Save variation
  const btnVarSave = document.getElementById('btn-var-save');
  if (btnVarSave) {
    btnVarSave.addEventListener('click', () => {
      const nameInput = document.getElementById('var-editor-name');
      const name = nameInput ? nameInput.value.trim() : '';
      if (!name) { alert('Please enter a name.'); return; }

      const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
      const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');

      if (_editorVarId) {
        // Update existing
        const idx = allVars.findIndex(v => v.id === _editorVarId);
        if (idx >= 0) {
          allVars[idx].name = name;
          allVars[idx].bols = _editorBols.map(b => [...b]);
        }
      } else {
        // Create new
        const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        allVars.push({
          id: newId,
          taalId: _editorTaalId,
          name: name,
          bols: _editorBols.map(b => [...b]),
          createdAt: new Date().toISOString(),
          source: 'custom'
        });
        _editorVarId = newId;
      }

      localStorage.setItem(varKey, JSON.stringify(allVars));
      _populateVariationDropdown(_editorTaalId);

      // Return to detail page
      _closePage('taal-var-editor-page');
      const taalDef = TAAL_DEFINITIONS[_editorTaalId];
      _buildTaalDetail(_editorTaalId, taalDef ? taalDef.name : '');
      console.log('[UI] Saved variation:', name);
    });
  }

  // Cancel editor
  const btnVarCancel = document.getElementById('btn-var-cancel');
  const btnCancelVarEditor = document.getElementById('btn-cancel-var-editor');
  function _cancelVarEditor() {
    _closePage('taal-var-editor-page');
  }
  if (btnVarCancel) btnVarCancel.addEventListener('click', _cancelVarEditor);
  if (btnCancelVarEditor) btnCancelVarEditor.addEventListener('click', _cancelVarEditor);

  // Delete variation from editor
  const btnVarDelete = document.getElementById('btn-var-delete');
  if (btnVarDelete) {
    btnVarDelete.addEventListener('click', () => {
      if (!_editorVarId) return;
      if (!confirm('Delete this variation?')) return;
      const varKey = STORAGE_KEYS.TAAL_VARIATIONS;
      const allVars = JSON.parse(localStorage.getItem(varKey) || '[]');
      const updated = allVars.filter(v => v.id !== _editorVarId);
      localStorage.setItem(varKey, JSON.stringify(updated));
      if (settings.taalVariation === _editorVarId) {
        settings.taalVariation = 'default';
        persistSettings();
      }
      _populateVariationDropdown(_editorTaalId);
      _closePage('taal-var-editor-page');
      const taalDef = TAAL_DEFINITIONS[_editorTaalId];
      _buildTaalDetail(_editorTaalId, taalDef ? taalDef.name : '');
    });
  }

  // Preview variation (play one cycle)
  const btnVarPreview = document.getElementById('btn-var-preview');
  let _previewTimeout = null;
  if (btnVarPreview) {
    btnVarPreview.addEventListener('click', async () => {
      if (_previewTimeout) { clearTimeout(_previewTimeout); _previewTimeout = null; }
      if (!audioEngine.isInitialized) await audioEngine.init();
      await audioEngine.resume();
      await _ensureTablaMode();

      const taalDef = TAAL_DEFINITIONS[_editorTaalId];
      if (!taalDef) return;

      const bpm = settings.tempo || 80;
      const beatDuration = 60 / bpm;
      const now = audioEngine.audioCtx.currentTime;

      let time = now + 0.05; // small offset
      for (let i = 0; i < taalDef.beats; i++) {
        const bolArr = _editorBols[i] || ['x'];
        const subDuration = beatDuration / bolArr.length;
        bolArr.forEach((bol, si) => {
          if (bol && bol !== 'x') {
            const velocity = i === 0 ? 1.0 : 0.7;
            _playTablaBol(bol, time + si * subDuration, velocity, subDuration);
          }
        });
        time += beatDuration;
      }
      // Visual feedback
      btnVarPreview.textContent = 'Playing...';
      btnVarPreview.disabled = true;
      _previewTimeout = setTimeout(() => {
        btnVarPreview.textContent = 'Preview';
        btnVarPreview.disabled = false;
        _previewTimeout = null;
      }, taalDef.beats * beatDuration * 1000 + 200);
    });
  }

  // BPM Panel — click the BPM tag to open, Done to close
  const bpmTag = document.getElementById('bpm-tag');
  const bpmPanel = document.getElementById('bpm-panel');
  const bpmDoneBtn = document.getElementById('btn-done-bpm');
  const bpmSlider = document.getElementById('bpm-slider');
  const bpmDisplay = document.getElementById('bpm-display');
  const bpmTagValue = document.getElementById('bpm-tag-value');
  const bpmLayaLabel = document.getElementById('bpm-laya-label');
  const bpmMinus5 = document.getElementById('bpm-minus5');
  const bpmPlus5 = document.getElementById('bpm-plus5');

  let baseBpm = settings.tempo || 80; // base BPM before multiplier

  /** Update all BPM displays and apply to settings immediately */
  function _applyBpm(bpm) {
    bpm = Math.max(30, Math.min(500, Math.round(bpm)));
    settings.tempo = bpm;
    if (bpmSlider) bpmSlider.value = bpm;
    if (bpmDisplay) bpmDisplay.textContent = bpm;
    if (bpmTagValue) {
      bpmTagValue.textContent = bpm;
      // Highlight orange when BPM differs from the default (80)
      const defaultBpm = PRACTICE_DEFAULTS.tempo || 80;
      bpmTagValue.style.color = (bpm !== defaultBpm) ? 'var(--accent, #F5A623)' : '';
    }
    if (bpmLayaLabel) bpmLayaLabel.textContent = getLayaLabel(bpm);
    // Sync settings modal controls
    const modalSlider = document.getElementById('setting-tempo');
    const modalNum = document.getElementById('setting-tempo-num');
    if (modalSlider) modalSlider.value = bpm;
    if (modalNum) modalNum.value = bpm;
    // Apply to taal engines live if playing
    // 1. Practice session's taal engine
    import('./practice-session.js').then(mod => {
      if (mod.default && mod.default.taalEngine && mod.default.state === 'playing') {
        mod.default.taalEngine.setTempo(bpm);
      }
    }).catch(() => {});
    // 2. Standalone tabla quick-toggle taal engine
    if (tablaTaalEngine && tablaPlaying) {
      tablaTaalEngine.setTempo(bpm);
    }
    updateSettingsSummary(settings);
    persistSettings();
  }

  // Initialize display
  _applyBpm(settings.tempo);

  function _openBpmPanel() {
    baseBpm = settings.tempo;
    if (bpmSlider) bpmSlider.value = settings.tempo;
    if (bpmDisplay) bpmDisplay.textContent = settings.tempo;
    if (bpmLayaLabel) bpmLayaLabel.textContent = getLayaLabel(settings.tempo);
    _openPage('bpm-panel');
    document.querySelectorAll('.bpm-mult').forEach(b => {
      b.classList.toggle('btn-active', b.dataset.mult === '1');
    });
  }

  // Open on tempo tile click
  const tempoTile = document.getElementById('btn-open-tempo');
  if (tempoTile) {
    tempoTile.addEventListener('click', _openBpmPanel);
  }

  // Back button on tempo page
  if (bpmDoneBtn) {
    bpmDoneBtn.addEventListener('click', () => _closePage('bpm-panel'));
  }

  // Slider
  if (bpmSlider) {
    bpmSlider.addEventListener('input', () => {
      baseBpm = parseInt(bpmSlider.value, 10);
      _applyBpm(baseBpm);
      // Reset multiplier to 1x since user is manually sliding
      document.querySelectorAll('.bpm-mult').forEach(b => {
        b.classList.toggle('btn-active', b.dataset.mult === '1');
      });
    });
  }

  // -5 / +5 buttons
  if (bpmMinus5) {
    bpmMinus5.addEventListener('click', () => { baseBpm = Math.max(30, settings.tempo - 5); _applyBpm(baseBpm); });
  }
  if (bpmPlus5) {
    bpmPlus5.addEventListener('click', () => { baseBpm = Math.min(500, settings.tempo + 5); _applyBpm(baseBpm); });
  }

  // Multiplier buttons (x/4, x/2, 1x, 2x, 4x)
  document.querySelectorAll('.bpm-mult').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bpm-mult').forEach(b => b.classList.remove('btn-active'));
      btn.classList.add('btn-active');
      const mult = parseFloat(btn.dataset.mult);
      _applyBpm(baseBpm * mult);
    });
  });

  // Preset BPM buttons
  document.querySelectorAll('.bpm-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      baseBpm = parseInt(btn.dataset.bpm, 10);
      _applyBpm(baseBpm);
      document.querySelectorAll('.bpm-mult').forEach(b => {
        b.classList.toggle('btn-active', b.dataset.mult === '1');
      });
    });
  });

  // Quick Thaat selector (inline dropdown in summary bar)
  const quickThaat = document.getElementById('quick-thaat');
  if (quickThaat) {
    quickThaat.value = settings.thaat || 'bilawal';
    quickThaat.addEventListener('change', () => {
      settings.thaat = quickThaat.value;
      // Sync modal dropdown
      const modalThaat = document.getElementById('setting-thaat');
      if (modalThaat) modalThaat.value = settings.thaat;
      // Re-generate the alankaar with new thaat notes
      const alankaarNotesEl = document.getElementById('alankaar-notes');
      updateAlankaarDisplay(settings, alankaarNotesEl);
      // Update the editor preview too if it exists
      const editorPreview = document.getElementById('editor-preview-notes');
      updateAlankaarDisplay(settings, editorPreview);
      persistSettings();
      console.log('[UI] Thaat changed to:', settings.thaat);
    });
  }

  // Quick Taal selector (inline dropdown in summary bar)
  const quickTaal = document.getElementById('quick-taal');
  if (quickTaal) {
    quickTaal.value = settings.taal || 'teentaal';
    quickTaal.addEventListener('change', () => {
      settings.taal = quickTaal.value;
      settings.taalVariation = 'default';
      _populateVariationDropdown(settings.taal);
      // Sync modal dropdown
      const modalTaal = document.getElementById('setting-taal');
      if (modalTaal) modalTaal.value = settings.taal;
      // Rebuild beat grid
      renderBeatGrid(settings.taal);
      persistSettings();
      console.log('[UI] Taal changed to:', settings.taal);
    });
  }

  // Old taal editor removed — replaced by the new variation editor above.
  // Settings button now opens the settings-page (handled in tileActions above).

  // ========================================================================
  // 3a. Key (Scale) Dropdown
  // ========================================================================
  const keySelect = document.getElementById('setting-key');
  if (keySelect) {
    keySelect.value = settings.key;

    keySelect.addEventListener('change', () => {
      settings.key = keySelect.value;
      const freq = KEY_FREQUENCIES[settings.key];
      if (freq !== undefined) settings.baseSaFreq = freq;
      updateSettingsSummary(settings);
      persistSettings();
    });
  }

  // (Saptak is now handled by the inline dropdown in section 1 above)

  // ========================================================================
  // 3c. Tempo — Slider + Number Input + Presets + Laya Badge
  // ========================================================================
  const tempoSlider  = document.getElementById('setting-tempo');
  const tempoNum     = document.getElementById('setting-tempo-num');
  const layaBadge    = document.getElementById('laya-badge');

  /** Sync all tempo UI elements and update settings */
  function updateTempo(bpm) {
    bpm = Math.max(30, Math.min(500, bpm));
    settings.tempo = bpm;
    if (tempoSlider) tempoSlider.value = bpm;
    if (tempoNum)    tempoNum.value = bpm;
    if (layaBadge)   layaBadge.innerHTML = `<span class="tag-label">Laya</span> ${getLayaLabel(bpm)}`;

    // Highlight matching preset button
    document.querySelectorAll('.tempo-preset').forEach(btn => {
      btn.classList.toggle('btn-active', parseInt(btn.dataset.bpm, 10) === bpm);
    });

    updateSettingsSummary(settings);
    persistSettings();
  }

  if (tempoSlider) {
    tempoSlider.value = settings.tempo;
    tempoSlider.addEventListener('input', () => updateTempo(parseInt(tempoSlider.value, 10)));
  }

  if (tempoNum) {
    tempoNum.value = settings.tempo;
    tempoNum.addEventListener('change', () => updateTempo(parseInt(tempoNum.value, 10) || 100));
  }

  // BPM preset buttons
  document.querySelectorAll('.tempo-preset').forEach(btn => {
    btn.addEventListener('click', () => updateTempo(parseInt(btn.dataset.bpm, 10)));
  });

  // Initialize laya badge
  if (layaBadge) layaBadge.innerHTML = `<span class="tag-label">Laya</span> ${getLayaLabel(settings.tempo)}`;

  // ========================================================================
  // 3d. Thaat Dropdown
  // ========================================================================
  const thaatSelect = document.getElementById('setting-thaat');
  if (thaatSelect) {
    thaatSelect.value = settings.thaat;

    thaatSelect.addEventListener('change', () => {
      settings.thaat = thaatSelect.value;
      // Sync quick-thaat dropdown
      const qt = document.getElementById('quick-thaat');
      if (qt) qt.value = settings.thaat;
      // Update alankaar display with new thaat notes
      const alankaarNotesEl = document.getElementById('alankaar-notes');
      updateAlankaarDisplay(settings, alankaarNotesEl);
      updateSettingsSummary(settings);
      persistSettings();
    });
  }

  // ========================================================================
  // 3e. Taal Dropdown
  // ========================================================================
  const taalSelect = document.getElementById('setting-taal');
  if (taalSelect) {
    taalSelect.value = settings.taal;

    taalSelect.addEventListener('change', () => {
      settings.taal = taalSelect.value;
      settings.taalVariation = 'default';
      _populateVariationDropdown(settings.taal);
      updateSettingsSummary(settings);
      renderBeatGrid(settings.taal);
      persistSettings();
    });
  }

  // ========================================================================
  // 4. Taal Search Filter
  // ========================================================================
  const taalSearch = document.getElementById('taal-search');
  if (taalSearch && taalSelect) {
    taalSearch.addEventListener('input', () => {
      filterTaalDropdown(taalSearch.value, taalSelect);
    });
  }

  // ========================================================================
  // 5a. Laykari Buttons
  // ========================================================================
  const laykariButtons = document.querySelectorAll('[data-laykari]');
  if (laykariButtons.length) {
    // Set initial active state.
    laykariButtons.forEach((btn) => {
      if (btn.dataset.laykari === settings.laykari) {
        btn.classList.add('btn-active');
      }
    });

    laykariButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleButtonGroup(laykariButtons, btn);
        settings.laykari = btn.dataset.laykari;
        persistSettings();
      });
    });
  }

  // ========================================================================
  // 5b. Notation Buttons
  // ========================================================================
  const notationButtons = document.querySelectorAll('[data-notation]');
  if (notationButtons.length) {
    notationButtons.forEach((btn) => {
      if (btn.dataset.notation === settings.notation) {
        btn.classList.add('btn-active');
      }
    });

    notationButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleButtonGroup(notationButtons, btn);
        settings.notation = btn.dataset.notation;
        persistSettings();
      });
    });
  }

  // ========================================================================
  // 6. Tanpura Controls
  // ========================================================================

  // 6a. String pattern buttons (Pa / Ma / Ni)
  const stringButtons = document.querySelectorAll('[data-tanpura-pattern]');
  if (stringButtons.length) {
    stringButtons.forEach((btn) => {
      if (btn.dataset.tanpuraPattern === settings.tanpuraPattern) {
        btn.classList.add('btn-active');
      }
    });

    stringButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleButtonGroup(stringButtons, btn);
        settings.tanpuraPattern = btn.dataset.tanpuraPattern;
        persistSettings();
      });
    });
  }

  // 6b. Octave buttons (Low / Med / High)
  const octaveButtons = document.querySelectorAll('[data-tanpura-octave]');
  if (octaveButtons.length) {
    octaveButtons.forEach((btn) => {
      if (btn.dataset.tanpuraOctave === settings.tanpuraOctave) {
        btn.classList.add('btn-active');
      }
    });

    octaveButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleButtonGroup(octaveButtons, btn);
        settings.tanpuraOctave = btn.dataset.tanpuraOctave;
        persistSettings();
      });
    });
  }

  // 6c. Speed slider
  const speedSlider  = document.getElementById('tanpura-speed');
  const speedDisplay = document.getElementById('tanpura-speed-val');
  if (speedSlider) {
    speedSlider.value = settings.tanpuraSpeed;
    if (speedDisplay) speedDisplay.textContent = `${settings.tanpuraSpeed}%`;

    speedSlider.addEventListener('input', () => {
      settings.tanpuraSpeed = parseInt(speedSlider.value, 10);
      if (speedDisplay) speedDisplay.textContent = `${settings.tanpuraSpeed}%`;
      // Update tanpura live if playing
      import('./tanpura.js').then(mod => {
        if (mod.default && mod.default.isPlaying) {
          mod.default.updateConfig({ speed: settings.tanpuraSpeed });
        }
      }).catch(() => {});
      persistSettings();
    });
  }

  // 6d/6e. Variance + Reverb sliders (Volume A/B removed — replaced by
  // the overall-volume knob on the main page plus the Balance slider under
  // Concert Mode).
  _bindAdvancedSlider('tanpura-variance',  'tanpura-variance-value',  'tanpuraVariance',  (v) => parseInt(v, 10),   (v) => `${v} ct`);
  _bindAdvancedSlider('tanpura-reverb',    'tanpura-reverb-value',    'tanpuraReverb',    (v) => parseInt(v, 10),   (v) => `${v}%`);

  // ========================================================================
  // 6b. Tanpura quick controls (always visible — overall volume + mute)
  // ========================================================================
  const tanpuraVolSlider  = document.getElementById('tanpura-vol');
  const tanpuraVolDisplay = document.getElementById('tanpura-vol-val');
  const tanpuraMuteBtn    = document.getElementById('btn-tanpura-mute');
  let tanpuraMuted = false;
  let tanpuraPreMuteVol = settings.tanpuraVolumeOverall ?? 60;

  const pushOverallVolume = async (val) => {
    // Prefer the controller path — it applies the headroom ceiling so the
    // tanpura can sit loud enough alongside the tabla bus (which bypasses
    // reverb). Fall back to a direct audio-engine call while the module
    // is still loading.
    const t = await (async () => {
      if (tanpura) return tanpura;
      try { const m = await import('./tanpura.js'); tanpura = m.default; return tanpura; } catch { return null; }
    })();
    if (t) {
      t.setVolume(val);
    } else if (audioEngine.isInitialized) {
      audioEngine.setTanpuraBusVolume((val / 100) * 1.5);
    }
  };

  if (tanpuraVolSlider) {
    const initial = settings.tanpuraVolumeOverall ?? 60;
    tanpuraVolSlider.value = initial;
    if (tanpuraVolDisplay) tanpuraVolDisplay.textContent = `${initial}%`;

    tanpuraVolSlider.addEventListener('input', () => {
      const val = parseInt(tanpuraVolSlider.value, 10);
      settings.tanpuraVolumeOverall = val;
      if (tanpuraVolDisplay) tanpuraVolDisplay.textContent = `${val}%`;
      pushOverallVolume(val);
      if (val > 0) { tanpuraMuted = false; tanpuraMuteBtn.textContent = '\u{1F50A}'; tanpuraMuteBtn.classList.remove('muted'); }
      persistSettings();
    });
  }

  if (tanpuraMuteBtn) {
    tanpuraMuteBtn.addEventListener('click', () => {
      tanpuraMuted = !tanpuraMuted;
      if (tanpuraMuted) {
        tanpuraPreMuteVol = settings.tanpuraVolumeOverall ?? 60;
        tanpuraVolSlider.value = 0;
        settings.tanpuraVolumeOverall = 0;
        if (tanpuraVolDisplay) tanpuraVolDisplay.textContent = '0%';
        tanpuraMuteBtn.textContent = '\u{1F507}';
        tanpuraMuteBtn.classList.add('muted');
      } else {
        tanpuraVolSlider.value = tanpuraPreMuteVol;
        settings.tanpuraVolumeOverall = tanpuraPreMuteVol;
        if (tanpuraVolDisplay) tanpuraVolDisplay.textContent = `${tanpuraPreMuteVol}%`;
        tanpuraMuteBtn.textContent = '\u{1F50A}';
        tanpuraMuteBtn.classList.remove('muted');
      }
      pushOverallVolume(settings.tanpuraVolumeOverall);
      persistSettings();
    });
  }

  // ========================================================================
  // 6h. Tanpura engine (sound source) selection + pattern buttons + live jivari
  // ========================================================================
  const tanpuraEngineSelect = document.getElementById('tanpura-engine-select');
  const tanpuraEngineHint = document.getElementById('tanpura-engine-hint');
  const tanpuraStringButtons = document.querySelectorAll('.tanpura-string');
  const tanpuraTuningLabel = document.getElementById('tanpura-tuning-label');
  const patternLabelMap = { pa: 'P,-S-S-S,', ma: 'm,-S-S-S,', ni: 'N,-S-S-S,' };
  const engineHintMap = {
    electronic: 'Synthesized drone with harmonic-count jivari.',
    sample:     'Real recorded tanpura with layered resonant jivari. Ni-Sa not yet available for this source.',
  };

  const applyCapabilitiesToPatternButtons = (supportedPatterns) => {
    tanpuraStringButtons.forEach(btn => {
      const p = btn.dataset.string;
      const supported = supportedPatterns.includes(p);
      btn.disabled = !supported;
      btn.classList.toggle('btn-disabled', !supported);
      if (!supported) {
        btn.title = 'Not available for the selected sound source';
        btn.style.opacity = '0.45';
        btn.style.cursor = 'not-allowed';
      } else {
        btn.title = '';
        btn.style.opacity = '';
        btn.style.cursor = '';
      }
    });
  };

  const updateEngineHint = (engineId) => {
    if (tanpuraEngineHint) tanpuraEngineHint.textContent = engineHintMap[engineId] || '';
  };

  const withTanpura = async () => {
    if (tanpura) return tanpura;
    try {
      const mod = await import('./tanpura.js');
      tanpura = mod.default;
      return tanpura;
    } catch (e) {
      console.error('[UI] tanpura load failed:', e);
      return null;
    }
  };

  // Pattern buttons (.tanpura-string) — initial state + click handlers.
  if (tanpuraStringButtons.length) {
    tanpuraStringButtons.forEach(btn => {
      btn.classList.toggle('btn-active', btn.dataset.string === settings.tanpuraPattern);
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        toggleButtonGroup(tanpuraStringButtons, btn);
        const p = btn.dataset.string;
        settings.tanpuraPattern = p;
        if (tanpuraTuningLabel) tanpuraTuningLabel.textContent = patternLabelMap[p] || '';
        updateSettingsSummary(settings);
        persistSettings();
        const t = await withTanpura();
        if (t) t.updateConfig({ pattern: p });
      });
    });
    if (tanpuraTuningLabel) {
      tanpuraTuningLabel.textContent = patternLabelMap[settings.tanpuraPattern] || '';
    }
  }

  // Engine dropdown (async — waits for tanpura module to load).
  (async () => {
    const t = await withTanpura();
    if (!t || !tanpuraEngineSelect) return;

    tanpuraEngineSelect.innerHTML = '';
    for (const info of t.listEngines()) {
      const opt = document.createElement('option');
      opt.value = info.id;
      opt.textContent = info.label;
      tanpuraEngineSelect.appendChild(opt);
    }
    tanpuraEngineSelect.value = settings.tanpuraEngine || 'electronic';

    // Attach engine-change listener before triggering the initial sync.
    t.onEngineChange(({ toId, supportedPatterns, coercedPattern }) => {
      applyCapabilitiesToPatternButtons(supportedPatterns);
      updateEngineHint(toId);
      if (settings.tanpuraPattern !== coercedPattern) {
        settings.tanpuraPattern = coercedPattern;
        tanpuraStringButtons.forEach(btn => btn.classList.toggle('btn-active', btn.dataset.string === coercedPattern));
        if (tanpuraTuningLabel) tanpuraTuningLabel.textContent = patternLabelMap[coercedPattern] || '';
        updateSettingsSummary(settings);
        persistSettings();
      }
    });

    // Initial engine sync (quiet, no crossfade since nothing is playing yet).
    try { await t.setEngine(tanpuraEngineSelect.value); } catch (e) { console.error('[UI] initial setEngine:', e); }
    const initialCaps = t.getCapabilities(tanpuraEngineSelect.value);
    if (initialCaps) applyCapabilitiesToPatternButtons(initialCaps.patterns);
    updateEngineHint(tanpuraEngineSelect.value);

    // Push persisted settings into the controller so state is consistent
    // with what the UI displays before the user presses Play.
    t.updateConfig({
      pattern: settings.tanpuraPattern || 'pa',
      octave: settings.tanpuraOctave || settings.saptak || 'MEDIUM',
      speed: settings.tanpuraSpeed ?? 30,
      variance: settings.tanpuraVariance ?? 3,
      reverb: settings.tanpuraReverb ?? 40,
      jivariA: settings.tanpuraJivariA ?? settings.tanpuraJivari ?? 65,
      jivariB: settings.tanpuraJivariB ?? settings.tanpuraJivari ?? 60,
    });
    t.setBalance(settings.tanpuraBalance ?? 50);
    t.setVolume(settings.tanpuraVolumeOverall ?? settings.tanpuraVolumeA ?? 60);
    try { await t.setConcertMode(!!settings.tanpuraConcertMode); } catch (e) { console.error('[UI] setConcertMode init:', e); }

    tanpuraEngineSelect.addEventListener('change', async () => {
      const id = tanpuraEngineSelect.value;
      settings.tanpuraEngine = id;
      persistSettings();
      try { await t.setEngine(id); } catch (e) { console.error('[UI] setEngine failed:', e); }
    });
  })();

  // ----- Jivari A (always visible) -----
  const jivariSlider  = document.getElementById('tanpura-jivari');
  const jivariDisplay = document.getElementById('tanpura-jivari-val');
  if (jivariSlider) {
    const initial = settings.tanpuraJivariA ?? settings.tanpuraJivari ?? 65;
    jivariSlider.value = initial;
    if (jivariDisplay) jivariDisplay.textContent = `${initial}%`;
    jivariSlider.addEventListener('input', async () => {
      const v = parseInt(jivariSlider.value, 10);
      settings.tanpuraJivariA = v;
      if (jivariDisplay) jivariDisplay.textContent = `${v}%`;
      const t = await withTanpura();
      if (t) t.setJivari(v, 'A');
      persistSettings();
    });
  }

  // ----- Jivari B (concert mode only) -----
  const jivariBSlider    = document.getElementById('tanpura-jivari-b');
  const jivariBDisplay   = document.getElementById('tanpura-jivari-b-val');
  const jivariBContainer = document.getElementById('tanpura-jivari-b-container');
  if (jivariBSlider) {
    const initial = settings.tanpuraJivariB ?? 60;
    jivariBSlider.value = initial;
    if (jivariBDisplay) jivariBDisplay.textContent = `${initial}%`;
    jivariBSlider.addEventListener('input', async () => {
      const v = parseInt(jivariBSlider.value, 10);
      settings.tanpuraJivariB = v;
      if (jivariBDisplay) jivariBDisplay.textContent = `${v}%`;
      const t = await withTanpura();
      if (t) t.setJivari(v, 'B');
      persistSettings();
    });
  }

  // ----- Balance slider (concert mode only) -----
  const balanceSlider    = document.getElementById('tanpura-balance');
  const balanceDisplay   = document.getElementById('tanpura-balance-val');
  const balanceContainer = document.getElementById('tanpura-balance-container');
  if (balanceSlider) {
    const initial = settings.tanpuraBalance ?? 50;
    balanceSlider.value = initial;
    if (balanceDisplay) balanceDisplay.textContent = `${initial}%`;
    balanceSlider.addEventListener('input', async () => {
      const v = parseInt(balanceSlider.value, 10);
      settings.tanpuraBalance = v;
      if (balanceDisplay) balanceDisplay.textContent = `${v}%`;
      if (audioEngine.isInitialized) audioEngine.setTanpuraBalance(v);
      const t = await withTanpura();
      if (t) t.setBalance(v);
      persistSettings();
    });
  }

  // ----- Concert mode toggle -----
  const concertToggle = document.getElementById('toggle-concert');
  const syncConcertUI = (on) => {
    if (balanceContainer) balanceContainer.classList.toggle('hidden', !on);
    if (jivariBContainer) jivariBContainer.classList.toggle('hidden', !on);
    const label = document.getElementById('tanpura-jivari-label');
    if (label) label.textContent = on ? 'Jivari\u00A0A' : 'Jivari';
  };
  if (concertToggle) {
    const initialOn = !!settings.tanpuraConcertMode;
    concertToggle.checked = initialOn;
    syncConcertUI(initialOn);

    concertToggle.addEventListener('change', async () => {
      const on = concertToggle.checked;
      settings.tanpuraConcertMode = on;
      syncConcertUI(on);
      if (audioEngine.isInitialized) audioEngine.setTanpuraPan(on, 0.7);
      const t = await withTanpura();
      if (t) {
        await t.setConcertMode(on);
      }
      persistSettings();
    });
  }

  // ========================================================================
  // 7. Tabla Controls
  // ========================================================================

  // 7a. Tabla quick controls (always visible — volume + mute)
  const tablaVolSlider  = document.getElementById('tabla-vol');
  const tablaVolDisplay = document.getElementById('tabla-vol-val');
  const tablaMuteBtn    = document.getElementById('btn-tabla-mute');
  let tablaMuted = false;
  let tablaPreMuteVol = settings.tablaVolume;

  if (tablaVolSlider) {
    tablaVolSlider.value = settings.tablaVolume;
    if (tablaVolDisplay) tablaVolDisplay.textContent = `${settings.tablaVolume}%`;

    tablaVolSlider.addEventListener('input', () => {
      const val = parseInt(tablaVolSlider.value, 10);
      settings.tablaVolume = val;
      if (tablaVolDisplay) tablaVolDisplay.textContent = `${val}%`;
      if (audioEngine.isInitialized) audioEngine.setTablaVolume(val / 100);
      if (val > 0) { tablaMuted = false; tablaMuteBtn.textContent = '\u{1F50A}'; tablaMuteBtn.classList.remove('muted'); }
      persistSettings();
    });
  }

  if (tablaMuteBtn) {
    tablaMuteBtn.addEventListener('click', () => {
      tablaMuted = !tablaMuted;
      if (tablaMuted) {
        tablaPreMuteVol = settings.tablaVolume;
        tablaVolSlider.value = 0;
        settings.tablaVolume = 0;
        if (tablaVolDisplay) tablaVolDisplay.textContent = '0%';
        tablaMuteBtn.textContent = '\u{1F507}';
        tablaMuteBtn.classList.add('muted');
      } else {
        tablaVolSlider.value = tablaPreMuteVol;
        settings.tablaVolume = tablaPreMuteVol;
        if (tablaVolDisplay) tablaVolDisplay.textContent = `${tablaPreMuteVol}%`;
        tablaMuteBtn.textContent = '\u{1F50A}';
        tablaMuteBtn.classList.remove('muted');
      }
      if (audioEngine.isInitialized) audioEngine.setTablaVolume(settings.tablaVolume / 100);
      persistSettings();
    });
  }

  // 7b. Tabla bass EQ
  const bassSlider  = document.getElementById('tabla-bass');
  const bassDisplay = document.getElementById('tabla-bass-val');
  if (bassSlider) {
    bassSlider.value = settings.tablaBassEQ;
    if (bassDisplay) bassDisplay.textContent = formatEQ(settings.tablaBassEQ);

    bassSlider.addEventListener('input', () => {
      settings.tablaBassEQ = parseInt(bassSlider.value, 10);
      if (bassDisplay) bassDisplay.textContent = formatEQ(settings.tablaBassEQ);
      if (audioEngine.isInitialized) audioEngine.setTablaBassEQ(settings.tablaBassEQ);
      persistSettings();
    });
  }

  // 7c. Tabla treble EQ
  const trebleSlider  = document.getElementById('tabla-treble');
  const trebleDisplay = document.getElementById('tabla-treble-val');
  if (trebleSlider) {
    trebleSlider.value = settings.tablaTrebleEQ;
    if (trebleDisplay) trebleDisplay.textContent = formatEQ(settings.tablaTrebleEQ);

    trebleSlider.addEventListener('input', () => {
      settings.tablaTrebleEQ = parseInt(trebleSlider.value, 10);
      if (trebleDisplay) trebleDisplay.textContent = formatEQ(settings.tablaTrebleEQ);
      if (audioEngine.isInitialized) audioEngine.setTablaTrebleEQ(settings.tablaTrebleEQ);
      persistSettings();
    });
  }

  // ========================================================================
  // 8. Swar Voice Controls — dynamic instrument list with add/delete
  // ========================================================================

  const BUILT_IN_INSTRUMENTS = [
    { key: 'harmonium', name: 'Harmonium' },
    { key: 'strings', name: 'Strings' },
    { key: 'guitar', name: 'Acoustic Guitar' },
    { key: 'piano', name: 'Piano' },
  ];

  if (!settings.swarVoiceVolumes) settings.swarVoiceVolumes = {};
  if (!settings.customInstruments) settings.customInstruments = [];
  // customInstruments: [{ key, name, url, varName }]

  /**
   * Rebuilds the entire instrument list UI from built-in + custom instruments.
   * Wires up all checkboxes, sliders, and delete buttons.
   */
  function _buildInstrumentList() {
    const container = document.getElementById('swar-voice-list');
    if (!container) return;
    container.innerHTML = '';

    const savedVoices = Array.isArray(settings.swarVoice)
      ? settings.swarVoice
      : [settings.swarVoice || 'harmonium'];

    const deletedBuiltIns = settings.deletedBuiltIns || [];
    const allInstruments = [
      ...BUILT_IN_INSTRUMENTS.filter(b => !deletedBuiltIns.includes(b.key)),
      ...(settings.customInstruments || []),
    ];

    for (const inst of allInstruments) {
      const isBuiltIn = BUILT_IN_INSTRUMENTS.some(b => b.key === inst.key);
      const isChecked = savedVoices.includes(inst.key);
      const vol = settings.swarVoiceVolumes[inst.key] ?? 100;

      const row = document.createElement('div');
      row.className = 'swar-voice-item';
      row.dataset.voice = inst.key;
      row.style.cssText = 'display:flex; align-items:center; gap:8px;';

      // Checkbox
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'swar-voice-cb';
      cb.value = inst.key;
      cb.checked = isChecked;

      // Name
      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'min-width:100px; color:var(--text-primary); font-size:0.85rem; flex-shrink:0;';
      nameSpan.textContent = inst.name;

      // Volume slider
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'swar-voice-vol';
      slider.dataset.voice = inst.key;
      slider.min = '0';
      slider.max = '100';
      slider.value = vol;
      slider.style.cssText = 'flex:1; max-width:100px;';
      if (!isChecked) slider.classList.add('swar-slider-inactive');

      // Volume display
      const volSpan = document.createElement('span');
      volSpan.className = 'swar-voice-vol-val';
      volSpan.dataset.voice = inst.key;
      volSpan.style.cssText = 'min-width:28px; text-align:right; font-size:0.7rem; color:var(--text-secondary);';
      volSpan.textContent = vol + '%';

      row.appendChild(cb);
      row.appendChild(nameSpan);
      row.appendChild(slider);
      row.appendChild(volSpan);

      // Delete button — all instruments except Harmonium (the mandatory default)
      if (inst.key !== 'harmonium') {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm';
        delBtn.style.cssText = 'padding:2px 6px; font-size:0.75rem; color:var(--error,#E74C3C); min-width:auto;';
        delBtn.textContent = '✕';
        delBtn.title = `Delete ${inst.name}`;
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(`Delete "${inst.name}"? This cannot be undone.`)) return;
          // Remove from custom instruments list if it's a custom one
          settings.customInstruments = (settings.customInstruments || []).filter(c => c.key !== inst.key);
          // Remove from built-in tracking if it was a built-in being removed
          // (built-ins other than harmonium can be hidden via deletedBuiltIns)
          if (isBuiltIn) {
            if (!settings.deletedBuiltIns) settings.deletedBuiltIns = [];
            if (!settings.deletedBuiltIns.includes(inst.key)) settings.deletedBuiltIns.push(inst.key);
          }
          // Remove from swarVoice if selected
          const voices = Array.isArray(settings.swarVoice) ? settings.swarVoice : [settings.swarVoice];
          settings.swarVoice = voices.filter(v => v !== inst.key);
          if (settings.swarVoice.length === 0) settings.swarVoice = 'harmonium';
          else if (settings.swarVoice.length === 1) settings.swarVoice = settings.swarVoice[0];
          delete settings.swarVoiceVolumes[inst.key];
          persistSettings();
          // Remove from synth
          import('./swar-synth.js').then(mod => {
            if (mod.default && mod.default.presets) {
              delete mod.default.presets[inst.key];
              delete mod.default.voiceVolumes[inst.key];
              if (mod.default.activeVoices && mod.default.activeVoices.includes(inst.key)) {
                mod.default.activeVoices = mod.default.activeVoices.filter(v => v !== inst.key);
                if (mod.default.activeVoices.length === 0) mod.default.activeVoices = ['harmonium'];
              }
            }
          }).catch(() => {});
          _buildInstrumentList();
        });
        row.appendChild(delBtn);
      }

      // Wire checkbox
      cb.addEventListener('change', () => {
        _onInstrumentCheckboxChange();
        slider.classList.toggle('swar-slider-inactive', !cb.checked);
      });

      // Wire slider
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value, 10);
        volSpan.textContent = v + '%';
        settings.swarVoiceVolumes[inst.key] = v;
        import('./swar-synth.js').then(mod => {
          if (mod.default && mod.default._initialized) mod.default.setVoiceVolume(inst.key, v);
        }).catch(() => {});
        persistSettings();
      });

      container.appendChild(row);
    }
  }

  function _onInstrumentCheckboxChange() {
    const cbs = document.querySelectorAll('.swar-voice-cb');
    const selected = [];
    cbs.forEach(c => { if (c.checked) selected.push(c.value); });
    // Ensure at least one
    if (selected.length === 0) {
      const first = document.querySelector('.swar-voice-cb');
      if (first) { first.checked = true; selected.push(first.value); }
    }
    settings.swarVoice = selected.length === 1 ? selected[0] : selected;
    import('./swar-synth.js').then(mod => {
      if (mod.default && mod.default._initialized) mod.default.setVoice(selected);
    }).catch(() => {});
    persistSettings();
  }

  /**
   * Loads all saved custom instruments into the swar synth.
   * Call after swarSynth.init() wherever the synth is initialized.
   */
  async function _loadCustomInstrumentsIntoSynth(synth) {
    if (!synth || !synth.player || !settings.customInstruments) return;
    for (const inst of settings.customInstruments) {
      if (synth.presets[inst.key]) continue; // already loaded
      try {
        const resp = await fetch(inst.url);
        if (!resp.ok) continue;
        const js = await resp.text();
        const vm = js.match(/var\s+(_tone_\w+|_drum_\w+)/);
        if (!vm) continue;
        const sc = document.createElement('script');
        sc.textContent = js;
        document.head.appendChild(sc);
        const preset = window[vm[1]];
        if (!preset) continue;
        if (audioEngine.audioCtx) {
          synth.player.adjustPreset(audioEngine.audioCtx, preset);
          await synth._waitForBuffers(preset);
        }
        synth.presets[inst.key] = preset;
        console.log(`[UI] Loaded custom instrument "${inst.name}" into synth`);
      } catch (err) {
        console.warn(`[UI] Failed to load custom instrument "${inst.name}":`, err.message);
      }
    }
  }

  function _applySwarVoiceVolumes() {
    import('./swar-synth.js').then(mod => {
      if (mod.default && mod.default._initialized) {
        for (const [voice, vol] of Object.entries(settings.swarVoiceVolumes)) {
          mod.default.setVoiceVolume(voice, vol);
        }
      }
    }).catch(() => {});
  }

  // Build the list on init
  _buildInstrumentList();
  _applySwarVoiceVolumes();

  // -- Add Custom Instrument button --
  const btnAddInstrument = document.getElementById('btn-add-instrument');
  if (btnAddInstrument) {
    btnAddInstrument.addEventListener('click', async () => {
      const urlInput = document.getElementById('custom-instrument-url');
      const nameInput = document.getElementById('custom-instrument-name');
      const errorEl = document.getElementById('custom-instrument-error');
      const url = urlInput?.value.trim();
      const name = nameInput?.value.trim();

      if (!url) { errorEl.textContent = 'Please enter a URL.'; errorEl.style.display = ''; return; }
      if (!name) { errorEl.textContent = 'Please enter a name.'; errorEl.style.display = ''; return; }
      if (!url.endsWith('.js')) { errorEl.textContent = 'URL must end with .js'; errorEl.style.display = ''; return; }

      errorEl.style.display = 'none';
      btnAddInstrument.textContent = 'Loading...';
      btnAddInstrument.disabled = true;

      try {
        // Init synth if needed
        if (!audioEngine.isInitialized) await audioEngine.init();
        await audioEngine.resume();
        const swarSynthMod = await import('./swar-synth.js');
        const swarSynth = swarSynthMod.default;
        await swarSynth.init();

        // Load custom preset via script tag (global scope so var lands on window)
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
        const jsCode = await response.text();
        const varMatch = jsCode.match(/var\s+(_tone_\w+|_drum_\w+)/);
        if (!varMatch) throw new Error('No WebAudioFont preset variable found in the file.');
        const varName = varMatch[1];
        // Inject as script tag to execute in global scope
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.textContent = jsCode;
          script.onload = resolve;
          document.head.appendChild(script);
          resolve(); // script.textContent executes synchronously
        });
        const preset = window[varName];
        if (!preset) throw new Error(`Preset variable ${varName} not found after loading.`);
        const key = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        if (audioEngine.audioCtx) {
          swarSynth.player.adjustPreset(audioEngine.audioCtx, preset);
          await swarSynth._waitForBuffers(preset);
        }
        swarSynth.presets[key] = preset;
        const result = { varName, key, name };

        // Save to settings
        settings.customInstruments.push({
          key: result.key,
          name: name,
          url: url,
          varName: result.varName,
        });
        persistSettings();

        // Rebuild list
        _buildInstrumentList();

        // Clear inputs
        urlInput.value = '';
        nameInput.value = '';
        console.log(`[UI] Custom instrument "${name}" added`);
      } catch (err) {
        errorEl.textContent = 'Failed: ' + err.message;
        errorEl.style.display = '';
        console.error('[UI] Add instrument failed:', err);
      } finally {
        btnAddInstrument.textContent = 'Add Instrument';
        btnAddInstrument.disabled = false;
      }
    });
  }

  // Load saved custom instruments into swar synth on init (if synth is already ready)
  if (settings.customInstruments && settings.customInstruments.length > 0) {
    import('./swar-synth.js').then(async (mod) => {
      const synth = mod.default;
      if (!synth._initialized || !synth.player) return;
      await _loadCustomInstrumentsIntoSynth(synth);
    }).catch(() => {});
  }

  // 8a. Swar quick controls (always visible — volume + mute)
  const swarVolSlider  = document.getElementById('swar-vol');
  const swarVolDisplay = document.getElementById('swar-vol-val');
  const swarMuteBtn    = document.getElementById('btn-swar-mute');
  let swarMuted = false;
  let swarPreMuteVol = settings.swarVolume;

  if (swarVolSlider) {
    swarVolSlider.value = settings.swarVolume;
    if (swarVolDisplay) swarVolDisplay.textContent = `${settings.swarVolume}%`;

    swarVolSlider.addEventListener('input', () => {
      const val = parseInt(swarVolSlider.value, 10);
      settings.swarVolume = val;
      if (swarVolDisplay) swarVolDisplay.textContent = `${val}%`;
      if (audioEngine.isInitialized) audioEngine.setSwarVolume(val / 100);
      if (val > 0) { swarMuted = false; swarMuteBtn.textContent = '\u{1F50A}'; swarMuteBtn.classList.remove('muted'); }
      persistSettings();
    });
  }

  if (swarMuteBtn) {
    swarMuteBtn.addEventListener('click', () => {
      swarMuted = !swarMuted;
      if (swarMuted) {
        swarPreMuteVol = settings.swarVolume;
        swarVolSlider.value = 0;
        settings.swarVolume = 0;
        if (swarVolDisplay) swarVolDisplay.textContent = '0%';
        swarMuteBtn.textContent = '\u{1F507}';
        swarMuteBtn.classList.add('muted');
      } else {
        swarVolSlider.value = swarPreMuteVol;
        settings.swarVolume = swarPreMuteVol;
        if (swarVolDisplay) swarVolDisplay.textContent = `${swarPreMuteVol}%`;
        swarMuteBtn.textContent = '\u{1F50A}';
        swarMuteBtn.classList.remove('muted');
      }
      if (audioEngine.isInitialized) audioEngine.setSwarVolume(settings.swarVolume / 100);
      persistSettings();
    });
  }

  // ========================================================================
  // 9. Transport Controls — wired to PracticeSession for real audio
  // ========================================================================
  const btnStart = document.getElementById('btn-start');
  const btnPause = document.getElementById('btn-pause');
  const btnStop  = document.getElementById('btn-stop');
  const timerEl  = document.getElementById('timer-display');

  // practiceSession is imported at the top of this module (static import)

  /**
   * Set transport button states and visual feedback.
   * @param {'idle'|'playing'|'paused'} state
   */
  function setTransportState(state) {
    switch (state) {
      case 'idle':
        if (btnStart) { btnStart.disabled = false; btnStart.textContent = '▶ Start'; }
        if (btnPause) { btnPause.disabled = true; }
        if (btnStop)  { btnStop.disabled  = true; }
        break;
      case 'playing':
        if (btnStart) { btnStart.disabled = true; }
        if (btnPause) { btnPause.disabled = false; }
        if (btnStop)  { btnStop.disabled  = false; }
        break;
      case 'paused':
        if (btnStart) { btnStart.disabled = false; btnStart.textContent = '▶ Resume'; }
        if (btnPause) { btnPause.disabled = true; }
        if (btnStop)  { btnStop.disabled  = false; }
        break;
    }
  }

  setTransportState('idle');
  let transportState = 'idle';

  // Target display — reads from profile.getTargetFor().dailyMinutes so the
  // main page mirrors what the user sets on the Profile page. Uses the
  // module-scoped `_refreshTargetDisplay` so the Profile page can call it
  // after committing a target change.
  _refreshTargetDisplay();

  // Completed-time ticker — shows today's accumulated practice minutes.
  // Drives off the practice-tracker (works for both free-practice and
  // exercise-player playback). Also shown static at app-load so the user
  // can see the day's progress before pressing Start.
  let timerInterval = null;
  function _renderTimer() {
    if (!timerEl) return;
    const summary = practiceTracker.getSummary();
    const sec = summary.todayExerciseSec || 0;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const target = profile.getTargetFor().dailyMinutes || 0;
    timerEl.textContent = `${m}:${String(s).padStart(2, '0')} / ${target}:00`;
  }
  function startTimerDisplay() {
    _renderTimer(); // immediate tick
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(_renderTimer, 2000);
  }
  function stopTimerDisplay() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    _renderTimer(); // final tick so the displayed value reflects the flush
  }
  _renderTimer(); // show today's carried-over progress immediately on page load

  // Beat highlight callback — highlights current beat cell in the grid
  function onBeatUpdate(beatInfo) {
    // Play tabla bol — use active variation bols instead of default theka
    if (practiceSession) {
      const activeBols = _getActiveBols(settings.taal);
      const bolsForMatra = activeBols[beatInfo.matraIndex] || (beatInfo.bol ? [beatInfo.bol] : ['x']);
      const beatDuration = practiceSession.taalEngine
        ? practiceSession.taalEngine.getBeatDuration()
        : 0.75;
      const subDuration = beatDuration / bolsForMatra.length;
      bolsForMatra.forEach((subBol, i) => {
        if (subBol && subBol !== 'x') {
          _playTablaBol(subBol, beatInfo.time + i * subDuration, beatInfo.velocity, subDuration);
        }
      });
    }
    // Remove current highlight from all cells
    document.querySelectorAll('.beat-cell.current').forEach(c => c.classList.remove('current'));
    // Add highlight to the current matra cell
    const cells = document.querySelectorAll('.beat-cell');
    if (cells[beatInfo.matraIndex]) {
      cells[beatInfo.matraIndex].classList.add('current');
    }
  }

  if (btnStart) {
    btnStart.addEventListener('click', async () => {
      // If an exercise is loaded, start it from main screen (don't open player page)
      if (settings.currentExerciseId) {
        // Load exercise if not already loaded
        if (!_exLoadedExercise || _exLoadedExercise.id !== settings.currentExerciseId) {
          const exercises = _getExercises();
          const ex = exercises.find(e => e.id === settings.currentExerciseId);
          if (ex) {
            _exLoadedExercise = ex;
            _exCurrentSection = 'aroha';
            _exCurrentCycleIdx = 0;
            _exCurrentBeatIdx = -1;
            _exIsUserTurn = false;
            _exPhraseCounter = 0;
            settings.taal = ex.taalId;
            const td = TAAL_DEFINITIONS[ex.taalId];
            const taalDisp = document.getElementById('taal-display');
            if (taalDisp && td) taalDisp.textContent = td.name;
            persistSettings();
          }
        }
        // Trigger the exercise start button (it handles all audio setup)
        const btnExStart = document.getElementById('btn-ex-start');
        if (btnExStart && !btnExStart.disabled) btnExStart.click();
        transportState = 'playing';
        setTransportState('playing');
        return;
      }

      // Free practice mode (no exercise loaded)
      console.log('[transport] Start clicked. State:', transportState, 'Session:', !!practiceSession);

      if (transportState === 'idle') {
        try {
          // Stop the quick-toggle tabla if it's running
          if (tablaPlaying && tablaTaalEngine) {
            tablaTaalEngine.stop();
            tablaPlaying = false;
            backgroundAudio.deactivate('tabla-quick');
            if (btnTablaQuickToggle) {
              btnTablaQuickToggle.innerHTML = '<span style="font-size:1.1rem;">▶</span>';
              btnTablaQuickToggle.style.background = 'transparent';
              btnTablaQuickToggle.style.color = 'var(--accent)';
            }
          }
          await _ensureTablaMode();
          await _startTanpura();
          practiceSession.configure(settings);
          practiceSession.onBeat = onBeatUpdate;
          await practiceSession.start();
          practiceTracker.startExercise();
          backgroundAudio.activate('free-practice');
          transportState = 'playing';
          setTransportState('playing');
          startTimerDisplay();
        } catch (err) {
          console.error('[transport] Start failed:', err, err.stack);
        }
      } else if (transportState === 'paused') {
        if (settings.currentExerciseId) {
          const btnExStart = document.getElementById('btn-ex-start');
          if (btnExStart) btnExStart.click();
        } else {
          practiceSession.resume();
          if (tanpura && typeof tanpura.resume === 'function') tanpura.resume();
          _syncTanpuraButtons();
          practiceTracker.resumeExercise();
          backgroundAudio.activate('free-practice');
        }
        transportState = 'playing';
        setTransportState('playing');
        startTimerDisplay();
      }
    });
  }

  if (btnPause) {
    btnPause.addEventListener('click', () => {
      if (transportState === 'playing') {
        if (settings.currentExerciseId) {
          const btnExPause = document.getElementById('btn-ex-pause');
          if (btnExPause && !btnExPause.disabled) btnExPause.click();
        } else if (practiceSession) {
          practiceSession.pause();
          if (tanpura && typeof tanpura.pause === 'function') tanpura.pause();
          practiceTracker.pauseExercise();
          backgroundAudio.deactivate('free-practice');
        }
        transportState = 'paused';
        setTransportState('paused');
        stopTimerDisplay();
      }
    });
  }

  if (btnStop) {
    btnStop.addEventListener('click', () => {
      if (transportState === 'playing' || transportState === 'paused') {
        if (settings.currentExerciseId) {
          const btnExStop = document.getElementById('btn-ex-stop');
          if (btnExStop && !btnExStop.disabled) btnExStop.click();
        } else if (practiceSession) {
          const stats = practiceSession.stop();
          _stopTanpura();
          practiceTracker.endExercise();
          backgroundAudio.deactivate('free-practice');
          document.querySelectorAll('.beat-cell.current').forEach(c => c.classList.remove('current'));
          console.log('[transport] Session stopped:', stats);
        }
        transportState = 'idle';
        setTransportState('idle');
        stopTimerDisplay();
      }
    });
  }

  // ========================================================================
  // 10. Initial Beat Grid Render
  // ========================================================================
  if (settings.taal) {
    renderBeatGrid(settings.taal);
  }

  // ========================================================================
  // 11. Lesson Display + Alankaar Editor (full page)
  // ========================================================================
  const lessonDisplay    = document.getElementById('lesson-display');
  const editorPage       = document.getElementById('alankaar-editor-page');
  const alankaarNotes    = document.getElementById('alankaar-notes');
  const editorPreview    = document.getElementById('editor-preview-notes');
  const lessonNameEl     = document.getElementById('lesson-name');
  const btnDoneAlankaar  = document.getElementById('btn-done-alankaar');

  // Default alankaar: full scale in current thaat
  if (!settings.currentAlankaar) {
    settings.currentAlankaar = 'scale';
    settings.currentAlankaarLabel = 'Full Scale';
  }
  updateAlankaarDisplay(settings, alankaarNotes);
  if (lessonNameEl) lessonNameEl.textContent = settings.currentAlankaarLabel || 'Full Scale';

  // Click lesson display → open full-page editor
  if (lessonDisplay && editorPage) {
    lessonDisplay.addEventListener('click', () => {
      editorPage.classList.remove('hidden');
      // Also update the preview in the editor
      updateAlankaarDisplay(settings, editorPreview);
    });
  }

  // Done button → close editor page, return to main screen
  if (btnDoneAlankaar && editorPage) {
    btnDoneAlankaar.addEventListener('click', () => {
      editorPage.classList.add('hidden');
    });
  }

  // Tab switching in alankaar editor
  document.querySelectorAll('.alankaar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.alankaar-tab').forEach(t => t.classList.remove('btn-active'));
      tab.classList.add('btn-active');
      const targetTab = tab.dataset.tab;
      document.querySelectorAll('.alankaar-tab-content').forEach(content => {
        content.classList.toggle('hidden', content.id !== `tab-${targetTab}`);
      });
    });
  });

  // Preset alankaar selection
  document.querySelectorAll('.alankaar-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.alankaar-preset').forEach(b => b.classList.remove('btn-active'));
      btn.classList.add('btn-active');

      const pattern = btn.dataset.pattern;
      settings.currentAlankaar = pattern;
      settings.currentAlankaarLabel = btn.textContent.split('—')[0].trim();

      // Update both the editor preview and the main screen display
      updateAlankaarDisplay(settings, alankaarNotes);
      updateAlankaarDisplay(settings, editorPreview);
      if (lessonNameEl) lessonNameEl.textContent = settings.currentAlankaarLabel;
      persistSettings();
    });
  });

  // Generate alankaar from pattern input
  const patternInput = document.getElementById('alankaar-pattern-input');
  const btnGenerate  = document.getElementById('btn-generate-alankaar');
  if (btnGenerate && patternInput) {
    btnGenerate.addEventListener('click', () => {
      const pattern = patternInput.value.trim();
      if (pattern) {
        settings.currentAlankaar = pattern;
        settings.currentAlankaarLabel = `Custom: ${pattern}`;
        updateAlankaarDisplay(settings, alankaarNotes);
        updateAlankaarDisplay(settings, editorPreview);
        if (lessonNameEl) lessonNameEl.textContent = settings.currentAlankaarLabel;
        persistSettings();
      }
    });
  }

  // ========================================================================
  // 12. Custom Alankaar Editor (beat-by-beat in the Lesson Editor)
  // ========================================================================

  let customLaykari = 1; // notes per beat (1=ekgun, 2=dugun, etc.)

  // Laykari buttons for custom tab
  document.querySelectorAll('.custom-laykari-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.custom-laykari-btn').forEach(b => b.classList.remove('btn-active'));
      btn.classList.add('btn-active');
      customLaykari = parseInt(btn.dataset.laykari, 10);
      _buildCustomGrid();
    });
  });

  // Swara names for dropdown options (positions 1-15, thaat-aware)
  function _getSwaraOptions() {
    const thaat = settings.thaat || 'bilawal';
    const options = [];
    for (let pos = 1; pos <= 15; pos++) {
      const label = getPositionLabel(pos, thaat, 'english');
      options.push({ pos, label });
    }
    return options;
  }

  /**
   * Build the custom taal grid — one cycle of the current taal.
   * Each matra gets `customLaykari` note slots (dropdowns).
   */
  function _buildCustomGrid() {
    const gridEl = document.getElementById('custom-taal-grid');
    if (!gridEl) return;

    const taalId = settings.taal || 'teentaal';
    const taalDef = TAAL_DEFINITIONS[taalId];
    if (!taalDef) return;

    const swaraOptions = _getSwaraOptions();
    gridEl.innerHTML = '';

    // Create a table
    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse; width:100%; font-size:0.8rem;';

    // Header row: vibhag markers
    const headerRow = document.createElement('tr');
    let matraIdx = 0;
    for (let v = 0; v < taalDef.vibhag.length; v++) {
      const vibSize = taalDef.vibhag[v];
      const marker = taalDef.tpiSequence ? taalDef.tpiSequence[v] : '';
      for (let m = 0; m < vibSize; m++) {
        const th = document.createElement('th');
        th.style.cssText = 'padding:4px 2px; text-align:center; font-size:0.65rem; color:var(--text-dim);';
        if (m === 0) {
          th.textContent = marker === 'X' ? 'X(Sam)' : marker === '0' ? '0' : marker;
          th.style.color = marker === 'X' ? 'var(--accent)' : marker === '0' ? 'var(--khali)' : 'var(--tali)';
        }
        headerRow.appendChild(th);
        matraIdx++;
      }
      // Vibhag separator
      if (v < taalDef.vibhag.length - 1) {
        const sep = document.createElement('th');
        sep.style.cssText = 'width:3px; background:var(--border);';
        headerRow.appendChild(sep);
      }
    }
    table.appendChild(headerRow);

    // Matra number row
    const numRow = document.createElement('tr');
    matraIdx = 0;
    for (let v = 0; v < taalDef.vibhag.length; v++) {
      for (let m = 0; m < taalDef.vibhag[v]; m++) {
        const td = document.createElement('td');
        td.style.cssText = 'padding:2px; text-align:center; font-size:0.7rem; color:var(--text-dim);';
        td.textContent = matraIdx + 1;
        numRow.appendChild(td);
        matraIdx++;
      }
      if (v < taalDef.vibhag.length - 1) {
        const sep = document.createElement('td');
        sep.style.cssText = 'width:3px; background:var(--border);';
        numRow.appendChild(sep);
      }
    }
    table.appendChild(numRow);

    // Bol row
    const bolRow = document.createElement('tr');
    matraIdx = 0;
    for (let v = 0; v < taalDef.vibhag.length; v++) {
      for (let m = 0; m < taalDef.vibhag[v]; m++) {
        const td = document.createElement('td');
        td.style.cssText = 'padding:2px; text-align:center; font-size:0.7rem; color:var(--text-secondary);';
        td.textContent = taalDef.bols[matraIdx] || '';
        bolRow.appendChild(td);
        matraIdx++;
      }
      if (v < taalDef.vibhag.length - 1) {
        const sep = document.createElement('td');
        sep.style.cssText = 'width:3px; background:var(--border);';
        bolRow.appendChild(sep);
      }
    }
    table.appendChild(bolRow);

    // Note input rows — one row per sub-beat (laykari)
    for (let sub = 0; sub < customLaykari; sub++) {
      const noteRow = document.createElement('tr');
      matraIdx = 0;
      for (let v = 0; v < taalDef.vibhag.length; v++) {
        for (let m = 0; m < taalDef.vibhag[v]; m++) {
          const td = document.createElement('td');
          td.style.cssText = 'padding:2px;';

          const select = document.createElement('select');
          select.className = 'custom-note-select';
          select.dataset.matra = matraIdx;
          select.dataset.sub = sub;
          select.style.cssText = 'width:100%; padding:3px 1px; font-size:0.75rem; background:var(--bg-tertiary); color:var(--text-primary); border:1px solid var(--border); border-radius:4px; min-width:38px;';

          // Empty option (no note)
          const emptyOpt = document.createElement('option');
          emptyOpt.value = '';
          emptyOpt.textContent = '—';
          select.appendChild(emptyOpt);

          // Swara options
          swaraOptions.forEach(({ pos, label }) => {
            const opt = document.createElement('option');
            opt.value = pos;
            opt.textContent = label;
            select.appendChild(opt);
          });

          td.appendChild(select);
          noteRow.appendChild(td);
          matraIdx++;
        }
        if (v < taalDef.vibhag.length - 1) {
          const sep = document.createElement('td');
          sep.style.cssText = 'width:3px; background:var(--border);';
          noteRow.appendChild(sep);
        }
      }
      table.appendChild(noteRow);
    }

    gridEl.appendChild(table);

    // Hide result on rebuild
    const resultEl = document.getElementById('custom-result');
    if (resultEl) resultEl.classList.add('hidden');
  }

  // Build grid when Custom tab is first shown
  document.querySelectorAll('.alankaar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab === 'custom') {
        _buildCustomGrid();
      }
    });
  });

  // Detect Pattern & Generate
  const btnCustomDetect = document.getElementById('btn-custom-detect');
  if (btnCustomDetect) {
    btnCustomDetect.addEventListener('click', () => {
      const taalDef = TAAL_DEFINITIONS[settings.taal || 'teentaal'];
      if (!taalDef) return;

      // Read all note positions from the grid
      const allNotes = []; // flat array of position numbers
      const selects = document.querySelectorAll('.custom-note-select');
      const notesPerMatra = {};

      selects.forEach(sel => {
        const matra = parseInt(sel.dataset.matra, 10);
        const sub = parseInt(sel.dataset.sub, 10);
        const val = sel.value ? parseInt(sel.value, 10) : null;
        if (!notesPerMatra[matra]) notesPerMatra[matra] = [];
        notesPerMatra[matra][sub] = val;
      });

      // Flatten to a sequence of positions (skip nulls)
      for (let m = 0; m < taalDef.beats; m++) {
        const subs = notesPerMatra[m] || [];
        for (let s = 0; s < customLaykari; s++) {
          if (subs[s] !== null && subs[s] !== undefined) {
            allNotes.push(subs[s]);
          }
        }
      }

      if (allNotes.length < 2) {
        alert('Please enter at least 2 notes to detect a pattern.');
        return;
      }

      // Detect the pattern: compute the relative offsets between consecutive groups
      // Look for a repeating offset pattern
      const offsets = [];
      for (let i = 1; i < allNotes.length; i++) {
        offsets.push(allNotes[i] - allNotes[0 + (i % allNotes.length === 0 ? 0 : 0)]);
      }

      // Try to find the group size by detecting when the pattern repeats
      // Simple approach: the first group is allNotes, compute offsets within it
      // Then check if shifting by 1 reproduces the next group
      let groupSize = allNotes.length;
      let patternOffsets = allNotes.map(n => n - allNotes[0]);

      // Check if there's a repeating sub-pattern
      for (let gs = 2; gs <= Math.floor(allNotes.length / 2); gs++) {
        const candidate = allNotes.slice(0, gs).map(n => n - allNotes[0]);
        let isRepeating = true;
        for (let g = 1; g < Math.floor(allNotes.length / gs); g++) {
          const groupStart = allNotes[g * gs];
          const expected = allNotes[0] + g; // shift by 1 per group
          for (let i = 0; i < gs; i++) {
            const actual = allNotes[g * gs + i];
            const expectedNote = expected + candidate[i];
            if (actual !== undefined && actual !== expectedNote) {
              isRepeating = false;
              break;
            }
          }
          if (!isRepeating) break;
        }
        if (isRepeating && Math.floor(allNotes.length / gs) >= 2) {
          groupSize = gs;
          patternOffsets = candidate;
          break;
        }
      }

      // Display detected pattern
      const patternStr = patternOffsets.map((o, i) => i === 0 ? 'n' : (o >= 0 ? `n+${o}` : `n${o}`)).join(', ');

      const patternDisplay = document.getElementById('custom-pattern-display');
      if (patternDisplay) {
        patternDisplay.textContent = `[${patternStr}] (group of ${groupSize} notes)`;
      }

      // Generate full aroha + avaroha using alankaar-engine
      try {
        const { parsePattern: pp, generateAlankaar: ga, getAlankaarDisplayText: gdt } =
          /* dynamic import would be ideal but we already have them */
          { parsePattern: null, generateAlankaar: null, getAlankaarDisplayText: null };
      } catch(e) {}

      // Use the offsets directly to build aroha (positions 1→15) and avaroha (reverse)
      const arohaGroups = [];
      for (let start = 1; start <= 15; start++) {
        const group = patternOffsets.map(o => start + o);
        if (group.every(p => p >= 1 && p <= 15)) {
          arohaGroups.push(group);
        }
      }

      // Avaroha: reverse the pattern offsets, go from high to low
      const reverseOffsets = [...patternOffsets].reverse().map(o => -o + patternOffsets[patternOffsets.length - 1]);
      // Normalize so first offset is 0
      const firstReverse = reverseOffsets[0];
      const avarohaOffsets = reverseOffsets.map(o => o - firstReverse);

      const avarohaGroups = [];
      const highestPos = arohaGroups.length > 0 ? Math.max(...arohaGroups[arohaGroups.length - 1]) : 15;
      for (let start = highestPos; start >= 1; start--) {
        const group = avarohaOffsets.map(o => start + o);
        if (group.every(p => p >= 1 && p <= 15)) {
          avarohaGroups.push(group);
        }
      }

      // Convert positions to labels
      const thaat = settings.thaat || 'bilawal';
      const arohaText = arohaGroups.map(g => g.map(p => getPositionLabel(p, thaat, 'english')).join(' ')).join(' | ');
      const avarohaText = avarohaGroups.map(g => g.map(p => getPositionLabel(p, thaat, 'english')).join(' ')).join(' | ');

      const fullDisplay = document.getElementById('custom-full-display');
      if (fullDisplay) {
        fullDisplay.innerHTML = `<div style="margin-bottom:4px;"><span style="color:var(--text-dim); font-size:0.7rem;">Aroha</span> ${arohaText}</div><div><span style="color:var(--text-dim); font-size:0.7rem;">Avaroha</span> ${avarohaText}</div>`;
      }

      // Show result
      const resultEl = document.getElementById('custom-result');
      if (resultEl) resultEl.classList.remove('hidden');

      // Store for Apply
      gridEl = document.getElementById('custom-taal-grid');
      if (gridEl) {
        gridEl._detectedPattern = patternStr;
        gridEl._arohaGroups = arohaGroups;
        gridEl._avarohaGroups = avarohaGroups;
      }
    });
  }

  // Clear custom grid
  const btnCustomClear = document.getElementById('btn-custom-clear');
  if (btnCustomClear) {
    btnCustomClear.addEventListener('click', () => {
      document.querySelectorAll('.custom-note-select').forEach(sel => { sel.value = ''; });
      const resultEl = document.getElementById('custom-result');
      if (resultEl) resultEl.classList.add('hidden');
    });
  }

  // Apply custom alankaar
  const btnCustomApply = document.getElementById('btn-custom-apply');
  if (btnCustomApply) {
    btnCustomApply.addEventListener('click', () => {
      const gridEl = document.getElementById('custom-taal-grid');
      const pattern = gridEl?._detectedPattern;
      if (!pattern) return;

      settings.currentAlankaar = pattern;
      settings.currentAlankaarLabel = `Custom: [${pattern}]`;
      const alankaarNotesEl = document.getElementById('alankaar-notes');
      updateAlankaarDisplay(settings, alankaarNotesEl);
      const editorPreview = document.getElementById('editor-preview-notes');
      updateAlankaarDisplay(settings, editorPreview);
      const lessonNameEl = document.getElementById('lesson-name');
      if (lessonNameEl) lessonNameEl.textContent = settings.currentAlankaarLabel;
      persistSettings();

      // Close editor
      const editorPage = document.getElementById('alankaar-editor-page');
      if (editorPage) editorPage.classList.add('hidden');
    });
  }

  // ========================================================================
  // 13. EXERCISE SYSTEM — Library, Designer, Player
  // ========================================================================

  // Module-scope exercise state
  let _exEditingId = null;          // exercise ID being edited in designer, or null for new
  let _exDesignerGenerated = null;  // last generated compact pattern data { parsed, generated, taalId, rangeStart, rangeEnd }
  let _exSelectedLevel = 'beginner';
  let _exMode = 'demo';            // exercise player mode: 'demo', 'practice', or 'test'
  let _exPlaying = false;           // is exercise player running?
  let _exCurrentSection = 'aroha';  // 'aroha' or 'avaroha'
  let _exCurrentCycleIdx = 0;       // index into aroha/avaroha cycles
  let _exCurrentBeatIdx = -1;       // current beat being played
  let _exLoadedExercise = null;     // full exercise object loaded for playback
  let _exIsUserTurn = false;        // for practice mode alternation
  let _exPhraseCounter = 0;         // counts phrases for practice mode alternation

  // Show/hide main mode bar based on whether an exercise is loaded
  function _syncMainModeBar() {
    const bar = document.getElementById('main-mode-bar');
    if (bar) bar.style.display = settings.currentExerciseId ? '' : 'none';
    // Sync mode button active state
    document.querySelectorAll('.main-mode-btn').forEach(b => {
      b.classList.toggle('btn-active', b.dataset.mode === _exMode);
    });
  }

  // Initialize exercise display from saved settings
  if (settings.currentExerciseId) {
    const exercises = JSON.parse(localStorage.getItem(STORAGE_KEYS.EXERCISES) || '[]');
    const ex = exercises.find(e => e.id === settings.currentExerciseId);
    const display = document.getElementById('exercise-display');
    if (display) display.textContent = ex ? ex.name : 'None';
  }
  _syncMainModeBar();

  // ---------------------------------------------------------------------------
  // Exercise Table Renderer
  // ---------------------------------------------------------------------------

  /**
   * Render a vibhag-aware taal table showing swara labels instead of bol names.
   * @param {HTMLElement} container - DOM element to render into
   * @param {string} taalId - Taal definition ID
   * @param {Array<{positions: number[]}>} beatsData - Array of beat data, one per matra
   * @param {Object} [opts] - Options
   * @param {string} [opts.thaat] - Thaat for swara resolution
   * @param {string} [opts.cellIdPrefix] - Prefix for cell IDs (for player highlighting)
   */
  function _renderExerciseTaalTable(container, taalId, beatsData, opts = {}) {
    if (!container) return;
    container.innerHTML = '';

    const taalDef = TAAL_DEFINITIONS[taalId];
    if (!taalDef) return;

    const thaat = opts.thaat || settings.thaat || 'bilawal';
    const notation = 'english';
    const cellIdPrefix = opts.cellIdPrefix || '';

    let matraIndex = 0;
    for (let v = 0; v < taalDef.vibhag.length; v++) {
      const vibhagSize = taalDef.vibhag[v];
      const marker = taalDef.tpiSequence[v];

      const row = document.createElement('div');
      row.classList.add('taal-table-row');

      // Vibhag marker
      const markerEl = document.createElement('div');
      markerEl.classList.add('vibhag-marker');
      if (marker === 'X') {
        markerEl.classList.add('sam');
        markerEl.textContent = 'X';
      } else if (marker === '0') {
        markerEl.classList.add('khali');
        markerEl.textContent = '0';
      } else {
        markerEl.classList.add('tali');
        markerEl.textContent = marker;
      }
      row.appendChild(markerEl);

      // Matra cells
      for (let m = 0; m < vibhagSize; m++) {
        const idx = matraIndex;
        const cell = document.createElement('div');
        cell.classList.add('matra-cell');
        if (cellIdPrefix) cell.id = `${cellIdPrefix}-${idx}`;

        // Beat type tint: first cell of Sam/Tali vibhag, ALL cells of Khali vibhag
        if (marker === 'X' && m === 0) cell.classList.add('beat-sam');
        else if (marker === '0') cell.classList.add('beat-khali');
        else if (marker !== 'X' && marker !== '0' && m === 0) cell.classList.add('beat-tali');

        // Matra number
        const numSpan = document.createElement('span');
        numSpan.classList.add('matra-num');
        numSpan.textContent = idx + 1;
        cell.appendChild(numSpan);

        // Swara labels
        const bolsSpan = document.createElement('span');
        bolsSpan.classList.add('matra-bols');
        const beat = beatsData[idx];
        if (beat && beat.positions) {
          const labels = beat.positions
            .map(p => {
              if (p === '_') return '—';  // tie/sustain symbol
              if (p != null) return getPositionLabel(p, thaat, notation);
              return '-';
            })
            .join(' ');
          if (beat.positions.length >= 2) bolsSpan.classList.add(`multi-${Math.min(beat.positions.length, 4)}`);
          bolsSpan.textContent = labels;
          // Dim the cell if ALL positions are ties
          if (beat.positions.every(p => p === '_')) {
            cell.style.opacity = '0.5';
          }
        } else {
          bolsSpan.textContent = '-';
        }
        cell.appendChild(bolsSpan);

        row.appendChild(cell);
        matraIndex++;
      }

      container.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Exercise Library
  // ---------------------------------------------------------------------------

  function _getExercises() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.EXERCISES) || '[]');
  }

  function _saveExercises(exercises) {
    localStorage.setItem(STORAGE_KEYS.EXERCISES, JSON.stringify(exercises));
  }

  // -----------------------------------------------------------------------
  // Exercise naming convention: <taalId>_<b|i|a><n>
  //   taalId  = canonical key from TAAL_DEFINITIONS (e.g. 'teentaal')
  //   level   = beginner→b, intermediate→i, advanced→a
  //   n       = (max existing number in this taal+level) + 1
  // -----------------------------------------------------------------------
  const LEVEL_CODES = { beginner: 'b', intermediate: 'i', advanced: 'a' };

  function _levelCode(level) {
    return LEVEL_CODES[level] || 'b';
  }

  function _nextExerciseNumber(taalId, level) {
    const prefix = `${taalId}_${_levelCode(level)}`;
    const re = new RegExp(`^${prefix}(\\d+)$`);
    const numbers = _getExercises()
      .map(e => re.exec(e.name || ''))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10));
    return (numbers.length ? Math.max(...numbers) : 0) + 1;
  }

  function _makeExerciseName(taalId, level) {
    return `${taalId}_${_levelCode(level)}${_nextExerciseNumber(taalId, level)}`;
  }

  /**
   * One-time rename of saved exercises to the new short naming convention.
   * Groups by (taalId, level), sorts each group by createdAt, and assigns
   * sequential numbers. Idempotent — safe to run on every app load; it is
   * a no-op once every exercise already matches `^<taalId>_<b|i|a>\d+$`.
   */
  function _migrateExerciseNames() {
    const exercises = _getExercises();
    if (!exercises.length) return;

    const groups = {};
    for (const ex of exercises) {
      const key = `${ex.taalId}_${_levelCode(ex.competency)}`;
      (groups[key] = groups[key] || []).push(ex);
    }

    let changed = false;
    for (const [prefix, list] of Object.entries(groups)) {
      list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      list.forEach((ex, idx) => {
        const expected = `${prefix}${idx + 1}`;
        if (ex.name !== expected) {
          ex.name = expected;
          changed = true;
        }
      });
    }

    if (changed) {
      _saveExercises(exercises);
      console.log('[UI] Migrated exercise names to <taalId>_<b|i|a><n> convention');
    }
  }
  _migrateExerciseNames();

  // Persisted across re-renders so user-toggled groups stay the way they
  // were when an exercise is edited or deleted.
  const _exListOpenGroups = new Set();
  const LEVEL_SORT_ORDER = { beginner: 0, intermediate: 1, advanced: 2 };

  function _buildExerciseList() {
    const container = document.getElementById('exercise-list-container');
    if (!container) return;

    // Capture any currently-open groups before wiping the DOM.
    container.querySelectorAll('details.exercise-group[open]').forEach(d => {
      if (d.dataset.taalId) _exListOpenGroups.add(d.dataset.taalId);
    });

    container.innerHTML = '';

    const exercises = _getExercises();
    if (exercises.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim); font-size:0.85rem; text-align:center; padding:16px;">No exercises yet. Tap "+ New Exercise" to create one.</p>';
      return;
    }

    // Group by taal.
    const groups = {};
    for (const ex of exercises) {
      (groups[ex.taalId] = groups[ex.taalId] || []).push(ex);
    }

    // Sort each group: level (b→i→a), then trailing number.
    for (const list of Object.values(groups)) {
      list.sort((a, b) => {
        const la = LEVEL_SORT_ORDER[a.competency] ?? 9;
        const lb = LEVEL_SORT_ORDER[b.competency] ?? 9;
        if (la !== lb) return la - lb;
        const na = parseInt((/(\d+)$/.exec(a.name || '') || [0, 0])[1], 10);
        const nb = parseInt((/(\d+)$/.exec(b.name || '') || [0, 0])[1], 10);
        return na - nb;
      });
    }

    // Render groups in TAAL_DEFINITIONS order; append any unknown taals at the end.
    const orderedTaalIds = [
      ...Object.keys(TAAL_DEFINITIONS).filter(id => groups[id]),
      ...Object.keys(groups).filter(id => !TAAL_DEFINITIONS[id]),
    ];

    for (const taalId of orderedTaalIds) {
      const list = groups[taalId];
      const taalDef = TAAL_DEFINITIONS[taalId];
      const taalName = taalDef ? taalDef.name : taalId;

      const hasActive = list.some(ex => ex.id === settings.currentExerciseId);
      const isOpen = _exListOpenGroups.has(taalId) || hasActive;

      const group = document.createElement('details');
      group.className = 'exercise-group';
      group.dataset.taalId = taalId;
      if (isOpen) group.open = true;

      group.innerHTML = `
        <summary class="exercise-group-header" style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; cursor:pointer; user-select:none; background:var(--bg-secondary); border-radius:8px; margin-top:8px;">
          <span style="font-size:0.95rem; font-weight:600;">${taalName}</span>
          <span style="font-size:0.8rem; color:var(--text-dim); background:var(--bg-tertiary); padding:2px 8px; border-radius:10px;">${list.length}</span>
        </summary>
        <div class="exercise-group-body" style="padding-top:4px;"></div>
      `;
      const body = group.querySelector('.exercise-group-body');

      // Track open-state persistence.
      group.addEventListener('toggle', () => {
        if (group.open) _exListOpenGroups.add(taalId);
        else _exListOpenGroups.delete(taalId);
      });

      for (const ex of list) {
        const item = document.createElement('div');
        item.classList.add('exercise-item');
        if (settings.currentExerciseId === ex.id) item.classList.add('active');

        item.innerHTML = `
          <div class="ex-info">
            <div class="ex-name">${ex.name || 'Unnamed'}</div>
            <div class="ex-meta">${ex.patternType || 'custom'} · ${ex.competency || 'beginner'}</div>
          </div>
          <div class="ex-actions">
            <button class="btn btn-sm btn-ghost ex-edit-btn" title="Edit">Edit</button>
            <button class="btn btn-sm btn-ghost ex-delete-btn" title="Delete" style="color:var(--error);">Del</button>
          </div>
        `;

        item.querySelector('.ex-info').addEventListener('click', () => {
          settings.currentExerciseId = ex.id;
          const display = document.getElementById('exercise-display');
          if (display) display.textContent = ex.name || 'Exercise';
          persistSettings();
          _syncMainModeBar();
          _closePage('exercise-library-page');
        });

        item.querySelector('.ex-edit-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          _openExerciseEdit(ex.id);
          _openPage('exercise-edit-page');
        });

        item.querySelector('.ex-delete-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`Delete exercise "${ex.name}"?`)) {
            const all = _getExercises().filter(x => x.id !== ex.id);
            _saveExercises(all);
            if (settings.currentExerciseId === ex.id) {
              settings.currentExerciseId = null;
              const display = document.getElementById('exercise-display');
              if (display) display.textContent = 'None';
              persistSettings();
            }
            _buildExerciseList();
          }
        });

        body.appendChild(item);
      }

      container.appendChild(group);
    }
  }

  // New Exercise button
  const btnNewExercise = document.getElementById('btn-new-exercise');
  if (btnNewExercise) {
    btnNewExercise.addEventListener('click', () => {
      _closePage('exercise-library-page');
      _openExerciseDesigner(null);
    });
  }

  // Clear Exercise button
  const btnClearExercise = document.getElementById('btn-clear-exercise');
  if (btnClearExercise) {
    btnClearExercise.addEventListener('click', () => {
      settings.currentExerciseId = null;
      _exLoadedExercise = null;
      const display = document.getElementById('exercise-display');
      if (display) display.textContent = 'None';
      persistSettings();
      _syncMainModeBar();
      _closePage('exercise-library-page');
    });
  }

  // ---------------------------------------------------------------------------
  // Exercise: Shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Update the pattern help text for a given taal with dynamic examples.
   * @param {string} taalId - Taal ID from TAAL_DEFINITIONS
   * @param {string} helpElementId - DOM ID of the help paragraph element
   */
  function _updatePatternHelp(taalId, helpElementId) {
    const el = document.getElementById(helpElementId);
    if (!el) return;
    const taalDef = TAAL_DEFINITIONS[taalId];
    if (!taalDef) return;
    const vibhagStr = taalDef.vibhag.join('+');
    // Build an example where each vibhag gets ascending digits starting from its index + 1
    const example1 = taalDef.vibhag.map((size, vi) => {
      const start = vi + 1;
      return Array.from({length: size}, (_, i) => start + i).join('');
    }).join(' ');
    el.innerHTML = `Digits 1-9 for notes, <strong>.</strong> for rest, <strong>space</strong> separates vibhags, <strong>[...]</strong> for multiple notes per beat.<br>` +
      `${taalDef.name} has ${taalDef.beats} beats (${vibhagStr}).<br>` +
      `Example: <code style="color:var(--accent);">${example1}</code>`;
  }

  /**
   * Detect laykari label from beat structure.
   * If all entries are 1 -> ekgun, all 2 -> dugun, all 3 -> tigun, all 4 -> chaugun, else mixed.
   */
  function _detectLaykari(beatStructure) {
    if (!beatStructure || beatStructure.length === 0) return 'ekgun';
    const unique = new Set(beatStructure);
    if (unique.size === 1) {
      const val = beatStructure[0];
      if (val === 1) return 'ekgun';
      if (val === 2) return 'dugun';
      if (val === 3) return 'tigun';
      if (val === 4) return 'chaugun';
    }
    return 'mixed';
  }

  /**
   * Render exercise preview tables for aroha and avaroha cycles.
   * Works for both designer and edit page by finding containers dynamically.
   * @param {string} taalId - Taal ID
   * @param {Object} generated - Output from generateFromCompactPattern
   * @param {string} [prefix] - Container prefix: '' for designer, 'ex-edit-' for edit page
   */
  function _renderExercisePreview(taalId, generated, prefix = '') {
    const arohaContainer = document.getElementById(prefix ? `${prefix}preview-aroha` : 'ex-preview-aroha');
    const avarohaContainer = document.getElementById(prefix ? `${prefix}preview-avaroha` : 'ex-preview-avaroha');

    if (arohaContainer) {
      arohaContainer.innerHTML = '';
      generated.arohaCycles.forEach((cycle, i) => {
        const label = document.createElement('div');
        label.className = 'ex-cycle-label';
        label.textContent = `Cycle ${i + 1}`;
        arohaContainer.appendChild(label);
        const tableDiv = document.createElement('div');
        tableDiv.style.marginBottom = '8px';
        arohaContainer.appendChild(tableDiv);
        _renderExerciseTaalTable(tableDiv, taalId, cycle.beats);
      });
      if (generated.arohaCycles.length === 0) {
        arohaContainer.innerHTML = '<p style="color:var(--text-dim); font-size:0.8rem;">No aroha cycles generated for this range/pattern.</p>';
      }
    }

    if (avarohaContainer) {
      avarohaContainer.innerHTML = '';
      generated.avarohaCycles.forEach((cycle, i) => {
        const label = document.createElement('div');
        label.className = 'ex-cycle-label';
        label.textContent = `Cycle ${i + 1}`;
        avarohaContainer.appendChild(label);
        const tableDiv = document.createElement('div');
        tableDiv.style.marginBottom = '8px';
        avarohaContainer.appendChild(tableDiv);
        _renderExerciseTaalTable(tableDiv, taalId, cycle.beats);
      });
      if (generated.avarohaCycles.length === 0) {
        avarohaContainer.innerHTML = '<p style="color:var(--text-dim); font-size:0.8rem;">No avaroha cycles generated for this range/pattern.</p>';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Exercise Designer (compact pattern input)
  // ---------------------------------------------------------------------------

  function _openExerciseDesigner(exerciseId) {
    _exEditingId = exerciseId;
    _exDesignerGenerated = null;

    const title = document.getElementById('exercise-designer-title');

    // Populate taal select
    const taalSelect = document.getElementById('ex-taal-select');
    if (taalSelect) {
      taalSelect.innerHTML = '';
      for (const [id, def] of Object.entries(TAAL_DEFINITIONS)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${def.name} (${def.beats})`;
        taalSelect.appendChild(opt);
      }
    }

    // Populate start/end note selects
    const startSelect = document.getElementById('ex-start-note');
    const endSelect = document.getElementById('ex-end-note');
    const thaat = settings.thaat || 'bilawal';

    [startSelect, endSelect].forEach(sel => {
      if (!sel) return;
      sel.innerHTML = '';
      for (let pos = 1; pos <= 15; pos++) {
        const opt = document.createElement('option');
        opt.value = pos;
        opt.textContent = `${pos}: ${getPositionLabel(pos, thaat, 'english')}`;
        sel.appendChild(opt);
      }
    });

    // Reset preview
    const previewContainer = document.getElementById('ex-preview-container');
    if (previewContainer) previewContainer.style.display = 'none';

    // Reset pattern input and error
    const patternInput = document.getElementById('ex-pattern-input');
    const patternError = document.getElementById('ex-pattern-error');
    if (patternError) patternError.style.display = 'none';

    if (exerciseId) {
      // Edit existing exercise via designer — populate from saved data
      const exercises = _getExercises();
      const ex = exercises.find(e => e.id === exerciseId);
      if (ex) {
        if (title) title.textContent = 'Edit Exercise';
        if (taalSelect) taalSelect.value = ex.taalId || 'teentaal';
        if (startSelect) startSelect.value = ex.rangeStart || 4;
        if (endSelect) endSelect.value = ex.rangeEnd || 11;

        // Level
        _exSelectedLevel = ex.competency || 'beginner';
        document.querySelectorAll('.ex-level-btn').forEach(btn => {
          btn.classList.toggle('btn-active', btn.dataset.level === _exSelectedLevel);
        });

        // Populate compact notation if available
        if (patternInput) {
          patternInput.value = ex.compactNotation || '';
        }

        // Name
        const nameInput = document.getElementById('ex-save-name');
        if (nameInput) nameInput.value = ex.name || '';
      }
    } else {
      // New exercise — set defaults
      if (title) title.textContent = 'New Exercise';
      if (taalSelect) taalSelect.value = settings.taal || 'teentaal';
      if (startSelect) startSelect.value = 4;
      if (endSelect) endSelect.value = 11;

      _exSelectedLevel = 'beginner';
      document.querySelectorAll('.ex-level-btn').forEach(btn => {
        btn.classList.toggle('btn-active', btn.dataset.level === 'beginner');
      });

      if (patternInput) patternInput.value = '';

      const nameInput = document.getElementById('ex-save-name');
      if (nameInput) nameInput.value = '';
    }

    // Update help text for the selected taal
    const currentTaalId = taalSelect ? taalSelect.value : (settings.taal || 'teentaal');
    _updatePatternHelp(currentTaalId, 'ex-pattern-help');

    _openPage('exercise-designer-page');
  }

  // Taal select change -> update pattern help
  const taalSelectDesigner = document.getElementById('ex-taal-select');
  if (taalSelectDesigner) {
    taalSelectDesigner.addEventListener('change', () => {
      _updatePatternHelp(taalSelectDesigner.value, 'ex-pattern-help');
    });
  }

  // Level buttons
  document.querySelectorAll('.ex-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ex-level-btn').forEach(b => b.classList.remove('btn-active'));
      btn.classList.add('btn-active');
      _exSelectedLevel = btn.dataset.level;
    });
  });

  // Generate button (compact pattern)
  const btnGenerateExercise = document.getElementById('btn-generate-exercise');
  if (btnGenerateExercise) {
    btnGenerateExercise.addEventListener('click', () => {
      const input = document.getElementById('ex-pattern-input')?.value || '';
      const taalId = document.getElementById('ex-taal-select')?.value || 'teentaal';
      const errorEl = document.getElementById('ex-pattern-error');

      const parsed = parseCompactPattern(input, taalId);
      if (parsed.error) {
        if (errorEl) {
          errorEl.textContent = parsed.error;
          errorEl.style.display = '';
        }
        return;
      }
      if (errorEl) errorEl.style.display = 'none';

      const rangeStart = parseInt(document.getElementById('ex-start-note')?.value || '4', 10);
      const rangeEnd = parseInt(document.getElementById('ex-end-note')?.value || '11', 10);

      const generated = generateFromCompactPattern({ parsed, rangeStart, rangeEnd });

      // Render preview tables
      _renderExercisePreview(taalId, generated);
      const previewContainer = document.getElementById('ex-preview-container');
      if (previewContainer) previewContainer.style.display = '';

      // Store for saving
      _exDesignerGenerated = { parsed, generated, taalId, rangeStart, rangeEnd };

      // Auto-generate name if empty — `<taalId>_<b|i|a><n>` where n is the
      // next free number for this (taalId, level) pair.
      const nameInput = document.getElementById('ex-save-name');
      if (nameInput && !nameInput.value.trim()) {
        nameInput.value = _makeExerciseName(taalId, _exSelectedLevel);
      }
    });
  }

  // Save exercise (designer)
  function _saveExerciseFromDesigner(forceNew) {
    if (!_exDesignerGenerated) {
      alert('Generate the exercise first before saving.');
      return;
    }

    const nameInput = document.getElementById('ex-save-name');
    const name = nameInput?.value.trim() || 'Unnamed Exercise';
    const { parsed, generated, taalId, rangeStart, rangeEnd } = _exDesignerGenerated;

    const laykari = _detectLaykari(parsed.beatStructure);

    const exerciseObj = {
      id: (!forceNew && _exEditingId) ? _exEditingId : Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name,
      taalId,
      rangeStart,
      rangeEnd,
      laykari,
      competency: _exSelectedLevel,
      patternType: 'compact',
      compactNotation: compactPatternToString(parsed.vibhags),
      beatStructure: parsed.beatStructure,
      arohaCycles: generated.arohaCycles,
      avarohaCycles: generated.avarohaCycles,
      createdAt: new Date().toISOString(),
    };

    const exercises = _getExercises();

    if (!forceNew && _exEditingId) {
      const idx = exercises.findIndex(e => e.id === _exEditingId);
      if (idx >= 0) {
        exercises[idx] = exerciseObj;
      } else {
        exercises.push(exerciseObj);
      }
    } else {
      exercises.push(exerciseObj);
    }

    _saveExercises(exercises);

    // Auto-load the saved exercise
    settings.currentExerciseId = exerciseObj.id;
    const display = document.getElementById('exercise-display');
    if (display) display.textContent = exerciseObj.name;
    persistSettings();

    _closePage('exercise-designer-page');
  }

  const btnSaveExercise = document.getElementById('btn-save-exercise');
  if (btnSaveExercise) {
    btnSaveExercise.addEventListener('click', () => _saveExerciseFromDesigner(false));
  }

  const btnSaveExerciseAs = document.getElementById('btn-save-exercise-as');
  if (btnSaveExerciseAs) {
    btnSaveExerciseAs.addEventListener('click', () => _saveExerciseFromDesigner(true));
  }

  // ---------------------------------------------------------------------------
  // Exercise Edit Page
  // ---------------------------------------------------------------------------

  let _exEditPageExercise = null;     // exercise object being edited
  let _exEditGenerated = null;        // last generated data for edit page

  function _openExerciseEdit(exerciseId) {
    const exercises = _getExercises();
    const exercise = exercises.find(e => e.id === exerciseId);
    if (!exercise) {
      alert('Exercise not found.');
      return;
    }

    _exEditPageExercise = exercise;
    _exEditGenerated = null;

    // Title
    const title = document.getElementById('exercise-edit-title');
    if (title) title.textContent = `Edit: ${exercise.name || 'Exercise'}`;

    // Read-only labels
    const taalDef = TAAL_DEFINITIONS[exercise.taalId];
    const taalLabel = document.getElementById('ex-edit-taal-label');
    if (taalLabel) taalLabel.textContent = taalDef ? taalDef.name : exercise.taalId;

    const laykariLabel = document.getElementById('ex-edit-laykari-label');
    if (laykariLabel) laykariLabel.textContent = exercise.laykari || 'ekgun';

    const levelLabel = document.getElementById('ex-edit-level-label');
    if (levelLabel) levelLabel.textContent = exercise.competency || 'beginner';

    // Populate start/end note selects
    const thaat = settings.thaat || 'bilawal';
    const startSelect = document.getElementById('ex-edit-start-note');
    const endSelect = document.getElementById('ex-edit-end-note');

    [startSelect, endSelect].forEach(sel => {
      if (!sel) return;
      sel.innerHTML = '';
      for (let pos = 1; pos <= 15; pos++) {
        const opt = document.createElement('option');
        opt.value = pos;
        opt.textContent = `${pos}: ${getPositionLabel(pos, thaat, 'english')}`;
        sel.appendChild(opt);
      }
    });

    if (startSelect) startSelect.value = exercise.rangeStart || 4;
    if (endSelect) endSelect.value = exercise.rangeEnd || 11;

    // Pattern input
    const patternInput = document.getElementById('ex-edit-pattern-input');
    const patternError = document.getElementById('ex-edit-pattern-error');
    if (patternError) patternError.style.display = 'none';

    if (exercise.compactNotation) {
      // New format
      if (patternInput) patternInput.value = exercise.compactNotation;
    } else {
      // Old format — show message
      if (patternInput) patternInput.value = '';
      if (patternInput) patternInput.placeholder = 'Old format — enter a new compact pattern to convert';
    }

    // Update pattern help for this exercise's taal
    _updatePatternHelp(exercise.taalId, 'ex-edit-pattern-help');

    // Name
    const nameInput = document.getElementById('ex-edit-name');
    if (nameInput) nameInput.value = exercise.name || '';

    // Render current exercise tables
    const previewContainer = document.getElementById('ex-edit-preview-container');
    if (exercise.arohaCycles && exercise.arohaCycles.length > 0) {
      if (previewContainer) previewContainer.style.display = '';
      // Use existing exercise data directly
      _renderExercisePreview(exercise.taalId, {
        arohaCycles: exercise.arohaCycles,
        avarohaCycles: exercise.avarohaCycles || [],
      }, 'ex-edit-');
    } else {
      if (previewContainer) previewContainer.style.display = 'none';
    }
  }

  // Regenerate button on edit page
  const btnRegenerateExercise = document.getElementById('btn-regenerate-exercise');
  if (btnRegenerateExercise) {
    btnRegenerateExercise.addEventListener('click', () => {
      if (!_exEditPageExercise) return;

      const input = document.getElementById('ex-edit-pattern-input')?.value || '';
      const taalId = _exEditPageExercise.taalId;
      const errorEl = document.getElementById('ex-edit-pattern-error');

      const parsed = parseCompactPattern(input, taalId);
      if (parsed.error) {
        if (errorEl) {
          errorEl.textContent = parsed.error;
          errorEl.style.display = '';
        }
        return;
      }
      if (errorEl) errorEl.style.display = 'none';

      const rangeStart = parseInt(document.getElementById('ex-edit-start-note')?.value || '4', 10);
      const rangeEnd = parseInt(document.getElementById('ex-edit-end-note')?.value || '11', 10);

      const generated = generateFromCompactPattern({ parsed, rangeStart, rangeEnd });
      _exEditGenerated = { parsed, generated, rangeStart, rangeEnd };

      // Render preview
      const previewContainer = document.getElementById('ex-edit-preview-container');
      if (previewContainer) previewContainer.style.display = '';
      _renderExercisePreview(taalId, generated, 'ex-edit-');
    });
  }

  // Save button on edit page (update existing)
  const btnEditSave = document.getElementById('btn-edit-save');
  if (btnEditSave) {
    btnEditSave.addEventListener('click', () => {
      if (!_exEditPageExercise) return;

      const nameInput = document.getElementById('ex-edit-name');
      const name = nameInput?.value.trim() || _exEditPageExercise.name || 'Unnamed Exercise';

      const exercises = _getExercises();
      const idx = exercises.findIndex(e => e.id === _exEditPageExercise.id);

      if (_exEditGenerated) {
        // Regenerated — save new data
        const { parsed, generated, rangeStart, rangeEnd } = _exEditGenerated;
        const laykari = _detectLaykari(parsed.beatStructure);

        const updated = {
          ..._exEditPageExercise,
          name,
          rangeStart,
          rangeEnd,
          laykari,
          patternType: 'compact',
          compactNotation: compactPatternToString(parsed.vibhags),
          beatStructure: parsed.beatStructure,
          arohaCycles: generated.arohaCycles,
          avarohaCycles: generated.avarohaCycles,
        };

        if (idx >= 0) exercises[idx] = updated;
        else exercises.push(updated);
      } else {
        // Just name change (no regeneration)
        if (idx >= 0) exercises[idx].name = name;
      }

      _saveExercises(exercises);

      // Update display if this is the currently loaded exercise
      if (settings.currentExerciseId === _exEditPageExercise.id) {
        const display = document.getElementById('exercise-display');
        if (display) display.textContent = name;
      }
      persistSettings();

      _closePage('exercise-edit-page');
    });
  }

  // Save As New button on edit page
  const btnEditSaveAs = document.getElementById('btn-edit-save-as');
  if (btnEditSaveAs) {
    btnEditSaveAs.addEventListener('click', () => {
      if (!_exEditPageExercise) return;

      const nameInput = document.getElementById('ex-edit-name');
      const baseName = nameInput?.value.trim() || _exEditPageExercise.name || 'Exercise';
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const newName = `${baseName} (copy)`;

      let newExercise;
      if (_exEditGenerated) {
        const { parsed, generated, rangeStart, rangeEnd } = _exEditGenerated;
        const laykari = _detectLaykari(parsed.beatStructure);
        newExercise = {
          ..._exEditPageExercise,
          id: newId,
          name: newName,
          rangeStart,
          rangeEnd,
          laykari,
          patternType: 'compact',
          compactNotation: compactPatternToString(parsed.vibhags),
          beatStructure: parsed.beatStructure,
          arohaCycles: generated.arohaCycles,
          avarohaCycles: generated.avarohaCycles,
          createdAt: new Date().toISOString(),
        };
      } else {
        newExercise = {
          ..._exEditPageExercise,
          id: newId,
          name: newName,
          createdAt: new Date().toISOString(),
        };
      }

      const exercises = _getExercises();
      exercises.push(newExercise);
      _saveExercises(exercises);

      // Auto-load the new exercise
      settings.currentExerciseId = newId;
      const display = document.getElementById('exercise-display');
      if (display) display.textContent = newName;
      persistSettings();

      _closePage('exercise-edit-page');
    });
  }

  // ---------------------------------------------------------------------------
  // Exercise Player
  // ---------------------------------------------------------------------------

  function _openExercisePlayer(exerciseId) {
    const exercises = _getExercises();
    const exercise = exercises.find(e => e.id === exerciseId);
    if (!exercise) {
      alert('Exercise not found.');
      return;
    }

    // If already playing this exercise, just open the page and sync — don't reset
    if (_exPlaying && _exLoadedExercise && _exLoadedExercise.id === exerciseId) {
      // Sync title
      const title = document.getElementById('exercise-player-title');
      if (title) title.textContent = exercise.name || 'Exercise';

      // Sync mode buttons on player page to current mode
      document.querySelectorAll('.ex-mode-btn').forEach(btn => {
        btn.classList.toggle('btn-active', btn.dataset.mode === _exMode);
      });

      // Render current cycle and highlight current beat
      _renderPlayerCycle();
      _updateExProgress();
      if (_exCurrentBeatIdx >= 0) _highlightBeat(_exCurrentBeatIdx);

      // Sync transport
      const btnStart = document.getElementById('btn-ex-start');
      const btnPause = document.getElementById('btn-ex-pause');
      const btnStop = document.getElementById('btn-ex-stop');
      if (btnStart) btnStart.disabled = true;
      if (btnPause) btnPause.disabled = false;
      if (btnStop) btnStop.disabled = false;

      // Sync "your turn" indicator
      const yourTurn = document.getElementById('ex-your-turn');
      if (yourTurn) yourTurn.style.display = _exIsUserTurn ? '' : 'none';

      _openPage('exercise-player-page');
      return;
    }

    // Fresh open — reset state
    _exLoadedExercise = exercise;
    _exCurrentSection = 'aroha';
    _exCurrentCycleIdx = 0;
    _exCurrentBeatIdx = -1;
    _exPlaying = false;
    _exIsUserTurn = false;
    _exPhraseCounter = 0;

    // Set global taal to exercise's taal
    settings.taal = exercise.taalId;
    const taalDef = TAAL_DEFINITIONS[exercise.taalId];
    const taalDisplay = document.getElementById('taal-display');
    if (taalDisplay && taalDef) taalDisplay.textContent = taalDef.name;
    persistSettings();

    // Set title
    const title = document.getElementById('exercise-player-title');
    if (title) title.textContent = exercise.name || 'Exercise';

    // Render first cycle
    _renderPlayerCycle();
    _updateExProgress();

    // Reset transport buttons
    const btnStart = document.getElementById('btn-ex-start');
    const btnPause = document.getElementById('btn-ex-pause');
    const btnStop = document.getElementById('btn-ex-stop');
    if (btnStart) btnStart.disabled = false;
    if (btnPause) btnPause.disabled = true;
    if (btnStop) btnStop.disabled = true;

    // Sync mode buttons to current _exMode
    document.querySelectorAll('.ex-mode-btn').forEach(btn => {
      btn.classList.toggle('btn-active', btn.dataset.mode === _exMode);
    });

    // Hide "your turn"
    const yourTurn = document.getElementById('ex-your-turn');
    if (yourTurn) yourTurn.style.display = 'none';

    _openPage('exercise-player-page');
  }

  function _getCurrentCycles() {
    if (!_exLoadedExercise) return [];
    return _exCurrentSection === 'aroha'
      ? (_exLoadedExercise.arohaCycles || [])
      : (_exLoadedExercise.avarohaCycles || []);
  }

  function _renderPlayerCycle() {
    const container = document.getElementById('ex-player-table');
    if (!container || !_exLoadedExercise) return;

    const cycles = _getCurrentCycles();
    const cycle = cycles[_exCurrentCycleIdx];
    if (!cycle) {
      container.innerHTML = '<p style="color:var(--text-dim); text-align:center;">No data for this cycle.</p>';
      return;
    }

    _renderExerciseTaalTable(container, _exLoadedExercise.taalId, cycle.beats, {
      cellIdPrefix: 'ex-beat',
    });
  }

  function _updateExProgress() {
    const el = document.getElementById('ex-progress');
    if (!el || !_exLoadedExercise) return;

    const cycles = _getCurrentCycles();
    const sectionLabel = _exCurrentSection === 'aroha' ? 'Aroha' : 'Avaroha';
    el.textContent = `${sectionLabel} · Cycle ${_exCurrentCycleIdx + 1} of ${cycles.length}`;
  }

  function _highlightBeat(beatIdx) {
    // Remove previous highlight
    const prev = document.querySelector('#ex-player-table .matra-cell.playing');
    if (prev) prev.classList.remove('playing');

    // Add new highlight
    if (beatIdx >= 0) {
      const cell = document.getElementById(`ex-beat-${beatIdx}`);
      if (cell) cell.classList.add('playing');
    }
    _exCurrentBeatIdx = beatIdx;
  }

  function _advanceCycle() {
    const cycles = _getCurrentCycles();
    _exCurrentCycleIdx++;

    if (_exCurrentCycleIdx >= cycles.length) {
      // Switch section
      if (_exCurrentSection === 'aroha') {
        _exCurrentSection = 'avaroha';
        _exCurrentCycleIdx = 0;
      } else {
        // Loop back to aroha
        _exCurrentSection = 'aroha';
        _exCurrentCycleIdx = 0;
      }
    }

    _renderPlayerCycle();
    _updateExProgress();
  }

  // Shared mode switch logic — syncs both main screen and player page buttons
  function _setExerciseMode(mode) {
    if (mode === 'test') {
      // Test mode not yet implemented — show brief feedback
      console.log('[Exercise] Test mode coming soon');
      return;
    }
    _exMode = mode;
    // Sync ALL mode buttons (both .ex-mode-btn and .main-mode-btn)
    document.querySelectorAll('.ex-mode-btn, .main-mode-btn').forEach(b => {
      b.classList.toggle('btn-active', b.dataset.mode === mode);
    });
    const yourTurn = document.getElementById('ex-your-turn');
    if (yourTurn) yourTurn.style.display = 'none';
    _exIsUserTurn = false;
    _exPhraseCounter = 0;
  }

  // Mode toggle — player page buttons
  document.querySelectorAll('.ex-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => _setExerciseMode(btn.dataset.mode));
  });

  // Mode toggle — main screen buttons
  document.querySelectorAll('.main-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => _setExerciseMode(btn.dataset.mode));
  });

  // Transport controls
  const btnExStart = document.getElementById('btn-ex-start');
  const btnExPause = document.getElementById('btn-ex-pause');
  const btnExStop = document.getElementById('btn-ex-stop');

  if (btnExStart) {
    btnExStart.addEventListener('click', async () => {
      // If no exercise loaded, try to load from settings
      if (!_exLoadedExercise && settings.currentExerciseId) {
        _openExercisePlayer(settings.currentExerciseId);
        return;
      }
      if (!_exLoadedExercise) {
        alert('No exercise loaded. Select one from the Exercise Library.');
        return;
      }

      try {
        if (!audioEngine.isInitialized) await audioEngine.init();
        await audioEngine.resume();

        // Stop the main-page quick-toggle tabla if it's running —
        // otherwise both it and the exercise engine play in parallel.
        if (tablaPlaying && tablaTaalEngine) {
          tablaTaalEngine.stop();
          tablaPlaying = false;
          backgroundAudio.deactivate('tabla-quick');
          if (btnTablaQuickToggle) {
            btnTablaQuickToggle.innerHTML = '<span style="font-size:1.1rem;">▶</span>';
            btnTablaQuickToggle.style.background = 'transparent';
            btnTablaQuickToggle.style.color = 'var(--accent)';
          }
        }

        // Start tanpura if not running
        await _startTanpura();

        // Ensure tabla mode
        await _ensureTablaMode();

        // Initialize swar synth for melodic playback
        const swarSynthMod = await import('./swar-synth.js');
        const swarSynth = swarSynthMod.default;
        await swarSynth.init();
        await _loadCustomInstrumentsIntoSynth(swarSynth);

        // Create or reuse taal engine
        const { TaalEngine } = await import('./taal-engine.js');
        const tabla = (await import('./tabla.js')).default;

        if (!exerciseTaalEngine) exerciseTaalEngine = new TaalEngine();
        exerciseTaalEngine.setTaal(_exLoadedExercise.taalId);
        exerciseTaalEngine.setTempo(settings.tempo || 80);
        exerciseTaalEngine.callbacks = [];

        tabla.setSaFreq(KEY_FREQUENCIES[settings.key] || 164.81);

        const taalDef = TAAL_DEFINITIONS[_exLoadedExercise.taalId];
        const totalBeats = taalDef ? taalDef.beats : 16;
        let beatInCycle = 0;

        exerciseTaalEngine.onBeat((matraIndex, beatType, bol, velocity, scheduledTime) => {
          // Read Sa frequency fresh on every beat (respects live key + saptak changes)
          let saFreq = KEY_FREQUENCIES[settings.key] || 164.81;
          // Apply saptak multiplier to shift swaras along with tanpura
          const saptak = settings.saptak || 'MADHYA';
          if (saptak === 'MANDRA' || saptak === 'LOW') saFreq *= 0.5;
          else if (saptak === 'TAAR' || saptak === 'HIGH') saFreq *= 2;

          // Play tabla bol
          const activeBols = _getActiveBols(_exLoadedExercise.taalId);
          const bolsForMatra = activeBols[matraIndex] || [bol];
          const beatDuration = exerciseTaalEngine.getBeatDuration();
          const subDuration = beatDuration / bolsForMatra.length;
          bolsForMatra.forEach((subBol, i) => {
            _playTablaBol(subBol, scheduledTime + i * subDuration, velocity, subDuration);
          });

          // Highlight current beat
          _highlightBeat(matraIndex);

          // Play swaras (Demo mode, or Practice mode when not user's turn)
          const shouldPlaySwaras = _exMode === 'demo' || (_exMode === 'practice' && !_exIsUserTurn);

          if (shouldPlaySwaras) {
            const cycles = _getCurrentCycles();
            const cycle = cycles[_exCurrentCycleIdx];
            if (cycle && cycle.beats && cycle.beats[matraIndex]) {
              const beat = cycle.beats[matraIndex];
              if (beat.positions) {
                const noteDuration = beatDuration / beat.positions.length;
                beat.positions.forEach((pos, si) => {
                  if (pos === '_') {
                    // Sustain — do nothing, the previous note is still ringing
                    return;
                  }
                  if (pos != null) {
                    // Calculate duration: extend through any following '_' in this beat and subsequent beats
                    let totalDuration = noteDuration;
                    // Check remaining sub-beats in this beat
                    for (let nextSi = si + 1; nextSi < beat.positions.length; nextSi++) {
                      if (beat.positions[nextSi] === '_') totalDuration += noteDuration;
                      else break;
                    }
                    // Check subsequent beats for '_' continuation (only if this is the last sub-beat or all remaining are '_')
                    if (si + 1 >= beat.positions.length || beat.positions.slice(si + 1).every(p => p === '_')) {
                      for (let nextBeat = matraIndex + 1; nextBeat < totalBeats; nextBeat++) {
                        const nb = cycle.beats[nextBeat];
                        if (nb && nb.positions && nb.positions.every(p => p === '_')) {
                          totalDuration += beatDuration;
                        } else {
                          // Check partial '_' at start of next beat
                          if (nb && nb.positions) {
                            for (const np of nb.positions) {
                              if (np === '_') totalDuration += beatDuration / nb.positions.length;
                              else break;
                            }
                          }
                          break;
                        }
                      }
                    }
                    swarSynth.playNote(pos, settings.thaat || 'bilawal', saFreq, scheduledTime + si * noteDuration, totalDuration * 0.95, 0.7);
                  }
                });
              }
            }
          }

          // Track cycle boundaries
          beatInCycle++;
          if (beatInCycle >= totalBeats) {
            beatInCycle = 0;

            if (_exMode === 'practice') {
              // Practice mode: alternate app/user turns per cycle
              if (!_exIsUserTurn) {
                // App just finished playing — now it's the user's turn
                // Keep the SAME cycle (same notes in table) for the user to play along
                _exIsUserTurn = true;
                const yourTurn = document.getElementById('ex-your-turn');
                if (yourTurn) yourTurn.style.display = '';
              } else {
                // User's turn just finished — advance to next cycle
                _exIsUserTurn = false;
                const yourTurn = document.getElementById('ex-your-turn');
                if (yourTurn) yourTurn.style.display = 'none';
                _advanceCycle();
              }
            } else {
              // Demo mode: advance every cycle
              _advanceCycle();
            }
          }
        });

        exerciseTaalEngine.start(audioEngine.audioCtx);
        _exPlaying = true;
        practiceTracker.startExercise(_exLoadedExercise?.id);
        backgroundAudio.activate('exercise');
        backgroundAudio.setTitle(_exLoadedExercise?.name
          ? `Swaradhana — ${_exLoadedExercise.name}`
          : 'Swaradhana — Exercise');

        if (btnExStart) { btnExStart.disabled = true; btnExStart.textContent = '▶ Start'; }
        if (btnExPause) btnExPause.disabled = false;
        if (btnExStop) btnExStop.disabled = false;

        // Sync main screen transport
        transportState = 'playing';
        setTransportState('playing');

      } catch (err) {
        console.error('[Exercise Player] Start failed:', err);
      }
    });
  }

  if (btnExPause) {
    btnExPause.addEventListener('click', () => {
      if (exerciseTaalEngine && _exPlaying) {
        exerciseTaalEngine.stop();
        _stopTanpura();
        _exPlaying = false;
        practiceTracker.pauseExercise();
        backgroundAudio.deactivate('exercise');
        if (btnExStart) { btnExStart.disabled = false; btnExStart.textContent = '▶ Resume'; }
        if (btnExPause) btnExPause.disabled = true;
        // Sync main transport
        transportState = 'paused';
        setTransportState('paused');
      }
    });
  }

  if (btnExStop) {
    btnExStop.addEventListener('click', () => {
      if (exerciseTaalEngine) {
        exerciseTaalEngine.stop();
      }
      practiceTracker.endExercise();
      backgroundAudio.deactivate('exercise');
      // Stop tanpura
      _stopTanpura();
      // Stop any swar notes
      import('./swar-synth.js').then(mod => {
        if (mod.default && mod.default._initialized) mod.default.stopAll();
      }).catch(() => {});

      _exPlaying = false;
      _exCurrentSection = 'aroha';
      _exCurrentCycleIdx = 0;
      _exCurrentBeatIdx = -1;
      _exIsUserTurn = false;
      _exPhraseCounter = 0;

      _highlightBeat(-1);
      _renderPlayerCycle();
      _updateExProgress();

      const yourTurn = document.getElementById('ex-your-turn');
      if (yourTurn) yourTurn.style.display = 'none';

      if (btnExStart) { btnExStart.disabled = false; btnExStart.textContent = '▶ Start'; }
      if (btnExPause) btnExPause.disabled = true;
      if (btnExStop) btnExStop.disabled = true;

      // Also reset main screen transport state
      transportState = 'idle';
      setTransportState('idle');
    });
  }

  // Back button for player — stop playback first
  // Back button on exercise player — just close the page, don't stop playback.
  // Session continues in the background. User can return by tapping the exercise name.
  // Playback only stops via the Stop button.

  // Wire up Exercise tile → open player if exercise loaded, else library
  const exerciseTile = document.getElementById('btn-open-exercise-library');
  if (exerciseTile) {
    // Override the generic tile click for double-tap behavior:
    // Single tap opens library. If we want tap on loaded exercise to open player,
    // we add a separate listener on the exercise-display span.
    const exDisplay = document.getElementById('exercise-display');
    if (exDisplay) {
      exDisplay.addEventListener('click', (e) => {
        if (settings.currentExerciseId) {
          e.stopPropagation();
          _openExercisePlayer(settings.currentExerciseId);
        }
      });
    }
  }

  // ========================================================================
  // Profile Page
  // ========================================================================
  _initProfilePage();
}

// ---------------------------------------------------------------------------
// Profile page helpers (outside initUI for clarity)
// ---------------------------------------------------------------------------

function _formatMinutes(totalSec) {
  const totalMin = Math.round((totalSec || 0) / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Update the main-screen "Target" box from the profile's daily target.
 * Exposed at module scope so both initUI (on load) and the Profile page
 * (on commit) can call it without wiring a custom event.
 */
function _refreshTargetDisplay() {
  const el = document.getElementById('target-display');
  if (!el) return;
  const mins = profile.getTargetFor().dailyMinutes || 0;
  el.textContent = `${mins} min${mins === 1 ? '' : 's'}`;
}

function _formatDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-');
  return `${d}/${m}`;
}

function _renderProfileChart(containerEl, bars, unitLabel) {
  containerEl.innerHTML = '';
  if (!bars.length) {
    containerEl.innerHTML = '<p style="color:var(--text-dim); font-size:0.75rem; text-align:center; padding:20px 0;">No data yet — practice a few sessions to see your trend here.</p>';
    return;
  }
  const maxSec = Math.max(1, ...bars.map(b => b.appSec || 0));
  for (const b of bars) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const appPct = Math.round(((b.appSec || 0) / maxSec) * 100);
    const exPct = Math.round(((b.exerciseSec || 0) / maxSec) * 100);
    if (appPct === 0 && exPct === 0) bar.classList.add('empty');
    bar.innerHTML = `
      <div class="bar-app" style="height:${appPct}%;"></div>
      <div class="bar-ex"  style="height:${exPct}%;"></div>
      <span class="bar-label">${b.label}<br>App ${_formatMinutes(b.appSec)} · Practice ${_formatMinutes(b.exerciseSec)}</span>
    `;
    bar.setAttribute('tabindex', '0');
    containerEl.appendChild(bar);
  }
}

function _buildDailyBars() {
  const activity = practiceTracker.getActivity();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const bars = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = practiceTracker._todayKey(d);
    const entry = activity.daily[key] || { appSec: 0, exerciseSec: 0 };
    bars.push({ label: _formatDateKey(key), appSec: entry.appSec || 0, exerciseSec: entry.exerciseSec || 0, date: key });
  }
  return bars;
}

function _buildWeeklyBars() {
  const activity = practiceTracker.getActivity();
  const bars = [];
  const today = new Date();
  for (let i = 25; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i * 7);
    const key = practiceTracker._weekKey(d);
    const entry = activity.weekly[key];
    if (entry) {
      bars.push({ label: key, appSec: entry.appSec || 0, exerciseSec: entry.exerciseSec || 0 });
    }
  }
  return bars;
}

function _buildMonthlyBars() {
  const activity = practiceTracker.getActivity();
  return Object.keys(activity.monthly).sort().map(key => {
    const e = activity.monthly[key];
    return { label: key, appSec: e.appSec || 0, exerciseSec: e.exerciseSec || 0 };
  });
}

function _renderProfilePage() {
  const p = profile.getProfile();
  const summary = practiceTracker.getSummary();

  // Identity
  const nameInput = document.getElementById('profile-name-input');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = p.name;
  const since = document.getElementById('profile-since');
  if (since && p.createdAt) {
    since.textContent = new Date(p.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  // Today + streak
  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setTxt('profile-today-app', _formatMinutes(summary.todayAppSec));
  setTxt('profile-today-ex', _formatMinutes(summary.todayExerciseSec));
  setTxt('profile-streak-current', summary.streak.current || 0);
  setTxt('profile-streak-longest', summary.streak.longest || 0);

  // Targets
  const effTargets = profile.getTargetFor();
  const daily = document.getElementById('profile-daily-target');
  const dailyVal = document.getElementById('profile-daily-target-val');
  const weekly = document.getElementById('profile-weekly-target');
  const weeklyVal = document.getElementById('profile-weekly-target-val');
  if (daily) { daily.value = effTargets.dailyMinutes; if (dailyVal) dailyVal.textContent = `${effTargets.dailyMinutes} min`; }
  if (weekly) { weekly.value = effTargets.weeklyHours; if (weeklyVal) weeklyVal.textContent = `${effTargets.weeklyHours} hr`; }

  // Target progress
  const dailyMet = effTargets.dailyMinutes > 0
    ? Math.min(999, Math.round((summary.todayExerciseSec / 60) / effTargets.dailyMinutes * 100))
    : 0;
  // Week total (sum of last 7 days' exercise)
  const activity = practiceTracker.getActivity();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let weekEx = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const entry = activity.daily[practiceTracker._todayKey(d)];
    if (entry) weekEx += entry.exerciseSec || 0;
  }
  const weeklyMet = effTargets.weeklyHours > 0
    ? Math.min(999, Math.round((weekEx / 3600) / effTargets.weeklyHours * 100))
    : 0;
  setTxt('profile-daily-met', dailyMet);
  setTxt('profile-weekly-met', weeklyMet);

  // Week-override toggle state
  const override = p.weeklyTargetOverrides[practiceTracker._weekKey()] != null;
  const tgl = document.getElementById('profile-week-override-toggle');
  if (tgl) tgl.checked = override;

  // Charts
  const dailyChart = document.getElementById('profile-chart-daily');
  if (dailyChart) _renderProfileChart(dailyChart, _buildDailyBars());
  const weeklyChart = document.getElementById('profile-chart-weekly');
  if (weeklyChart) _renderProfileChart(weeklyChart, _buildWeeklyBars());
  const monthlyChart = document.getElementById('profile-chart-monthly');
  if (monthlyChart) {
    const monthlyBars = _buildMonthlyBars();
    _renderProfileChart(monthlyChart, monthlyBars);
    const empty = document.getElementById('profile-lifetime-empty');
    if (empty) empty.textContent = monthlyBars.length ? '' : 'Historical monthly totals appear here once data is older than 6 months.';
  }

  // Totals
  setTxt('profile-total-app', _formatMinutes(summary.totalAppSec));
  setTxt('profile-total-ex', _formatMinutes(summary.totalExerciseSec));
  setTxt('profile-days-active', summary.daysActive);
  const avgSec = summary.daysActive ? Math.round(summary.totalAppSec / summary.daysActive) : 0;
  setTxt('profile-avg-daily', _formatMinutes(avgSec));
}

function _initProfilePage() {
  const openPage = id => { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); };
  const closePage = id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); };
  const btnOpen = document.getElementById('btn-profile');
  const btnBack = document.getElementById('btn-back-profile');
  const nameInput = document.getElementById('profile-name-input');
  const daily = document.getElementById('profile-daily-target');
  const dailyVal = document.getElementById('profile-daily-target-val');
  const weekly = document.getElementById('profile-weekly-target');
  const weeklyVal = document.getElementById('profile-weekly-target-val');
  const overrideToggle = document.getElementById('profile-week-override-toggle');
  const btnExportJson = document.getElementById('profile-export-json');
  const btnExportCsv = document.getElementById('profile-export-csv');
  const btnResetActivity = document.getElementById('profile-reset-activity');

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      _renderProfilePage();
      openPage('profile-page');
    });
  }
  if (btnBack) btnBack.addEventListener('click', () => closePage('profile-page'));

  if (nameInput) {
    let saveTimer = null;
    nameInput.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => profile.setName(nameInput.value), 400);
    });
    nameInput.addEventListener('blur', () => profile.setName(nameInput.value));
  }

  // Live label feedback while dragging.
  const _updateTargetLabels = () => {
    if (daily && dailyVal) dailyVal.textContent = `${daily.value} min`;
    if (weekly && weeklyVal) weeklyVal.textContent = `${weekly.value} hr`;
  };
  // Persist + recompute only on release. Writing slider.value mid-drag (which
  // _renderProfilePage does) interrupts the gesture on mobile.
  const _commitTargetChange = () => {
    const d = parseInt(daily?.value || '30', 10);
    const w = parseInt(weekly?.value || '3', 10);
    if (overrideToggle && overrideToggle.checked) {
      profile.setWeeklyTarget('current', { dailyMinutes: d, weeklyHours: w });
    } else {
      profile.setTargets({ dailyMinutes: d, weeklyHours: w });
    }
    _renderProfilePage();
    _refreshTargetDisplay(); // keep the main-screen Target box in sync
  };
  if (daily) {
    daily.addEventListener('input', _updateTargetLabels);
    daily.addEventListener('change', _commitTargetChange);
  }
  if (weekly) {
    weekly.addEventListener('input', _updateTargetLabels);
    weekly.addEventListener('change', _commitTargetChange);
  }

  if (overrideToggle) {
    overrideToggle.addEventListener('change', () => {
      if (overrideToggle.checked) {
        // Seed override from current baseline so the slider position stays.
        const eff = profile.getTargetFor();
        profile.setWeeklyTarget('current', { dailyMinutes: eff.dailyMinutes, weeklyHours: eff.weeklyHours });
      } else {
        profile.setWeeklyTarget('current', null);
      }
      _renderProfilePage();
      _refreshTargetDisplay();
    });
  }

  const _downloadBlob = (filename, content, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };
  if (btnExportJson) btnExportJson.addEventListener('click', () => {
    _downloadBlob(`swaradhana_activity_${new Date().toISOString().slice(0,10)}.json`, practiceTracker.exportJson(), 'application/json');
  });
  if (btnExportCsv) btnExportCsv.addEventListener('click', () => {
    _downloadBlob(`swaradhana_activity_${new Date().toISOString().slice(0,10)}.csv`, practiceTracker.exportCsv(), 'text/csv');
  });
  if (btnResetActivity) btnResetActivity.addEventListener('click', () => {
    if (confirm('Reset all practice history? This cannot be undone.\n\nProfile name and targets will be kept.')) {
      practiceTracker.reset();
      _renderProfilePage();
    }
  });
}

// ---------------------------------------------------------------------------
// Helper: updateAlankaarDisplay
// ---------------------------------------------------------------------------

/**
 * Update the alankaar notation display based on the current settings.
 * For 'scale', shows the full ascending + descending scale in the current thaat.
 * For patterns, shows the pattern name (full generation in Phase 4).
 *
 * @param {Object} settings - Current settings with thaat, currentAlankaar
 * @param {HTMLElement|null} el - The DOM element to update
 */
function updateAlankaarDisplay(settings, el) {
  if (!el) return;

  if (settings.currentAlankaar === 'scale') {
    // Show full scale aroha + avaroha for the current thaat
    const thaat = settings.thaat || 'bilawal';
    const positions = [4, 5, 6, 7, 8, 9, 10, 11]; // S R G m P D N S'
    const aroha = positions.map(p => getPositionLabel(p, thaat, 'english'));
    const avaroha = [...positions].reverse().map(p => getPositionLabel(p, thaat, 'english'));
    el.innerHTML = `<div style="margin-bottom:4px;"><span style="color:var(--text-dim); font-size:0.7rem;">Aroha</span> ${aroha.join(' ')}</div><div><span style="color:var(--text-dim); font-size:0.7rem;">Avaroha</span> ${avaroha.join(' ')}</div>`;
  } else {
    el.textContent = settings.currentAlankaarLabel || settings.currentAlankaar;
  }
}

// ---------------------------------------------------------------------------
// Private: _bindAdvancedSlider
// ---------------------------------------------------------------------------

/**
 * Generic helper to bind a range slider to a settings property, a display
 * element, and auto-persist on change.
 *
 * @param {string} sliderId   - The DOM id of the <input type="range">.
 * @param {string} displayId  - The DOM id of the value display element.
 * @param {string} settingsKey - The key in the settings object to update.
 * @param {function} parse     - Converts the slider's string value to the
 *                               appropriate type (e.g. parseInt, parseFloat).
 * @param {function} format    - Converts the parsed value to a display string.
 * @private
 */
function _bindAdvancedSlider(sliderId, displayId, settingsKey, parse, format) {
  const slider  = document.getElementById(sliderId);
  const display = document.getElementById(displayId);

  if (!slider || !_settings) return;

  slider.value = _settings[settingsKey];
  if (display) display.textContent = format(_settings[settingsKey]);

  slider.addEventListener('input', () => {
    const val = parse(slider.value);
    _settings[settingsKey] = val;
    if (display) display.textContent = format(val);
    persistSettings();
  });
}
