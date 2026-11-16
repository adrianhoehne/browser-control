/**
 * Holds one TCP port until SIGTERM, and says so once it is bound.
 *
 * Comparison 5 of the parity yardstick is "another bridge already owns the
 * extension port" (`docs/37`), and that case must be produced on purpose: an
 * accidental listener is a flake, not a measurement. This is the deliberate one.
 *
 * It prints `holding <host>:<port>` to stdout the moment the bind resolved, and
 * the caller waits for that line. Readiness has to be observable — a holder that
 * is still binding when the bridge starts would make the comparison measure the
 * wrong thing (a bridge that simply won the race).
 *
 * The bind is loopback-only, like the bridge's own listener: the comparison is
 * about a refused bind, not about who may reach the port.
 */
import net from "node:net";

const HOST = "127.0.0.1";

function parsePort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`hold-port: not a port number: ${rawPort}\n`);
    process.exit(1);
  }
  return port;
}

const port = parsePort(process.argv[2]);
const server = net.createServer();

server.once("error", (error) => {
  process.stderr.write(`hold-port: cannot bind ${HOST}:${port}: ${error.code ?? error.message}\n`);
  process.exit(1);
});

server.listen(port, HOST, () => {
  process.stdout.write(`holding ${HOST}:${port}\n`);
});

// One signal, one exit: an "orderly stop" is the whole contract, and a second
// SIGTERM (a `kill` loop, a Ctrl-C twice) must not turn it into a 130.
process.once("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.once("SIGINT", () => {
  server.close(() => process.exit(0));
});
