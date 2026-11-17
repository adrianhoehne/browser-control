//! Environment of the bridge, read once at startup.
//!
//! Everything here is pure: no I/O besides `read_token()`, no globals. `main()`
//! passes the process environment in as a lookup, which keeps this module
//! testable without spawning a process — the shape `bridge/config.mjs` had.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::log::Level;
use crate::protocol;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8110;

/// The second endpoint: MCP over HTTP. Its own port, because it is its own
/// listener — the extension socket must not share a surface with it.
const DEFAULT_HTTP_PORT: u16 = 8111;

const DEFAULT_LOG_LEVEL: Level = Level::Info;

/// bc's token contract: at least 32 hex characters, because that is the shortest
/// sane `openssl rand -hex 16`. Filesystem permissions (0600) are the operator's
/// job, not ours — checking them here would only produce false comfort.
const MIN_TOKEN_LENGTH: usize = 32;

/// Where the token lives when `BC_TOKEN_FILE` says nothing. Relative to the home
/// directory, because Node does not expand a literal `~` (and neither do we): a
/// tilde reaching `read` is a guaranteed `ENOENT` on a perfectly valid setup.
const DEFAULT_TOKEN_PATH: &str = ".config/browser-control/token";

/// Everything this module reads goes through this lookup, so the tests hand in an
/// environment instead of mutating the process's own.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The process environment as a lookup.
pub fn process_env() -> impl Fn(&str) -> Option<String> {
    |name: &str| std::env::var(name).ok()
}

/// The configuration a started bridge runs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub http_port: u16,
    pub log_level: Level,
    pub hello_timeout_ms: u64,
    pub call_timeout_ms: u64,
}

/// Turns the raw environment into the bridge's configuration. Invalid values fall
/// back to their default instead of failing: a bridge that refuses to start
/// because of a stray typo in `BC_LOG` helps nobody.
pub fn load_config(env: Env) -> Config {
    let (host, port) = parse_bind(&read_env(env, "BC_BIND"));
    let log_level = Level::parse(&read_env(env, "BC_LOG")).unwrap_or(DEFAULT_LOG_LEVEL);

    Config {
        host,
        port,
        http_port: parse_port(&read_env(env, "BC_HTTP_PORT")).unwrap_or(DEFAULT_HTTP_PORT),
        log_level,
        hello_timeout_ms: parse_timeout(
            &read_env(env, "BC_HELLO_TIMEOUT_MS"),
            protocol::HELLO_TIMEOUT_MS,
        ),
        call_timeout_ms: parse_timeout(&read_env(env, "BC_CALL_TIMEOUT_MS"), protocol::CALL_TIMEOUT_MS),
    }
}

/// Path of the token file: `BC_TOKEN_FILE` when it names one, else the documented
/// default under the home directory.
pub fn token_path(env: Env) -> PathBuf {
    let configured = read_env(env, "BC_TOKEN_FILE");
    if !configured.is_empty() {
        return PathBuf::from(configured);
    }
    home_directory(env).join(DEFAULT_TOKEN_PATH)
}

/// Returns the trimmed token, or `None` when it is missing or unusable. The
/// caller decides what `None` means; here it only means "no token we could use".
///
/// `openssl rand -hex 32 > token` writes a trailing newline, so the content is
/// trimmed before both checks and return.
pub fn read_token(token_file: &Path) -> io::Result<Option<String>> {
    let bytes = match fs::read(token_file) {
        Ok(bytes) => bytes,
        // A missing file is a configuration state the caller reports with exit 2.
        // Anything else (EACCES, EISDIR) is a different problem and must surface
        // as one instead of hiding behind "missing or too short".
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    // Lossy on purpose, like Node's `readFileSync(file, "utf8")`: a token file
    // with a stray byte stays "missing or too short" (exit 2) instead of turning
    // into an encoding error (exit 1) that no restart heals either.
    let token = String::from_utf8_lossy(&bytes).trim().to_string();

    if token.chars().count() < MIN_TOKEN_LENGTH {
        return Ok(None);
    }
    if !token.chars().all(|character| character.is_ascii_hexdigit()) {
        return Ok(None);
    }
    Ok(Some(token))
}

/// Reads and trims one environment variable. Absent and blank are the same thing:
/// neither is a configuration decision.
fn read_env(env: Env, name: &str) -> String {
    env(name).map(|raw| raw.trim().to_string()).unwrap_or_default()
}

fn parse_port(raw_port: &str) -> Option<u16> {
    let port = js_number(raw_port)?;
    if port.fract() != 0.0 || !(1.0..=65_535.0).contains(&port) {
        return None;
    }
    Some(port as u16)
}

/// `BC_BIND` is `host:port` and nothing else.
///
/// Splits at the *last* colon: an IPv6 literal contains colons of its own, and a
/// split on the first one would shred `[::1]:8110` into useless pieces.
///
/// The brackets are stripped because the resolver does not accept the bracketed
/// notation — they are added back only when the address is displayed
/// (`log::format_address`), so `BC_BIND=[::1]:8110` actually listens instead of
/// failing with "host not found".
///
/// An empty host would mean "all interfaces" to the resolver. Falling back to
/// loopback is the safer reading of a broken value: this listener is meant to sit
/// behind the reverse proxy, nowhere else.
///
/// Note that `BC_BIND=127.0.0.1:0` silently becomes `8110` — port `0` is rejected
/// like any other invalid port. That is today's behaviour and it is ported, not
/// repaired (`docs/18`, `## Bekannte Lücken`).
fn parse_bind(raw_bind: &str) -> (String, u16) {
    if raw_bind.is_empty() {
        return (DEFAULT_HOST.to_string(), DEFAULT_PORT);
    }

    let Some(separator) = raw_bind.rfind(':') else {
        return (DEFAULT_HOST.to_string(), DEFAULT_PORT);
    };

    let host = strip_ipv6_brackets(&raw_bind[..separator]);
    let port = parse_port(&raw_bind[separator + 1..]);

    let host = if host.is_empty() {
        DEFAULT_HOST.to_string()
    } else {
        host
    };

    (host, port.unwrap_or(DEFAULT_PORT))
}

fn strip_ipv6_brackets(host: &str) -> String {
    host.strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host)
        .to_string()
}

