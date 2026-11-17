#!/usr/bin/env bash
#
# The parity yardstick of the Rust bridge (`docs/37`, stage 2).
#
# Seven comparisons, recorded once from the Node bridge into
# `scripts/parity/expected/` and measured against afterwards. Two implementations
# that both do the same wrong thing would be "identical" — that is why the
# comparison has an expectation and is not merely differential.
#
#   --check      run the Rust bridge and compare it with the artefacts
#   --self-test  mutate one artefact per comparison and require seven differences
#   --impl       rust   (the only implementation that is left)
#   --only 5,6   restrict the run to some comparisons; the rest stay unmeasured
#   --keep       keep the mktemp run directory and name it
#
# **The Node bridge is gone.** It was deleted in the cut (`docs/38`, stage 4b), so
# `--record`, `--impl node` and the pair `node,node` lost their subject: the seven
# artefacts are frozen and only the Rust side is measured against them. All three
# answer with `keine Node-Bridge mehr — die sieben Artefakte sind eingefroren;
# gemessen wird mit --impl rust --check` and exit 1, instead of spawning a script
# that no longer exists.
#
# **Do not run this at the same time as `npm test`.** The parity run owns ports
# 18115 (extension listener) and 18116 (MCP over HTTP); `npm test` used to reserve
# them in `test/ports.js`, and since the cut they belong to this file alone — a
# concurrent suite would still fight over them if it ever bound them again. The
# check is not enforced, only documented — a "port busy" abort below is what an
# overlap looks like.
#
# Nothing here builds anything: `--impl rust` starts the binary stage 1 produced
# and stops with `rust binary missing: <path>` when it is not there. A yardstick
# that compiles its own candidate measures the compiler as well.
#
# Run artefacts (token, probes, mutants) live in a `mktemp` directory that is
# removed on exit. Nothing is written into the tree any more: the seven files under
# `scripts/parity/expected/` are frozen, and `--check` only ever reads them.
set -u -o pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PARITY="$ROOT/scripts/parity"
EXPECTED="$PARITY/expected"
REQUESTS="$PARITY/requests"
DRIVER="$PARITY/driver.mjs"
WS_PROBE="$PARITY/ws-probe.mjs"
HOLD_PORT="$PARITY/hold-port.mjs"
RUST_BIN="$ROOT/bridge-rs/target/x86_64-unknown-linux-musl/release/browser-control-bridge"

# The two ports this run owns. They are the only numbers of the range 18110–18119
# that anything still reserves: the Node test files that shared it are deleted with
# the Node bridge (`test/ports.js` went with them).
EXT_PORT=18115
HTTP_PORT=18116
BIND="127.0.0.1:$EXT_PORT"

ALL_COMPARISONS=(1 2 3 4 5 6 7)
# The case counts are frozen in the `# cases=` header line of each artefact, and
# `--check` compares that line like every other one. Nothing can record a short
# comparison any more: recording is gone along with the Node bridge.

declare -A NAMES=(
  [1]="initialize and tools/list"
  [2]="every tool: result, error code, refused argument"
  [3]="no extension, silent extension"
  [4]="close 4401, close 4408"
  [5]="occupied port, exit 1"
  [6]="missing token file, exit 2"
  [7]="log lines in info, debug, debug --http"
)
declare -A ARTIFACT=(
  [1]="1-initialize-and-tools-list.txt"
  [2]="2-tools.txt"
  [3]="3-extension-failures.txt"
  [4]="4-close-codes.txt"
  [5]="5-port-busy.txt"
  [6]="6-token-missing.txt"
  [7]="7-logs.txt"
)

# The header block itself, so that the help cannot drift away from the file when
# a line is added above it: a line-number range here was one comment away from
# printing the wrong text.
usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

fail() {
  printf 'parity: %s\n' "$*" >&2
  exit 1
}

