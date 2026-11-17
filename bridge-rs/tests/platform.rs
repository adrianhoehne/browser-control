//! Port ownership: the two `/proc` cases of `test/port-owner.test.js`, and the
//! platform-independent table cases of the Windows lookup.
//!
//! The `/proc` lookup only exists on Linux, so those cases are Linux-only. Compiled out,
//! never passed: a green tick elsewhere would claim a capability the module does not have
//! there, and the caller's fallback text is exactly what would happen. The Windows table
//! cases are the opposite — arithmetic over integers and strings, so they run everywhere,
//! which is the only reason they are checked at all on a Linux development machine.

// The case names are copied from the Node suite so the mapping stays readable;
// `docs/38`, `### What could go wrong` names the allow.
#![allow(non_snake_case)]

use browser_control_bridge::platform::windows_table::{
    holds_port, image_basename, port_of, STATE_ESTAB, STATE_LISTEN, STATE_TIME_WAIT,
};

#[cfg(target_os = "linux")]
mod linux_only {
    use std::net::TcpListener;

    use browser_control_bridge::platform::find_port_owner;

    /// Binds a throwaway loopback listener and returns the port the kernel
    /// actually picked — port `0` only promises to find one.
    fn listenOnFreePort() -> (TcpListener, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a free loopback port");
        let port = listener
            .local_addr()
            .expect("a bound listener has an address")
            .port();

        (listener, port)
    }

    #[test]
    fn findPortOwner_withOwnListeningSocket_shouldNameThisProcess() {
        // GIVEN a listener that belongs to this very test process,
        let (listener, port) = listenOnFreePort();

        // WHEN we ask who owns that port,
        let owner = find_port_owner(port).expect("this process listens on that port");

        // THEN the answer is this process. The PID is the contract; the name is
        // whatever `/proc/<pid>/comm` says, and that differs by runtime, so only
        // its shape is asserted — pinning the name would test the runtime, not
        // this module.
        assert_eq!(owner.pid, std::process::id());
        assert!(
            !owner.name.is_empty() && !owner.name.chars().any(char::is_whitespace),
            "expected a single token as the process name, got {:?}",
            owner.name,
        );

        drop(listener);
    }

    #[test]
    fn findPortOwner_withReleasedPort_shouldReturnNull() {
        // GIVEN a port that was bound once and released again,
        let (listener, port) = listenOnFreePort();
        drop(listener);

        // WHEN we ask for an owner nobody has,
        let owner = find_port_owner(port);

        // THEN the module must say "no idea" instead of guessing a process:
        assert_eq!(owner, None);
    }
}

// The four cases below used to sit in `src/platform/windows.rs` behind `#[cfg(windows)]`,
// where no run of `cargo test` on a development machine ever executed them — and the port
// field of the first three was built with the wrong byte order the whole time. They are
// plain arithmetic over `u32` and `&str`, so they belong to the platform-independent half of
// the lookup (`platform::windows_table`) and run here like any other case. The names are
// unchanged, so the mapping to the Node suite and to `linux.rs` stays readable, and they sit
// at file level for the same reason: a module around them would prefix every case name.

/// Port 8110 as the kernel puts it in a `MIB_TCPROW_OWNER_PID`.
///
/// The local port travels in *network* order in the low 16 bits of `dwLocalPort`, so the two
/// bytes in memory are `1F AE` and the DWORD is `0x0000AE1F` on a little-endian Windows — not
/// `0x00001FAE`, which is the same bytes read the wrong way round and decodes to 44575.
/// `from_le_bytes` spells the memory layout out, so the constant does not silently follow the
/// endianness of whichever machine compiles the test.
const PORT_8110_FIELD: u32 = u32::from_le_bytes([0x1F, 0xAE, 0, 0]);

#[test]
fn port_of_withANetworkOrderField_shouldReadThePort() {
    // GIVEN the table field for port 8110 as it arrives on the wire,
    let field = PORT_8110_FIELD;
    assert_eq!(field, 0x0000_AE1F, "8110 is 0x1F 0xAE in network order");

    // WHEN we decode it,
    // THEN the port comes back:
    assert_eq!(port_of(field), 8110);

    // ... and the naive read — the DWORD's own low 16 bits — is the byte-swapped twin. This
    // assertion is the point of the case: without it, a decoder that happened to swap by
    // accident would still look correct.
    assert_eq!(
        field as u16,
        8110u16.swap_bytes(),
        "reading the DWORD as u16 must give the swapped port, not 8110"
    );
    assert_eq!(field as u16, 44_575, "0xAE1F is what a missed swap reports");
}

#[test]
fn holds_port_withAListeningRowOnThePort_shouldBeTrue() {
    assert!(holds_port(STATE_LISTEN, PORT_8110_FIELD, 8110));
    assert!(holds_port(STATE_ESTAB, PORT_8110_FIELD, 8110));
}

#[test]
fn holds_port_withAnotherStateOrPortOrTheKernelPid_shouldBeFalse() {
    let field = PORT_8110_FIELD;
    // TIME_WAIT: a leftover that mentions the port without holding it.
    assert!(!holds_port(STATE_TIME_WAIT, field, 8110));
    // Right state, wrong port: 8111.
    assert!(!holds_port(STATE_LISTEN, field, 8111));
    // A state the table uses for "no row" must not be read as a match.
    assert!(!holds_port(0, field, 8110));
}

#[test]
fn image_basename_withAWindowsPath_shouldKeepTheFileName() {
    assert_eq!(
        image_basename(r"C:\Users\joe\AppData\Local\browser-control\browser-control-bridge.exe"),
        "browser-control-bridge.exe"
    );
    assert_eq!(
        image_basename(r"\\?\C:\Windows\System32\node.exe"),
        "node.exe"
    );
    assert_eq!(image_basename("/usr/bin/node"), "node");
    // No separator at all: the whole thing is the name.
    assert_eq!(image_basename("node"), "node");
}
