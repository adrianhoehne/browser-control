# Connect an MCP client

This guide connects pi, Codex, OpenCode, or another MCP client to
browser-control. Start the server before you connect a client.

1. Start the server: run `start.sh` (Linux) or `start.cmd` (Windows).
2. Copy two lines from the start window: the line `http:` and the line `token:`.
3. **pi** — add this entry to `~/.pi/agent/mcp.json`:

   ```json
   { "mcpServers": { "browser-control": {
       "url": "http://127.0.0.1:8111/mcp",
       "headers": { "Authorization": "!echo Bearer $(cat <folder>/data/token)" } } } }
   ```

   The `!` value reads the token at start. The token stays out of the file.
4. **Codex** — run these two commands in a shell:

   ```bash
   export BC_TOKEN=$(cat <folder>/data/token)
   codex mcp add browser-control --url http://127.0.0.1:8111/mcp --bearer-token-env-var BC_TOKEN
   ```

5. **OpenCode** — run this command:

   ```bash
   opencode mcp add browser-control --url http://127.0.0.1:8111/mcp --header "Authorization=Bearer <token>"
   ```

   This client writes the token into its own configuration file.
6. **Another client** — use one of these two patterns. Both send the header
   `Authorization: Bearer <token>`.

   ```json
   {
     "mcpServers": {
       "browser-control": {
         "url": "http://127.0.0.1:8111/mcp",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```

   ```toml
   [mcp_servers.browser-control]
   url = "http://127.0.0.1:8111/mcp"
   headers = { Authorization = "Bearer <token>" }
   ```

7. Check the connection: the client lists thirteen tools. Ask for
   `browser_status`, then `browser_open_tab`, then `browser_read`. pi puts
   `mcp__browser-control__` in front of each name. Codex and OpenCode show the
   same names without a prefix.
8. Use the same token for Firefox and for the client. One token serves both.

The client connects to `http://127.0.0.1:8111/mcp`. The token is the same on
both sides: the line `token:` of the start window is the token of `data/token`.