# Echoes the run directory when it is kept, so a failed comparison can be looked
# at. Silent otherwise. Guarded because the trap can fire before the directory
# exists — a port preflight abort runs it too.
RUN_DIR=
cleanup() {
  if [ -n "${HOLD_PID:-}" ]; then
    kill -TERM "$HOLD_PID" 2>/dev/null
    wait "$HOLD_PID" 2>/dev/null
  fi
  [ -n "$RUN_DIR" ] || return 0
  if [ "${KEEP:-0}" -eq 1 ]; then
    printf 'run directory kept: %s\n' "$RUN_DIR" >&2
  else
    rm -rf "$RUN_DIR"
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------- options ----

while [ $# -gt 0 ]; do
  case "$1" in
    --record) MODE=record ;;
    --check) MODE=check ;;
    --self-test) MODE=self-test ;;
    --impl) shift; IMPL=${1:-} ;;
    --impl=*) IMPL=${1#--impl=} ;;
    --only) shift; ONLY=${1:-} ;;
    --only=*) ONLY=${1#--only=} ;;
    --keep) KEEP=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'parity: unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

MODE=${MODE:-}
IMPL=${IMPL:-rust}
ONLY=${ONLY:-}
KEEP=${KEEP:-0}

# One sentence, in the operator's language, for a state that is final: the Node
# bridge was deleted (`docs/38`, stage 4b) and the seven artefacts are the record it
# left behind. Recording is not "broken", it has no subject — so this is a loud
# abort and not a fallback to the other implementation.
NODE_BRIDGE_GONE="keine Node-Bridge mehr — die sieben Artefakte sind eingefroren; gemessen wird mit --impl rust --check"

case "$IMPL" in
  rust) ;;
  node|node,node|node,rust|rust,node) fail "$NODE_BRIDGE_GONE" ;;
  *) fail "unbekanntes --impl $IMPL — die Node-Bridge ist gelöscht, übrig ist nur 'rust'" ;;
esac

if [ "$MODE" = record ]; then
  fail "$NODE_BRIDGE_GONE"
fi

if [ -z "$MODE" ]; then
  usage >&2
  fail "one of --check or --self-test is required"
fi

# Never build. A yardstick that compiles its candidate would also be measuring the
# toolchain, and the spec says the binary comes from stage 1.
[ -x "$RUST_BIN" ] || fail "rust binary missing: $RUST_BIN"

SELECTED=("${ALL_COMPARISONS[@]}")
if [ -n "$ONLY" ]; then
  IFS=',' read -r -a SELECTED <<< "$ONLY"
  for n in "${SELECTED[@]}"; do
    case "$n" in
      1|2|3|4|5|6|7) ;;
      *) fail "--only wants numbers 1–7, got $n" ;;
    esac
  done
fi

# --------------------------------------------------------------- port preflight ----

# A busy port must abort before anything is measured: an occupied 18115 would make
# comparison 5 pass for the wrong reason and every other comparison fail for one.
port_is_free() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(() => process.exit(0)));
  ' "$1"
}

for port in "$EXT_PORT" "$HTTP_PORT"; do
  port_is_free "$port" || fail "port busy: 127.0.0.1:$port — stop the other run first (npm test and parity.sh do not run side by side)"
done

# ---------------------------------------------------------------- run directory ----

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/bc-parity.XXXXXX") || fail "cannot create a run directory"
TOKEN_FILE="$RUN_DIR/token"

# Generated per run, never a literal: a token in the repository would be a finding
# for the secret grep of the acceptance, and a token in an artefact would be a
# credential in a diff. The comparison 4 artefact keeps only the close code.
node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))' > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

# ------------------------------------------------------------------- masking ----

# The mask table of `docs/37`, applied to every comparison before it is compared —
# in `--check` and `--self-test` alike. Skipping it in one of the two would make it
# useless: the timestamps of two runs (the frozen artefact's and this one's) differ
# by construction, so an unmasked comparison could never be identical.
#
#   timestamp prefix   the same regex `test/bridge.test.js` uses
#   port owner         PID differs per run, the name differs per Node version
#                      (`node` on 22, `MainThread` on 24)
#   run directory      comparison 6 prints the token path, which is a `mktemp` path
mask() {
  sed -E \
    -e 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z //' \
    -e 's/owner pid=[0-9]+ name=[^ ]+/owner pid=<pid> name=<name>/g' \
    -e "s|${RUN_DIR//./\\.}|<run>|g"
}

