# browser-control

A Firefox extension drives your **visible, logged-in browser**, and a small
bridge exposes that browser as an **MCP server** for agents. The agent works in
its own tab — one you can watch — with your logins, your cookies and your
profile. No headless browser, no second profile, no automated login.

```
Agent  ──MCP over HTTP──▶  Bridge (Node)  ──WebSocket──▶  Firefox extension
        (bearer token)     127.0.0.1:8111                  agent tab
```

The extension dials **out** to the bridge. That is why the bridge needs no
inbound port, and why the agent can only see tabs it created itself.

## What it does

**Thirteen tools**, all with the `browser_` prefix:

| Tool | Purpose |
|---|---|
| `status` | windows and tabs as JSON, agent tabs marked |
| `navigate`, `read` | open a page (waits for it to settle), read its content as text |
| `click`, `type`, `focus` | interact, type, bring the tab to the front |
| `inspect` | query the DOM, selector and attributes |
| `open_tab`, `close_tab` | manage agent tabs (at most five) |
| `eval` | run code in the page context (**off by default**) |
| `screenshot` | the visible part of the tab (**off by default**) |
| `frames` | list and address iframes |
| `transcript` | a YouTube transcript as segments with timestamps, in the video's original track |

Plus: settle detection instead of fixed sleeps, shadow DOM and frames,
persistence across a background tab, and a log that does not copy page text.

## Security

- **One token**, kept on the operator's filesystem and never in the repo; the
  bridge checks it on every MCP request.
- **Loopback only.** The MCP port is bound to `127.0.0.1` and does not belong
  behind a public proxy.
- **Three switches**, all off by default: password fields, code evaluation,
  screenshots. The agent never flips them itself.
- **The agent only sees its own tabs.** It does not drive yours.

## Quick start

The full guide is **[INSTALL.md](INSTALL.md)**: token file, bridge as a systemd
user service, loading the extension. A reverse proxy is optional and covered at
the end.

Short version for one machine without a proxy:

```bash
# 1. token
install -d -m 700 ~/.config/browser-control
openssl rand -hex 32 > ~/.config/browser-control/token
chmod 600 ~/.config/browser-control/token

# 2. bridge as a service
cp deploy/browser-control.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now browser-control

# 3. extension: about:debugging#/runtime/this-firefox → "Load Temporary Add-on…"
#    → pick extension/manifest.json, then set endpoint and token under Preferences.
```

The extension is **unsigned**. After a Firefox restart it is gone and has to be
loaded again; signing through AMO is not set up.

## Development

There are **no dependencies** — Node ≥ 22 is enough:

```bash
npm test        # 736 cases, TAP output, ~90 s
npm run check   # node --check over every .js/.mjs
```

How changes happen (spec → gate → dev plan → review → acceptance) is described
in **[CONTRIBUTING.md](CONTRIBUTING.md)**; the design and measurement history
lives in [`docs/`](docs/README.md) — 34 specs, each with its measurements and the
decisions that followed.

## Known limits

- **Unsigned**: temporary load, again after every Firefox restart.
- **Windows** is only partly covered (`docs/29`, `docs/30`).
- **YouTube labels can lie**: `browser_transcript` reads the track YouTube calls
  the original; language detection is deliberately out of scope.
- **One operator, one browser**: the bridge serves the extension that is
  connected.

## License

[MIT](LICENSE).
