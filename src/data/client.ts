import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './database.types';

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export function readSupabaseConfig(env: ImportMetaEnv = import.meta.env): SupabaseConfig {
  const url = env.VITE_SUPABASE_URL?.trim();
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url) throw new Error('Missing VITE_SUPABASE_URL');
  if (!publishableKey) throw new Error('Missing VITE_SUPABASE_PUBLISHABLE_KEY');

  return { url, publishableKey };
}

let client: SupabaseClient<Database> | undefined;

export function getSupabaseClient(): SupabaseClient<Database> {
  if (!client) {
    const config = readSupabaseConfig();
    client = createClient<Database>(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}
