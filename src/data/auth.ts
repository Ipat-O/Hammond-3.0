import { getSupabaseClient } from './client';

export interface OwnerCredentials {
  email: string;
  password: string;
}

export const ownerAuth = {
  setup(credentials: OwnerCredentials) {
    return getSupabaseClient().auth.signUp(credentials);
  },
  signIn(credentials: OwnerCredentials) {
    return getSupabaseClient().auth.signInWithPassword(credentials);
  },
  getPersistedSession() {
    return getSupabaseClient().auth.getSession();
  },
  signOut() {
    return getSupabaseClient().auth.signOut();
  },
  onAuthStateChange(
    callback: Parameters<ReturnType<typeof getSupabaseClient>['auth']['onAuthStateChange']>[0],
  ) {
    return getSupabaseClient().auth.onAuthStateChange(callback);
  },
};