fn parse_timeout(raw_value: &str, fallback: u64) -> u64 {
    match js_number(raw_value) {
        Some(value) if value.fract() == 0.0 && value > 0.0 => value as u64,
        _ => fallback,
    }
}

/// Mirrors what the Node module got out of `Number(raw)` for the values it feeds
/// this function — a decimal number with an optional fraction and exponent, or a
/// `0x`-prefixed hex literal — but it is deliberately *not* `Number(raw)` itself:
/// `Number("0b1010")` is `10` and `Number("0o17")` is `15`, while both fall back
/// to the default here. The only callers are `BC_BIND`'s port and the two
/// timeouts, which nobody writes in binary or octal; supporting those bases would
/// be code that exists only to be tested, so the difference is named here instead
/// of hidden behind a "mirrors JavaScript" claim that would be false.
///
/// The empty string is `None` here although `Number("")` is `0`: the Node code
/// tested for `""` before it ever called `Number`, because absent and blank mean
/// the same thing (see `read_env`).
fn js_number(raw: &str) -> Option<f64> {
    if raw.is_empty() {
        return None;
    }
    if let Some(hex_digits) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        return i64::from_str_radix(hex_digits, 16)
            .ok()
            .map(|value| value as f64);
    }
    let value: f64 = raw.parse().ok()?;
    // `Infinity` parses in Rust and is a number in JavaScript too — but never an
    // integer, so it must not survive this far.
    value.is_finite().then_some(value)
}

/// The home directory, asked of the environment like everything else here.
///
/// No fallback beyond the injected environment: reaching for `process_env()` when
/// `HOME` is unset would make `token_path` depend on the shell that happens to run
/// it — a unit test would pass or fail with the developer's `HOME`, and the module
/// header's "no globals" would be a lie.
///
/// The price is Node's `os.homedir()` passwd fallback: without `HOME`, Node finds
/// the home in `/etc/passwd` and this finds an empty base, so the token is looked
/// up in `./.config/…` and the bridge stops with exit 2 instead. That is not
/// rebuilt here — it would need a passwd reader and a dependency for a variable
/// systemd always sets.
fn home_directory(env: Env) -> PathBuf {
    PathBuf::from(read_env(env, "HOME"))
}

#[cfg(test)]
mod tests {
    // The case names carry the Node suite's spelling so the mapping stays readable;
    // `docs/38`, `### What could go wrong` names the allow.
    #![allow(non_snake_case)]

    use std::collections::HashMap;

    use super::*;

    /// `load_config` over a fixed pseudo-environment, so a case never depends on
    /// what happens to be exported in the shell that runs the tests.
    fn config_with(vars: &[(&str, &str)]) -> Config {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        let env = move |name: &str| vars.get(name).cloned();
        load_config(&env)
    }

