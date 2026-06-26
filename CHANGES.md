# Changes

This document captures a batch of changes to the alankaar engine, the exercise
designer/player, and the addition of a Metronome taal, plus a Play control in
the Taal Variation Editor.

## Files changed

Copy these four files together — they are interdependent (`ui-controller.js`
imports `generateFromSeed` from `alankaar-engine.js` and references the
`metronome` taal in `config.js`):

- `app/index.html`
- `app/js/config.js`
- `app/js/alankaar-engine.js`
- `app/js/ui-controller.js`

Everything else (other JS modules, CSS, assets, `webaudiofont/`) is unchanged.

> After copying, serve `app/` and **hard-reload** (or use a no-cache static
> server) — ES modules cache aggressively, so a stale `ui-controller.js` will
> show the new HTML without the new behavior.

---

## 1. Taal Variation Editor — looping Play button

- Added a **Play / Stop** toggle in the editor header (`app/index.html`).
- Plays the variation being edited as a **continuous loop** (distinct from the
  existing one-shot Preview), reading bols/accents from the live working copy,
  so edits are heard on the next cycle without restarting.
- Entering the editor stops any taal running from the main screen.
- The currently sounding **matra cell is highlighted** in time with the audio.
- Leaving the editor (Save / Cancel / Back / Delete) stops playback and clears
  the highlight.

## 2. Audio-synced visual highlighting

Per-beat visuals (cell highlights, exercise strip) previously drove off the
taal engine's 200 ms scheduling lookahead, drifting ~0.2 s out of sync.

- Added a shared **note-queue + `requestAnimationFrame`** scheduler
  (`_scheduleVisualBeat` / `_clearVisualBeats`).
- Visuals now fire against the audio clock, **~0.05 s ahead** of the audible
  beat (`VISUAL_BEAT_LEAD`), with output-latency compensation
  (`outputLatency` / `baseLatency`).
- Applied to the taal editor highlight, the on-screen exercise strip, and the
  exercise player table. Co-located visuals (strip + beat-grid, player table +
  strip) ride the same queued update so they can't drift apart.

## 3. Alankaar engine overhaul (`alankaar-engine.js`)

### Avaroha is now a true vertical reflection
The avaroha is the aroha reflected about the midpoint of its range
(`p → peak + valley − p`), keeping the rhythmic skeleton — `_` sustains,
`.` rests, and `[..]` multi-note grouping — **in place**, and mapping identical
beats to identical beats (e.g. `[12][12]` → `[P'm'][P'm']`). It begins at the
peak and descends. (Earlier approaches reversed the note stream, which scrambled
sustains/rests and repeated beats.)

### Unified seed-based generation: `generateFromSeed`
Both extension modes now share one engine; they differ only in the per-repetition
shift:

| Mode | Shift | Meaning |
|---|---|---|
| **first+1** | `1` | next phrase starts +1 above the previous phrase's **first** note (overlapping climb) |
| **last+1** | `last − first + 1` | next phrase starts +1 above the previous phrase's **last** note (non-overlapping blocks) |

- The seed may be **shorter than the taal** (any length). It tiles — notes *and*
  rhythm together — across the playable range until the peak reaches the **End
  note** (a hard cap), with out-of-range notes silenced.
- Phrases may straddle cycle boundaries when the seed length is not a factor of
  the taal's matra count.
- The old strict `generateFromCompactPattern` (full-cycle, Mode A) was removed;
  `generateFromCompactPatternLastPlusOne` is now a thin wrapper over
  `generateFromSeed`.

### Continuous aroha → avaroha with vibhag-aligned junctions
The exercise is one continuous line rather than two separate cycle arrays that
each restart on sam:

- The aroha is rest-padded only to the **next vibhag boundary**, then the avaroha
  is appended — so the avaroha starts at the next vibhag with no wasted cycle.
- The repeating **block** = aroha → (rest to vibhag) → avaroha → (rest to vibhag).
  Both the internal junction and the block end land on vibhag boundaries.
- The block is repeated to the next whole number of taal cycles (LCM with the
  cycle length) so the exercise **loops on sam**. When the block isn't itself a
  whole cycle, the alankaar shifts within the taal across blocks (expected) — but
  every section transition stays on a vibhag boundary.
- `generateFromSeed` returns `avarohaStartMatra` and `blockMatras`; the player,
  strip, preview, and labels derive Aroha / Avaroha / "Aroha → Avaroha"
  block-relative (`matra % blockMatras` vs `avarohaStartMatra`). Both fields are
  persisted with saved exercises.

## 4. Metronome taal

A single repeating beat with a **user-selected tabla bol** and **no
vibhag/cycle/avartan structure** — exercises composed on it flow continuously
(aroha straight into avaroha and back, no breaks).

- **Definition** (`config.js`): `metronome` taal — `beats: 1, vibhag: [1],
  tpiSequence: ['X'], isMetronome: true`; plus `PRACTICE_DEFAULTS.metronomeBol`
  (default `Na`).
- **Bol picker**: the metronome's detail page shows the 13 tabla bols
  (Dha, Dhin, Ta, Na, Tin, Ti, Ge, Ke, Ka, Re, Tu, Ddhi, Ga); tapping one
  sets/persists `settings.metronomeBol` and auditions it. Variations/theka are
  hidden for the metronome.
