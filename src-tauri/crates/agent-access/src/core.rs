//! The connection-binding source of truth: at most one active [`AgentAccessProfile`] at a time,
//! guarded by a plain mutex (reads/writes are cheap, never held across an `.await`). Deliberately
//! has no `tauri` dependency so [`super::server::handle_connection`]'s protocol logic is testable
//! without a running app.

use std::sync::Mutex;

use super::store::AgentAccessProfile;

#[derive(Default)]
pub struct AgentAccessCore {
    profile: Mutex<Option<AgentAccessProfile>>,
}

impl AgentAccessCore {
    pub fn current(&self) -> Option<AgentAccessProfile> {
        self.profile
            .lock()
            .expect("agent access core lock poisoned")
            .clone()
    }

    pub fn set(&self, profile: Option<AgentAccessProfile>) {
        *self
            .profile
            .lock()
            .expect("agent access core lock poisoned") = profile;
    }

    /// Atomically bumps the current profile's generation (revoke/reconnect) and returns the new
    /// value, or `None` if there is no active profile to revoke.
    pub fn bump_generation(&self) -> Option<u64> {
        let mut guard = self
            .profile
            .lock()
            .expect("agent access core lock poisoned");
        let profile = guard.as_mut()?;
        profile.generation += 1;
        Some(profile.generation)
    }
}
