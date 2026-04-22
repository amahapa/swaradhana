<<<<<<< HEAD
# Swaradhana

A browser-based Hindustani Classical Music practice app for bansuri (bamboo
flute) players — and anyone who needs a programmable tanpura + tabla
companion. Runs as a static web app (no build step), installs as a PWA on
Android.

**Author:** Arun Mahapatro · **License:** MIT (see `LICENSE`)

---

## What it does

- **Tanpura drone** — two pluggable engines (synthesised or recorded MP3
  samples) with working real-time jivari. Concert mode plays dual
  tanpuras panned L/R with a small detune, like sitting between two real
  drones.
- **Tabla** — taal engine with 10 built-in taals (Teentaal, Ektal,
  Keherwa, Deepchandi, Rupak, Bhajani, Khemta, Dadra, Jhumra, Dhamar),
  editable bol variations, and two sample sets (tabla_e_1 in E,
  tabla_c_1 in C from Naad/MIT) plus electronic synthesis. Dayan
  pitch-shifts with the user's Sa; bayan stays fixed.
- **Alankaar / swar engine** — programmable pattern generator (compact
  notation), mixed-laykari support (`[22]` = dugun, `[333]` = tigun),
  sustain notation (`_`), auto-fits to any taal.
- **Exercise system** — create, name, save, edit exercises. Demo and
  Practice modes. Automatic pattern generation over any flute range.
  Exercises are grouped by taal in the library with collapsible sections.
- **Practice tracker + Profile page** — the app records time spent in the
  app (with 5-minute idle cutoff) and time spent in active practice,
  separately. Profile page shows Today / Last-30-days (daily bars) /
  Last-6-months (weekly) / Lifetime (monthly) trends, current + longest
  streak, and a target meter. Editable per-profile daily/weekly targets
  plus per-week overrides. Activity auto-rolls up from daily → weekly →
  monthly so the log never bloats. Export JSON/CSV or reset.
- **Background-audio on mobile** — keeps the tanpura / tabla / exercise
  playing with the screen off via silent-loop + MediaSession + Wake Lock.
  Works best when installed as a PWA on Android.
- **Full configurability** — 10 thaats, 12 bansuri keys, fine-tuning in
  cents, saptak switching, multi-voice swar synth with 4 built-in
  WebAudioFont presets + custom instrument upload.
- **Responsive design** — three mobile breakpoints (640 / 480 / 380 px)
  scale typography and tighten spacing; the 2-column settings grid
  survives even on iPhone SE.

Target users: individual bansuri / vocal practitioners who want a
configurable, offline-capable practice companion.

---

## Run it

### Quickest — local server

```bash
cd app
python3 -m http.server 8000
# open http://localhost:8000
```

No build step, no dependencies. Any static server works.

### Install on Android

See the PWA section below. TL;DR — host on GitHub Pages / Netlify, open
in Chrome on your phone, tap "Install app" from the menu.

---

## Project layout

```
Swaradhana/
├── README.md              (this file)
├── app/                   the full web app — deployable as-is
│   ├── index.html         single-page UI
│   ├── manifest.json      PWA manifest (standalone, portrait)
│   ├── js/
│   │   ├── app.js                         entry point
│   │   ├── config.js                      constants, settings defaults
│   │   ├── music-engine.js                frequency / thaat / swara math
│   │   ├── audio-engine.js                Web Audio graph singleton
│   │   ├── taal-engine.js                 lookahead beat scheduler
│   │   ├── tabla.js                       electronic tabla synth
│   │   ├── tabla-samples.js               sample-based tabla (per-set ref freq + GAIN_BY_SET)
│   │   ├── tanpura.js                     tanpura controller (pluggable engines)
│   │   ├── tanpura-electronic-engine.js   additive synth (PeriodicWave)
│   │   ├── tanpura-sample-engine.js       MP3 playback + real jivari DSP
│   │   ├── swar-synth.js                  WebAudioFont melodic synth
│   │   ├── alankaar-engine.js             pattern generator / taal fitter
│   │   ├── practice-session.js            session orchestrator
│   │   ├── practice-tracker.js            app-time + exercise-time log (daily → weekly → monthly)
│   │   ├── profile.js                     name / avatar / targets / per-week overrides
│   │   ├── background-audio.js            mobile keep-alive (silent loop + MediaSession + Wake Lock)
│   │   ├── ui-controller.js               all UI bindings
│   │   └── storage.js                     localStorage wrapper
│   ├── css/                styles.css + components.css (custom CSS, no framework)
│   ├── assets/
│   │   ├── audio/
│   │   │   ├── tabla/tabla_e_1/            tabla samples tuned to E
│   │   │   ├── tabla/tabla_c_1/            tabla samples tuned to C (Naad, MIT)
│   │   │   └── tanpura/tanpura_1/          tanpura drones, 12 keys × 2 patterns
│   │   └── icons/                          PWA + in-app icons
│   └── webaudiofont/       SoundFont files for the swar synth (Harmonium, Strings, Guitar, Piano)
└── docs/                   full specification docs — see below
```

---

## Specification (for regeneration / deep reference)

Everything the app does is specified in `docs/`. The docs are the
authoritative source; the code follows them. A capable code-gen LLM
should be able to rebuild the app from these specs alone.

