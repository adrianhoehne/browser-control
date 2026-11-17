//! The guard rail around `tests/common/mod.rs` — the three invariants of
//! `test/ports.test.js`, unchanged.
//!
//! Every other test file trusts the table to hold numbers nobody else uses. That
//! trust is exactly what these cases check, because a duplicate port does not fail
//! loudly: it makes some *other* file's bridge exit 1 and turns a green run into a
//! confusing red one elsewhere.

// The case names are copied from the Node suite so the mapping stays readable;
// `docs/38`, `### What could go wrong` names the allow.
#![allow(non_snake_case)]

mod common;

use common::{ReservedEntry, FIRST_RESERVED_PORT, LAST_RESERVED_PORT, RESERVED_PORTS};

/// Every port number of the table, with the entry and role that claim it.
fn claimedPorts() -> Vec<(String, u16)> {
    RESERVED_PORTS
        .iter()
        .flat_map(claimOf)
        .collect()
}

fn claimOf(entry: &ReservedEntry) -> Vec<(String, u16)> {
    entry
        .roles
        .iter()
        .map(|(role, port)| (format!("{}.{}", entry.name, role), *port))
        .collect()
}

#[test]
fn reservedPorts_everyNumber_shouldLieInsideTheReservedRange() {
    // GIVEN the whole table of reserved ports,
    let claims = claimedPorts();

    // WHEN each number is compared with the range the spec reserves,
    // THEN the table is not empty and no number sits outside 18110–18119 — the
    // numbers below that are either privileged or the operator's own bridge:
    assert!(!claims.is_empty(), "the table must reserve at least one port");
    for (where_, port) in &claims {
        assert!(
            *port >= FIRST_RESERVED_PORT && *port <= LAST_RESERVED_PORT,
            "{where_} = {port} is outside {FIRST_RESERVED_PORT}–{LAST_RESERVED_PORT}",
        );
    }
}

#[test]
fn reservedPorts_twoEntriesOnOneNumber_shouldNotExist() {
    // GIVEN the table, with every claim flattened to a name/port pair,
    let claims = claimedPorts();

    // WHEN the numbers are grouped by their value,
    let mut claimers: Vec<(u16, Vec<String>)> = Vec::new();
    for (where_, port) in claims {
        match claimers.iter_mut().find(|(known, _)| *known == port) {
            Some((_, names)) => names.push(where_),
            None => claimers.push((port, vec![where_])),
        }
    }
    let shared: Vec<&(u16, Vec<String>)> = claimers
        .iter()
        .filter(|(_, names)| names.len() > 1)
        .collect();

    // THEN no value is claimed twice — a shared port would make two files fight
    // over one bridge, which is the hang this table replaced:
    assert!(
        shared.is_empty(),
        "ports claimed more than once: {shared:?}",
    );
}

#[test]
fn reservedPorts_everyEntry_shouldNameAnExtensionPort() {
    // GIVEN the table,
    // WHEN each entry is read as "the ports one test file binds",
    // THEN each one has the extension listener every spawning test needs, and no
    // other role is left unnamed:
    for entry in RESERVED_PORTS {
        assert!(
            !entry.roles.is_empty(),
            "{} claims no ports at all",
            entry.name,
        );
        assert!(
            entry.roles.iter().any(|(role, _)| *role == "extension"),
            "{} has no `extension` port: {:?}",
            entry.name,
            entry.roles,
        );
        for (role, port) in entry.roles {
            // The other half of the Node case — "is it a port number?", which it
            // checked with `Number.isInteger(port)` — is the type here: a `u16`
            // cannot be a string, a float, a NaN, negative or above 65_535. The one
            // value the type lets through and `isPort()` in
            // `bridge/port-owner.mjs` would refuse is `0`, and the range case above
            // already rules out everything below 18110, so the guard is not
            // repeated here.
            assert!(
                !role.is_empty(),
                "{}.{role} = {port} has a role without a name",
                entry.name,
            );
        }
    }
}
