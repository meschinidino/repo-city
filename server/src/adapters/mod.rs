//! CLI adapters (design D4/T3). Each adapter translates one CLI's
//! stream into the normalized enum in `crate::events`. Unmapped CLI
//! events are counted, never passed raw to the client (R17/L2:
//! recorded fixtures are labeled simulated and prove translation
//! only, never live-agent behavior).

pub mod claude;
pub mod muse;

/// Translation tallies for one stream. The adapter pass bar (D18) is
/// judged from these numbers against the watcher denominator.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stats {
    pub mapped: usize,
    pub unmapped: usize,
    /// Raw CLI event types that produced no normalized event.
    pub unmapped_kinds: Vec<String>,
}
