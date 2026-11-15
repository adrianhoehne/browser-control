import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../bridge/config.mjs";

// An empty environment keeps these cases independent of whatever happens to be
// exported in the shell that runs the suite. `loadConfig()` reads no files.
const NO_ENV = {};

test("loadConfig_withoutHttpPortEnv_shouldDefaultTo8111", () => {
  // GIVEN an environment that says nothing about the HTTP port,
  // WHEN the configuration is loaded,
  // THEN the documented default applies:
  assert.equal(loadConfig(NO_ENV).httpPort, 8111);
});

test("loadConfig_withHttpPortEnv_shouldUseThatPort", () => {
  // GIVEN an environment naming a different port,
  const env = { ...NO_ENV, BC_HTTP_PORT: "9123" };

  // WHEN the configuration is loaded,
  // THEN the configured port wins over the default:
  assert.equal(loadConfig(env).httpPort, 9123);
});

test("loadConfig_withGarbageHttpPort_shouldFallBackToTheDefault", () => {
  // GIVEN a value that cannot be a port — every field here falls back rather
  // than throwing, because a typo in one variable must not stop the service,
  const garbageValues = ["", "elf", "0", "65536", "-1", "8111.5"];

  for (const rawHttpPort of garbageValues) {
    // WHEN the configuration is loaded with it,
    const { httpPort } = loadConfig({ ...NO_ENV, BC_HTTP_PORT: rawHttpPort });

    // THEN the port stays at the default instead of becoming NaN or 0:
    assert.equal(httpPort, 8111, `BC_HTTP_PORT=${rawHttpPort} was not rejected`);
  }
});
