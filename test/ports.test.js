/**
 * The guard rail around `test/ports.js`.
 *
 * Every other test file trusts the table to hold numbers that nobody else uses.
 * That trust is exactly what these three cases check, because a duplicate port
 * does not fail loudly — it makes some *other* file's bridge exit 1 and turns a
 * green run into a confusing red one elsewhere.
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as RESERVED_PORTS from "./ports.js";

// Inclusive, and spelled out rather than imported: the range is the contract,
// so a test that reads its own bounds from the module could not notice them
// drifting.
const FIRST_RESERVED_PORT = 18110;
const LAST_RESERVED_PORT = 18119;

/** Every port number of the table, with the entry that claims it. */
function claimedPorts() {
  return Object.entries(RESERVED_PORTS).flatMap(([entryName, entry]) =>
    Object.entries(entry).map(([role, port]) => ({ where: `${entryName}.${role}`, port })),
  );
}

test("reservedPorts_everyNumber_shouldLieInsideTheReservedRange", () => {
  // GIVEN the whole table of reserved ports,
  const claims = claimedPorts();

  // WHEN each number is compared with the range the spec reserves,
  // THEN the table is not empty and no number sits outside 18110–18119 — the
  // numbers below that are either privileged or the operator's own bridge:
  assert.ok(claims.length > 0, "the table must reserve at least one port");
  for (const { where, port } of claims) {
    assert.ok(
      Number.isInteger(port) && port >= FIRST_RESERVED_PORT && port <= LAST_RESERVED_PORT,
      `${where} = ${port} is outside ${FIRST_RESERVED_PORT}–${LAST_RESERVED_PORT}`,
    );
  }
});

test("reservedPorts_twoEntriesOnOneNumber_shouldNotExist", () => {
  // GIVEN the table, with every claim flattened to a name/port pair,
  const claims = claimedPorts();

  // WHEN the numbers are grouped by their value,
  // THEN no value is claimed twice — a shared port would make two files fight
  // over one bridge, which is the hang this table replaced:
  const claimers = new Map();
  for (const { where, port } of claims) {
    claimers.set(port, [...(claimers.get(port) ?? []), where]);
  }
  const shared = [...claimers.entries()].filter(([, names]) => names.length > 1);

  assert.deepEqual(shared, [], `ports claimed more than once: ${JSON.stringify(shared)}`);
});

test("reservedPorts_everyEntry_shouldNameAnExtensionPort", () => {
  // GIVEN the table,
  // WHEN each entry is read as "the ports one test file binds",
  // THEN each one has the extension listener every spawning test needs, and no
  // other role is left unnamed or mistyped:
  for (const [entryName, entry] of Object.entries(RESERVED_PORTS)) {
    assert.ok(
      Number.isInteger(entry.extension),
      `${entryName} has no integer \`extension\` port: ${JSON.stringify(entry)}`,
    );
    for (const [role, port] of Object.entries(entry)) {
      assert.ok(Number.isInteger(port), `${entryName}.${role} is not a port number: ${port}`);
    }
  }
});
