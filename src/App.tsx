import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { nativeFilesystem, nativeLocalSettings } from './api/native';
import {
  ownerAuth,
  ProjectMemoryRepository,
  ProjectRepository,
  SupabaseInstructionRepository,
  TaskRepository,
} from './data';
import { InstructionsService } from './instructions/service';
import { TrackerPage } from './tracker/TrackerPage';
import type { TrackerServices } from './tracker/contracts';

function createDefaultServices(): TrackerServices {
  return {
    auth: ownerAuth,
    repositories: {
      projects: new ProjectRepository(),
      tasks: new TaskRepository(),
      memory: new ProjectMemoryRepository(),
    },
    directoryContext: {
      filesystem: nativeFilesystem,
      settings: nativeLocalSettings,
    },
    instructions: new InstructionsService(new SupabaseInstructionRepository()),
  };
}

interface AuthScreenProps {
  auth: TrackerServices['auth'];
  onAuthenticated: (session: Session) => void;
}

function AuthScreen({ auth, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      const result =
        mode === 'signIn'
          ? await auth.signIn({ email, password })
          : await auth.setup({ email, password });
      if (result.error) throw result.error;
      if (result.data.session) {
        onAuthenticated(result.data.session);
      } else {
        setMessage('Account created. Check your email if confirmation is enabled, then sign in.');
        setMode('signIn');
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Authentication failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-heading">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <span className="brand-name">Hammond</span>
        </div>
        <p className="eyebrow">Owner workspace</p>
        <h1 id="auth-heading">
          {mode === 'signIn' ? 'Welcome back.' : 'Create your owner account.'}
        </h1>
        <p className="auth-copy">
          Your projects, tasks, and comments are stored in your owner-scoped Hammond workspace.
        </p>
        <form className="stack-form" onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
              minLength={6}
              required
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {message && <p className="form-success">{message}</p>}
          <button className="button button-primary" type="submit" disabled={saving}>
            {saving ? 'Working…' : mode === 'signIn' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setMode(mode === 'signIn' ? 'signUp' : 'signIn');
            setError(null);
            setMessage(null);
          }}
        >
          {mode === 'signIn' ? 'Need an account? Create one' : 'Already have an account? Sign in'}
        </button>
      </section>
    </main>
  );
}

export interface AppProps {
  services?: TrackerServices;
  initialSession?: Session | null;
}

function App({ services, initialSession }: AppProps) {
  const [activeServices] = useState<TrackerServices>(() => services ?? createDefaultServices());
  const [session, setSession] = useState<Session | null | undefined>(initialSession);
  const [authLoading, setAuthLoading] = useState(initialSession === undefined);

  useEffect(() => {
    if (initialSession !== undefined) {
      setSession(initialSession);
      setAuthLoading(false);
      return;
    }

    let mounted = true;
    void activeServices.auth
      .getPersistedSession()
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) throw error;
        setSession(data.session);
        setAuthLoading(false);
      })
      .catch(() => {
        if (!mounted) return;
        setSession(null);
        setAuthLoading(false);
      });

    const { data } = activeServices.auth.onAuthStateChange(async (_event, nextSession) => {
      if (mounted) setSession(nextSession);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [activeServices, initialSession]);

  if (authLoading || session === undefined) {
    return <main className="loading-shell">Restoring your Hammond workspace…</main>;
  }

  if (!session) {
    return <AuthScreen auth={activeServices.auth} onAuthenticated={setSession} />;
  }

  return (
    <TrackerPage
      services={activeServices}
      ownerId={session.user.id}
      ownerEmail={session.user.email ?? undefined}
      onSignOut={() => {
        void activeServices.auth.signOut();
        setSession(null);
      }}
    />
  );
}

export default App;
