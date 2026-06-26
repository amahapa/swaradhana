# Swaradhana

**स्वर साधना** — *svara sādhanā*, "the discipline of notes."

**Author:** Arun Mahapatro · **License:** MIT (see `LICENSE`)

This README is a **build-spec index**. It is the top-level entry point for
rebuilding the entire app from the `docs/` folder. If you are an LLM
regenerating the codebase, read this file first to learn the layout and which
doc to consult for which module, then follow the rebuild order at the bottom.

---

## What Swaradhana is

Swaradhana is a browser-based Hindustani Classical Music practice app for
bansuri (bamboo flute) players, and more generally for anyone who needs a
programmable tanpura + tabla + swar companion for Hindustani practice (vocal,
sitar, sarod, etc.). It bundles a tanpura drone (synth or sampled), a tabla
engine with 10 built-in taals, a swar synth driven by WebAudioFont, an
exercise/alankaar pattern generator, a practice tracker with streaks, and a
profile page with daily/weekly/monthly analytics.

It runs as a static web app — no build step, no bundler, no package manager.
Open `app/index.html` over any HTTP server and it works. On Android it
installs as a PWA (manifest declares standalone, portrait, dark theme) and
keeps audio running with the screen off via a silent-loop + MediaSession +
Wake Lock combo. Target user is an individual practitioner who wants an
offline-capable, configurable practice companion.

---

## Quick start

### Run locally

