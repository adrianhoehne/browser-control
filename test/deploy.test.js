/**
 * **Text check** of the systemd user unit in `deploy/`.
 *
 * These cases read the file as text and pin the lines it has to contain. They do
 * not claim that systemd accepts the file — only `systemd-analyze verify` and a
 * real `systemctl --user start` could say that, and neither belongs in `npm test`.
 * What they do claim is narrower and worth having: the `ExecStart` that someone
 * would forget, the fixed port, and the absence of anything machine-specific or
 * secret that has no business being in a checked-in unit.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const UNIT_URL = new URL("../deploy/browser-control.service", import.meta.url);

/**
 * Every line the unit must carry verbatim, section headers included. Kept in one
 * place on purpose: a property added to the unit without being listed here is a
 * property nobody pinned.
 */
const REQUIRED_LINES = [
  "[Unit]",
  "[Service]",
  "[Install]",
  "Environment=BC_HTTP_PORT=8111",
  "ExecStart=/usr/bin/env node %h/browser-control/bridge/bridge.mjs --http",
  "Restart=on-failure",
  "RestartSec=2",
  "RestartPreventExitStatus=2",
  "StandardError=journal",
  "WantedBy=default.target",
];

/** A literal token or key would look like this; the unit has no use for one. */
const TOKEN_SHAPED = /[0-9a-f]{32,}/;

const WILDCARD_ADDRESS = "0.0.0.0";
const ABSOLUTE_HOME_PATH = "/home/";

function readUnitText() {
  return readFile(UNIT_URL, "utf8");
}

function nonCommentLines(unitText) {
  return unitText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

test("browserControlService_asTextCheck_shouldExistAndBeNonEmpty", async () => {
  // GIVEN the deploy directory of this repository,
  // WHEN the unit file is read as text,
  // THEN the read must succeed and yield content — a missing unit would
  // otherwise only show up as a broken `systemctl --user` invocation later:
  const unitText = await readUnitText();

  assert.ok(unitText.trim().length > 0, "unit file is empty");
});

test("browserControlService_asTextCheck_shouldContainEveryRequiredLineLiterally", async () => {
  // GIVEN the unit as text,
  const unitText = await readUnitText();
  const lines = nonCommentLines(unitText);

  // WHEN we look for each required line as a whole line,
  // THEN every one of them has to be there — `includes` on the whole line and not
  // on the file, so a property buried inside a comment does not count:
  for (const requiredLine of REQUIRED_LINES) {
    assert.ok(
      lines.includes(requiredLine),
      `unit is missing the line: ${requiredLine}`,
    );
  }
});

test("browserControlService_asTextCheck_shouldDescribeTheBridgeForTheOperatorsFirefox", async () => {
  // GIVEN the unit as text,
  const unitText = await readUnitText();
  const descriptionLines = nonCommentLines(unitText).filter((line) =>
    line.startsWith("Description="),
  );

  // WHEN we read its Description,
  // THEN it has to be exactly one line that says what this thing is — a bridge
  // for the operator's own Firefox, not a generic node process:
  assert.equal(descriptionLines.length, 1, "unit needs exactly one Description");

  const description = descriptionLines[0];
  assert.match(description, /bridge/i);
  assert.match(description, /firefox/i);
});

test("browserControlService_asTextCheck_shouldStartTheHttpTransport", async () => {
  // GIVEN the unit as text,
  const unitText = await readUnitText();

  // WHEN we check how the bridge is started,
  // THEN `--http` has to be there — without it the process would only speak
  // stdio and the `url` entry documented for clients would point at nothing:
  assert.ok(unitText.includes("--http"), "unit does not start the HTTP transport");
});

test("browserControlService_asTextCheck_shouldNameTheFixedHttpPort8111", async () => {
  // GIVEN the unit as text,
  const unitText = await readUnitText();

  // WHEN we look for the port the HTTP transport binds,
  // THEN it has to be the fixed 8111 from the spec — the service does not search
  // for a free port, so this number is the contract clients are configured with:
  assert.ok(
    nonCommentLines(unitText).includes("Environment=BC_HTTP_PORT=8111"),
    "unit does not pin BC_HTTP_PORT=8111",
  );
});

test("browserControlService_asTextCheck_shouldNotBindTheWildcardAddress", async () => {
  // GIVEN the unit as text,
  const unitText = await readUnitText();

  // WHEN we search for a wildcard bind address,
  // THEN there must be none: the bridge is loopback-only by construction, and a
  // wildcard here would publish the operator's browser to the network:
  assert.ok(
    !unitText.includes(WILDCARD_ADDRESS),
    `unit names the wildcard address ${WILDCARD_ADDRESS}`,
  );
});

test("browserControlService_asTextCheck_shouldNotCarryAnAbsoluteHomePath", async () => {
  // GIVEN the unit as text,
  const unitText = await readUnitText();

  // WHEN we search for an absolute home path,
  // THEN there must be none — `%h` is the user unit specifier for exactly this,
  // and a hard-coded home would make the unit wrong for every other operator:
  assert.ok(
    !unitText.includes(ABSOLUTE_HOME_PATH),
    `unit names the absolute path ${ABSOLUTE_HOME_PATH} instead of %h`,
  );
});

test("browserControlService_asTextCheck_shouldNotCarryATokenShapedString", async () => {
  // GIVEN the unit as text,
  const unitText = await readUnitText();

  // WHEN we search for something that looks like a token,
  // THEN there must be none: secrets live in the token file, never in a file that
  // is checked in — and the repository-wide grep in the acceptance criteria is
  // the same net, one level up:
  assert.doesNotMatch(unitText, TOKEN_SHAPED);
});

test("execStart_asTextCheck_shouldUseTheHomeSpecifierInsteadOfAnAbsoluteClonePath", async () => {
  // GIVEN the unit as text,
  const unitText = await readUnitText();
  const execStartLines = nonCommentLines(unitText).filter((line) =>
    line.startsWith("ExecStart="),
  );

  // WHEN we read its single ExecStart,
  // THEN the script path has to hang off `%h/browser-control/`, the documented
  // clone location, and must not be an absolute path of some machine. The exact
  // line is pinned by REQUIRED_LINES; here we only ask where the path starts:
  assert.equal(execStartLines.length, 1, "unit needs exactly one ExecStart");

  assert.ok(
    execStartLines[0].includes(" %h/browser-control/bridge/bridge.mjs"),
    `ExecStart does not resolve the script from %h: ${execStartLines[0]}`,
  );
  assert.ok(
    !execStartLines[0].includes(ABSOLUTE_HOME_PATH),
    "ExecStart contains an absolute clone path",
  );
});
