//! Which local process listens on a port — asked of the operating system,
//! nothing else.
//!
//! Why not a probe (connect and see): a probe says *what* answers, not *who* owns
//! it, and it pokes a port that may belong to somebody else. Why not `ss`/`lsof` on
//! Linux or `netstat`/`Get-NetTCPConnection` on Windows: the service must not depend
//! on a program that a minimal `PATH` may not have, and spawning one to answer a log
//! line is a second process to get wrong.
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

#[cfg(windows)]
mod windows;

/// The half of the Windows lookup that never calls the operating system: row fields and
/// image paths. It is deliberately *not* behind `#[cfg(windows)]` — a pure function that
/// no test on the development machine can reach is a pure function nobody checked. Public
/// so `tests/platform.rs` measures it on every platform, exactly as it measures `linux`.
pub mod windows_table;

/// `port` is the whole question: `127.0.0.1:8111` and `0.0.0.0:8111` both make a
/// bind fail with `EADDRINUSE`, so "who owns 8111" is the useful one. The host the
/// caller holds is deliberately not an argument.
///
/// Called once at startup, never per request — the full `/proc` walk is cheap only
/// if nobody does it in a hot path, and the same goes for the two TCP tables of
/// `GetExtendedTcpTable`.
#[cfg(target_os = "linux")]
pub fn find_port_owner(port: u16) -> Option<PortOwner> {
    linux::find_port_owner(port)
}

/// Windows answers the same question from `GetExtendedTcpTable`, which is what
/// `bridge/port-owner.mjs` never could do there: the template reads `/proc` and
/// returned `null` on Windows, so every failed bind said "Besitzer nicht
/// ermittelbar". The line around it does not change — `port <address> in use, owner
/// pid=<pid> name=<name>` is built in `main.rs` for both platforms.
#[cfg(windows)]
pub fn find_port_owner(port: u16) -> Option<PortOwner> {
    windows::find_port_owner(port)
}

/// macOS and anything else that is neither Linux nor Windows: no lookup, and the
/// honest answer is the one `findPortOwner` gives when it cannot decide. A platform
/// that wants its own answer adds a module here instead of guessing in the caller.
#[cfg(not(any(target_os = "linux", windows)))]
pub fn find_port_owner(_port: u16) -> Option<PortOwner> {
    None
}
