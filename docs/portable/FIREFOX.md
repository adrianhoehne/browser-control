# Load the extension in Firefox

This guide loads the extension from this folder. You need Firefox and the start
window of `start.sh`. Keep that window open: it shows the token.

1. Start Firefox.

> **Warning:** The extension is temporary. After a Firefox restart it is gone.
> Repeat steps 3 to 9. The endpoint and the token stay saved.

2. Type `about:debugging#/runtime/this-firefox` in the address bar and press Enter.
3. Select **Load Temporary Add-on…** on the page.
4. In the file dialog, select the XPI file from this folder: `browser-control-<version>.xpi`.
5. Open the settings of the extension.
6. Enter `ws://127.0.0.1:8110` in the endpoint field.
7. Enter the token from the `token:` line of the start window.
8. Select **Save**.
9. Reload the extension in `about:debugging` one time.

The start window shows three lines. The line `endpoint:` carries
`ws://127.0.0.1:8110`; this address belongs to the extension. The line `http:`
carries `http://127.0.0.1:8111/mcp`; this address belongs to the MCP client
(`CLIENTS.md`).

If the bridge runs on another machine, replace `127.0.0.1` with its address in
step 6. Do not change the port unless you changed `BC_BIND`.