# One `# case=` line per input line: for the JSON-RPC comparisons a case *is* one
# answer line, and the marker is what makes a missing answer visible as a gap
# instead of shifting the next case up.
number_lines() {
  awk '{ printf "# case=%d\n%s\n", ++n, $0 }'
}

# One case out of a multi-line run (stderr with an exit code, a whole log
# sequence): the caller pipes the run in and names the case.
add_case() {
  printf '# case=%s\n' "$1"
  cat
}

# -------------------------------------------------------------- writing artefacts ----

# Body on stdin, artefact at $1: header first, then the marked cases. The header
# is counted from the markers, so a half-recorded comparison cannot claim more
# cases than it has.
write_artifact() {
  local target=$1
  local body="$RUN_DIR/body.tmp"

  cat > "$body"
  local cases
  cases=$(awk '/^# case=/{count++} END{print count+0}' "$body")
  { printf '# cases=%s\n' "$cases"; cat "$body"; } > "$target"
}

# -------------------------------------------------------------------- the probes ----

driver_rpc() { # impl, request file, extra driver arguments...
  local impl=$1 requests=$2
  shift 2
  node "$DRIVER" --mode rpc --impl "$impl" --requests "$REQUESTS/$requests" \
    --token-file "$TOKEN_FILE" --bind "$BIND" --http-port "$HTTP_PORT" "$@"
}

driver_run() { # impl, mode, extra driver arguments...
  local impl=$1 mode=$2
  shift 2
  node "$DRIVER" --mode "$mode" --impl "$impl" --token-file "$TOKEN_FILE" \
    --bind "$BIND" --http-port "$HTTP_PORT" "$@"
}

# The 13 `error:<code>` modes of comparison 2. Each code is one the bridge answers
# with a sentence of its own, so the artefact measures the sentence layer and not
# only the JSON envelope. `eval_failed`, `screenshot_failed` and
# `transcript_needs_focus` additionally carry the fixture's `error.message` into
# the sentence — the path that a hand-written fixture would have to invent.
ERROR_FIXTURE_ARGS=()
add_error_fixture() {
  ERROR_FIXTURE_ARGS+=(--fixture-env "$1")
}
add_error_fixture "BC_TEST_ANSWER=error:status_failed"
add_error_fixture "BC_TEST_NAVIGATE_ANSWER=error:navigate_failed"
add_error_fixture "BC_TEST_READ_ANSWER=error:not_readable"
add_error_fixture "BC_TEST_CLICK_ANSWER=error:no_match"
add_error_fixture "BC_TEST_TYPE_ANSWER=error:not_typeable"
add_error_fixture "BC_TEST_FOCUS_ANSWER=error:no_agent_tab"
add_error_fixture "BC_TEST_INSPECT_ANSWER=error:invalid_params"
add_error_fixture "BC_TEST_OPEN_TAB_ANSWER=error:too_many_tabs"
add_error_fixture "BC_TEST_CLOSE_TAB_ANSWER=error:no_agent_tab"
add_error_fixture "BC_TEST_EVAL_ANSWER=error:eval_failed"
add_error_fixture "BC_TEST_SCREENSHOT_ANSWER=error:screenshot_failed"
add_error_fixture "BC_TEST_FRAMES_ANSWER=error:page_busy"
add_error_fixture "BC_TEST_TRANSCRIPT_ANSWER=error:transcript_needs_focus"

probe_1() { # impl
  driver_rpc "$1" 1-initialize.jsonl | mask | number_lines
}

