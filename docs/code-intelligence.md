# Code intelligence for agents (LSP over MCP)

Agents get compiler-grade facts about the code (definitions, references, types, diagnostics, safe renames) from
language servers, exposed as tools of one MCP server named **`lsp`**. It works the same in Claude Code (interactive
and `claude -p`), GitHub Copilot CLI and Codex, and in every git worktree.

**graphify comes first.** Use graphify (`graphify query/explain/path`) to decide where to look and to investigate
architecture and relationships. Use the `lsp` tools for precise work at code graphify or a read already located:
confirm the definition, signature and callers before changing existing code, check diagnostics after every edit,
preview renames.

## How it fits together

```text
agent CLI ──stdio──> scripts/lsp/mcp.mjs ──unix socket──> lspd (one per checkout) ──stdio──> lsp-mcp-server
 (.mcp.json, .codex/config.toml)          (logs calls)      (leases C#, gates calls)          └─> language servers
```

- **`scripts/lsp/mcp.mjs`**: the MCP server the CLIs start. It finds the checkout from the current directory
  (`git rev-parse --show-toplevel`), starts that checkout's daemon if none runs, relays MCP messages and appends each
  tool call to the call log. It never connects to another checkout's daemon.
- **`scripts/lsp/lspd.mjs`**: the per-checkout daemon. All sessions in a checkout (the main agent, subagents, the
  pipeline's headless runs, the edit hook) share its language servers. It runs
  [lsp-mcp-server](https://github.com/ProfessioneIT/lsp-mcp-server) as the LSP client, starts language servers on
  first use, stops idle ones and exits when idle with no sessions.
- **C# (Roslyn)** is heavy, so each daemon needs a machine-wide **lease** before it starts one (default cap 6).
  Without a lease, or while the solution is restoring or loading, C# calls answer at once with
  `C# language server unavailable (<reason>); use graphify and grep` instead of hanging.

## Servers

| Language | Server | Version | Installed by |
| :- | :- | :- | :- |
| C# (`.cs`) | `roslyn-language-server` (Roslyn, the server behind the VS Code C# extension) | 5.13.0-1.26514.10 | `.config/dotnet-tools.json` (local tool) |
| TypeScript / JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) | `typescript-language-server` + `typescript` | 5.3.0 + 6.0 (`~6.0.0`, shared with ESLint) | `package.json` devDependencies |
| bash (`.sh .bash`) | `bash-language-server` | 5.8.1 | `package.json` |
| JSON, CSS, HTML | `vscode-langservers-extracted` | 4.10.0 | `package.json` |
| YAML | `yaml-language-server` | 1.25.0 | `package.json` |
| MCP bridge | `lsp-mcp-server` | 1.1.27 | `package.json` |

Versions are pinned exactly. The Node servers are the newest releases that still run on Node 20 (newer
`typescript-language-server` and `yaml-language-server` majors need Node 22; TypeScript 7 no longer ships
`tsserver`). There is no Bicep or Dockerfile in the repo, so no server for them.

Not covered: `.razor` and `.cshtml` markup (C# code-behind `.cs` files are), XAML, PowerShell. `bash-language-server`
reports lint diagnostics only when `shellcheck` is on `PATH` (optional: `brew install shellcheck`).

## Install and verify

`scripts/setup.sh` runs `scripts/lsp/setup.sh`, which is idempotent and installs nothing globally:
`npm ci` when neither this checkout nor the main checkout has `node_modules`, then `dotnet tool restore`.
A fresh git worktree needs nothing: it falls back to the main checkout's `node_modules`, and the Roslyn package sits
in the shared NuGet cache. Before Roslyn starts, lspd runs `dotnet restore` (of `eShop.Web.slnf`, or of the given
filter) when projects have no restore output, so a new worktree gets real diagnostics instead of "type not found".

```bash
scripts/lsp/setup.sh --check          # start this checkout's daemon and run the smoke test
node scripts/lsp/lspd.mjs status      # every daemon on the machine and the C# leases
```

`check.mjs` asks each server for hover, definition, references and diagnostics on real files
(`src/Catalog.API/Apis/CatalogApi.cs`, `e2e/teststack/catalog-api.spec.ts`, ...).

In a CLI: Claude Code `/mcp` (or `claude mcp get lsp`), Copilot `copilot mcp get lsp`, Codex `codex mcp get lsp`.

## How each agent CLI gets it

| CLI | Config | Notes |
| :- | :- | :- |
| Claude Code (interactive) | `.mcp.json`, approved by `enabledMcpjsonServers: ["lsp"]` in `.claude/settings.json` | Project approvals apply once the folder is trusted; trust covers all worktrees of the repo. |
| `claude -p` | same `.mcp.json` | Connects without approval. MCP tools still need permission: list them in `--allowedTools`. |
| GitHub Copilot CLI | reads the same `.mcp.json` (workspace config) | Workspace MCP servers load only in a trusted folder; `-p` in an untrusted worktree needs `--trust-folder`. |
| Codex | `.codex/config.toml` `[mcp_servers.lsp]` | Project config loads only for trusted projects; otherwise pass the server with `-c` (below). |

Claude Code also runs `scripts/lsp/hook.mjs` after `Edit`, `Write` and `MultiEdit` on `.cs`, `.ts`, `.js`, `.mjs`
and `.sh` files: when the checkout's daemon runs and reports errors in the edited file, they are shown to the agent
next to the tool result. It never starts a daemon and stays silent when the server is unavailable.

## Tools

All take absolute paths inside the checkout and 1-indexed line/column.

- **Read-only**: `lsp_goto_definition`, `lsp_goto_type_definition`, `lsp_find_references`,
  `lsp_find_implementations`, `lsp_hover`, `lsp_signature_help`, `lsp_document_symbols`, `lsp_workspace_symbols`,
  `lsp_find_symbol`, `lsp_smart_search`, `lsp_call_hierarchy`, `lsp_type_hierarchy`, `lsp_diagnostics`,
  `lsp_workspace_diagnostics`, `lsp_index_files`, `lsp_completions`, `lsp_document_highlights`, `lsp_inlay_hints`,
  `lsp_selection_range`, `lsp_folding_ranges`, `lsp_file_imports`, `lsp_file_exports`, `lsp_related_files`,
  `lsp_server_status`.
- **Mutating** (edit files when asked to apply): `lsp_rename` (`dry_run` defaults to true), `lsp_code_actions`
  (`apply` defaults to false), `lsp_format_document` (`apply` defaults to false).
- `lsp_start_server` / `lsp_stop_server` are hidden: lspd manages server lifecycles shared by several sessions.

Allowing them in headless runs:

| CLI | All tools (implement/write) | Read-only (verifiers, reviewers) |
| :- | :- | :- |
| `claude -p --allowedTools` | `mcp__lsp` | each read-only tool as `mcp__lsp__<tool>`, e.g. `mcp__lsp__lsp_find_references` |
| `copilot -p` | `--allow-tool lsp` | `--allow-tool lsp --deny-tool 'lsp(lsp_rename)' --deny-tool 'lsp(lsp_code_actions)' --deny-tool 'lsp(lsp_format_document)'` |
| `codex exec` | nothing (`default_tools_approval_mode = "approve"`) | `-c 'mcp_servers.lsp.disabled_tools=["lsp_rename","lsp_code_actions","lsp_format_document"]'` |

Codex in a project it does not trust ignores `.codex/config.toml`; define the server on the command line instead:
`-c 'mcp_servers.lsp.command="node"' -c 'mcp_servers.lsp.args=["<worktree>/scripts/lsp/mcp.mjs"]' -c 'mcp_servers.lsp.env_vars=["PIPELINE_AGENT_NAME"]' -c 'mcp_servers.lsp.default_tools_approval_mode="approve"'`.

## Daemon commands (for the pipeline and humans)

Every command prints one JSON line. `--worktree` defaults to the checkout containing the current directory.

```bash
node scripts/lsp/lspd.mjs start --worktree <path> [--slnf <file>]
#  {"ok":true,"pid":n,"socket":"...","csharp":"running|unavailable","reason":...,"csharpState":"restoring|starting|loading|ready",...}
#  idempotent: a running daemon answers with the same pid and socket (its solution is not changed)
node scripts/lsp/lspd.mjs stop --worktree <path>
node scripts/lsp/lspd.mjs status [--worktree <path>]     # without --worktree: all daemons and leases
node scripts/lsp/lspd.mjs stop-all
node scripts/lsp/lspd.mjs diagnostics --worktree <path> --files <f1> [<f2>...] [--no-start]
#  {"ok":true,"files":{"<f1>":[{"severity":"error","line":5,"col":35,"code":"CS0029","message":"..."}],
#                      "<f2>":{"unavailable":"C# language server unavailable (still loading eShop.slnx (12s so far)); use graphify and grep"}}}
node scripts/lsp/slnf.mjs --owns <glob> [--owns <glob>...] --out <file.slnf>
#  {"ok":true,"projects":[...],"out":"..."}: projects whose directory matches a glob (or contains files a glob
#  names) plus their transitive ProjectReferences; paths are valid for eShop.slnx in the same checkout
```

Put generated filters outside the tree, e.g. `"$(git rev-parse --git-dir)/lsp/story.slnf"`.

Files:

| What | Where |
| :- | :- |
| Socket, pid file, start lock | `$TMPDIR/eshop-lsp/<sha256(realpath(worktree))[:12]>.{sock,json,lock}` |
| C# leases (machine-wide) | `$TMPDIR/eshop-lsp/leases/slot-<n>.json` (`{slot,pid,owner,since}`; a dead pid's slot is reclaimed) |
| Daemon log, restore log, C# state | `<git-dir>/lsp/lspd.log`, `restore.log`, `csharp.json` |
| Call log (metrics) | `<git-dir>/lsp/calls.jsonl`: `{ts, agent, tool, file, symbol}` per tool call; `agent` is `$PIPELINE_AGENT_NAME`, `symbol` the query, new name or `line:column` |

`<git-dir>` is `git rev-parse --git-dir`: `.git` in the main checkout, `.git/worktrees/<name>` in a worktree.

Settings live in `scripts/lsp/config.json`: `maxLanguageServers` (C# lease cap, default 6, env `LSP_MAX_SERVERS`),
`idleSec` (default 900, env `LSP_IDLE_SEC`; idle language servers stop, and the daemon exits when idle with no
sessions), `callTimeoutSec`, `diagnosticsTimeoutSec`, `defaultSolution` (`eShop.slnx`), `restoreSolution`.
`LSP_SLNF` makes `mcp.mjs` start a missing daemon with that filter.

## Memory

Measured on macOS (Apple silicon), resident memory after the solution loaded and a few queries:

| Process | RSS |
| :- | :- |
| Roslyn, full `eShop.slnx` (the MAUI projects fail to load without workloads; the rest load) | ~730 MB (590 MB right after load) |
| Roslyn, `slnf.mjs --owns 'src/Catalog.API/**'` (5 projects) | ~500 MB |
| Roslyn wrappers (`roslyn-proxy.mjs`, `dotnet tool run`, tool relay) | ~105 MB |
| TypeScript (`typescript-language-server` + 2 `tsserver`) | ~560 MB |
| bash-language-server | ~130 MB |
| lspd + lsp-mcp-server | ~100 MB |

So a worktree costs roughly 0.7 to 1.6 GB while agents use it, mostly Roslyn; the lease cap bounds the Roslyn part
machine-wide (6 x ~0.8 GB). Warm load of the full solution takes about 10 s; a fresh worktree adds a NuGet restore
(about 10 s with a warm cache). Use a story filter for parallel runs, and `LSP_MAX_SERVERS` to lower the cap.

## Troubleshooting

- `C# language server unavailable (all 6 ... slots are in use ...)`: other checkouts hold the leases. See
  `lspd.mjs status`; `lspd.mjs stop --worktree <path>` frees one. A crashed daemon's slot is reclaimed automatically.
- C# stays `loading`: see `<git-dir>/lsp/lspd.log` and `restore.log`; after `csharpLoadTimeoutSec` calls go through
  anyway.
- Bogus "type or namespace not found" errors: the project was not restored; `dotnet restore eShop.Web.slnf`, then
  `lspd.mjs stop` and start again.
- MCP server fails to start: `node scripts/lsp/mcp.mjs < /dev/null` prints the reason; usually `npm ci` is missing.
- YAML server exits during initialization with `Cannot find module 'ajv/dist/core'`: ESLint's `ajv@6` got hoisted over the
  `ajv@8` the YAML server needs. `package.json` pins `ajv@^8` as a dev dependency for this; keep it when updating ESLint.
- Everything at once: `node scripts/lsp/lspd.mjs stop-all`.
- Tests: `node --test scripts/lsp/test/*.test.mjs` (also part of `npm run test:pipeline`).
