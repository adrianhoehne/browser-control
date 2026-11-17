//! The third copy of the wire constants, held against the second one.
//!
//! `test/protocol.test.js` ran `extension/protocol.js` through `node:vm` and
//! compared two objects; `vm.runInNewContext` and `Object.isFrozen` have no
//! counterpart here. What replaces them is a small reader for the one shape that
//! file actually has: a frozen object literal of `KEY: value` and `GROUP: {…}`
//! entries. A shape this reader does not know is a loud failure, because the whole
//! point of the case is that a silent default would make every drift look like
//! agreement.

// The case name is copied from the Node suite so the mapping stays readable;
// `docs/38`, `### What could go wrong` names the allow.
#![allow(non_snake_case)]

use std::fs;
use std::path::PathBuf;

use browser_control_bridge::protocol;

const PROTOCOL_JS: &str = "../extension/protocol.js";

#[test]
fn protocol_constants_matchTheExtension() {
    // GIVEN the classic-script copy the extension publishes on `globalThis`,
    let source = protocolSource();
    let mut fromTheExtension = flattenProtocol(&source);
    fromTheExtension.sort();

    // WHEN the bridge's own constants are read the same way,
    let mut fromTheBridge = bridgeConstants();
    fromTheBridge.sort();

    // THEN the two lists agree name for name and value for value. A constant that
    // exists on one side only is a difference too, which is why the whole list is
    // compared and not a hand-picked subset:
    assert_eq!(
        fromTheBridge.len(),
        fromTheExtension.len(),
        "the extension publishes {} constants, the bridge carries {}",
        fromTheExtension.len(),
        fromTheBridge.len(),
    );
    assert_eq!(fromTheBridge, fromTheExtension);
}

fn protocolSource() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(PROTOCOL_JS);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// The bridge side of the comparison: every constant of `protocol.rs` with the
/// path the extension file uses for it.
/// The bridge side of the comparison: the table `protocol.rs` generates from the
/// same macro that declares the constants, so an entry can only be missing here if
/// the constant itself is missing.
fn bridgeConstants() -> Vec<(String, String)> {
    protocol::constants()
}

/* ------------------------------------------------------------- the file reader */

/// Flattens `globalThis.BC_PROTOCOL = Object.freeze({ … })` into
/// `("TYPES.HELLO", "hello")` pairs.
fn flattenProtocol(source: &str) -> Vec<(String, String)> {
    let body = objectBody(source).unwrap_or_else(|| {
        panic!("extension/protocol.js has no `BC_PROTOCOL = Object.freeze({{…}})`:\n{source}")
    });

    let mut flattened = Vec::new();
    flattenObject(body, "", &mut flattened);
    flattened
}

fn objectBody(source: &str) -> Option<&str> {
    // The assignment, not the bare name: the doc comment above it mentions
    // `globalThis` and could mention the name as well one day.
    let name = source.find("BC_PROTOCOL =")?;
    let open = name + source[name..].find('{')?;
    let close = matchingBrace(source.as_bytes(), open)?;

    Some(&source[open + 1..close])
}

