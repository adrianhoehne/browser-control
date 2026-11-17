//! Port ownership on Linux: `/proc/net/tcp*` for the socket, `/proc/*/fd` for the
//! process, `/proc/<pid>/comm` for the name. No binary, no probe, no dependency.

use std::fs;

use super::PortOwner;

const PROC_NET_TABLES: [&str; 2] = ["/proc/net/tcp", "/proc/net/tcp6"];

// Field offsets of one `/proc/net/tcp` row, once the row is split on whitespace.
// A row reads like:
//   `0: 0100007F:1FAA 00000000:0000 0A 00000000:00000000 ... 0 16598 ...`
// so the slot number keeps its trailing colon in field 0 and everything after it
// shifts by one.
const FIELD_LOCAL_ADDRESS: usize = 1;
const FIELD_STATE: usize = 3;
const FIELD_INODE: usize = 9;

/// `TCP_LISTEN`. Every other state is a connection that merely mentions the port.
const TCP_LISTEN: &str = "0A";

/// Inode 0 appears on rows with no socket behind them (TIME_WAIT leftovers among
/// others). It matches no filedescriptor, so such a row is not worth a scan.
const NO_INODE: &str = "0";

/// The name written when the process vanished between finding and naming it. The
/// PID is still the more useful half of the answer, so it is not thrown away over
/// a name.
const UNKNOWN_PROCESS_NAME: &str = "unknown";

pub fn find_port_owner(port: u16) -> Option<PortOwner> {
    let inodes = listen_inodes(port);
    if inodes.is_empty() {
        return None;
    }

    let pid = find_pid_owning_any(&inodes)?;
    Some(PortOwner {
        pid,
        name: process_name(pid),
    })
}

/// Inodes of every listening socket on `port`, from both TCP tables.
///
/// An unreadable table is not an error: a kernel without IPv6 has no `tcp6` file,
/// and a hardened container may hide both — in which case the set stays empty and
/// the caller says "no nameable owner".
fn listen_inodes(port: u16) -> Vec<String> {
    let mut inodes = Vec::new();
    for table in PROC_NET_TABLES {
        let Ok(content) = fs::read_to_string(table) else {
            continue;
        };
        for line in content.lines() {
            if let Some(inode) = listen_inode(line, port) {
                if !inodes.iter().any(|known| known == inode) {
                    inodes.push(inode.to_string());
                }
            }
        }
    }
    inodes
}

fn listen_inode(line: &str, port: u16) -> Option<&str> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    // Also catches the header row and anything short enough to be truncated.
    if fields.len() <= FIELD_INODE {
        return None;
    }
    if fields[FIELD_STATE] != TCP_LISTEN {
        return None;
    }
    if hex_port(fields[FIELD_LOCAL_ADDRESS]) != Some(port) {
        return None;
    }

    match fields[FIELD_INODE] {
        NO_INODE => None,
        inode => Some(inode),
    }
}

/// `0100007F:1FAA` → 8110; `None` when the field is not `address:hexport`.
fn hex_port(local_address: &str) -> Option<u16> {
    let (_, hex_port) = local_address.split_once(':')?;
    u16::from_str_radix(hex_port, 16).ok()
}

/// First process whose filedescriptors include one of the inodes.
///
/// Filedescriptors of other users' processes are unreadable and simply skipped.
/// Any match wins, because a child that inherited the socket is as much an answer
/// as the parent — the operator gets a PID they can act on either way. The PIDs are
/// sorted so that two runs of the same walk name the same process; `/proc` itself
/// has no order to offer.
fn find_pid_owning_any(inodes: &[String]) -> Option<u32> {
    let markers: Vec<String> = inodes.iter().map(|inode| format!("socket:[{inode}]")).collect();

    let mut pids = pids();
    pids.sort_unstable();
    pids.into_iter()
        .find(|pid| owns_any_socket(*pid, &markers))
}

fn pids() -> Vec<u32> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .collect()
}

fn owns_any_socket(pid: u32, markers: &[String]) -> bool {
    let Ok(descriptors) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        // The process is gone, or its `/fd` belongs to another user.
        return false;
    };

    for descriptor in descriptors.filter_map(Result::ok) {
        // A descriptor closed between `read_dir` and `read_link` is skipped, not
        // reported: the walk is a snapshot, not a transaction.
        let Ok(target) = fs::read_link(descriptor.path()) else {
            continue;
        };
        let target = target.to_string_lossy();
        if markers.iter().any(|marker| *marker == target) {
            return true;
        }
    }
    false
}

fn process_name(pid: u32) -> String {
    fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|name| name.trim().to_string())
        .unwrap_or_else(|_| UNKNOWN_PROCESS_NAME.to_string())
}
