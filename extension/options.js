"use strict";

/**
 * Options page: read and write `endpoint`, `token`, `allowPasswordFields`,
 * `allowEval` and `allowScreenshot`.
 *
 * A classic script loaded by options.html — an inline script would be blocked by
 * the MV3 CSP, and there is no import between an options page and the
 * background page in this manifest. The storage keys therefore appear twice
 * (here and in background.js); both respect the table in the spec's
 * `## Configuration`.
 *
 * `ALLOW_PASSWORD_FIELDS`, `ALLOW_EVAL` and `ALLOW_SCREENSHOT` are deliberately
 * both the storage key and the element id: a single literal cannot drift into "the
 * checkbox saves where the extension does not read", and `test/manifest.test.js`
 * pins that both files spell it identically.
 */
(() => {
  const ENDPOINT_KEY = "endpoint";
  const TOKEN_KEY = "token";
  const ALLOW_PASSWORD_FIELDS = "allowPasswordFields";
  const ALLOW_EVAL = "allowEval";
  const ALLOW_SCREENSHOT = "allowScreenshot";

  const STATUS_LOAD_FAILED = "Einstellungen konnten nicht geladen werden.";
  const STATUS_SAVED = "Gespeichert.";
  const STATUS_SAVE_FAILED = "Speichern fehlgeschlagen. Einzelheiten stehen in der Konsole der Erweiterung.";

  function readFieldValue(fieldId) {
    return document.getElementById(fieldId).value;
  }

  /**
   * A checkbox has no `.value` worth storing — it is `"on"` whatever the operator
   * did. `.checked` is the decision.
   */
  function readChecked(fieldId) {
    return document.getElementById(fieldId).checked === true;
  }

  function showStatus(text) {
    document.getElementById("status").textContent = text;
  }

  function asText(value) {
    return typeof value === "string" ? value : "";
  }

  /**
   * Trims on the way in and on the way out.
   *
   * `openssl rand -hex 32 > token` writes a trailing newline, and copying it
   * into the field copies that newline along: an untrimmed token can never match
   * the one the bridge compares against. Same for the endpoint — `new
   * WebSocket()` refuses a URL with a trailing blank.
   */
  async function loadSettings() {
    try {
      const stored = await browser.storage.local.get([
        ENDPOINT_KEY,
        TOKEN_KEY,
        ALLOW_PASSWORD_FIELDS,
        ALLOW_EVAL,
        ALLOW_SCREENSHOT,
      ]);
      document.getElementById("endpoint").value = asText(stored[ENDPOINT_KEY]).trim();
      document.getElementById("token").value = asText(stored[TOKEN_KEY]).trim();
      // Only the boolean `true` ticks the box: a `"true"` from a hand-edited
      // storage must not look like an unlocked password field.
      document.getElementById(ALLOW_PASSWORD_FIELDS).checked =
        stored[ALLOW_PASSWORD_FIELDS] === true;
      // The same rule for the switch that unlocks code: a stored `"true"` is not a
      // decision, and the box has to show what the extension will act on.
      document.getElementById(ALLOW_EVAL).checked = stored[ALLOW_EVAL] === true;
      // And the same rule for the switch that lets the agent look at the tab: a
      // stored `"true"` is not a decision here either.
      document.getElementById(ALLOW_SCREENSHOT).checked = stored[ALLOW_SCREENSHOT] === true;
    } catch (error) {
      console.error("bc: loading the settings failed", error);
      showStatus(STATUS_LOAD_FAILED);
    }
  }

  async function saveSettings(settings) {
    await browser.storage.local.set(settings);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const settings = {
      [ENDPOINT_KEY]: readFieldValue("endpoint").trim(),
      [TOKEN_KEY]: readFieldValue("token").trim(),
      [ALLOW_PASSWORD_FIELDS]: readChecked(ALLOW_PASSWORD_FIELDS),
      [ALLOW_EVAL]: readChecked(ALLOW_EVAL),
      [ALLOW_SCREENSHOT]: readChecked(ALLOW_SCREENSHOT),
    };

    try {
      await saveSettings(settings);
      showStatus(STATUS_SAVED);
    } catch (error) {
      console.error("bc: saving the settings failed", error);
      showStatus(STATUS_SAVE_FAILED);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("settings-form").addEventListener("submit", handleSubmit);
    void loadSettings();
  });
})();