probe_2() { # impl
  local impl=$1
  # The success run pins the picture size. The fixture's default screenshot is a
  # 214 311-byte JPEG — as base64 that is ~285 KB of artefact for a case whose
  # point is the shape of the answer (text block first, image block second), not
  # the pixels. 24 bytes keeps the magic and the length rule and stays readable.
  driver_rpc "$impl" 2-call.jsonl --fixture \
    --fixture-env BC_TEST_SCREENSHOT_BYTES=24 \
    --await-after-fixture 'extension connected peer=' | mask | number_lines || return 1

  driver_rpc "$impl" 2-call.jsonl --fixture "${ERROR_FIXTURE_ARGS[@]}" \
    --await-after-fixture 'extension connected peer=' | mask | number_lines || return 1

  # No fixture: a refused argument must never reach a peer, and a run without one
  # is what proves the call was refused at the bridge.
  driver_rpc "$impl" 2-refusal.jsonl | mask | number_lines || return 1
}

probe_3() { # impl
  local impl=$1
  driver_rpc "$impl" 3-status.jsonl | mask | number_lines || return 1
  driver_rpc "$impl" 3-status.jsonl --fixture --fixture-env BC_TEST_ANSWER=0 \
    --await-after-fixture 'extension connected peer=' | mask | number_lines || return 1
}

probe_4() { # impl
  local impl=$1
  local wrong_token
  wrong_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')

  driver_run "$impl" probe --await-before-fixture 'listening on' \
    --probe "$WS_PROBE" --probe-arg --url --probe-arg "ws://$BIND" \
    --probe-arg --token --probe-arg "$wrong_token" | mask | number_lines || return 1

  driver_run "$impl" probe --await-before-fixture 'listening on' \
    --probe "$WS_PROBE" --probe-arg --url --probe-arg "ws://$BIND" \
    --probe-arg --silent | mask | number_lines || return 1
}

probe_5() { # impl
  local impl=$1
  local hold_log="$RUN_DIR/hold.log"

  node "$HOLD_PORT" "$EXT_PORT" > "$hold_log" 2>&1 &
  HOLD_PID=$!
  if ! wait_for_line "$hold_log" 'holding'; then
    kill -TERM "$HOLD_PID" 2>/dev/null
    HOLD_PID=
    printf 'the port holder never reported readiness:\n' >&2
    cat "$hold_log" >&2
    return 1
  fi

  local status=0
  driver_run "$impl" exit | mask | add_case 1 || status=1

  kill -TERM "$HOLD_PID" 2>/dev/null
  wait "$HOLD_PID" 2>/dev/null
  HOLD_PID=
  return $status
}

probe_6() { # impl
  # Its own driver call, not `driver_run`: this comparison needs a token path that
  # was never written, and a second `--token-file` next to the shared one would
  # read like a typo waiting to happen.
  node "$DRIVER" --mode exit --impl "$1" --token-file "$RUN_DIR/missing/token" \
    --bind "$BIND" --http-port "$HTTP_PORT" | mask | add_case 1
}

probe_7() { # impl
  local impl=$1
  driver_run "$impl" logs --log info --fixture \
    --await-before-fixture 'listening on' \
    --await-after-fixture 'extension connected peer=' \
    --await-after-fixture 'status windows=' | mask | add_case 1 || return 1

  driver_run "$impl" logs --log debug --fixture \
    --await-before-fixture 'listening on' \
    --await-after-fixture 'extension connected peer=' \
    --await-after-fixture 'status windows=' \
    --await-after-fixture '^\}$' | mask | add_case 2 || return 1

  # The `--http` case waits for its second listener before the fixture starts, so
  # the order of the two `listening on` lines is a property of the bridge and not
  # of how fast two child processes happened to start.
  driver_run "$impl" logs --log debug --http --fixture \
    --await-before-fixture 'listening on' \
    --await-before-fixture 'for POST /mcp' \
    --await-after-fixture 'extension connected peer=' \
    --await-after-fixture 'status windows=' \
    --await-after-fixture '^\}$' | mask | add_case 3 || return 1
}

# Polls a file for a line. Bounded, so a holder that never binds fails the
# comparison instead of hanging the run.
wait_for_line() { # file, pattern
  local file=$1 pattern=$2 attempt
  for attempt in $(seq 1 250); do
    grep -q -- "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.02
  done
  return 1
}

# ------------------------------------------------------------ one comparison ----

