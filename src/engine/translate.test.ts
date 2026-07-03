import { describe, it, expect } from 'vitest'
import { translate, SANKYO_30 } from './translate'
import type { NoteEvent } from './types'

const CITY = 'Hồ Chí Minh'
const COUNTRY = 'Vietnam'

/** Strip the non-deterministic fields for structural comparison. */
function stable(text: string): string {
  const strip = translate(text, CITY, COUNTRY)
  const { id: _id, created_at: _created_at, ...rest } = strip
  void _id
  void _created_at
  return JSON.stringify(rest)
}

function hasNoteShape(n: NoteEvent): boolean {
  return (
    typeof n.t === 'number' &&
    (typeof n.pitch === 'string' || n.pitch === null) &&
    typeof n.dur === 'number' &&
    typeof n.vel === 'number' &&
    (typeof n.hue === 'number' || n.hue === null)
  )
}

describe('translate', () => {
  it('1. is deterministic (excluding id and created_at)', () => {
    const a = stable('The canal smells of rain')
    const b = stable('The canal smells of rain')
    const c = stable('The canal smells of rain')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('2. empty string returns empty notes and 0 length', () => {
    const strip = translate('', CITY, COUNTRY)
    expect(strip.notes).toEqual([])
    expect(strip.strip_length_mm).toBe(0)
  })

  it('3. pure rests: three spaces -> three null-pitch notes', () => {
    const strip = translate('   ', CITY, COUNTRY)
    expect(strip.notes).toHaveLength(3)
    for (const n of strip.notes) {
      expect(n.pitch).toBeNull()
    }
  })

  it('4. language parity across vi/ko/en', () => {
    for (const text of ['mưa', '비', 'rain']) {
      const strip = translate(text, CITY, COUNTRY)
      for (const n of strip.notes) {
        expect(hasNoteShape(n)).toBe(true)
      }
      expect(strip.source_length).toBe(Array.from(text.normalize('NFC')).length)
    }
  })

  it('5. pitch index stability: "aaa" -> three identical G4 notes', () => {
    const strip = translate('aaa', CITY, COUNTRY)
    expect(strip.notes).toHaveLength(3)
    // 'a' = U+0061 = 97, 97 % 30 = 7, SANKYO_30[7] = 'G4'
    expect(SANKYO_30[7]).toBe('G4')
    for (const n of strip.notes) {
      expect(n.pitch).toBe('G4')
    }
  })

  it('6. vowels produce warm hues (20-55)', () => {
    const strip = translate('aeiou', CITY, COUNTRY)
    for (const n of strip.notes) {
      expect(n.hue).not.toBeNull()
      expect(n.hue!).toBeGreaterThanOrEqual(20)
      expect(n.hue!).toBeLessThanOrEqual(55)
    }
  })

  it('7. schema shape has all required fields', () => {
    const strip = translate('rain', CITY, COUNTRY)
    expect(strip).toHaveProperty('id')
    expect(strip).toHaveProperty('created_at')
    expect(strip).toHaveProperty('locale_hint')
    expect(strip).toHaveProperty('source_length')
    expect(strip).toHaveProperty('notes')
    expect(strip).toHaveProperty('palette')
    expect(strip).toHaveProperty('strip_length_mm')
    expect(strip.palette).toHaveLength(2)
  })

  it('8. strip_length_mm scales with source length', () => {
    expect(translate('ab', CITY, COUNTRY).strip_length_mm).toBeLessThan(
      translate('abcdefghij', CITY, COUNTRY).strip_length_mm,
    )
  })
})
