import type { NoteEvent, StripJSON } from './types'

/**
 * Sankyo 30-note layout. This is the canonical note list, do not change.
 * Index 0 = C4 (lowest), index 29 = A6 (highest).
 */
export const SANKYO_30 = [
  'C4', 'Db4', 'D4', 'Eb4', 'E4', 'F4', 'Gb4', 'G4', 'Ab4', 'A4', 'Bb4', 'B4',
  'C5', 'Db5', 'D5', 'Eb5', 'E5', 'F5', 'Gb5', 'G5', 'Ab5', 'A5', 'Bb5', 'B5',
  'C6', 'D6', 'E6', 'F6', 'G6', 'A6',
] as const

export type Pitch = (typeof SANKYO_30)[number]

// --- Character classification sets ---------------------------------------

const SPACE_CHARS = new Set([' ', ' ', '　'])
const COMMA_CHARS = new Set([',', '،', '、', '，'])
const SENTENCE_END_CHARS = new Set([
  '.', '!', '?', '。', '！', '？', '…',
])

// Covers Latin (including all Vietnamese diacritics), Korean vowel jamo
const VOWEL_RE =
  /^[aeiouàáâãäåèéêëìíîïòóôõöùúûüýāăąēĕėęěīĭįōŏőūŭůűưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/iu

// --- Rest builders --------------------------------------------------------

function shortRest(t: number): NoteEvent {
  return { t, pitch: null, dur: 0.125, vel: 0, hue: null }
}

function mediumRest(t: number): NoteEvent {
  return { t, pitch: null, dur: 0.25, vel: 0, hue: null }
}

function longRest(t: number): NoteEvent {
  return { t, pitch: null, dur: 0.5, vel: 0, hue: null }
}

// --- Classification helpers ----------------------------------------------

function isLetter(char: string): boolean {
  return /\p{L}/u.test(char)
}

function charToPitchIndex(cp: number): number {
  return cp % 30
}

function isVowelChar(char: string, cp: number): boolean {
  // Korean syllable block: every syllable contains a vowel
  // but treat as consonant-leaning (initial consonant is dominant)
  if (cp >= 0xac00 && cp <= 0xd7a3) return false
  // Korean jamo vowels
  if (cp >= 0x1161 && cp <= 0x1175) return true
  if (cp >= 0x314f && cp <= 0x3163) return true
  return VOWEL_RE.test(char)
}

function computeHue(pitchIndex: number, isVowel: boolean): number {
  const pitchRatio = pitchIndex / 29 // 0 = C4 (low), 1 = A6 (high)
  // Vowels: rose (20deg) at low pitch -> gold (55deg) at high pitch
  // Consonants: cyan (190deg) at low pitch -> indigo (250deg) at high pitch
  if (isVowel) {
    return Math.round(20 + pitchRatio * 35)
  } else {
    return Math.round(190 + pitchRatio * 60)
  }
}

// --- Color utilities ------------------------------------------------------

/** Convert HSL (h in deg, s & l in 0-1) to a #rrggbb hex string. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

// --- Locale detection -----------------------------------------------------

function detectLocale(text: string): StripJSON['locale_hint'] {
  if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(text)) return 'ko'
  if (
    /[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/i.test(
      text,
    )
  )
    return 'vi'
  if (/[a-z]/i.test(text)) return 'en'
  return 'unknown'
}

// --- Main translation -----------------------------------------------------

export function translate(text: string): StripJSON {
  const normalized = text.normalize('NFC')
  const locale_hint = detectLocale(normalized)

  // Iterate by Unicode code point (not UTF-16 unit).
  const chars = Array.from(normalized)
  const source_length = chars.length

  const notes: NoteEvent[] = []
  const vowelHues: number[] = []
  const consonantHues: number[] = []
  let t = 0

  for (const char of chars) {
    const cp = char.codePointAt(0)!
    let note: NoteEvent

    if (SPACE_CHARS.has(char)) {
      note = shortRest(t)
    } else if (COMMA_CHARS.has(char)) {
      note = mediumRest(t)
    } else if (SENTENCE_END_CHARS.has(char)) {
      note = longRest(t)
    } else if (isLetter(char)) {
      const pitchIndex = charToPitchIndex(cp)
      const vowel = isVowelChar(char, cp)
      const hue = computeHue(pitchIndex, vowel)
      note = {
        t,
        pitch: SANKYO_30[pitchIndex],
        dur: 0.25,
        vel: 0.8,
        hue,
      }
      if (vowel) vowelHues.push(hue)
      else consonantHues.push(hue)
    } else {
      // digits, other punctuation, control chars -> short rest
      note = shortRest(t)
    }

    notes.push(note)
    t += note.dur
  }

  const totalDuration = notes.reduce((sum, n) => sum + n.dur, 0)
  const strip_length_mm = Math.round(totalDuration * 36)

  // Palette: median hue of vowel notes and median hue of consonant notes.
  let palette: [string, string]
  const haveVowels = vowelHues.length > 0
  const haveConsonants = consonantHues.length > 0
  if (haveVowels && haveConsonants) {
    palette = [
      hslToHex(median(vowelHues), 0.75, 0.65),
      hslToHex(median(consonantHues), 0.75, 0.65),
    ]
  } else if (haveVowels) {
    const c = hslToHex(median(vowelHues), 0.75, 0.65)
    palette = [c, c]
  } else if (haveConsonants) {
    const c = hslToHex(median(consonantHues), 0.75, 0.65)
    palette = [c, c]
  } else {
    // No notes at all: neutral paper-toned palette.
    palette = ['#F0DEB0', '#F0DEB0']
  }

  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    locale_hint,
    source_length,
    notes,
    palette,
    strip_length_mm,
  }
}