| Doc | What it covers |
|---|---|
| [`docs/instruction.md`](docs/instruction.md) | Master build instructions, tech stack, file list, audio signal chain, settings schema, phase roadmap |
| [`docs/audio_engine.md`](docs/audio_engine.md) | `AudioEngine` singleton, signal graph, tanpura bus layout, balance/pan/volume math, scheduler |
| [`docs/tanpura.md`](docs/tanpura.md) | Pluggable engine architecture (controller + electronic + sample), concert mode, jivari DSP, notation conventions |
| [`docs/tabla_and_taals.md`](docs/tabla_and_taals.md) | Bols, taal concepts, 10 built-in taals, bol variation system, sample-player architecture with per-set reference frequency |
| [`docs/alankaars.md`](docs/alankaars.md) | Pattern catalog, generation algorithm, boundary handling, taal fitting |
| [`docs/thaats_and_raags.md`](docs/thaats_and_raags.md) | 10 thaats with pre-computed position tables |
| [`docs/frequency_mapping.md`](docs/frequency_mapping.md) | Just intonation ratios, key frequencies |
| [`docs/written_music.md`](docs/written_music.md) | Notation rules (swaras, flute positions, laykari, ornaments) |
| [`docs/features.md`](docs/features.md) | Full feature specs F1–F27 with build status |
| [`docs/ui_design.md`](docs/ui_design.md) | Color palette, typography, layout patterns |
| [`docs/practice_curriculum.md`](docs/practice_curriculum.md) | Session structure guidance |

---

## Tech stack

- **Vanilla JavaScript** (ES modules), no build step.
- **Web Audio API** for all audio synthesis, scheduling, and sample
  playback.
- **WebAudioFont** for the melodic swar synth (4 SoundFont presets).
- **localStorage** for persistence (settings, exercises, taal variations,
  profiles).
- **PWA manifest** for installable-app behaviour on mobile.
- Custom CSS with variables — no UI framework.

See `docs/instruction.md § Tech Stack` for the full rationale.

---

## Install as an Android app (PWA)

1. Push `app/` to any static host with HTTPS. GitHub Pages works — point
   Pages at `app/` or copy `app/` contents into a `gh-pages` branch.
   Netlify Drop or Cloudflare Pages also work.
2. Open the hosted URL in Chrome on Android.
3. Menu → **Install app** (or **Add to Home screen**). The Swaradhana
   icon appears in your app drawer. Launches full-screen, portrait, dark
   theme — from the `manifest.json`.
4. First tap inside the app unlocks the `AudioContext` (browser autoplay
   policy).

Note: a service worker (`sw.js`) for full offline support is planned but
not yet built; the app needs internet on first load until then.

For a genuine `.apk` file (Trusted Web Activity), feed the hosted URL
into [pwabuilder.com](https://www.pwabuilder.com/) or use Google's
`bubblewrap` CLI — it wraps the same PWA into an installable Android
package.

---

## Audio assets and credits

All bundled audio files carry a `CREDITS.md` alongside them with origin
and license information:

- **`app/assets/audio/tanpura/tanpura_1/`** — tanpura drones
  (Pa-Sa and Ma-Sa, 12 keys each). Source: Rāga Junglism (open-access).
  See `tanpura_1/CREDITS.md` for attribution text.
- **`app/assets/audio/tabla/tabla_c_1/`** — tabla bol samples. Source:
  [Naad](https://github.com/oormicreations/naad) by Oormi Creations,
  **MIT License**. First variant per bol; dayan bols pitch-normalised to
  C4 during asset prep. See `tabla_c_1/CREDITS.md`.
- **`app/assets/audio/tabla/tabla_e_1/`** — original bundled tabla set,
  reference Sa = E3.
- **`app/webaudiofont/`** — SoundFont data from the WebAudioFont project
  (FluidR3, Aspirin, Chaos). Each file carries its own license header.

If you redistribute the app, retain these `CREDITS.md` files and include
the attributions they list.

---

## Current status

Practical for daily use as a tanpura + tabla + swar companion with a
custom exercise library. Not all documented features are built yet —
see `docs/features.md` for a checklist (many items flagged `[BUILT]`,
others `[PARTIAL]` or `[NOT BUILT]`). Short list of things that work:

- Tanpura drone (both engines), concert mode, per-bus jivari, balance
- Tabla playback (electronic + both sample sets), taal variations
- Exercise designer, library, player, demo/practice modes
- Multi-voice swar synth with configurable instruments
- Full settings persistence, export/import, data management

Bigger items not yet built: pitch detection, scoring engine, competency
dashboard, Google Drive sync, raag system. Per-feature status in
`docs/features.md`.

### Recently added
- **Profile page + practice tracker** — daily/weekly/monthly activity
  bars, streak counter, editable targets with per-week override, JSON
  and CSV export.
- **Background audio on mobile** — tanpura/tabla/exercise now keep
  playing with the screen off (best when the app is installed as a PWA
  on Android). See `docs/features.md § F28`.
- **Responsive design** — three mobile breakpoints; the 2-column main
  settings grid survives even on iPhone SE.
- **Exercise naming convention** `<taalId>_<b|i|a><n>` (`teentaal_b1`,
  `keherwa_i3`, `deepchandi_a2`) with automatic one-time migration of
  older names.
- **Exercise library grouping** by taal, collapsible, sorted b → i → a.

---

## Development notes

- Use a no-cache dev server to avoid ES-module caching pain:
  ```python
  class H(SimpleHTTPRequestHandler):
      def end_headers(self):
          self.send_header('Cache-Control', 'no-store')
          super().end_headers()
  ```
- If you edit a module and the browser still runs the old code: hard
  refresh (`⌘⇧R` on macOS / `Ctrl⇧R` on Windows) or disable cache in
  DevTools → Network.
- All UI bindings live in `app/js/ui-controller.js` (large; ~4000
  lines). Adding a feature typically means editing that file plus one of
  the domain modules and `index.html`.

---

## License

Code: **MIT License** © 2026 Arun Mahapatro (see `LICENSE`).

Audio assets: see per-folder `CREDITS.md` — varies by source.

---

## Author

**Arun Mahapatro**

The app is a personal project. If you find a bug or want to propose a
feature, open an issue.
