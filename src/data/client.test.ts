import { readSupabaseConfig } from './client';

describe('readSupabaseConfig', () => {
  it('reads the Vite variables', () => {
    const env = {
      BASE_URL: '/',
      MODE: 'test',
      DEV: false,
      PROD: false,
      SSR: false,
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable',
    } as ImportMetaEnv;
    expect(readSupabaseConfig(env)).toEqual({
      url: 'https://example.supabase.co',
      publishableKey: 'publishable',
    });
  });

  it('names a missing variable without exposing values', () => {
    expect(() => readSupabaseConfig({} as ImportMetaEnv)).toThrow('Missing VITE_SUPABASE_URL');
  });
});
