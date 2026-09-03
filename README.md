# dsh-addon-kit

Reusable add-ons for **DeepSeek Harness (DSH)** and any MCP/A2A-capable agent:
browsers, desktop control, cross-agent bridging, UI patches, and mobile access —
packaged as independent, portable artifacts.

> **Sanitized public release.** All private identifiers (IPs, domains, local
> paths, deployment names) are replaced with placeholders such as
> `<PC_TAILSCALE_IP>` / `<YOUR_DOMAIN>.ts.net`. No credentials are included —
> generate your own with `generate-keys.ps1`. A CI sanity gate
> (`.github/workflows/sanity.yml`, `ci-scan.py`) re-checks every push.

## Artifacts

| Path | What it is | Reuse target |
|---|---|---|
| `skills/computer-use-strategy` | Execution strategy skill (token-saving ladder: DOM → UIA → screenshots → physical input) | Any DSH (`~/.dsh/skills/`), any Claude/Cursor skill dir |
| `mcp/desktop` | Windows desktop execution layer: 10 physical + 7 UIA tools (screenshot / click / type / hotkey / window mgmt / UI-Automation tree, invoke, setvalue) | Any MCP client (stdio); `pip install mcp<2 mss` |
| `mcp/playwright-browsers` | Chrome / Edge / Firefox browser layer via official @playwright/mcp (DOM-level, 24 tools each, persistent profiles) | Any MCP client; `npx @playwright/mcp --browser <browser>` |
| `plugins/dsh-file-attach` | DSH web attachment plugin (host + browser faces, v0.1.0) | DSH only (compose into cordis.yml) |
| `bridges/a2a-peer-bridge` | A2A v1.0 endpoint + cross-host MCP bridge (card discovery / run_task / message / push callback with Bearer + HMAC signature auth) | **Any A2A standard client** (another DSH, peer agent, …) |
| `mobile-remote` | Phone access kit: Tailscale portproxy + tailscale serve HTTPS + trust hosts | Any DSH deployment (Tailscale layer is generic) |
| `ui-patches/dsh-patch-kit-release` | DSH web-frontend UI patch library (mobile PWA/injection + 50+ layout patches; marker-based, idempotent) | DSH Linux/LXC deployments |

Machine-readable index: `addon-manifest.yaml`. 中文版说明见 [README.zh.md](README.zh.md).

## Install matrix

- **Another DSH instance** — copy skills; apply each `cordis-patch.yaml` snippet
  (adjust paths); run the `install.ps1` scripts.
- **Claude Code / Cursor / Windsurf / any MCP client** — configure `desktop` and
  `playwright-browsers` as stdio MCP servers (commands are identical); convert the
  skill to the host's skills format.
- **Any A2A agent (another DSH, peer, …)** — deploy the bridge side (run
  `generate-keys.ps1`, never reuse someone else's values), then card discovery
  just works.

## Usage policy (token economics)

1. **Browser pages → DOM first** (`browser_find` / `browser_snapshot`), screenshots only to verify rendering.
2. **Desktop → UIA first** (control-tree text, no cursor grab), window/region screenshots second, physical input last.
3. Long-running tasks: wait before re-checking; compact long sessions.

## Author workflow

```
edit sources -> git commit (local full repo) -> python publish_public.py
             -> push (public repo, CI sanity gate auto-runs)
```

- The local full archive keeps private topology local.
- `publish_public.py` mirror-syncs `dsh-addon-kit-public/` (keeps its git history).

## License

MIT — see [LICENSE](LICENSE).
