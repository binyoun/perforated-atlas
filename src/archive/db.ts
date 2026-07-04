import { db } from './supabase'
import type { StripJSON } from '../engine/types'

export async function saveStrip(strip: StripJSON): Promise<void> {
  if (!db) return
  const { error } = await db.from('strips').insert({
    id: strip.id,
    created_at: strip.created_at,
    city: strip.city ?? '',
    country: strip.country ?? '',
    locale_hint: strip.locale_hint,
    source_length: strip.source_length,
    word_count: strip.word_count ?? 0,
    notes: strip.notes,
    palette: strip.palette,
    strip_length_mm: strip.strip_length_mm,
  })
  if (error) console.warn('Strip save failed:', error.message)
}

export async function loadStrip(id: string): Promise<StripJSON | null> {
  if (!db) return null
  const { data, error } = await db.from('strips').select('*').eq('id', id).single()
  if (error || !data) return null
  return data as StripJSON
}

export async function loadRecent(limit = 24): Promise<StripJSON[]> {
  if (!db) return []
  const { data, error } = await db
    .from('strips')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error || !data) return []
  return data as StripJSON[]
}