    #[test]
    fn parse_bind_withPortZero_shouldFallBackTo8110LikeAnyOtherInvalidPort() {
        // GIVEN the binding the operator expects to mean "any free port" — a lie
        // the Node module never told them about (docs/18, "Bekannte Lücken"),
        // WHEN it is parsed,
        let (host, port) = parse_bind("127.0.0.1:0");

        // THEN the host survives and the port falls back — ported, not repaired:
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, DEFAULT_PORT);
    }

    #[test]
    fn parse_bind_withAnIpv6Literal_shouldStripTheBrackets() {
        let (host, port) = parse_bind("[::1]:18115");

        assert_eq!(host, "::1");
        assert_eq!(port, 18_115);
    }

    #[test]
    fn parse_bind_withAnEmptyHost_shouldFallBackToLoopback() {
        let (host, port) = parse_bind(":8110");

        assert_eq!(host, DEFAULT_HOST);
        assert_eq!(port, 8_110);
    }

    #[test]
    fn parse_bind_withoutAColon_shouldFallBackToTheDefault() {
        assert_eq!(parse_bind("8110"), (DEFAULT_HOST.to_string(), DEFAULT_PORT));
        assert_eq!(parse_bind(""), (DEFAULT_HOST.to_string(), DEFAULT_PORT));
    }

    #[test]
    fn load_config_withALogLevelThatIsNotALevel_shouldUseInfo() {
        assert_eq!(config_with(&[("BC_LOG", "trace")]).log_level, Level::Info);
        assert_eq!(config_with(&[("BC_LOG", " debug ")]).log_level, Level::Debug);
    }

    #[test]
    fn token_path_withoutTheEnv_shouldLiveUnderTheHomeDirectory() {
        let env = |name: &str| (name == "HOME").then(|| "/home/tester".to_string());

        assert_eq!(
            token_path(&env),
            PathBuf::from("/home/tester/.config/browser-control/token")
        );
    }

    #[test]
    fn read_token_withADirectoryAsTheTokenPath_shouldBeAnErrorAndNotNone() {
        // GIVEN a path that is a directory: reading it fails with `EISDIR` on
        // Linux and `EACCES` on Windows, and the case needs neither root nor
        // `chmod`. It is the one that separates "no token" (exit 2) from "the
        // read itself failed" (exit 1),
        let path = std::env::temp_dir().join(format!("bc-rust-token-dir-{}", std::process::id()));
        fs::create_dir_all(&path).expect("create the directory");

        // WHEN it is read,
        let result = read_token(&path);

        // THEN the answer is an error, not `Ok(None)`: an `Err(_) => Ok(None)`
        // would turn a permission problem into a silent exit 2 and leave the suite
        // green. The texts differ per implementation (Node: `EISDIR: illegal
        // operation on a directory, read`, Rust: `Is a directory (os error 21)`)
        // while the exit code does not, so only the error is asserted here.
        let error = result.expect_err("reading a directory must fail");
        assert!(
            error.kind() != io::ErrorKind::NotFound,
            "a directory is not a missing file, got {error}",
        );

        fs::remove_dir(&path).expect("remove the directory");
    }

    #[test]
    fn parse_timeout_withAnExponent_shouldBeThePlainNumber() {
        // GIVEN the exponent form JavaScript accepts and an operator might write,
        // WHEN it is parsed as a timeout,
        // THEN it is a thousand milliseconds, not the fallback:
        assert_eq!(parse_timeout("1e3", protocol::CALL_TIMEOUT_MS), 1_000);
        assert_eq!(parse_timeout("1E3", protocol::CALL_TIMEOUT_MS), 1_000);
    }

    #[test]
    fn parse_timeout_withAFraction_shouldFallBackToTheDefault() {
        // GIVEN a fraction — a number, but not a whole millisecond count,
        // WHEN it is parsed as a timeout,
        // THEN the fallback applies, because a truncated half millisecond would be
        // a threshold nobody wrote:
        assert_eq!(
            parse_timeout("0.5", protocol::CALL_TIMEOUT_MS),
            protocol::CALL_TIMEOUT_MS,
        );
    }

    #[test]
    fn read_token_withAMissingFile_shouldBeNoneAndNotAnError() {
        // GIVEN a path that was never written — the state the caller reports with
        // exit 2, and the one that must not look like an I/O failure,
        let missing = std::env::temp_dir().join("bc-rust-token-that-does-not-exist");

        // WHEN it is read,
        let result = read_token(&missing);

        // THEN the answer is "no token", not an error:
        assert!(matches!(result, Ok(None)), "got {result:?}");
    }

    #[test]
    fn read_token_withAShortOrNonHexToken_shouldBeNone() {
        let path = std::env::temp_dir().join(format!("bc-rust-token-{}", std::process::id()));
        let cases = [
            ("", "empty file"),
            ("\n", "whitespace only"),
            ("0123456789abcdef0123456789abcde", "31 hex characters"),
            ("0123456789abcdef0123456789abcdeZ", "32 characters, one of them not hex"),
        ];

        for (content, case) in cases {
            // GIVEN a token file with a value that cannot be used,
            fs::write(&path, content).expect("write the token file");

            // WHEN it is read,
            let result = read_token(&path).expect("reading an existing file cannot fail here");

            // THEN it is refused, whatever else the value contains:
            assert_eq!(result, None, "{case}: the value was accepted");
        }

        // ... and a trimmed 32-character hex token is accepted, uppercase included:
        fs::write(&path, "  0123456789ABCDEF0123456789ABCDEF\n").expect("write the token file");
        assert_eq!(
            read_token(&path).expect("reading an existing file cannot fail here"),
            Some("0123456789ABCDEF0123456789ABCDEF".to_string())
        );

        fs::remove_file(&path).expect("remove the token file");
    }
}
