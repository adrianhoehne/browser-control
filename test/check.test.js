/**
 * The syntax check from `CONTRIBUTING.md`, exercised as the process it is.
 *
 * `scripts/check.mjs` is the middle line of the acceptance block, and its value
 * rests on three things this file pins: that it really parses the whole tree, that
 * it says *how many* files it parsed, and that a broken file turns the run red
 * with the file named. The temporary trees supply the shapes the real tree does
 * not have — a syntax error, an empty directory, a vendored subdirectory.
 *
 * The count of the real tree is compared against this file's own traversal. Two
 * traversals making the same mistake would still agree, which is why the named
 * paths are asserted as well; a third mistake stays possible either way.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectFiles } from "../scripts/check.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const CHECK_SCRIPT_PATH = path.join(REPOSITORY_ROOT, "scripts", "check.mjs");

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const CHECKED_EXTENSIONS = new Set([".js", ".mjs"]);

const SINGLE_LINE = /^checked \d+ files?$/;

function runCheck(root) {
  const result = spawnSync(process.execPath, [CHECK_SCRIPT_PATH, root], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Builds a temporary tree; the returned root is removed when the test ends. */
function makeTree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bc-check-"));

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** This test's own traversal, deliberately written apart from the script's. */
function countCheckableFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? count : count + countCheckableFiles(path.join(directory, entry.name));
    }
    const counts = entry.isFile() && CHECKED_EXTENSIONS.has(path.extname(entry.name));
    return counts ? count + 1 : count;
  }, 0);
}

test("main_onRealRepositoryTree_checksEveryFileAndExitsZero", () => {
  // GIVEN the real tree this repository ships:
  const expectedCount = countCheckableFiles(REPOSITORY_ROOT);

  // WHEN the check runs over it,
  const { status, stdout, stderr } = runCheck(REPOSITORY_ROOT);

  // THEN it exits 0, prints exactly one countable line on stdout, and says
  // nothing on stderr. The line's count is the number this test sees itself, so
  // a skipped subtree or a missed extension shows up here.
  assert.equal(status, 0);
  assert.equal(stderr, "");

  const lines = stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], SINGLE_LINE);
  assert.equal(lines[0], `checked ${expectedCount} ${expectedCount === 1 ? "file" : "files"}`);

  // The files of this increment are inside the checked set itself, not merely on
  // disk: a count alone could not tell the difference, since two skipped files
  // and two extra ones would cancel out.
  const checkedPaths = collectFiles(REPOSITORY_ROOT);
  const checkScriptRelativePath = path.join("scripts", "check.mjs");
  const testFileRelativePath = path.join("test", "check.test.js");

  assert.ok(checkedPaths.includes(checkScriptRelativePath), `${checkScriptRelativePath} is not in the checked set`);
  assert.ok(checkedPaths.includes(testFileRelativePath), `${testFileRelativePath} is not in the checked set`);
});

test("main_withSyntaxError_reportsFileAndFailsWithSingularSummary", (t) => {
  // GIVEN a temporary tree holding one file that does not parse:
  const root = makeTree(t, { "broken.js": "const = ;\n" });

  // WHEN the check runs over it,
  const { status, stdout, stderr } = runCheck(root);

  // THEN it exits 1, names the file with a SyntaxError line on stderr, keeps
  // stdout empty, and sums up in the singular form:
  assert.equal(status, 1);
  assert.equal(stdout, "");

  const lines = stderr.trimEnd().split("\n");
  assert.equal(lines.at(-1), "checked 1 file, 1 failed");
  assert.ok(
    lines.some((line) => line.startsWith("broken.js: ") && line.includes("SyntaxError")),
    `expected a "broken.js: SyntaxError..." line, got:\n${stderr}`,
  );
});

test("main_withJsAndMjsFiles_checksBothExtensions", (t) => {
  // GIVEN a clean tree with one file per checked extension:
  const root = makeTree(t, { "ok.js": "const a = 1;\n", "ok.mjs": "export const b = 2;\n" });

  // WHEN the check runs over it,
  const { status, stdout, stderr } = runCheck(root);

  // THEN both are parsed and counted:
  assert.equal(status, 0);
  assert.equal(stderr, "");
  assert.equal(stdout, "checked 2 files\n");
});

test("main_withSingleCleanFile_reportsSingularSuccessLine", (t) => {
  // GIVEN a clean tree with exactly one file:
  const root = makeTree(t, { "only.js": "const a = 1;\n" });

  // WHEN the check runs over it,
  const { status, stdout } = runCheck(root);

  // THEN the success line uses the singular — the same rule as the summary:
  assert.equal(status, 0);
  assert.equal(stdout, "checked 1 file\n");
});

test("main_withSkippedDirectoriesAtAnyDepth_ignoresThemAndCountsTheRest", (t) => {
  // GIVEN broken files nested inside a `.git` and a `node_modules` directory,
  // with one clean file beside them:
  const root = makeTree(t, {
    "a/.git/x.js": "const = ;\n",
    "a/b/node_modules/y.js": "const = ;\n",
    "clean.js": "const a = 1;\n",
  });

  // WHEN the check runs over it,
  const skipped = runCheck(root);

  // THEN only the clean file is parsed, so the run is green in the singular;
  // an exclusion that stopped at the top level would parse the broken ones.
  assert.equal(skipped.status, 0);
  assert.equal(skipped.stderr, "");
  assert.equal(skipped.stdout, "checked 1 file\n");

  // AND an empty tree is a visible statement ("nothing to parse"), not a crash:
  const emptyRoot = makeTree(t, {});
  const empty = runCheck(emptyRoot);

  assert.equal(empty.status, 0);
  assert.equal(empty.stderr, "");
  assert.equal(empty.stdout, "checked 0 files\n");
});

test("main_withNonScriptFile_ignoresItInTheCount", (t) => {
  // GIVEN one clean script and a text file beside it:
  const root = makeTree(t, { "ok.js": "const a = 1;\n", "notes.txt": "not a script\n" });

  // WHEN the check runs over it,
  const { status, stdout } = runCheck(root);

  // THEN only `.js`/`.mjs` count, so the number stays at one:
  assert.equal(status, 0);
  assert.equal(stdout, "checked 1 file\n");
});
