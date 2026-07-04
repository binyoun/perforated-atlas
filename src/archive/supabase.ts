import { createClient, SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL ?? ''
const key = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

// null when env vars are missing (graceful degradation — archive is disabled)
export const db: SupabaseClient | null =
  url && key && !url.includes('placeholder') ? createClient(url, key) : null

export const archiveEnabled = db !== null
