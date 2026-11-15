import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { PROTOCOL } from "../bridge/protocol.mjs";

const EXTENSION_PROTOCOL_URL = new URL("../extension/protocol.js", import.meta.url);

/**
 * Runs the classic script the way the extension does and returns its constants.
 *
 * The JSON round trip is not decoration: `deepStrictEqual` also compares
 * `[[Prototype]]`, and a value built inside `vm.runInNewContext` carries the
 * other realm's `Object.prototype`, so a direct comparison fails with "same
 * structure but not reference-equal".
 */
async function loadExtensionProtocol() {
  const source = await readFile(EXTENSION_PROTOCOL_URL, "utf8");
  const sandbox = vm.createContext({});
  vm.runInNewContext(source, sandbox, { filename: "extension/protocol.js" });

  // A `const` at the top of a classic script stays lexical and never becomes a
  // context property — hence the `globalThis` assignment in the script itself.
  assert.notEqual(sandbox.BC_PROTOCOL, undefined, "classic script did not publish BC_PROTOCOL");
  return JSON.parse(JSON.stringify(sandbox.BC_PROTOCOL));
}

test("loadExtensionProtocol_runningTheClassicScript_shouldPublishFrozenConstants", async () => {
  // GIVEN the classic protocol script of the extension,
  // WHEN we run it in a fresh VM context,
  const source = await readFile(EXTENSION_PROTOCOL_URL, "utf8");
  const sandbox = vm.createContext({});
  vm.runInNewContext(source, sandbox, { filename: "extension/protocol.js" });

  // THEN the published object must exist and be immutable, because a background
  // page that mutates shared constants is a debugging story nobody wants:
  assert.equal(Object.isFrozen(sandbox.BC_PROTOCOL), true);
});

test("extensionAndBridgeProtocols_methodsNavigate_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `navigate` method name,
  // THEN each must carry it literally. `deepStrictEqual` above compares the two
  // copies with each other and stays green when *both* lack the key — the one
  // drift it cannot see, so this case spells the value out twice:
  assert.equal(PROTOCOL.METHODS.NAVIGATE, "navigate");
  assert.equal(extensionProtocol.METHODS.NAVIGATE, "navigate");
});

test("extensionAndBridgeProtocols_methodsRead_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `read` method name,
  // THEN each must carry it literally — same reason as the `navigate` case
  // above: the whole-object comparison is blind to a key both sides omit:
  assert.equal(PROTOCOL.METHODS.READ, "read");
  assert.equal(extensionProtocol.METHODS.READ, "read");
});

test("extensionAndBridgeProtocols_methodsClick_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `click` method name,
  // THEN each must carry it literally — same reason as the `navigate` and `read`
  // cases: the whole-object comparison stays green when *both* copies lose the
  // key:
  assert.equal(PROTOCOL.METHODS.CLICK, "click");
  assert.equal(extensionProtocol.METHODS.CLICK, "click");
});

test("extensionAndBridgeProtocols_methodsType_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `type` method name,
  // THEN each must carry it literally — same reason as the `navigate`, `read` and
  // `click` cases: the whole-object comparison stays green when *both* copies lose
  // the key:
  assert.equal(PROTOCOL.METHODS.TYPE, "type");
  assert.equal(extensionProtocol.METHODS.TYPE, "type");
});

test("extensionAndBridgeProtocols_methodsFocus_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `focus` method name,
  // THEN each must carry it literally — same reason as the `navigate`, `read`,
  // `click` and `type` cases: the whole-object comparison stays green when *both*
  // copies lose the key:
  assert.equal(PROTOCOL.METHODS.FOCUS, "focus");
  assert.equal(extensionProtocol.METHODS.FOCUS, "focus");
});

test("extensionAndBridgeProtocols_methodsInspect_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `inspect` method name,
  // THEN each must carry it literally — same reason as the `navigate`, `read`,
  // `click`, `type` and `focus` cases: the whole-object comparison stays green
  // when *both* copies lose the key:
  assert.equal(PROTOCOL.METHODS.INSPECT, "inspect");
  assert.equal(extensionProtocol.METHODS.INSPECT, "inspect");
});

test("extensionAndBridgeProtocols_methodsOpenTab_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `open_tab` method name,
  // THEN each must carry it literally — same reason as the cases above: the
  // whole-object comparison stays green when *both* copies lose the key:
  assert.equal(PROTOCOL.METHODS.OPEN_TAB, "open_tab");
  assert.equal(extensionProtocol.METHODS.OPEN_TAB, "open_tab");
});