- **Playback**: `_getActiveBols('metronome')` returns the chosen bol on the one
  beat; no accents. With 1 matra, the vibhag-padding and block-repeat collapse
  automatically, so the alankaar is break-free and loops seamlessly.
- **Generation guard**: `generateFromSeed` skips the seed-length check for the
  metronome (no cycle to fit the seed into).
- **Display**: a Metronome exercise renders as one continuous **wrapping note
  grid** (~8 per row, no vibhag/cycle lines) in both the preview and the player
  table, with the aroha start tinted as sam and the avaroha start as a divider.
  The on-screen scrolling strip works as-is.
- The taal list and the exercise designer's taal dropdown pick up the metronome
  automatically; the variation switcher auto-hides (no variations).
- Practice mode plays the metronome continuously (no per-beat turn-swaps).

### Metronome limits / notes
- The metronome preview grid is **read-only** (inline cell-editing isn't wired
  for it) — regenerate to change the pattern.
- For a metronome exercise, type a **flat note sequence** (e.g. `123`); spaces
  are optional visual grouping only.

## 5. Manual / blank-cycle composition (all exercises editable)

The exercise designer and edit page can now build an exercise **by hand**, not
just from a seed:

- **"+ Add blank cycle"** (on both the designer and edit panels, alongside the
  Generate buttons) creates an exercise with one empty taal cycle, or appends
  another. A blank cycle is a full taal cycle of empty matras, so vibhag/cycle
  boundaries are inherent. On the Metronome the button reads **"+ Add note"** and
  adds a single note cell, auto-selecting it so the note picker opens for fast
  chaining.
- A hand-composed exercise has no aroha/avaroha split (`extensionMode: 'manual'`,
  `avarohaStartMatra: null`); previews, the player and the strip label its cycles
  simply **"Cycle N"** (no Aroha/Avaroha). Playback just loops the cycles.
- The existing **inline cell editor** (tap a matra → pick swara(s) / rest `·` /
  sustain `—`) now also works on the **Metronome grid**, which is no longer
  read-only. Each metronome note is its own 1-matra cycle and maps cleanly to the
  same editor.
- Each cycle's label has an **× remove** control; the Metronome note picker has a
  **"✕ Remove note"** action. Trailing never-filled note cells are trimmed on
  save (Metronome).
- You can also append blank cycles onto a seed-generated exercise to extend it
  (its existing Aroha/Avaroha labels are left as-is for the generated part).

## 6. Human-voice (sargam vocal) swar playback

A new **"Vocal (Sargam)"** swar voice plays recorded human snippets for the
swaras, like a sustaining instrument.

- **New module `js/vocal-engine.js`** — an attack + sustain-loop sampler. A note
  plays the recorded attack once, then **loops a stable sustain region**
  (`AudioBufferSourceNode` `loop`/`loopStart`/`loopEnd`) to hold it for any
  duration. Loop points trim trailing silence and snap to zero crossings to
  reduce clicks (tunable via `ATTACK_KEEP` / `LOOP_LEN`).
- **Pitch** — samples were recorded at madhya Sa = C# and are played at their
  **recorded pitch (playbackRate 1.0)** — the vocal is deliberately **not**
  transposed to the user's key. Per note only the *file* is chosen, by the note's
  swara + octave (from the notation), so komal/teevra/octave variants are sung
  correctly in **every thaat**.
- **Assets** — 25 `.wav` files in `assets/audio/vocal/` (mandra P/D/N, full
  chromatic madhya, taar up to Pa, with komal `_k` / teevra `_t` variants).
  Filename pattern: `{Swara}[_k|_t]_{lower|middle|higher}.wav`.
- **Integration** — Vocal is just another entry in the existing multi-voice swar
  system (`settings.swarVoice`), with its own checkbox + volume slider. In
  `SwarSynth.playNote` the `vocal` voice dispatches to the vocal engine instead
  of a WebAudioFont preset; `setVoice` lazy-loads the samples when selected. So
  it works everywhere swaras play (exercises, swar page, etc.) with no other
  changes. It can be layered with other voices or used alone.

### Vocal notes / tuning
- The vocal is **not** key-transposed by design — it sings at the recorded C#
  pitch regardless of the selected key (so it can sound in a different key than
  the tanpura/other voices; that's intended).
- Octave is taken from the notation marker (`,` mandra, `'` taar); the saptak
  setting does not shift the vocal octave.
- If a held note's sustain pulses or ticks, tune `ATTACK_KEEP` / `LOOP_LEN` or
  the loop-point logic in `vocal-engine.js`.
- One asset filename is lowercase (`d_k_lower.wav`); the engine references it
  explicitly, but renaming to `D_k_lower.wav` keeps the set consistent.

## Compatibility

- Exercises **saved before** these changes use the older layout (separate
  avaroha array, no `avarohaStartMatra` / `blockMatras`); they still render and
  play via legacy fallbacks. **Regenerate** them to adopt the continuous /
  vibhag-aligned / metronome behavior.
