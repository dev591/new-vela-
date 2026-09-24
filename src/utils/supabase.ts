import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase env vars missing (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) — Supabase features are disabled.')
}

// Fall back to a placeholder so a missing .env degrades gracefully at request
// time instead of crashing the whole bundle at module load.
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'public-anon-key-missing'
)