```bash
cd app
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works. There is no build step and no `package.json`.
For development, use a no-cache server to avoid ES-module caching pain:

```python
class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
```

### Install as a PWA on Android

1. Push `app/` to any HTTPS static host (GitHub Pages, Netlify Drop,
   Cloudflare Pages).
2. Open the URL in Chrome on Android.
3. Menu → **Install app** (or **Add to Home screen**). Launches full-screen,
   portrait, dark theme — driven by `manifest.json`.
4. First tap inside the app unlocks the `AudioContext` (browser autoplay
   policy — `app.js` listens for the first `click` / `touchstart` and calls
   `audioEngine.init()` + `audioEngine.resume()`).

For a real `.apk`, feed the hosted URL into [pwabuilder.com](https://www.pwabuilder.com/)
or use Google's `bubblewrap` CLI (Trusted Web Activity).

### Browser requirements

- Modern Chrome / Safari / Firefox.
- Web Audio API (`AudioContext`, `ConvolverNode`, `BiquadFilterNode`,
  `StereoPanner`, `PeriodicWave`, `WaveShaperNode`).
- ES modules (native `<script type="module">`).
- `localStorage`, optional Wake Lock API (mobile).

A service worker for full offline support is **planned but not built** — the
app needs internet on first load until then.

---

## Repository layout

```
Swaradhana/
├── README.md                  this file (build-spec index)
├── LICENSE                    MIT
├── app/                       deployable web app (no build step)
│   ├── index.html             single-page UI; all screens are .full-page overlays
│   ├── manifest.json          PWA manifest (standalone, portrait, dark)
│   ├── css/
│   │   ├── styles.css           theme, CSS variables, layout, full-page overlays (~1387 lines)
│   │   └── components.css       buttons, sliders, modals, beat grid, taal/exercise tables (~1276 lines)
│   ├── js/
│   │   ├── app.js                          entry point: load settings, initUI, gesture-gated AudioContext init, practice-tracker lifecycle
│   │   ├── config.js                       constants — PRACTICE_DEFAULTS, STORAGE_KEYS, SWAR_RATIOS, KEY_FREQUENCIES, THAAT_DEFINITIONS, TAAL_DEFINITIONS, LAYKARI_MULTIPLIERS, LAYA_RANGES, PITCH_TOLERANCE, VELOCITY_SCALING, PROFILE_DEFAULTS
│   │   ├── storage.js                      localStorage wrapper — save/load/remove/exportAllData/importAllData/clearAllData
│   │   ├── music-engine.js                 frequency + thaat math — getEffectiveSaFreq, getSwarFreq, getPositionFreq, getPositionSwara, getPositionLabel, classifyLaya, getTanpuraVoicing
│   │   ├── audio-engine.js                 Web Audio singleton — AudioContext (latencyHint:'playback'), masterGain, dryMix, reverb, compressor (orphaned), tanpura/swar/tabla/aux buses
│   │   ├── taal-engine.js                  beat scheduler — 200ms lookahead, 50ms pump, sam/tali/khali/filler classification, deferred tempo/taal at cycle boundary
│   │   ├── tabla.js                        electronic tabla synth — BOL_PARAMS for 13 bols (osc + noise envelopes)
│   │   ├── tabla-samples.js                sample-based tabla — REFERENCE_FREQ_BY_SET, GAIN_BY_SET, dayan pitch-shift via playbackRate, bayan exemption {Ga, Ge, Ghe, Ka, Kat, Ke}
│   │   ├── tanpura.js                      TanpuraController — pluggable engine facade, single vs concert mode, A/B engine instances, capability gating
│   │   ├── tanpura-electronic-engine.js    PeriodicWave additive synth — jivari = 2/4/16/32 harmonics, patterns ['pa','ma','ni']
│   │   ├── tanpura-sample-engine.js        MP3 playback + jivari DSP (5-band bandpass + comb delay + soft-clip), patterns ['pa','ma'], loopStart=1.5s, loopEnd=dur-3s
│   │   ├── swar-synth.js                   WebAudioFont melodic synth — 4 presets (harmonium/strings/guitar/piano), multi-voice 1/sqrt(N) scaling, custom instrument upload
│   │   ├── accents.js                      AccentPlayer — manjira_1/2, ghungroo_1, tali_1; routes through tablaGain (no new graph topology)
│   │   ├── alankaar-engine.js              pattern grammar — parsePattern, parseCompactPattern, generateFromCompactPattern, fitToTaal, bracket [..] mixed laykari, sustain `_`, rest `.`
│   │   ├── practice-session.js             session orchestrator — configure/start/pause/resume/stop, demo/practice/test modes, scheduledTime, onBeat/onCycleChange
│   │   ├── practice-tracker.js             activity logger — 30s heartbeat, 5-min idle cutoff, daily→weekly→monthly rollup, streak, JSON/CSV export
│   │   ├── profile.js                      name/avatar/createdAt, baseline targets, weeklyTargetOverrides, target resolution priority
│   │   ├── background-audio.js             mobile keep-alive — silent 30s WAV loop + MediaSession + Wake Lock, ref-counted activate/deactivate
│   │   └── ui-controller.js                all UI bindings — page navigation, settings grid, BPM panel, transport, taal CRUD, exercise CRUD, exercise player (~4000 lines)
│   ├── assets/
│   │   ├── audio/
│   │   │   ├── tabla/tabla_e_1/             16 MP3 bols, ref Sa = E3 (164.81 Hz)
│   │   │   ├── tabla/tabla_c_1/             16 MP3 bols, ref Sa = C4 (261.63 Hz, Naad/MIT)
│   │   │   └── tanpura/tanpura_1/           24 MP3 drones (Pa-Sa & Ma-Sa × 12 keys)
│   │   ├── exercises/                       seed exercise JSONs (optional)
│   │   └── icons/                           PWA + in-app icons
│   └── webaudiofont/
│       ├── WebAudioFontPlayer.js                ~124 KB
│       ├── 0210_FluidR3_GM_sf2_file.js          Harmonium (Accordion, GM 21), ~297 KB
│       ├── 0480_Chaos_sf2_file.js               Strings ensemble (GM 48), ~141 KB
│       ├── 0240_Aspirin_sf2_file.js             Acoustic Guitar (GM 25), ~206 KB
│       └── 0000_FluidR3_GM_sf2_file.js          Concert Piano (GM 1), ~1.2 MB
└── docs/                      authoritative specifications (rebuild source of truth)
```

---

## Documentation map (the rebuild index)

The docs in `docs/` are the source of truth. To rebuild a module, find its
row in the table below and read the listed doc(s).

| Doc | Covers | Source files to rebuild |
|---|---|---|
| [`docs/instruction.md`](docs/instruction.md) | Tech stack, master architecture, settings schema, phase roadmap | All — read first for the big picture |
| [`docs/features.md`](docs/features.md) | User-facing features F1–F28+, build-status flags, flows | `js/ui-controller.js` behaviour, mode buttons, transport, exercise player |
| [`docs/ui_design.md`](docs/ui_design.md) | HTML structure, CSS variables, color palette, typography, page inventory | `app/index.html`, `app/css/styles.css`, `app/css/components.css` |
| [`docs/audio_engine.md`](docs/audio_engine.md) | Web Audio graph, master chain, tanpura/swar/tabla/aux buses, routing rules | `app/js/audio-engine.js` |
| [`docs/tanpura.md`](docs/tanpura.md) | Pluggable engine architecture, concert mode, jivari DSP, sample loop trim, A/B buses | `app/js/tanpura.js`, `app/js/tanpura-electronic-engine.js`, `app/js/tanpura-sample-engine.js` |
| [`docs/tabla_and_taals.md`](docs/tabla_and_taals.md) | Bols, taal cycle/vibhag, theka, sam/tali/khali, sample-player ref-freq, taal variation editor | `app/js/tabla.js`, `app/js/tabla-samples.js`, `app/js/taal-engine.js`, `THAAT_DEFINITIONS`/`TAAL_DEFINITIONS` in `config.js` |
| [`docs/alankaars.md`](docs/alankaars.md) | Pattern catalog, compact-pattern grammar, generator, taal-fitting, range clamp | `app/js/alankaar-engine.js` |
| [`docs/thaats_and_raags.md`](docs/thaats_and_raags.md) | 10 thaats with position-to-swara alteration maps; raag system spec (not yet built) | `THAAT_DEFINITIONS` in `app/js/config.js`, `app/js/music-engine.js` |
| [`docs/frequency_mapping.md`](docs/frequency_mapping.md) | Just-intonation `SWAR_RATIOS`, `KEY_FREQUENCIES`, saptak multipliers | `KEY_FREQUENCIES`, `SWAR_RATIOS`, `SAPTAK` in `app/js/config.js` |
| [`docs/written_music.md`](docs/written_music.md) | Notation rules — flute positions 1–15, swara labels, ornaments, laykari, Hindi/English | `app/js/music-engine.js` (`getPositionLabel`, `getPositionSwara`), `config.js` notation tables |
| [`docs/practice_curriculum.md`](docs/practice_curriculum.md) | Session structure, demo/practice/test mode semantics | `app/js/practice-session.js`, `app/js/practice-tracker.js` |

> A capable code-gen LLM should be able to use this table alone to decide
> which doc to load when rebuilding a given file.

---

## Key data shapes (brief)

Full schemas live in `docs/instruction.md § Settings Schema` and the
specific feature docs. Quick summary:

- **`settings`** (`STORAGE_KEYS.SETTINGS`, defaults from
  `PRACTICE_DEFAULTS` in `config.js`) — `key`, `tempo`, `saptak`, `thaat`,
  `taal`, `taalVariation`, `laykari`, `notation`; tanpura
  (`tanpuraEngine`, `tanpuraPattern`, `tanpuraSpeed`, `tanpuraConcertMode`,
  `tanpuraJivariA/B`, `tanpuraBalance`, `tanpuraVolumeOverall`); tabla
  (`tablaSource`, `tablaVolume`, `tablaBassEQ`, `tablaTrebleEQ`,
  `tablaBalance`, `tablaTimber`, `tablaReverb`); swar (`swarVolume`,
  `swarVoice`, `swarVoiceVolumes`); `currentExerciseId`. See
  `audio_engine.md` and `tanpura.md` for the meaning of each field.
- **`exercise`** (`STORAGE_KEYS.EXERCISES`) — `id` (`<taalId>_<b|i|a><n>`),
  `name`, `taalId`, `rangeStart`/`rangeEnd` (1–15), `laykari`,
  `competency`, `patternType` (`compact` | `legacy`), `compactNotation`,
  `beatStructure`, generated `arohaCycles`/`avarohaCycles`. See
  `alankaars.md` for the grammar and generator.
- **`taal variation`** (`STORAGE_KEYS.TAAL_VARIATIONS`) — `id`, `taalId`,
  `name`, per-matra `bols[]` (max 4 per matra), per-matra `accents[]`. See
  `tabla_and_taals.md`.
- **`profile`** (`STORAGE_KEYS.PROFILE`) — `name`, `avatar`, `createdAt`,
  baseline `targets` (`dailyMinutes`, `weeklyHours`),
  `weeklyTargetOverrides` keyed by ISO week. See `practice_curriculum.md`.
- **`activity`** (`STORAGE_KEYS.ACTIVITY`) — rolling log: `daily` (last
  30 days), `weekly` (last 26 weeks), `monthly` (forever), `streak`
  (`current`, `longest`, `lastActiveDate`). Both `appSec` (5-min idle
  cutoff) and `exerciseSec` are tracked separately. See
  `practice_curriculum.md`.

---

## Runtime dependencies

All assets are bundled — no CDN, no npm install. Loaded as follows:

- **WebAudioFont presets** (`app/webaudiofont/`, ~1.8 MB total across 4
  files) — `WebAudioFontPlayer.js` plus 4 SoundFont JS files (Harmonium /
  Strings / Guitar / Piano). Loaded via `<script>` tags in `index.html`;
  exposes globals (`WebAudioFontPlayer`, `_tone_0210_…`, etc.). Notes are
  scheduled via the player at playback time. See `swar-synth.js`.
- **Tabla MP3 sample sets** — `tabla_e_1` (16 bols, ref Sa = E3 / 164.81
  Hz) and `tabla_c_1` (16 bols, ref Sa = C4 / 261.63 Hz, from Naad/MIT).
  Loaded on-demand when source changes via `fetch()` +
  `audioCtx.decodeAudioData()`; **eagerly decoded at engine init**, never
  lazily on first beat. Dayan bols pitch-shift by `userSa /
  referenceFreq`; bayan bols (`Ga, Ge, Ghe, Ka, Kat, Ke`) are
  pitch-locked. See `tabla-samples.js`.
- **Tanpura MP3 set** — `tanpura_1` (24 files: 12 keys × 2 patterns,
  Pa-Sa and Ma-Sa). Loaded by `tanpura-sample-engine.js` on init and on
  engine swap; loop region trimmed (`loopStart = 1.5s`, `loopEnd =
  duration - 3s`) to skip head/tail fade zones. Decoded eagerly. Ni-Sa
  not yet sourced.
- **Accent samples** — `assets/audio/other/{manjira_1, manjira_2,
  ghungroo_1, tali_1}.mp3` (wired in `accents.js`; routed through the
  tabla input node).
- **Google Fonts** (Inter, Noto Sans Devanagari) — imported in
  `styles.css`. No offline fallback yet.

---

## Mobile audio stability (critical invariants)

These constraints must be preserved by any rebuild — they are the result of
real Android Chrome stability work and removing them causes audible
cracking and underruns. Source: `audio-engine.js`, `tanpura.js`,
`accents.js`, `background-audio.js`.

- **`AudioContext` is created with `latencyHint: 'playback'`**, sample
  rate 44100. Larger buffer sizes; latency cost (~50–100ms) is
  imperceptible for a practice app, stability gain is large on mobile.
- **Swar and auxiliary buses route through `dryMix`, NOT through the
  compressor or convolver.** The `compressor` node exists but is
  orphaned. `reverb` (synthetic 1s room IR) is connected to `masterGain`
  but only fed by the on-demand tabla reverb send.
- **In single-mode tanpura, the active engine's `outputGain` connects
  directly to `masterGain`** — bypassing `tanpuraGainA`, `panA`, and
  `tanpuraBusGain`. Concert mode is the only path that uses the A/B bus
  topology.
- **All audio assets are pre-decoded at engine / player init**, never
  lazily. `decodeAudioData` is async and CPU-intensive; doing it on the
  first beat causes an audible glitch.
- **Accents share the tabla input node.** Accent `AudioBufferSource`s
  connect to `tablaGain`, not a new chain. No new graph topology per
  matra.
- **`background-audio.js` runs three keep-alive mechanisms** when any
  audio source is active (ref-counted via `activate(source)` /
  `deactivate(source)`): a 30-second silent stereo WAV looped through an
  `<audio>` element so the OS treats the tab as "playing media";
  `navigator.mediaSession.metadata` + no-op action handlers; a screen
  Wake Lock. Required for PWA-on-Android background playback.

---

## Rebuild order (suggested sequence)

Build modules in this order so dependencies resolve cleanly. Read the
relevant doc(s) from the table above before writing each file.

1. **`config.js`** + **`storage.js`** — no deps. Establishes constants,
   storage keys, defaults.
2. **`music-engine.js`** — depends on `config.js`. Frequency / thaat /
   swara math.
3. **`audio-engine.js`** — depends on `config.js`. AudioContext +
   master signal chain. Read `audio_engine.md` and obey the mobile
   invariants above.
4. **`tabla-samples.js`** + **`tabla.js`** — depend on `audio-engine`.
   Sample loader and electronic synth.
5. **`tanpura-sample-engine.js`** + **`tanpura-electronic-engine.js`** +
   **`tanpura.js`** — depend on `audio-engine` (and on each other via
   the controller). Read `tanpura.md`.
6. **`swar-synth.js`** + **`accents.js`** — depend on `audio-engine` and
   on globals exposed by `webaudiofont/*.js` (loaded via `<script>`
   tags in `index.html`).
7. **`taal-engine.js`** — depends on `config.js`. Lookahead beat
   scheduler with sam/tali/khali classification.
8. **`practice-tracker.js`** + **`profile.js`** — depend on `storage.js`.
9. **`alankaar-engine.js`** — depends on `config.js` and `music-engine.js`.
   Read `alankaars.md` for the compact-pattern grammar.
10. **`background-audio.js`** — standalone (uses `<audio>` element,
    MediaSession, Wake Lock). Ref-counted activate/deactivate.
11. **`practice-session.js`** — depends on `taal-engine`, swar/tabla
    engines, and the scheduler. Note: it does **not** import `tanpura.js`
    — tanpura is UI-managed.
12. **`ui-controller.js`** — depends on everything. ~4000 lines of UI
    bindings. Read `features.md` and `ui_design.md`.
13. **`app.js`** — entry point. Reads settings, calls `initUI`, wires
    gesture-gated `audioEngine.init()` + `audioEngine.resume()`, starts
    `practiceTracker`. See `app/js/app.js` for the exact bootstrap
    pattern.
14. **`css/styles.css` + `css/components.css` + `index.html`** — can
    proceed in parallel; driven by `ui_design.md`.

---

## Acceptance criteria

A rebuild passes if all of the following hold:

- Loads in modern Chrome with **no console errors**.
- The first click or touch unlocks the `AudioContext` (no autoplay-policy
  warnings on subsequent playback).
- Tapping the Tanpura tile after selecting a key plays the tanpura drone
  and **loops cleanly** (no click at loop boundary; sample engine trims
  head/tail).
- The Tabla tile plays the selected taal at the correct tempo, with the
  **sam highlighted** in the beat grid on every cycle start.
- Saved exercises load from `localStorage`; opening the exercise player
  produces the correct **swara notes** (positions resolve through
  `getPositionSwara` for the current thaat).
- On a **mid-range Android** device, tanpura + tabla + swar playing
  simultaneously **does not crack** (verifies the mobile invariants).
- The **practice tracker** logs daily `appSec` (5-min idle cutoff) and
  `exerciseSec` separately, and they appear on the Profile page.
- **Export then Import** of the JSON backup roundtrips all
  `swaradhana_*` `localStorage` keys without data loss.

---

## License / attribution

Code: **MIT License** © 2026 Arun Mahapatro (see `LICENSE`).

Audio assets carry per-folder `CREDITS.md`:

- `app/assets/audio/tanpura/tanpura_1/` — tanpura drones from Rāga
  Junglism (open-access). See `tanpura_1/CREDITS.md`.
- `app/assets/audio/tabla/tabla_c_1/` — from
  [Naad](https://github.com/oormicreations/naad) by Oormi Creations,
  **MIT**. First variant per bol; dayan bols pitch-normalised to C4
  during asset prep. See `tabla_c_1/CREDITS.md`.
- `app/assets/audio/tabla/tabla_e_1/` — original bundled set, ref Sa = E3.
- `app/webaudiofont/` — SoundFont data from the WebAudioFont project
  (FluidR3, Aspirin, Chaos). Each file carries its own license header.

If you redistribute the app, retain these `CREDITS.md` files.

---

## Author

**Arun Mahapatro.** Personal project. Open an issue for bugs / feature
requests.
