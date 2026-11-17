//! Log lines and address formatting: the two pieces every other module writes
//! through, so that the shape of a line is decided in exactly one place.
//!
//! stderr belongs to the operator and the journal; stdout is the JSON-RPC channel
//! and nothing else (`docs/18`). Nothing in here touches stdout.

use std::io;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

/// The two levels `BC_LOG` knows. Anything else is `info`, because a stray typo
/// in one environment variable must not stop the service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Debug,
}

impl Level {
    /// `None` for every value that is not a level; the caller decides the default.
    pub fn parse(raw: &str) -> Option<Level> {
        match raw {
            "info" => Some(Level::Info),
            "debug" => Some(Level::Debug),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Debug => "debug",
        }
    }
}

/// One log line, prefixed with an ISO timestamp. This is also the hub's log
/// writer: the hub formats the message, the timestamp belongs to the process.
///
/// A line that cannot be written is not worth crashing over — the alternative
/// would be a `?` on every log call in every module.
pub fn log_line(message: &str) {
    let line = format!("{} {}\n", now_timestamp(), message);
    // One `write_all` on a locked stderr, so two lines from two tasks cannot
    // interleave halfway through a timestamp.
    let _ = std::io::stderr().lock().write_all(line.as_bytes());
}

/// IPv6 literals are logged in their bracketed form; `::1:8110` reads like a
/// different address entirely.
pub fn format_address(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// The symbolic name `bridge.mjs` prints for a failed bind:
/// ``logLine(`${label} failed on ${address}: ${error.code ?? error.message}`)``.
///
/// Rust's `io::Error` has no `code`, but it has `kind()`, which *is* the symbolic
/// name in portable form: `AddrInUse` is `EADDRINUSE` on Linux and `10048` on
/// Windows, so one `match` replaces the per-platform errno tables a number-based
/// mapping needed.
///
/// Everything else falls back to the error *text* and not to `kind().to_string()`:
/// the text carries the OS message and its number ("Is a directory (os error 21)"),
/// which is what an operator can grep for, while the kind's display degenerates to
/// "uncategorized error" precisely for the errors nobody has a name for. The one
/// name that is contract is pinned anyway: comparison 5 of the parity yardstick
/// (`docs/37`) records `EADDRINUSE`, and "Address already in use (os error 98)"
/// would fail it.
pub fn error_code(error: &io::Error) -> String {
    let name = match error.kind() {
        io::ErrorKind::AddrInUse => "EADDRINUSE",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
        _ => return error.to_string(),
    };

    name.to_string()
}

fn now_timestamp() -> String {
    iso_timestamp(SystemTime::now())
}

/// `Date.prototype.toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`, always exactly
/// three millisecond digits and always `Z`.
///
/// The parity yardstick strips exactly this prefix (`scripts/parity.sh`, mask
/// table in `docs/37`), and `test/bridge.test.js` pins the same regex — a
/// timestamp with two or six millisecond digits would make every log comparison
/// fail for a reason that looks like a protocol difference.
pub fn iso_timestamp(time: SystemTime) -> String {
    // Pre-1970 is not a case this service can meet; `unwrap_or(0)` keeps the
    // function total instead of panicking on a clock that is set back before the
    // epoch during boot.
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map(|since_epoch| since_epoch.as_millis() as i64)
        .unwrap_or(0);

    let seconds = millis.div_euclid(1_000);
    let milliseconds = millis.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milliseconds:03}Z",
        second_of_day / 3_600,
        (second_of_day / 60) % 60,
        second_of_day % 60,
    )
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's `civil_from_days`:
/// no table, no leap-year special case, correct for every proleptic Gregorian
/// year, which is the same calendar `Date` uses.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    // Shift the epoch to 0000-03-01, so that the leap day is the *last* day of
    // the year and the 400-year cycle starts on a March.
    let shifted = days_since_epoch + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    } as u32;

    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    // The case names carry the Node suite's spelling so the mapping stays readable;
    // `docs/38`, `### What could go wrong` names the allow.
    #![allow(non_snake_case)]

    use super::*;
    use std::time::Duration;

    #[test]
    fn iso_timestamp_withAnExactSecond_shouldStillCarryThreeMillisecondsAndZ() {
        // GIVEN an instant with no milliseconds at all,
        let time = UNIX_EPOCH + Duration::from_secs(1_763_000_000);

        // WHEN it is formatted the way `toISOString()` formats it,
        let formatted = iso_timestamp(time);

        // THEN the fraction is `000`, not dropped and not padded to six digits:
        assert_eq!(formatted, "2025-11-13T02:13:20.000Z");
    }

    #[test]
    fn iso_timestamp_withMilliseconds_shouldKeepExactlyThreeDigits() {
        // GIVEN an instant with a millisecond part,
        let time = UNIX_EPOCH + Duration::from_millis(1_763_000_000_007);

        // WHEN it is formatted,
        let formatted = iso_timestamp(time);

        // THEN the digits are right-aligned in a three-digit field:
        assert_eq!(formatted, "2025-11-13T02:13:20.007Z");
    }

    #[test]
    fn iso_timestamp_atTheLeapDayBoundary_shouldUseTheGregorianCalendar() {
        // GIVEN 2024-02-29T23:59:59.999Z, the day `civil_from_days` has to get
        // wrong first if the leap-year handling ever breaks,
        let time = UNIX_EPOCH + Duration::from_millis(1_709_251_199_999);

        // WHEN it is formatted,
        // THEN the date is the leap day and not 2024-03-01:
        assert_eq!(iso_timestamp(time), "2024-02-29T23:59:59.999Z");
    }

    #[test]
    fn format_address_withAnIpv6Host_shouldBracketIt() {
        assert_eq!(format_address("::1", 8110), "[::1]:8110");
        assert_eq!(format_address("127.0.0.1", 8110), "127.0.0.1:8110");
    }

    #[test]
    fn level_parse_withAnUnknownValue_shouldBeNone() {
        assert_eq!(Level::parse("debug"), Some(Level::Debug));
        assert_eq!(Level::parse("trace"), None);
        assert_eq!(Level::parse(""), None);
    }

    #[test]
    fn error_code_withAddrInUse_shouldBeTheNameTheNodeBridgePrints() {
        // GIVEN the failure an occupied port produces, built from its `ErrorKind`
        // so that the case needs neither a socket nor a second process,
        let error = io::Error::from(io::ErrorKind::AddrInUse);

        // WHEN the code is read the way `bridge.mjs` reads `error.code`,
        let code = error_code(&error);

        // THEN it is the name Node prints — and the same name the parity run
        // recorded from `bridge.mjs` itself, which is what keeps comparison 5
        // green. Asserting against the recorded line, not only against a literal,
        // is the point: two implementations that agree with each other and with
        // nothing else are exactly what the yardstick exists to catch.
        assert_eq!(code, "EADDRINUSE");
        assert_eq!(
            code,
            recordedBindCode(),
            "the parity artefact records a different code than this mapping produces",
        );
    }

    #[test]
    fn error_code_withAKindOutsideTheTable_shouldFallBackToTheTextWithoutPanicking() {
        // GIVEN an error the mapping has no name for: `EISDIR` is what reading a
        // directory gives, and it is none of the three kinds above,
        let error = io::Error::from_raw_os_error(21);

        // WHEN the code is read,
        let code = error_code(&error);

        // THEN nothing panics and the answer is the OS text — not an empty string
        // that would leave the log line ending in a colon. Node spells this one
        // `EISDIR: illegal operation on a directory, read`; the texts differ and
        // only the exit code is contract (`docs/38`), so no spelling is asserted.
        assert!(!code.is_empty(), "the fallback must not be empty");
        assert_eq!(code, error.to_string());
    }

    /// The code token of the recorded Node line, `listener failed on <address>:
    /// <code>`, taken from the artefact comparison 5 compares against.
    fn recordedBindCode() -> String {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/parity/expected/5-port-busy.txt");
        let recorded = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));

        recorded
            .lines()
            .find_map(|line| line.strip_prefix("listener failed on "))
            .and_then(|rest| rest.rsplit_once(": "))
            .map(|(_, code)| code.trim().to_string())
            .unwrap_or_else(|| panic!("{} has no `listener failed on …: <code>` line", path.display()))
    }
}
