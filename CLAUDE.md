# Perforated Atlas

A museum-quality browser artwork about urban water memory in Ho Chi Minh City.
A visitor types a memory of water in the city; the sentence is translated into a
perforated music-box strip (Sankyo 30-note), which scrolls across a canvas and
plays as it passes a brass comb read-head.

**Privacy lock: the original text is NEVER stored. Only the pattern (notes),
palette, and length are kept.** The translation is one-way and lossy by design.

---

## Concept lock

| Element        | Locked decision                                                    |
| -------------- | ------------------------------------------------------------------ |
| Instrument     | Sankyo 30-note music box (fixed 30-pitch layout, see below)        |
| Medium         | Perforated paper strip, scrolled past a fixed comb read-head       |
| Input          | Free text, any of vi / ko / en (others -> unknown)                 |
| Mapping        | Deterministic: code point -> pitch, letter class -> hue            |
| Palette        | Two hex colors: median vowel hue + median consonant hue            |
| Physical scale | 36 mm/s of strip; ~380mm for a 42-char sentence                    |
| Stored data    | Pattern + palette + length only. Never the raw text.               |

---

## Two-version architecture

The project ships in two forms that share one engine and one schema:

1. **Web version** (this repo) — canvas renderer in the browser, GitHub Pages.
2. **Machine apparatus** (future) — a physical scroll + comb + microcontroller
   (`firmware/`) driven by the same `StripJSON`.

The boundary is the **`StripJSON`** contract: the pure `translate()` engine
produces it, and every renderer (canvas now, physical machine later) consumes it.
Keep `src/engine/` DOM-free and dependency-free so both versions can share it.

---

## Strip JSON schema

```typescript
interface NoteEvent {
  t: number            // time offset in seconds from strip start
  pitch: string | null // "C4", "Db4", etc., or null for rest
  dur: number          // duration in seconds
  vel: number          // velocity 0-1
  hue: number | null   // color hue 0-360 (HSL), null for rests
}

interface StripJSON {
  id: string           // UUID v4, generated at creation
  created_at: string   // ISO8601
  locale_hint: 'vi' | 'ko' | 'en' | 'unknown'
  source_length: number // char count of original text (count only, not text)
  notes: NoteEvent[]
  palette: [string, string]  // two dominant hex colors
  strip_length_mm: number    // physical strip length
}
```

---

## Translation rules

- `text.normalize('NFC')` first, then iterate by **code point** (not UTF-16 unit).
- **Rests** (pitch null, vel 0, hue null):
  - Space (U+0020, U+00A0, U+3000) -> short rest, dur 0.125
  - Comma-like (`,` `،` `、` `，`) -> medium rest, dur 0.25
  - Sentence-end (`.` `!` `?` `。` `！` `？` `…`) -> long rest, dur 0.5
  - Any other non-letter (digits, other punctuation, control) -> short rest
- **Letters** -> note: `pitch = SANKYO_30[codePoint % 30]`, dur 0.25, vel 0.8.
- **Hue**: `pitchRatio = index / 29`.
  - Vowel: `round(20 + pitchRatio * 35)` (rose -> gold)
  - Consonant: `round(190 + pitchRatio * 60)` (cyan -> indigo)
  - Vowel detection covers Latin + Vietnamese diacritics + Korean vowel jamo;
    Korean syllable blocks (U+AC00..U+D7A3) count as consonant-leaning.
- **strip_length_mm** = `round(totalDuration * 36)`.
- **palette** = `[hslToHex(medianVowelHue,0.75,0.65), hslToHex(medianConsonantHue,0.75,0.65)]`;
  if only one class present, duplicate it; if no notes, paper-toned fallback.
- **id** via `crypto.randomUUID()`.

### Sankyo 30-note layout (canonical, do not change)

```
C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4
C5 Db5 D5 Eb5 E5 F5 Gb5 G5 Ab5 A5 Bb5 B5
C6 D6 E6 F6 G6 A6
```

Index 0 = C4 (lowest), index 29 = A6 (highest).

---

## Phase plan

- **Phase 1 (DONE):** Translation engine + canvas strip renderer. Type -> strip
  JSON -> animated perforated strip scrolls, play/pause with brass button.
