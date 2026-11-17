//! Entry point of the bridge: read configuration, refuse to start without a
//! usable token, bind the extension listener, serve the hub on every accepted
//! connection and stop cleanly on SIGTERM/SIGINT.
//!
//! Stages 2a (`docs/38`) and 2b gave this file its configuration, its listener and
//! the WebSocket codec; 2c adds the socket glue for the hub — the per-connection
//! read/write loop, the HTTP head reader and the answers for a request that is not a
//! handshake. That glue lives in `link.rs` and `head.rs`, not here: a start path the
//! integration tests cannot see is a start path nothing measures, which is how a
//! swallowed `hello` and a `400` where a `426` belongs stayed invisible. What stays in
//! this file is the start itself — configuration, bind, accept loop, signals, exit
//! codes.
//!
//! `/mcp` over stdio and HTTP arrive after that, so `--http` is still not read.
//!
//! stdout is the JSON-RPC channel and nothing else: every line this file writes
//! goes to stderr through `log::log_line`.
//!
//! The two exit codes of the service are deliberate: `1` for a start that failed
//! (a port that could not be bound among them — systemd restarts, which is the
//! point), `2` for a missing or too short token file (no restart heals that, which
//! is what `RestartPreventExitStatus=2` in the unit is for).

use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;

use browser_control_bridge::config;
use browser_control_bridge::hub::Hub;
use browser_control_bridge::link;
use browser_control_bridge::log;
use browser_control_bridge::platform;

const EXIT_OK: i32 = 0;
const EXIT_FAILURE: i32 = 1;
const EXIT_CONFIGURATION: i32 = 2;

#[tokio::main]
async fn main() {
    std::process::exit(run().await);
}

async fn run() -> i32 {
    let env = config::process_env();
    let configuration = config::load_config(&env);
    let address = log::format_address(&configuration.host, configuration.port);
    let token_file = config::token_path(&env);

    // Read before anything binds: a bridge without a token would sit on the port
    // refusing every extension, and exit 2 is what the unit's
    // `RestartPreventExitStatus=2` is written for.
    let token = match config::read_token(&token_file) {
        Ok(Some(token)) => token,
        Ok(None) => {
            log::log_line(&format!(
                "token file missing or too short: {}",
                token_file.display()
            ));
            return EXIT_CONFIGURATION;
        }
        Err(error) => {
            log::log_line(&format!("bridge failed: {error}"));
            return EXIT_FAILURE;
        }
    };

    // Installed before the bind, like `bridge.mjs` does it: a signal during startup
    // must exit 0 through the same path a signal during work does, instead of dying
    // with the default signal status.
    let mut signals = match stop::Signals::register() {
        Ok(signals) => signals,
        Err(error) => {
            log::log_line(&format!("bridge failed: {error}"));
            return EXIT_FAILURE;
        }
    };

    // A tuple, not a formatted `host:port`: the resolver wants the bare IPv6
    // literal, and `::1:8110` would be an address nobody asked for.
    let listener = match TcpListener::bind((configuration.host.as_str(), configuration.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            log_bind_failure("listener", &address, configuration.port, &error);
            return EXIT_FAILURE;
        }
    };

    log::log_line(&format!(
        "listening on {address} log={}",
        configuration.log_level.as_str()
    ));

    let hub = Arc::new(Hub::new(&configuration, token));
    // The request head on this port is unauthenticated input, and the only deadline
    // the configuration has for unauthenticated input is the `hello` timeout. Reading
    // it once keeps both halves of "prove yourself within X" on the same number.
    let head_deadline = Duration::from_millis(configuration.hello_timeout_ms);

    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                // One task per connection: the accept loop must never wait for a
                // peer's handshake, and a browser that opens and abandons a socket
                // must not delay the next one.
                Ok((stream, peer_address)) => {
                    let hub = Arc::clone(&hub);
                    // The peer is the bare address, not `address:port`: the template
                    // logged `socket.remoteAddress`, and a port in this field would be
                    // a shape no Node line ever produced.
                    let peer = peer_address.ip().to_string();
                    tokio::spawn(async move {
                        let (reader, writer) = stream.into_split();
                        link::serve_connection(hub, reader, writer, peer, head_deadline).await;
                    });
                }
                // A connection aborted between the SYN and our accept is not an error:
                // Node ignores `ECONNABORTED` silently, and a line per aborted
                // handshake would be a log flood from any port scan.
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionAborted => {}
                // Everything else leaves a listener that cannot listen. `EMFILE` used
                // to spin here forever, writing the same failure as fast as the CPU
                // allowed; the template logs once and ends with 1, and 1 is what the
                // unit restarts for.
                Err(error) => {
                    log::log_line(&format!(
                        "listener failed on {address}: {}",
                        log::error_code(&error)
                    ));
                    return EXIT_FAILURE;
                }
            },
            signal = signals.next() => {
                log::log_line(&format!("{signal}, shutting down"));
                return EXIT_OK;
            }
        }
    }
}

/// The two lines a failed bind writes: what failed, and who owns the port.
///
/// The second line costs a `/proc` walk and only runs on a failed start, which is
/// exactly why it can afford to be helpful.
fn log_bind_failure(label: &str, address: &str, port: u16, error: &std::io::Error) {
    log::log_line(&format!(
        "{label} failed on {address}: {}",
        log::error_code(error)
    ));

    let owner = match platform::find_port_owner(port) {
        Some(owner) => format!("owner pid={} name={}", owner.pid, owner.name),
        None => "Besitzer nicht ermittelbar".to_string(),
    };
    log::log_line(&format!("port {address} in use, {owner}"));
}

/// The shutdown contract: SIGTERM and SIGINT are the only two ways this process is
/// asked to stop, and both end with 0 — the service is not failing, it is being
/// stopped.
#[cfg(unix)]
mod stop {
    use tokio::signal::unix::{signal, Signal, SignalKind};

    /// Both handlers, registered the moment this returns. Registering eagerly is
    /// the point: a signal that arrives while the listener binds must still end the
    /// process with 0.
    pub struct Signals {
        terminate: Signal,
        interrupt: Signal,
    }

    impl Signals {
        pub fn register() -> std::io::Result<Signals> {
            Ok(Signals {
                terminate: signal(SignalKind::terminate())?,
                interrupt: signal(SignalKind::interrupt())?,
            })
        }

        /// The reason `main` logs, spelled the way the Node bridge spells it.
        pub async fn next(&mut self) -> &'static str {
            tokio::select! {
                _ = self.terminate.recv() => "received SIGTERM",
                _ = self.interrupt.recv() => "received SIGINT",
            }
        }
    }
}

/// Windows has no SIGTERM. `ctrl_c` is the stop request a console process gets, and
/// the Task Scheduler path of stage 3 of `docs/38` is built on it.
#[cfg(not(unix))]
mod stop {
    pub struct Signals;

    impl Signals {
        pub fn register() -> std::io::Result<Signals> {
            Ok(Signals)
        }

        pub async fn next(&mut self) -> &'static str {
            let _ = tokio::signal::ctrl_c().await;
            "received SIGINT"
        }
    }
}
