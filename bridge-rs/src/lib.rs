//! The Rust bridge of browser-control, ported module by module from `bridge/`
//! (`docs/38`).
//!
//! It is a library as well as a binary because the behaviour was pinned by unit
//! tests in the Node suite: `test/config.test.js` imported `loadConfig` instead
//! of spawning a process, and the port keeps that shape. `main.rs` is only the
//! start path on top of these modules.

pub mod config;
pub mod head;
pub mod hub;
pub mod link;
pub mod log;
pub mod mcp;
pub mod platform;
pub mod protocol;
pub mod stdio;
pub mod ws;
