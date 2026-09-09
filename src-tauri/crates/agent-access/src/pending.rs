//! The bounded table of facade calls currently relayed to the frontend and awaiting a response
//! via the `agent_access_respond` command. Kept as its own small module so both the pipe server
//! (inserts/awaits) and the Tauri command (resolves) can share one instance without either
//! depending on the other's internals.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

use super::types::FacadeError;

#[derive(Debug)]
pub enum FacadeOutcome {
    Ok(serde_json::Value),
    Err(FacadeError),
}

struct Entry {
    generation: u64,
    sender: oneshot::Sender<FacadeOutcome>,
}

#[derive(Default)]
pub struct PendingRequests {
    entries: Mutex<HashMap<String, Entry>>,
}

pub enum InsertError {
    TooManyPending,
}

impl PendingRequests {
    pub fn try_insert(
        &self,
        id: String,
        generation: u64,
        max: usize,
    ) -> Result<oneshot::Receiver<FacadeOutcome>, InsertError> {
        let mut guard = self.entries.lock().expect("pending requests lock poisoned");
        if guard.len() >= max {
            return Err(InsertError::TooManyPending);
        }
        let (sender, receiver) = oneshot::channel();
        guard.insert(id, Entry { generation, sender });
        Ok(receiver)
    }

    /// Resolves a pending entry submitted under exactly `generation`. Returns `false` — a silent,
    /// documented no-op, never an error — when there is no such pending entry (already resolved,
    /// already timed out) or its generation no longer matches (a revoke/reconnect superseded it
    /// after the request was issued): the caller must not treat either case as a delivery
    /// failure worth surfacing to the frontend.
    pub fn resolve(&self, id: &str, generation: u64, outcome: FacadeOutcome) -> bool {
        let mut guard = self.entries.lock().expect("pending requests lock poisoned");
        match guard.get(id) {
            Some(entry) if entry.generation == generation => {
                let entry = guard.remove(id).expect("checked above");
                entry.sender.send(outcome).is_ok()
            }
            _ => false,
        }
    }

    pub fn remove(&self, id: &str) {
        self.entries
            .lock()
            .expect("pending requests lock poisoned")
            .remove(id);
    }

    /// Drops every pending entry issued under `generation`. Dropping a `oneshot::Sender` resolves
    /// its receiver with `Err(RecvError)` immediately, so an in-flight pipe call waiting on it
    /// wakes right away instead of running out the full request timeout — used when a connection
    /// generation is superseded by revoke, reconnect, sign-out, or shutdown.
    pub fn invalidate_generation(&self, generation: u64) {
        let mut guard = self.entries.lock().expect("pending requests lock poisoned");
        guard.retain(|_, entry| entry.generation != generation);
    }

    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .expect("pending requests lock poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::MAX_PENDING_REQUESTS;

    #[tokio::test]
    async fn resolve_delivers_the_outcome_to_the_matching_receiver() {
        let pending = PendingRequests::default();
        let receiver = pending.try_insert("req-1".to_owned(), 1, 8).ok().unwrap();
        assert!(pending.resolve(
            "req-1",
            1,
            FacadeOutcome::Ok(serde_json::json!({"ok": true}))
        ));
        let outcome = receiver.await.unwrap();
        assert!(matches!(outcome, FacadeOutcome::Ok(_)));
    }

    #[tokio::test]
    async fn resolve_is_a_noop_for_an_unknown_id() {
        let pending = PendingRequests::default();
        assert!(!pending.resolve("missing", 1, FacadeOutcome::Ok(serde_json::json!(null))));
    }

    #[tokio::test]
    async fn resolve_is_a_noop_when_the_generation_no_longer_matches() {
        let pending = PendingRequests::default();
        let _receiver = pending.try_insert("req-1".to_owned(), 1, 8).ok().unwrap();
        assert!(!pending.resolve("req-1", 2, FacadeOutcome::Ok(serde_json::json!(null))));
        // Still pending under its original generation.
        assert_eq!(pending.len(), 1);
    }

    #[tokio::test]
    async fn invalidate_generation_wakes_pending_receivers_with_an_error() {
        let pending = PendingRequests::default();
        let receiver = pending.try_insert("req-1".to_owned(), 5, 8).ok().unwrap();
        pending.invalidate_generation(5);
        assert!(receiver.await.is_err());
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn invalidate_generation_leaves_other_generations_untouched() {
        let pending = PendingRequests::default();
        let _r1 = pending.try_insert("req-1".to_owned(), 1, 8).ok().unwrap();
        let _r2 = pending.try_insert("req-2".to_owned(), 2, 8).ok().unwrap();
        pending.invalidate_generation(1);
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn try_insert_rejects_once_the_bound_is_reached() {
        let pending = PendingRequests::default();
        for i in 0..MAX_PENDING_REQUESTS {
            pending
                .try_insert(format!("req-{i}"), 1, MAX_PENDING_REQUESTS)
                .ok()
                .unwrap();
        }
        let result = pending.try_insert("one-too-many".to_owned(), 1, MAX_PENDING_REQUESTS);
        assert!(matches!(result, Err(InsertError::TooManyPending)));
    }
}
