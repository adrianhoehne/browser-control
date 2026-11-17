//! The configuration surface of the bridge: the three cases of
//! `test/config.test.js`, plus the bind parsing they do not reach.
//!
//! An empty environment keeps these cases independent of whatever happens to be
//! exported in the shell that runs the suite. `load_config()` reads no files.

// The case names are copied from the Node suite so the mapping stays readable;
// `docs/38`, `### What could go wrong` names the allow.
#![allow(non_snake_case)]

use std::collections::HashMap;

use browser_control_bridge::config::{load_config, Config};

/// Each case builds its own pseudo-environment; absent and blank are the same
/// thing here, exactly as in the module.
fn configWith(vars: &[(&str, &str)]) -> Config {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
    let env = move |name: &str| vars.get(name).cloned();

    load_config(&env)
}

#[test]
fn loadConfig_withoutHttpPortEnv_shouldDefaultTo8111() {
    // GIVEN an environment that says nothing about the HTTP port,
    let noEnv: &[(&str, &str)] = &[];

    // WHEN the configuration is loaded,
    // THEN the documented default applies:
    assert_eq!(configWith(noEnv).http_port, 8111);
}

#[test]
fn loadConfig_withHttpPortEnv_shouldUseThatPort() {
    // GIVEN an environment naming a different port,
    let env: &[(&str, &str)] = &[("BC_HTTP_PORT", "9123")];

    // WHEN the configuration is loaded,
    // THEN the configured port wins over the default:
    assert_eq!(configWith(env).http_port, 9123);
}

#[test]
fn loadConfig_withGarbageHttpPort_shouldFallBackToTheDefault() {
    // GIVEN values that cannot be a port — every field falls back rather than
    // throwing, because a typo in one variable must not stop the service,
    let garbageValues = ["", "elf", "0", "65536", "-1", "8111.5"];

    for rawHttpPort in garbageValues {
        // WHEN the configuration is loaded with it,
        let httpPort = configWith(&[("BC_HTTP_PORT", rawHttpPort)]).http_port;

        // THEN the port stays at the default instead of becoming NaN or 0:
        assert_eq!(
            httpPort, 8111,
            "BC_HTTP_PORT={rawHttpPort} was not rejected"
        );
    }
}

#[test]
fn loadConfig_withPortZeroOnTheBind_shouldStillFallBackTo8110() {
    // GIVEN the binding the operator expects to mean "any free port" — the silent
    // lie `docs/18` names and this port keeps, not repairs,
    let env: &[(&str, &str)] = &[("BC_BIND", "127.0.0.1:0")];

    // WHEN the configuration is loaded,
    let config = configWith(env);

    // THEN the host survives and the port is the default, because `0` is rejected
    // like every other invalid port:
    assert_eq!(config.host, "127.0.0.1");
    assert_eq!(config.port, 8110);
}

#[test]
fn loadConfig_withAnIpv6Bind_shouldStripTheBrackets() {
    // GIVEN the bracketed literal an operator would write — Node's resolver does
    // not accept it, so the brackets are stripped for the address and added back
    // only for the log line,
    let env: &[(&str, &str)] = &[("BC_BIND", "[::1]:18115")];

    // WHEN the configuration is loaded,
    let config = configWith(env);

    // THEN the host is the bare literal and the port is the one that was written:
    assert_eq!(config.host, "::1");
    assert_eq!(config.port, 18115);
}