/// `prefix` is the dotted path of the object being read; nested groups append their
/// key, so `close.auth_failed`-style collisions cannot happen.
fn flattenObject(source: &str, prefix: &str, out: &mut Vec<(String, String)>) {
    let bytes = source.as_bytes();
    let mut index = 0;

    loop {
        index = skipTrivia(bytes, index);
        if index >= bytes.len() {
            return;
        }

        let keyStart = index;
        while let Some(byte) = bytes.get(index) {
            if byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'$' {
                index += 1;
            } else {
                break;
            }
        }
        let key = &source[keyStart..index];
        if key.is_empty() {
            panic!(
                "extension/protocol.js: expected a constant name near `{}`",
                snippet(source, keyStart),
            );
        }

        index = skipSpaces(bytes, index);
        if bytes.get(index) != Some(&b':') {
            panic!("extension/protocol.js: expected `:` after `{key}` near `{}`", snippet(source, index));
        }
        // Groups are wrapped in `Object.freeze(…)`; a scalar is not.
        index = unwrapFreeze(bytes, skipSpaces(bytes, index + 1));

        let path = format!("{prefix}{key}");
        match bytes.get(index) {
            Some(b'{') => {
                let close = matchingBrace(bytes, index).unwrap_or_else(|| {
                    panic!("extension/protocol.js: `{key}` has an unclosed `{{`")
                });
                flattenObject(&source[index + 1..close], &format!("{path}."), out);
                index = closeAfterWrapper(bytes, close + 1);
            }
            Some(b'"') => {
                let close = closingQuote(bytes, index).unwrap_or_else(|| {
                    panic!("extension/protocol.js: `{key}` has an unterminated string")
                });
                out.push((path, source[index + 1..close].to_string()));
                index = closeAfterWrapper(bytes, close + 1);
            }
            Some(_) => {
                let valueStart = index;
                while let Some(byte) = bytes.get(index) {
                    if *byte == b',' || *byte == b'}' || *byte == b'\n' {
                        break;
                    }
                    index += 1;
                }
                out.push((path, source[valueStart..index].trim().to_string()));
            }
            None => panic!("extension/protocol.js: `{key}` has no value"),
        }
    }
}

/// Skips the `Object.freeze(` in front of a group. The values of this file are
/// numbers and strings, so nothing but that call can appear before a value.
fn unwrapFreeze(bytes: &[u8], mut index: usize) -> usize {
    const FREEZE: &[u8] = b"Object.freeze";

    while bytes.get(index..index + FREEZE.len()) == Some(FREEZE) {
        index = skipSpaces(bytes, index + FREEZE.len());
        if bytes.get(index) == Some(&b'(') {
            index = skipSpaces(bytes, index + 1);
        }
    }
    index
}

/// Steps past the `)` that closes an `Object.freeze(` unwrapped above.
fn closeAfterWrapper(bytes: &[u8], index: usize) -> usize {
    if bytes.get(index) == Some(&b')') {
        index + 1
    } else {
        index
    }
}

/// A short window around `index`, for panic messages that should point at the
/// problem instead of dumping the file.
fn snippet(source: &str, index: usize) -> String {
    let mut end = (index + 120).min(source.len());
    while !source.is_char_boundary(end) {
        end -= 1;
    }
    source[index..end].replace('\n', " ")
}

fn skipTrivia(bytes: &[u8], mut index: usize) -> usize {
    loop {
        while let Some(byte) = bytes.get(index) {
            if byte.is_ascii_whitespace() || *byte == b',' {
                index += 1;
            } else {
                break;
            }
        }
        // The file explains itself with `//` comments between entries; a comment
        // must not be read as a key.
        if bytes.get(index) == Some(&b'/') && bytes.get(index + 1) == Some(&b'/') {
            index = lineEnd(bytes, index);
            continue;
        }
        return index;
    }
}

fn skipSpaces(bytes: &[u8], mut index: usize) -> usize {
    while let Some(byte) = bytes.get(index) {
        if byte.is_ascii_whitespace() {
            index += 1;
        } else {
            break;
        }
    }
    index
}

fn lineEnd(bytes: &[u8], index: usize) -> usize {
    match bytes[index..].iter().position(|byte| *byte == b'\n') {
        Some(offset) => index + offset + 1,
        None => bytes.len(),
    }
}

/// Index of the `}` that closes the `{` at `open`. Quoted strings and `//`
/// comments are stepped over, so a brace inside either cannot shift the depth.
fn matchingBrace(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut index = open;

    while index < bytes.len() {
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            b'"' => index = closingQuote(bytes, index)?,
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index = lineEnd(bytes, index);
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Index of the `"` that closes the string opened at `open`.
fn closingQuote(bytes: &[u8], open: usize) -> Option<usize> {
    let mut index = open + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some(index),
            _ => index += 1,
        }
    }
    None
}