test("extensionAndBridgeProtocols_methodsCloseTab_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `close_tab` method name,
  // THEN each must carry it literally — same reason as the cases above: the
  // whole-object comparison stays green when *both* copies lose the key:
  assert.equal(PROTOCOL.METHODS.CLOSE_TAB, "close_tab");
  assert.equal(extensionProtocol.METHODS.CLOSE_TAB, "close_tab");
});

test("extensionAndBridgeProtocols_methodsEval_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `eval` method name,
  // THEN each must carry it literally — same reason as the cases above: the
  // whole-object comparison stays green when *both* copies lose the key:
  assert.equal(PROTOCOL.METHODS.EVAL, "eval");
  assert.equal(extensionProtocol.METHODS.EVAL, "eval");
});

test("extensionAndBridgeProtocols_methodsScreenshot_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `screenshot` method name,
  // THEN each must carry it literally — same reason as every case above: the
  // whole-object comparison stays green when *both* copies lose the key, and a
  // method missing on one side is a call the other side never gets an answer to:
  assert.equal(PROTOCOL.METHODS.SCREENSHOT, "screenshot");
  assert.equal(extensionProtocol.METHODS.SCREENSHOT, "screenshot");
});

test("extensionAndBridgeProtocols_methodsFrames_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `frames` method name,
  // THEN each must carry it literally — same reason as every case above: the
  // whole-object comparison stays green when *both* copies lose the key, and this
  // is the method the twelfth tool asks for, so a missing one would answer
  // `unsupported_method` to a tool that is advertised in `tools/list`:
  assert.equal(PROTOCOL.METHODS.FRAMES, "frames");
  assert.equal(extensionProtocol.METHODS.FRAMES, "frames");
});

test("extensionAndBridgeProtocols_methodsTranscript_shouldBothSpellItOutLiterally", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the `transcript` method name,
  // THEN each must carry it literally — same reason as every case above: the
  // whole-object comparison stays green when *both* copies lose the key, and this
  // is the method the thirteenth tool asks for, so a missing one would answer
  // `unsupported_method` to a tool that is advertised in `tools/list`:
  assert.equal(PROTOCOL.METHODS.TRANSCRIPT, "transcript");
  assert.equal(extensionProtocol.METHODS.TRANSCRIPT, "transcript");
});

test("extensionAndBridgeProtocols_maxMessageBytes_shouldBothCarryFiveMebibytes", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the message limit,
  // THEN each must carry it literally — the whole-object comparison below is blind
  // to a value both copies change together, and 5 MiB is the room a 3 MiB picture
  // needs once Base64 turns it into 4 194 304 bytes:
  assert.equal(PROTOCOL.MAX_MESSAGE_BYTES, 5242880);
  assert.equal(extensionProtocol.MAX_MESSAGE_BYTES, 5242880);
});

test("extensionAndBridgeProtocols_callTimeoutMs_shouldBothCarryTwentySeconds", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we ask each copy for the call deadline,
  // THEN each must carry it literally — same reason as the `MAX_MESSAGE_BYTES`
  // case, plus one of its own: a bridge that gave up earlier than the extension
  // could still be shrinking a picture would read `ExtensionTimeout` for an answer
  // that was on its way:
  assert.equal(PROTOCOL.CALL_TIMEOUT_MS, 20000);
  assert.equal(extensionProtocol.CALL_TIMEOUT_MS, 20000);
});

test("extensionProtocol_callTimeoutMs_shouldStayAboveTheEvalGuard", async () => {
  // GIVEN the constants both sides carry,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we compare the hub's call timeout with the extension's own eval deadline,
  // THEN the extension must answer first. `EVAL_GUARD_MS` is 2 500 ms —
  // `EVAL_TIMEOUT_MS` 2 000 plus 500 ms of air for a throttled page timer — and a hub
  // that gave up at 2 500 or earlier would answer `ExtensionTimeout` instead of
  // `eval_timeout`. Both numbers live inside the background page's IIFE and cannot be
  // read from here, so this pin guards the order, not the value:
  assert.ok(
    extensionProtocol.CALL_TIMEOUT_MS > 2500,
    `CALL_TIMEOUT_MS is ${extensionProtocol.CALL_TIMEOUT_MS}`,
  );
  assert.equal(PROTOCOL.CALL_TIMEOUT_MS, extensionProtocol.CALL_TIMEOUT_MS);
});

test("extensionProtocol_comparedToBridgeProtocol_shouldBeIdentical", async () => {
  // GIVEN the constants of both sides,
  const extensionProtocol = await loadExtensionProtocol();

  // WHEN we compare them value by value,
  // THEN they must match exactly — a drifted close code or timeout on one side
  // would only surface as a mysterious disconnect in the field:
  assert.deepStrictEqual(extensionProtocol, PROTOCOL);
});
