# Swaradhana

**स्वर साधना** — *svara sādhanā*, "the discipline of notes."

**Author:** Arun Mahapatro · **License:** MIT (see `LICENSE`)

Swaradhana is a browser-based Hindustani classical music practice companion: a
programmable **tanpura** drone, a **tabla** engine with 10 taals, a melodic
**swar** synth, an **exercise (alankaar)** generator, and a practice tracker
with streaks and targets. It is built for bansuri players but works for any
Hindustani practice — vocal, sitar, sarod, harmonium, and more.

This README is a **user guide** — how to operate the app. (For the
architecture and rebuild specs, see the `docs/` folder.)

---

## Quick start

### Run locally

```bash
cd app
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works — there is no build step and no install.

### Install on your phone (PWA)

1. Host the `app/` folder on any HTTPS static host (GitHub Pages, Netlify,
   Cloudflare Pages), or open the local URL above on the same network.
2. **Android (Chrome):** menu (⋮) → **Install app** / *Add to Home screen*.
3. **iOS (Safari):** Share → **Add to Home Screen**.
4. Launches full-screen, portrait, dark theme.
5. **The first tap anywhere unlocks audio** (browser autoplay policy) — tap
   once before expecting sound.

**Background playback:** when installed as a PWA, audio keeps playing with the
screen off (Android is the most reliable; iOS is best-effort). Use this for
long tanpura/tabla practice sessions.

---

## The main screen

The main screen has a settings grid of tiles plus a transport row:

- **Key** (top-left) — your Sa. Tap to pick from 12 pitches and fine-tune in cents.
- **Saptak** — octave: Mandra (lower), Madhya (middle), Taar (upper).
- **Tempo** — BPM. Tap to open the tempo page; the small ▶ on the tile toggles tabla.
- **Thaat** — scale type (Bilawal, Kalyan, Khamaj, Bhairav, Bhairavi, Kafi, Asavari, Todi, Purvi, Marwa). Determines the swaras your note positions map to.
- **Taal** — rhythm cycle. The `‹ D ›` switcher cycles taal variations (see below).
- **Tanpura** — drone tuning. The small ▶ on the tile toggles the drone.
- **Transport row** — *Completed* (today's minutes) · *Target* (daily goal) · **Start / Pause / Stop**.
- **Exercise bar** — tap **Exercise** (left) to open the library; tap the exercise name (right) to open the player.

### Free practice (tanpura + tabla, no exercise)

1. Set **Key**, **Saptak**, **Thaat**, and **Tempo**.
2. Turn on **Tanpura** and/or **Tabla** (tile ▶ buttons), or just press **Start**.
3. **Start** plays the tabla theka at the current taal with the tanpura drone.
4. **Pause** freezes audio (the beat pointer holds); **Stop** ends and resets.
   After a pause, **Start** reads **Resume**.

---

## Setting up the sound

### Tanpura (Settings → Customize Tanpura)

- **Sound source** — *Electronic* (additive synth, all patterns) or a sampled set (recorded, with jīvārī DSP).
- **Pattern (first string)** — **Pa-Sa** or **Ma-Sa** (Ni where supported).
- **Speed** — drone cycle speed.
- **Concert mode** — off = single tanpura; on = dual A/B tanpuras (B panned right, slightly detuned), with a **Balance (L↔R)** slider.
- **Jivari A / B** — brightness of the buzzing overtone.
- **Reverb / Variance** — room ambience and subtle timing humanization.
- **Play / Stop** auditions the current configuration.

### Tabla (Settings → Customize Tabla)

- **Sound source** — *Electronic (synthesized)* or a real sampled set (e.g. Key of E, or Key of C from Naad).
- **Balance (Dayan ↔ Bayan)**, **Timber** (mellow↔bright), **Bass EQ**, **Reverb**.
- Sampled dāyāñ pitch-shifts to your key automatically; bāyāñ stays at recorded pitch.
- Set per-instrument **volume / EQ** under the master volume (🔊) page.

### Swar voice (Settings → Customize Swara)

- Pick one or more voices — **Harmonium, Strings, Guitar, Piano**, or **Vocal (Sargam)** (recorded human sargam). Selected voices layer together, each with its own volume.
- **Add a custom instrument** by pasting a WebAudioFont preset `.js` URL (from the WebAudioFont catalog) and naming it.

---

## Programming exercises (alankaars)

Exercises are melodic patterns that the app expands into a full ascent (āroha)
and descent (avaroha) across your chosen range, aligned to a taal.

### Create one

1. Main screen → **Exercise** → **+ New Exercise** to open the designer.
2. Set:
   - **Taal** — the rhythmic cycle (defaults to your current taal).
   - **Level** — Beginner / Intermediate / Advanced.
   - **Start Note** and **End Note** — flute positions **1–15** (4 = Sa, 8 = Pa, 11 = high Sa). The pattern tiles upward until it reaches the End Note ceiling.
3. Type a **pattern** (the compact seed — see below).
4. Tap a generator to expand it:
   - **First + 1** — each repeat shifts the seed's *first* note up by one (smooth, overlapping climb).
   - **Last + 1** — each repeat starts one above the *last* note (separated, blocky phrases).
   - The **avaroha (descent)** is generated automatically as a mirror of the āroha, keeping the same rhythm.
5. Review the **Āroha** and **Avaroha** preview tables. Tap any matra cell to tweak it by hand (chips + position palette; up to 4 notes per matra). A *Manually edited* badge warns that regenerating discards hand edits.
6. **Save** (updates the current exercise) or **Save As New** (fresh copy). It's auto-named like `teentaal_b1`, but you can rename it.

To build entirely by hand, skip the generators and use **+ Add blank cycle**,
then tap cells to fill them.

### Compact pattern notation

The pattern is a short seed of digits and symbols. Digits are **relative note
positions** within your range (1 = lowest played, ascending from there).

| Symbol | Meaning | Example |
|---|---|---|
| `1`–`9` | a note position | `1234` → four ascending notes |
| `.` | rest (silence on this beat) | `1.3` → note, rest, note |
| `_` | sustain (hold the previous note) | `12_3` → 1, 2 (held), 3 |
| `[…]` | 2–4 notes packed into one beat (mixed laykari) | `[12]34` → two notes on beat 1, then one each |
| space | visual grouping of vibhags (optional) | `1234 2345 3456` |

Examples to copy:

```
1234                         simple ascending scale (one note per beat)
12_3 23_4 34_5 45_6          each beat: two notes, second sustained
1234 2345 [34][45][56] 5678  dugun (two notes/beat) on the third group
1.3 .2.3 1234 5678           rests woven in
```

Rules: a pattern can't start with `_` (nothing to sustain yet); brackets hold
2–4 notes; only digits, `.`, `_`, `[]`, and spaces are allowed.

### Practice modes (Exercise Player)

Open the player by tapping the exercise name, then pick a mode:

- **Demo** — the app plays tanpura + tabla + the melody every cycle. You listen and follow the moving highlight.
- **Practice** — the app plays a phrase, then goes silent for one cycle (tabla + tanpura keep going) and shows a **Your Turn** cue so you play it back. Then it repeats.
- **Test** — placeholder (not yet active).

**Start / Pause / Stop** control playback. Leaving the player keeps audio
running; reopening it re-syncs to the current beat. **Clear Exercise** on the
library page unloads the exercise back to free practice.

---

## Creating taal variations

A **taal** is a repeating rhythmic cycle of beats (matras) grouped into vibhags,
with landmark beats — **sam** (the "1", amber), **tali** (accented, teal), and
**khali** (hollow/quiet, purple). The app ships 10 taals (Teentaal, Ektal,
Keherwa, Deepchandi, Rupak, Bhajani, Khemta, Dadra, Jhumra, Dhamar) plus a
single-beat **Metronome**.

A **variation** is your custom version of a taal's theka (the bol pattern). The
built-in default theka is read-only; your variations live alongside it.

### Create one

1. Main screen → tap the **Taal** tile → pick a taal → **+ New Variation** (or **Edit** an existing one).
2. Give it a **name**.
3. **Tap a matra cell** in the grid to select it (it highlights amber).
4. **Tap bols** from the palette (Dha, Dhin, Tin, Na, Ta, Ge, TiRaKiTa, …) to add them to that beat — **up to 4 bols per matra**. Tap a chip to remove it, or **Clear Matra** to empty the beat. Use the rest bol (`x`) for silence.
5. Optionally add **accents** (Manjira 1/2, Ghungroo, Tali) layered on the selected matra.
6. **Preview** plays one cycle; the header **Play / Stop** loops it continuously, highlighting the sounding matra — edit on the fly and the changes are heard next cycle.
7. **Save**. **Cancel** discards changes; **Delete** (on existing variations) removes it.

### Use a variation

- On the Taal Variations page, tap **Set Active** on the variation you want.
- Or use the **`‹ D ›`** switcher on the main-screen Taal tile to cycle through default + your variations. Switching variations keeps any loaded exercise (it only changes the tabla pattern, not the base taal).
- For the **Metronome**, instead of a variation editor you simply pick the single bol it should click.

---

## Exporting and importing

There are two levels: a full backup, and additive per-item transfers.

### Full backup (everything)

- **Settings (⚙️) → Export Data** downloads `swaradhana_backup_<date>.json` containing all your settings, exercises, taal variations, profile, activity, and custom instruments.
- **Settings → Import Data** restores from such a file (this **overwrites** current data after a confirmation).
- **Settings → Clear All Data** wipes everything (double-confirmed, irreversible).

Use this before reinstalling your browser or switching devices.

### Per-item (additive merge — never overwrites unrelated items)

Use this to move a single exercise or variation between devices safely:

- **Exercises** — Exercise Library → **Export** downloads your exercises as JSON; **Import** merges them back **by id** (new ones are added, matching ids update, everything else is left alone).
- **Taal variations** — open a taal's Variations page → **Export** / **Import** works the same way, merging by id.

Because the merge is keyed by id, importing onto another device adds or updates
only the items in the file and never disturbs the rest of your library.

---

## Profile and practice tracking (👤)

- **Identity** — name, avatar, and a "practicing since" date.
- **Today** — app time, exercise (practice) time, and your 🔥 streak (current + best).
- **Targets** — a **daily minutes** and **weekly hours** goal, with an optional *override for this week only*. The transport row's *Target* reflects this.
- **Charts** — last 30 days, last 6 months, and lifetime, each stacking total app time vs. exercise time.
- **Export** your activity as **JSON** or **CSV**, or **Reset history** (keeps your name/targets).

---

## License / attribution

Code: **MIT License** © 2026 Arun Mahapatro (see `LICENSE`).

Audio assets carry per-folder `CREDITS.md` (tanpura drones, tabla sample sets
from Naad/Oormi Creations, and WebAudioFont SoundFont data). Retain these
`CREDITS.md` files if you redistribute the app.

---

## Author

**Arun Mahapatro.** Personal project. Open an issue for bugs / feature requests.
