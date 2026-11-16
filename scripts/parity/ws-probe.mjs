/**
 * One WebSocket probe against the extension listener, and the close code it got.
 *
 * Comparison 4 of the parity yardstick (`docs/37`) is the two refusals a bridge
 * performs on a fresh connection: a `hello` carrying a wrong token must end in
 * close `4401`, a connection that never sends `hello` in close `4408`. Both are
 * *close frames*, not silent hangs and not process exits, so the probe reports
 * exactly that: `code=<n> reason=<text>`.
 *
 * An empty reason is reported as `reason=` with nothing behind it — that is the
 * honest byte form, and a probe that printed `reason=<none>` would hide the
 * difference between "the bridge said nothing" and "the bridge said something".
 *
 * Usage:
 *   node ws-probe.mjs --url ws://127.0.0.1:18115 --silent
 *   node ws-probe.mjs --url ws://127.0.0.1:18115 --token <t>
 *
 * The two modes are exclusive, because a probe that did both would be measuring
 * whichever half arrived first.
 */
const DEFAULT_DEADLINE_MS = 5_000;
const HELLO_PROTOCOL_VERSION = 1;
const EXTENSION_VERSION = "0.1.0";

const USAGE = `usage: ws-probe.mjs --url <ws://host:port> (--silent | --token <token>) [--deadline <ms>]
`;

function parseOptions(argv) {
  const options = { url: null, silent: false, token: null, deadline: DEFAULT_DEADLINE_MS };

  for (let index = 0; index < argv.length; index += 1) {
    const separator = argv[index].indexOf("=");
    const name = separator === -1 ? argv[index] : argv[index].slice(0, separator);
    const inlineValue = separator === -1 ? null : argv[index].slice(separator + 1);
    const value = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${name} needs a value`);
      return argv[index];
    };

    switch (name) {
      case "--url": options.url = value(); break;
      case "--silent": options.silent = true; break;
      case "--token": options.token = value(); break;
      case "--deadline": options.deadline = Number(value()); break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${argv[index]}`);
    }
  }

  if (options.url === null) throw new Error("--url is required");
  if (options.silent === (options.token !== null)) {
    throw new Error("exactly one of --silent and --token is required");
  }
  return options;
}

/**
 * The hello the real extension sends, copied from `test/fixtures/fake-extension.mjs`
 * in the fields the bridge actually reads: `type` and a non-empty `token`. The
 * browser block is along for the shape and decides nothing.
 */
function helloMessage(token) {
  return {
    type: "hello",
    protocol: HELLO_PROTOCOL_VERSION,
    extensionVersion: EXTENSION_VERSION,
    browser: { name: "Firefox", version: "152.0.3" },
    token,
  };
}

function fail(message) {
  process.stderr.write(`ws-probe: ${message}\n`);
  process.exit(1);
}

function main() {
  const options = parseOptions(process.argv.slice(2));

  let opened = false;

  const socket = new WebSocket(options.url);

  // The deadline turns "the bridge never answered" into a failed probe instead of
  // a hung parity run. It is generous on purpose: the hello deadline is 300 ms, so
  // a five-second wait only ever fires on a bridge that is not there at all.
  const timer = setTimeout(() => {
    fail(`no close frame within ${options.deadline} ms (opened=${opened})`);
  }, options.deadline);

  socket.addEventListener("open", () => {
    opened = true;
    if (options.token !== null) socket.send(JSON.stringify(helloMessage(options.token)));
  });

  socket.addEventListener("message", () => {
    // Nothing to read: comparison 4 is about how the connection *ends*. A message
    // here would be a `welcome`, which the wrong-token case must never produce —
    // the close code stays the measurement either way.
  });

  socket.addEventListener("error", () => {
    // A refused or broken handshake never produces a close frame — and a close
    // code nobody received must not be printed as one. The one line this probe
    // exists for is a close the *bridge* sent, so anything short of a handshake is
    // a failed probe, not a measurement.
    if (!opened) fail(`the connection never completed its handshake (url: ${options.url})`);
  });

  socket.addEventListener("close", (event) => {
    clearTimeout(timer);

    // A code of 1006 is the client's "the connection dropped without a close
    // frame" and therefore never a bridge answer. Reporting it as one would claim
    // a measurement nobody made.
    if (!opened) fail(`the handshake was never completed (code ${event.code})`);

    process.stdout.write(`code=${event.code} reason=${event.reason}\n`);
    process.exit(0);
  });
}

try {
  main();
} catch (error) {
  fail(error?.message ?? error);
}
