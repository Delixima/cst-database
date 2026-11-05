/**
 * CST Sanction Logs - front-end configuration
 * ------------------------------------------------------------------
 * Fill in the two values below from your Supabase dashboard:
 *   Project Settings > API (or "API Keys")
 *     - SUPABASE_URL      : "Project URL", e.g. https://abcdefghijkl.supabase.co
 *     - SUPABASE_ANON_KEY : the "anon" / "publishable" PUBLIC key
 *
 * These two values are PUBLIC by design: they are shipped to every browser.
 * All security is enforced in Postgres (Row Level Security + triggers).
 *
 * NEVER put the "service_role" / "secret" key in this file or anywhere
 * in /public. It bypasses every security rule of the database.
 */
export const SUPABASE_URL = 'https://jkvjggpwrulhfqjqpdej.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprdmpnZ3B3cnVsaGZxanFwZGVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4Njk3OTYsImV4cCI6MjEwOTQ0NTc5Nn0.DVV6QVSMFpM3PSpBl3r_P9LEtDMPC-HBo4vv2WslVWA';

/** Show the "Se connecter avec Discord" button (configure the provider first, see README). */
export const ENABLE_DISCORD_LOGIN = false;

/** Number of rows per page in paginated tables. */
export const PAGE_SIZE = 25;
