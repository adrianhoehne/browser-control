//! The ports the Rust suite is allowed to bind — reserved, never searched.
//!
//! A service whose port moves is useless to a client, and a port search hides
//! exactly the collision one wants to see: on 2026-10-23 two concurrent test runs
//! swallowed each other's bridges that way and hung until the deadline
//! (`docs/18`, "Nachtrag 2026-10-23: feste Ports, keine Suche").
//!
//! Shared with `test/ports.js`, which stays the table for the Node suite, and kept
//! as the one source here: the two suites own the same numbers, so `cargo test` and
//! `npm test` must never run concurrently — the second run's bridge would find the
//! first run's port taken and exit 1. The parity run has the same rule. Rules of the
//! range, unchanged:
//!
//! - One entry per test file that binds a port. Two files on one number is the bug
//!   this module exists to prevent, and `tests/ports.rs` asserts it.
//! - `18110`–`18119` only: `8110`/`8111` belong to the operator's running bridge,
//!   and anything below `1024` would want privileges in production too.
//! - Adding a file that binds a port means adding an entry here first. The numbers
//!   are the whole contract; nothing derives them at runtime.

/// Inclusive bounds of the reserved range, spelled out rather than imported: the
/// range is the contract, so a test that read its bounds from here could not
/// notice them drifting.
pub const FIRST_RESERVED_PORT: u16 = 18110;
pub const LAST_RESERVED_PORT: u16 = 18119;

/// One test file's claim: a name, and the ports it may bind, role by role.
pub struct ReservedEntry {
    pub name: &'static str,
    pub roles: &'static [(&'static str, u16)],
}

/// `EXTENSION_BRIDGE` = `tests/bridge.rs`, `MCP_FIXTURE` = `tests/mcp.rs`,
/// `HTTP_MCP` = `tests/http.rs`, `PARITY` = `scripts/parity.sh`. The Rust test
/// files arrive with the stages that spawn a bridge (2b onwards); the numbers are
/// reserved now so that no stage quietly picks its own.
pub const RESERVED_PORTS: &[ReservedEntry] = &[
    ReservedEntry {
        name: "EXTENSION_BRIDGE",
        roles: &[("extension", 18110), ("http", 18111)],
    },
    ReservedEntry {
        name: "MCP_FIXTURE",
        roles: &[("extension", 18112)],
    },
    ReservedEntry {
        name: "HTTP_MCP",
        roles: &[("extension", 18113), ("http", 18114)],
    },
    ReservedEntry {
        name: "PARITY",
        roles: &[("extension", 18115), ("http", 18116)],
    },
];