- **Phase 2 (DONE):** Sound. Tone.js music-box synthesis triggered on
  `onNotePlay` (FM tine + tooth click + paper hiss).
- **Phase 3 (DONE):** Light. Read-head blooms + afterglow field (`src/light/`).
- **Phase 4 (DONE):** Presence. MediaPipe hand tracking wakes/pauses the
  machine; proximity drives light intensity (`src/presence/`).
- **Phase 5 (DONE):** Archive. Supabase persistence, archive list, permalinks,
  QR + PNG export (`src/archive/`). Pattern/palette/length only — never raw text.
- **Phase 6:** Firmware. Physical machine apparatus (`firmware/`). Contract
  ready — see `firmware/INTEGRATION.md`.
- **Phase 7:** Installation polish + exhibition build.

---

## Folder structure

```
perforated-atlas/
├── CLAUDE.md
├── index.html            # museum-object UI, all CSS inline
├── vite.config.ts        # base '/perforated-atlas/', vitest node env
├── src/
│   ├── engine/           # PURE, DOM-free, no deps — shared by all renderers
│   │   ├── types.ts
│   │   ├── translate.ts  # translate(text): StripJSON + SANKYO_30
│   │   └── translate.test.ts
│   ├── apparatus/
│   │   └── StripRenderer.ts   # canvas renderer, consumes StripJSON
│   ├── sound/            # Phase 2
│   ├── light/            # Phase 3
│   ├── presence/         # Phase 4
│   ├── archive/          # Phase 5
│   └── main.ts           # wiring
├── public/samples/       # Phase 2 audio
├── firmware/             # Phase 6
└── .github/workflows/deploy.yml
```

---

## Design system

All UI colors are CSS custom properties on `:root` in `index.html`:

| Variable           | Value     | Role                                    |
| ------------------ | --------- | --------------------------------------- |
| `--bg`             | `#0b0b0b` | Page + canvas background                |
| `--paper`          | `#E8E0CC` | Strip parchment (canvas-side reference) |
| `--brass-dim`      | `#5A4A28` | Button borders                          |
| `--brass-mid`      | `#9A8A52` | Button text                             |
| `--brass-bright`   | `#D4BC7A` | Input text, QR foreground               |
| `--text-primary`   | `#A89060` | Title                                   |
| `--text-secondary` | `#7A6A48` | Subtitle, afterword, welcome line       |
| `--text-dim`       | `#5A4A2A` | Hints, archive meta                     |
| `--text-ghost`     | `#3A3020` | Labels, faint borders                   |
| `--border`         | `#252015` | Title rule                              |

Canvas-side constants (paper, holes, comb, grain, idle pulse) live in the
exported `RENDERER_CONFIG` object at the top of `src/apparatus/StripRenderer.ts`.

UI states: `<main data-state="welcome|input">` gates the onboarding flow
(title plate + instruction line first, input area after). The renderer has an
idle breathing pulse at the read head whenever a strip is loaded but not
playing. Spacebar toggles play/pause once a strip is loaded.

## Version 2 integration

The physical machine (ESP32 + stepper + WS2812 + comb) consumes the same
`StripJSON`. The full firmware contract — schema guarantees, Supabase REST
fetch without SDK, pitch→MIDI table, seconds→steps formula, hue→RGB and
vel→brightness mapping — is in **`firmware/INTEGRATION.md`**. The engine in
`src/engine/` runs in Node 18+ for pre-generating strips offline.

## Current status

**Phases 1–5 complete** plus a professional polish pass: design-system CSS
variables, museum title plate, welcome/onboarding state, paper grain + shadow
depth on the strip, idle breathing at the read head, keyboard control,
CDN/GPS failure hardening, `RENDERER_CONFIG` consolidation,
`totalDuration`/`progress` getters, and the V2 firmware contract.
**Phase 6 next: firmware build** against `firmware/INTEGRATION.md`.

## Conventions

- `src/engine/` must stay pure: no DOM, no external dependencies.
- Tests run with `npm test` (`vitest run`).
- Build with `npm run build` (tsc typecheck + vite build).
- Never persist raw input text anywhere.
