//! Port ownership, measured against the real `/proc` — the two cases of
//! `test/port-owner.test.js`.
//!
//! The lookup reads `/proc`, so these cases are Linux-only. Compiled out, never
//! passed: a green tick elsewhere would claim a capability the module does not have
//! there, and the caller's fallback text is exactly what would happen.

// The case names are copied from the Node suite so the mapping stays readable;
// `docs/38`, `### What could go wrong` names the allow.
#![allow(non_snake_case)]

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
