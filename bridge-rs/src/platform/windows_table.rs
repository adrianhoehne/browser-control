//! The pure half of the Windows port lookup: a table row's state and port fields in,
//! a decision out; an image path in, a process name out.
//!
//! Nothing here calls the operating system, so nothing here may live behind
//! `#[cfg(windows)]`. That split is the whole point of the module: while these helpers
//! sat inside `mod windows`, no test on a development machine could reach them — Linux
//! compiled the module out, and only a cross-target `clippy` looked at the code. The
//! byte order of the port field was wrong behind a green build and stayed wrong until
//! somebody multiplied it out by hand.
//!
//! `windows.rs` next door keeps what really is a Windows API call: `GetExtendedTcpTable`,
//! `OpenProcess`, `QueryFullProcessImageNameW`.

/// `MIB_TCP_STATE_LISTEN` (`2`): a socket waiting for connections on the port.
///
/// Written as numbers because the `windows-sys` constants only exist in a `cfg(windows)`
/// dependency. `windows.rs` compares the two at compile time, so the duplication cannot
/// drift into a silent mismatch.
pub const STATE_LISTEN: u32 = 2;

/// `MIB_TCP_STATE_ESTAB` (`5`): an established connection that still holds the *local*
/// port. On Windows the server side of a connection carries the same local port as the
/// listener, so leaving it out would report "no owner" for a busy but reachable port.
pub const STATE_ESTAB: u32 = 5;

/// `MIB_TCP_STATE_TIME_WAIT` (`11`): a leftover that mentions the port without holding it.
/// Named here so the false-case test says which state it means instead of a bare `11`.
pub const STATE_TIME_WAIT: u32 = 11;

/// The two states that make a bind fail on that port.
///
/// `LISTEN` is what the Linux module matches (`0A` in `/proc/net/tcp`); `ESTAB` is added
/// because this lookup only ever names processes that hold the port, never the ephemeral
/// side of a client.
pub const STATES_THAT_HOLD_A_PORT: [u32; 2] = [STATE_LISTEN, STATE_ESTAB];

/// True when this row is a socket that holds `port` on its local side.
pub fn holds_port(row_state: u32, row_local_port: u32, port: u16) -> bool {
    // State 0 is `MIB_TCP_STATE_CLOSED`, which no live row carries — a row of zeros is a
    // slot the buffer reserved and the kernel never filled. It must not match, and neither
    // must TIME_WAIT (a leftover that mentions the port without holding it) or anything
    // else outside the two states above.
    if !STATES_THAT_HOLD_A_PORT.contains(&row_state) {
        return false;
    }

    port_of(row_local_port) == port
}

/// The local port of a table row.
///
/// The table stores it in network byte order in the low 16 bits of the field, so the low
/// byte of the value is the *high* byte of the port. Reading it through `u16::from_be_bytes`
/// keeps this independent of the host's endianness.
pub fn port_of(row_local_port: u32) -> u16 {
    let low = (row_local_port & 0xFF) as u8;
    let high = ((row_local_port >> 8) & 0xFF) as u8;
    u16::from_be_bytes([low, high])
}

/// The last path component of `path`.
///
/// The Linux side reads `/proc/<pid>/comm`, which is the executable's basename and nothing
/// else; a full path on one platform and a bare name on the other would make the single
/// `name=<name>` field of the log line mean two different things. `/` is stripped as well as
/// `\`, because a path handed out by a POSIX-subsystem or device-path interface may carry
/// either separator.
pub fn image_basename(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_string()
}
