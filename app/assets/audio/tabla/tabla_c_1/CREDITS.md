# tabla_c_1 — Sample Attribution

Tabla bol samples in this directory are derived from the **Naad** open-source
tabla composer by Oormi Creations:

- Source: https://github.com/oormicreations/naad (folder `Bol/`)
- License: **MIT License** © Oormi Creations and Contributors

The MIT license is reproduced in `LICENSE.txt` in the Naad repo; a short
attribution to Oormi Creations in Swaradhana's about/credits screen is
sufficient to comply.

## Processing applied

For each Naad bol folder, the first variant (`*01.wav`) was selected and
processed as follows:

1. **Dayan bols** (Ta, Na, Tin, Ti, Tu) were pitch-normalised to a common
   reference of **C4 = 261.63 Hz** via linear-interpolation resampling so
   that a single playback-rate shift at runtime tracks the user's global Sa
   for all dayan bols uniformly.
2. **Bayan bols** (Ga, Ge, Ke) were left at their recorded pitch — the
   bayan stays fixed near C/C# regardless of the user's selected key.
3. **Composite bols** (Dha, Dhin, Dhi) kept their native tuning; the dayan
   component sits at C4 naturally because they were recorded on the same
   tabla as Ta/Na.
4. All files converted from WAV to MP3 (128 kbps) via `lameenc`.

## Files

Primary files (direct mapping to Naad source):

| File | Source in Naad | Role |
|---|---|---|
| `Dha.mp3` | `Bol/Dha/Dha01.wav` | composite (pitch-shift with key) |
| `Dhin.mp3` | `Bol/Dhin/Dhin01.wav` | composite |
| `Dhi.mp3` | `Bol/Dhit/Dhit01.wav` | composite |
| `Ta.mp3` | `Bol/Ta/Ta01.wav` (pitch-shifted −6¢) | dayan |
| `Na.mp3` | `Bol/Na/Na01.wav` (pitch-shifted −6¢) | dayan |
| `Tin.mp3` | `Bol/Tin/Tin01.wav` (pitch-shifted −16¢) | dayan |
| `Ti.mp3` | `Bol/Ti/Ti01.wav` (pitch-shifted +25¢) | dayan |
| `Tu.mp3` | `Bol/Tun/Tun01.wav` (pitch-shifted −145¢) | dayan |
| `Ga.mp3` | `Bol/Ga/Ga01.wav` | bayan (fixed) |
| `Ge.mp3` | `Bol/Ge/Ge01.wav` | bayan (fixed) |
| `Ke.mp3` | `Bol/Ke/Ke01.wav` | bayan (fixed) |

Duplicates added to cover Swaradhana's full bol set (taal definitions):

| Duplicate | Copied from | Rationale |
|---|---|---|
| `Ghe.mp3` | `Ge.mp3` | same bayan open stroke, alt spelling |
| `Ka.mp3` | `Ke.mp3` | closed dayan slap approximated by closed bayan |
| `Kat.mp3` | `Ke.mp3` | closed hit |
| `Te.mp3` | `Ti.mp3` | closed dayan stroke |
| `R.mp3` | `Ta.mp3` | dayan slap |

If these duplicates don't sound right in practice, replacing them with
better-matched source recordings is a file-only change (no code edits).
