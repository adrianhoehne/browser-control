//! Which local process listens on a port — asked of the operating system,
//! nothing else.
//!
//! Why not a probe (connect and see): a probe says *what* answers, not *who* owns
//! it, and it pokes a port that may belong to somebody else. Why not `ss`/`lsof`:
//! the service must not depend on a binary that a minimal systemd `PATH` may not
//! have.
//!
//! Every failure returns `None`. The caller then writes "Besitzer nicht
//! ermittelbar" and names nobody — a wrong PID in a log line sends the operator
//! hunting the wrong process, which is worse than admitting ignorance.

/// One answer of the lookup: a PID the operator can act on, and the name the
/// process calls itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortOwner {
    pub pid: u32,
    pub name: String,
}

#[cfg(target_os = "linux")]
mod linux;

/// `port` is the whole question: `127.0.0.1:8111` and `0.0.0.0:8111` both make a
/// bind fail with `EADDRINUSE`, so "who owns 8111" is the useful one. The host the
/// caller holds is deliberately not an argument.
///
/// Called once at startup, never per request — the full `/proc` walk is cheap only
/// if nobody does it in a hot path.
#[cfg(target_os = "linux")]
pub fn find_port_owner(port: u16) -> Option<PortOwner> {
    linux::find_port_owner(port)
}

/// Everywhere else there is no `/proc` to read. Windows gets
/// `GetExtendedTcpTable` in stage 3 of `docs/38`; until then the honest answer is
/// the same one `findPortOwner` gives when it cannot decide.
#[cfg(not(target_os = "linux"))]
pub fn find_port_owner(_port: u16) -> Option<PortOwner> {
    None
}
