import type { Session } from '@supabase/supabase-js';

import type {
  ProjectMemoryRepository,
  ProjectRepository,
  TaskRepository,
} from '../data';

export type TrackerSession = Pick<Session, 'user'>;

export interface TrackerRepositories {
  projects: Pick<ProjectRepository, 'list' | 'create' | 'update' | 'archive'>;
  tasks: Pick<TaskRepository, 'list' | 'create' | 'update' | 'archive'>;
  memory: Pick<ProjectMemoryRepository, 'listComments' | 'addComment'>;
}

export interface TrackerAuth {
  setup(credentials: { email: string; password: string }): ReturnType<typeof import('../data').ownerAuth.setup>;
  signIn(credentials: { email: string; password: string }): ReturnType<typeof import('../data').ownerAuth.signIn>;
  getPersistedSession(): ReturnType<typeof import('../data').ownerAuth.getPersistedSession>;
  signOut(): ReturnType<typeof import('../data').ownerAuth.signOut>;
  onAuthStateChange: typeof import('../data').ownerAuth.onAuthStateChange;
}

export interface TrackerServices {
  auth: TrackerAuth;
  repositories: TrackerRepositories;
}