# Builds the probe of comparison $2 for implementation $1 and writes it to
# `$RUN_DIR/probe-<n>.txt`. Returns non-zero when the probe itself failed.
record_probe() { # impl, comparison
  local impl=$1 n=$2
  local body="$RUN_DIR/body-$n.txt"

  if ! declare -F "probe_$n" > /dev/null; then
    printf 'comparison %s has no probe\n' "$n" >&2
    return 1
  fi
  if ! "probe_$n" "$impl" > "$body"; then
    printf 'comparison %s: the probe failed\n' "$n" >&2
    return 1
  fi
  write_artifact "$RUN_DIR/probe-$n.txt" < "$body"
}

artifact_of() { # comparison
  printf '%s/%s' "$EXPECTED" "${ARTIFACT[$1]}"
}

show_difference() { # expected, actual
  diff -u "$1" "$2" 2>/dev/null | head -20 | cut -c1-220 >&2
}

# --------------------------------------------------------------------- modes ----

check_mode() { # impl
  local impl=$1 n passed=0 total=0
  for n in "${SELECTED[@]}"; do
    total=$((total + 1))
    if record_probe "$impl" "$n" && cmp -s "$(artifact_of "$n")" "$RUN_DIR/probe-$n.txt"; then
      printf 'ok %s %s\n' "$n" "${NAMES[$n]}"
      passed=$((passed + 1))
    else
      printf 'diff %s %s\n' "$n" "${NAMES[$n]}"
      show_difference "$(artifact_of "$n")" "$RUN_DIR/probe-$n.txt"
    fi
  done

  printf '%s/%s wie erwartet\n' "$passed" "$total"
  [ "$passed" -eq "$total" ]
}

# Flipping the first character of the first content line: deterministic, applies
# to every artefact whatever its shape, and cannot be a no-op.
mutate_artifact() { # artefact
  awk '
    BEGIN { done = 0 }
    {
      if (!done && $0 !~ /^#/) {
        prefix = substr($0, 1, 1)
        $0 = (prefix == "X" ? "Y" : "X") substr($0, 2)
        done = 1
      }
      print
    }
  ' "$1"
}

self_test_mode() { # impl
  local impl=$1 n red=0 total=0

  for n in "${SELECTED[@]}"; do
    total=$((total + 1))

    if ! record_probe "$impl" "$n"; then
      printf 'keine Probe %s %s\n' "$n" "${NAMES[$n]}"
      continue
    fi
    # A self-test on a comparison that is already red proves nothing: the mutation
    # would be "detected" by the pre-existing difference.
    if ! cmp -s "$(artifact_of "$n")" "$RUN_DIR/probe-$n.txt"; then
      printf 'schon vorher verschieden %s %s\n' "$n" "${NAMES[$n]}"
      show_difference "$(artifact_of "$n")" "$RUN_DIR/probe-$n.txt"
      continue
    fi

    mutate_artifact "$(artifact_of "$n")" > "$RUN_DIR/mutant-$n.txt"
    if cmp -s "$RUN_DIR/mutant-$n.txt" "$RUN_DIR/probe-$n.txt"; then
      printf 'Mutation nicht gesehen %s %s\n' "$n" "${NAMES[$n]}"
      continue
    fi

    printf 'rot %s %s\n' "$n" "${NAMES[$n]}"
    red=$((red + 1))
  done

  printf '%s/%s rot wie erwartet\n' "$red" "$total"
  [ "$red" -eq "$total" ]
}

# ---------------------------------------------------------------------- main ----

STATUS=0
case "$MODE" in
  check) check_mode "$IMPL" || STATUS=1 ;;
  self-test) self_test_mode "$IMPL" || STATUS=1 ;;
esac

# The other half of the port preflight: a listener this run forgot to stop must be
# a red run, not a surprise for the next one.
for port in "$EXT_PORT" "$HTTP_PORT"; do
  port_is_free "$port" || {
    printf 'parity: a listener is still bound to 127.0.0.1:%s after the run\n' "$port" >&2
    STATUS=1
  }
done

exit "$STATUS"
