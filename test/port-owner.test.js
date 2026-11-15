import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { findPortOwner } from "../bridge/port-owner.mjs";

// The lookup reads `/proc`, so these cases are Linux-only. Skipped, never
// passed: a green tick on macOS would claim a capability the module does not
// have there, and the caller's fallback text is exactly what would happen.
const SKIP_OUTSIDE_LINUX =
  process.platform === "linux" ? false : "reads /proc, which only Linux provides";

/**
 * Binds a throwaway loopback listener and returns it with the port the kernel
 * actually picked — `port: 0` only promises to find one.
 */
async function listenOnFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("findPortOwner_withOwnListeningSocket_shouldNameThisProcess", { skip: SKIP_OUTSIDE_LINUX }, async () => {
  // GIVEN a listener that belongs to this very test process,
  const { server, port } = await listenOnFreePort();

  // WHEN we ask who owns that port,
  try {
    const owner = findPortOwner({ host: "127.0.0.1", port });

    // THEN the answer is this process, named by its `comm` entry:
    assert.deepEqual(owner, { pid: process.pid, name: "node" });
  } finally {
    await closeServer(server);
  }
});

test("findPortOwner_withReleasedPort_shouldReturnNull", { skip: SKIP_OUTSIDE_LINUX }, async () => {
  // GIVEN a port that was bound once and released again,
  const { server, port } = await listenOnFreePort();
  await closeServer(server);

  // WHEN we ask for an owner nobody has,
  const owner = findPortOwner({ host: "127.0.0.1", port });

  // THEN the module must say "no idea" instead of guessing a process:
  assert.equal(owner, null);
});
