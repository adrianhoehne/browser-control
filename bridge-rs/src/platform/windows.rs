//! Port ownership on Windows: `GetExtendedTcpTable` for the socket,
//! `OpenProcess` + `QueryFullProcessImageNameW` for the name. No `netstat`, no probe,
//! no second process.
//!
//! The same contract as the Linux module next door: every doubt answers `None`, and the
//! caller then writes "Besitzer nicht ermittelbar". A guessed PID sends the operator
//! hunting the wrong process, which is worse than admitting ignorance.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_TCPTABLE_OWNER_PID, MIB_TCP_STATE_ESTAB, MIB_TCP_STATE_LISTEN, TCP_TABLE_OWNER_PID_ALL,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::windows_table::{holds_port, image_basename};
use super::PortOwner;

/// Address families for `GetExtendedTcpTable`. They live in `Win32_Networking_WinSock` in
/// `windows-sys`, and that feature is not one of the four `docs/38`,
/// `## Dependency changes` names — the numbers themselves are fixed by WinSock, so they
/// are spelled out here instead of pulling a whole feature in for two constants.
const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;

// The state numbers themselves live in `windows_table.rs`, where they compile on every
// platform; this is the only build that also has the real enum. A number that drifted
// there would turn a match into a miss with every test still green, so the compiler is
// asked to compare the two. `assert!` would be the plainer word, but in a `const` block
// clippy reads a constant `assert!` as a tautology test and an `if … panic!` as a
// hand-rolled assert; the lint is silenced once, for this block only.
#[allow(clippy::manual_assert)]
const _: () = {
    if super::windows_table::STATE_LISTEN != MIB_TCP_STATE_LISTEN as u32 {
        panic!("windows_table::STATE_LISTEN no longer matches MIB_TCP_STATE_LISTEN");
    }
    if super::windows_table::STATE_ESTAB != MIB_TCP_STATE_ESTAB as u32 {
        panic!("windows_table::STATE_ESTAB no longer matches MIB_TCP_STATE_ESTAB");
    }
};

/// How often the size-then-fill pair is repeated before the lookup gives up.
///
/// The table can grow between the two calls, and a second `ERROR_INSUFFICIENT_BUFFER` is a
/// real possibility on a busy machine, not a bug. Three attempts cover it; a loop that
/// never ends would hang the start path over a log line.
const TABLE_LOOKUP_ATTEMPTS: usize = 3;

/// Longest image path `QueryFullProcessImageNameW` can produce (`\\?\`-prefixed paths reach
/// 32 767 wide characters). Heap-allocated, because 64 KiB on the stack for a value needed
/// once per failed start is absurd.
const MAX_IMAGE_PATH: usize = 32_768;

/// The name written when the process vanished between finding and naming it — the same word
/// `platform/linux.rs` falls back to. The PID is still the more useful half of the answer,
/// so it is not thrown away over a name.
const UNKNOWN_PROCESS_NAME: &str = "unknown";

pub fn find_port_owner(port: u16) -> Option<PortOwner> {
    // IPv4 first only because it is the common case; both tables are asked, because the
    // bind that failed does not tell the caller which family it was — `parse_bind` turns
    // `[::1]:8110` into a host string, and `TcpListener::bind` may resolve either way.
    let pid = owner_in_ipv4_table(port).or_else(|| owner_in_ipv6_table(port))?;

    Some(PortOwner {
        pid,
        name: process_name(pid),
    })
}

fn owner_in_ipv4_table(port: u16) -> Option<u32> {
    let buffer = tcp_table(AF_INET)?;

    // SAFETY: `tcp_table` only returns buffers that `GetExtendedTcpTable` filled for exactly
    // this table class, so the head is a `MIB_TCPTABLE_OWNER_PID`; the row count is clamped
    // to what the buffer can physically hold before it becomes a slice, because the count in
    // the header is kernel-supplied and this module does not overread on its word.
    let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
    let rows = unsafe {
        let capacity = row_capacity::<MIB_TCPROW_OWNER_PID>(buffer.len());
        std::slice::from_raw_parts(table.table.as_ptr(), (table.dwNumEntries as usize).min(capacity))
    };

    rows.iter()
        .find(|row| holds_port(row.dwState, row.dwLocalPort, port))
        .map(|row| row.dwOwningPid)
}

