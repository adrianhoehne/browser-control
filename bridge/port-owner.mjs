/**
 * Which local process listens on a port — asked of `/proc`, nothing else.
 *
 * Why not a probe (connect and see): a probe says *what* answers, not *who*
 * owns it, and it pokes a port that may belong to somebody else. Why not
 * `ss`/`lsof`: the service must not depend on a binary that a minimal systemd
 * `PATH` may not have.
 *
 * Every failure returns `null`. The caller then writes "Besitzer nicht
 * ermittelbar" and names nobody — a wrong PID in a log line sends the operator
 * hunting the wrong process, which is worse than admitting ignorance.
 */
import fs from "node:fs";

const PROC_NET_TABLES = Object.freeze(["/proc/net/tcp", "/proc/net/tcp6"]);

// Field offsets of one `/proc/net/tcp` row, once the trailing `:` of the slot
// column is gone. A row reads like:
//   `0: 0100007F:1FAA 00000000:0000 0A 00000000:00000000 ... 0 16598 ...`
const FIELD = Object.freeze({ LOCAL_ADDRESS: 1, STATE: 3, INODE: 9 });

// TCP_LISTEN. Every other state is a connection that merely mentions the port.
const TCP_LISTEN = "0A";

// Inode 0 appears on rows with no socket behind them (TIME_WAIT leftovers among
// others). It matches no filedescriptor, so such a row is not worth a scan.
const NO_INODE = "0";

const PID_DIRECTORY_PATTERN = /^\d+$/;

/**
 * Returns `{pid, name}`, or `null` when the owner cannot be determined.
 *
 * `host` is accepted for symmetry with the bind target the caller holds, but
 * the matching is by port alone: `127.0.0.1:8111` and `0.0.0.0:8111` both make
 * a bind fail with EADDRINUSE, so the useful question is "who owns port 8111",
 * not "who owns exactly that address".
 *
 * Called once at startup, never per request — the full `/proc` walk is cheap
 * only if nobody does it in a hot path.
 */
export function findPortOwner({ port }) {
  if (!isPort(port)) return null;

  try {
    const inodes = readListenInodes(port);
    if (inodes.size === 0) return null;

    const pid = findPidOwningAny(inodes);
    if (pid === null) return null;

    return { pid, name: readProcessName(pid) };
  } catch {
    // No `/proc` at all (non-Linux, hardened container), or it became
    // unreadable mid-walk. One answer covers all of it: no nameable owner.
    return null;
  }
}

function isPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/** Inodes of every listening socket on `port`, from both TCP tables. */
function readListenInodes(port) {
  const inodes = new Set();
  for (const tablePath of PROC_NET_TABLES) {
    for (const inode of readInodesOfTable(tablePath, port)) inodes.add(inode);
  }
  return inodes;
}

function readInodesOfTable(tablePath, port) {
  let content;
  try {
    content = fs.readFileSync(tablePath, "utf8");
  } catch {
    // A kernel without IPv6 has no `tcp6` table. That is not a failure.
    return [];
  }

  const inodes = [];
  for (const line of content.split("\n")) {
    const inode = parseListenLine(line, port);
    if (inode !== null) inodes.push(inode);
  }
  return inodes;
}

function parseListenLine(line, port) {
  const fields = line.trim().split(/\s+/);
  // Catches the header row and anything short enough to be truncated.
  if (fields.length <= FIELD.INODE) return null;
  if (fields[FIELD.STATE] !== TCP_LISTEN) return null;
  if (parseHexPort(fields[FIELD.LOCAL_ADDRESS]) !== port) return null;

  const inode = fields[FIELD.INODE];
  return inode === NO_INODE ? null : inode;
}

/** `0100007F:1FAA` → 8110; `null` when the field is not `address:hexport`. */
function parseHexPort(localAddress) {
  const [, hexPort] = localAddress.split(":");
  const port = Number.parseInt(hexPort, 16);
  return Number.isInteger(port) ? port : null;
}

/**
 * First process whose filedescriptors include one of the inodes.
 *
 * Filedescriptors of other users' processes are unreadable and simply skipped.
 * Any match wins, because a child that inherited the socket is as much an
 * answer as the parent — the operator gets a PID they can act on either way.
 */
function findPidOwningAny(inodes) {
  const socketMarkers = new Set([...inodes].map((inode) => `socket:[${inode}]`));

  for (const pid of readPids()) {
    if (ownsAnySocket(pid, socketMarkers)) return pid;
  }
  return null;
}

function readPids() {
  return fs
    .readdirSync("/proc")
    .filter((name) => PID_DIRECTORY_PATTERN.test(name))
    .map(Number);
}

function ownsAnySocket(pid, socketMarkers) {
  let descriptors;
  try {
    descriptors = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    // The process is gone, or its `/fd` belongs to another user.
    return false;
  }

  for (const descriptor of descriptors) {
    let target;
    try {
      target = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`);
    } catch {
      // The descriptor was closed between `readdir` and `readlink`.
      continue;
    }
    if (socketMarkers.has(target)) return true;
  }
  return false;
}

function readProcessName(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    // The process vanished between finding and naming it. The PID is still the
    // more useful half of the answer, so it is not thrown away over a name.
    return "unknown";
  }
}
