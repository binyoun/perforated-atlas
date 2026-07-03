export interface NoteEvent {
  t: number // time offset in seconds from strip start
  pitch: string | null // "C4", "Db4", etc., or null for rest
  dur: number // duration in seconds
  vel: number // velocity 0-1
  hue: number | null // color hue 0-360 (HSL), null for rests
}

export interface StripJSON {
  id: string // UUID (v4, generated at creation time)
  created_at: string // ISO8601
  locale_hint: 'vi' | 'ko' | 'en' | 'unknown'
  source_length: number // character count of original text
  notes: NoteEvent[]
  palette: [string, string] // two dominant hex colors computed from notes
  strip_length_mm: number // physical strip length
}