fn owner_in_ipv6_table(port: u16) -> Option<u32> {
    let buffer = tcp_table(AF_INET6)?;

    // SAFETY: as above, for the IPv6 table class. The field order differs from the IPv4 row
    // (the address is 16 bytes and the state sits behind it), which is why the two tables
    // are walked by their own structs instead of by a hand-computed offset.
    let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID) };
    let rows = unsafe {
        let capacity = row_capacity::<MIB_TCP6ROW_OWNER_PID>(buffer.len());
        std::slice::from_raw_parts(table.table.as_ptr(), (table.dwNumEntries as usize).min(capacity))
    };

    rows.iter()
        .find(|row| holds_port(row.dwState, row.dwLocalPort, port))
        .map(|row| row.dwOwningPid)
}

/// How many rows of `Row` fit into a `words`-long buffer, header included.
///
/// The header is one `u32` (`dwNumEntries`) and both row types are plain `u32` fields, so
/// there is no padding to account for — and a compressed buffer therefore cannot make this
/// arithmetic point one row past the end.
fn row_capacity<Row>(words: usize) -> usize {
    let bytes = words.saturating_mul(std::mem::size_of::<u32>());
    let header = std::mem::size_of::<u32>();
    bytes.saturating_sub(header) / std::mem::size_of::<Row>()
}

/// One `GetExtendedTcpTable` table, as a zero-initialised buffer.
///
/// `TCP_TABLE_OWNER_PID_ALL` is the flavour that carries the owning PID with every row (the
/// module, listener and connection flavours either leave the PID out or split the answer
/// over three tables). The first call only sizes the buffer; the second fills it.
fn tcp_table(family: u32) -> Option<Vec<u32>> {
    for _ in 0..TABLE_LOOKUP_ATTEMPTS {
        let mut size: u32 = 0;
        // SAFETY: a null buffer with a zero size is the documented "how much do I need"
        // call; it reads nothing and writes only `size`.
        let sized = unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                /* order: unused for the OWNER_PID flavours */ 0,
                family,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if sized != ERROR_INSUFFICIENT_BUFFER || size == 0 {
            return None;
        }

        // `Vec<u32>` and not `Vec<u8>`: both table types need 4-byte alignment, and asking
        // for it here is cheaper than an alignment helper on a `Vec<u8>`.
        let words = (size as usize).div_ceil(std::mem::size_of::<u32>());
        let mut buffer = vec![0u32; words];

        // SAFETY: the pointer comes from a vector of the requested size, the size argument
        // says exactly that, and the buffer lives until after the table has been read.
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr() as *mut c_void,
                &mut size,
                0,
                family,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };

        match status {
            _ if status == NO_ERROR => return Some(buffer),
            // The table grew between the two calls: size it again.
            _ if status == ERROR_INSUFFICIENT_BUFFER => continue,
            // Any other failure (no permission for another user's table, no IPv6, a moved
            // Win32 error) is not worth distinguishing here: the caller writes one line
            // either way.
            _ => return None,
        }
    }

    None
}

fn process_name(pid: u32) -> String {
    match image_path(pid) {
        Some(path) => image_basename(&path),
        None => UNKNOWN_PROCESS_NAME.to_string(),
    }
}

/// The full image path of `pid`, or `None` when it cannot be read.
fn image_path(pid: u32) -> Option<String> {
    // `PROCESS_QUERY_LIMITED_INFORMATION` is the smallest right that can name an image. The
    // broader `PROCESS_QUERY_INFORMATION` would ask for more than this needs and is refused
    // for processes of other users — and "other user" is exactly the case this lookup must
    // survive, because a forgotten bridge under a second account still holds the port.
    // SAFETY: `OpenProcess` reads its arguments and returns a handle or null; nothing is
    // dereferenced here.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }

    let mut buffer = vec![0u16; MAX_IMAGE_PATH];
    let mut length = buffer.len() as u32;
    // SAFETY: the buffer is `length` wide characters long and writable, and `length` is
    // passed by pointer as the caller's own size variable.
    let written = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut length)
    };
    // Closed on both paths: one leaked handle per failed start would be small, but this
    // module would be the only place in the tree that leaks, and `CloseHandle` is free.
    // SAFETY: `handle` came from `OpenProcess` above and is closed exactly once.
    unsafe { CloseHandle(handle) };

    if written == 0 {
        return None;
    }

    // The reported length may or may not count the terminator, depending on the Windows
    // version; trailing NULs are trimmed instead of trusted, so either convention reads the
    // same.
    let length = (length as usize).min(buffer.len());
    let path = String::from_utf16_lossy(&buffer[..length]);
    let path = path.trim_end_matches('\0');
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}
