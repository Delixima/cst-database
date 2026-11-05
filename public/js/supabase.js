import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

/** True when config.js still contains the placeholder values. */
export const isConfigured =
  typeof SUPABASE_URL === 'string' &&
  /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$|^https:\/\/[^/]+\/?$/i.test(SUPABASE_URL) &&
  !SUPABASE_URL.includes('YOUR_PROJECT_REF') &&
  typeof SUPABASE_ANON_KEY === 'string' &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.startsWith('YOUR_');

export const supabase = createClient(
  isConfigured ? SUPABASE_URL : 'https://placeholder.supabase.co',
  isConfigured ? SUPABASE_ANON_KEY : 'placeholder-anon-key-not-configured',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

/**
 * Unwraps a Supabase response: returns data or throws the error.
 * @template T
 * @param {{ data: T, error: any }} res
 * @returns {T}
 */
export function unwrap(res) {
  if (res.error) throw res.error;
  return res.data;
}
