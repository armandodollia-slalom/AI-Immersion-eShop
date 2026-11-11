# Model allowlist

The pipeline only calls the models this project allows. The policy lives in `scripts/models/config.json`, per agent CLI (provider), and `scripts/models/models.mjs` shows what the CLIs on your machine can serve, resolves model names and checks every model configured elsewhere in the repo.

Current policy: **Claude Opus 5.5 and Claude Sonnet 5.5 only**, Sonnet 5.5 by default.

| Provider (CLI) | Allowed ids | Default |
| --- | --- | --- |
| `claude` (Claude Code) | `claude-opus-5-5`, `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `copilot` (GitHub Copilot CLI) | `claude-opus-5.5`, `claude-sonnet-5.5` | `claude-sonnet-5.5` |
| `codex` (OpenAI Codex CLI) | none | none |

Each provider uses its CLI's own spelling: Claude Code writes versions with dashes, Copilot CLI with dots.

**Codex is disabled.** Codex only serves OpenAI models, so under this policy its allowed list is empty. Any run that would use it (`PIPELINE_AGENT_CLI=codex`, `agent.cli: "codex"`, an implement role with `"cli": "codex"`) fails before the CLI starts with `no allowed models configured for codex`. To enable it, add OpenAI model ids to `providers.codex.allowed` (the policy then no longer says "Opus and Sonnet only").

## Commands

```bash
node scripts/models/models.mjs list                 # provider, installed, allowed, discovered, available, default
node scripts/models/models.mjs list --json
node scripts/models/models.mjs discover --refresh   # re-run discovery, ignoring the 24h cache
node scripts/models/models.mjs check                # exit 1 if a configured model is not allowed
node scripts/models/models.mjs resolve --provider claude --model opus   # -> claude-opus-5-5
node scripts/models/models.mjs resolve --provider copilot               # -> claude-sonnet-5.5 (the default)
```

`resolve` accepts the canonical id, the other spelling (`claude-opus-5.5` for Claude, `claude-opus-5-5` for Copilot), a family alias (`opus`, `sonnet`: the newest allowed model of that family), optional `aliases` from the policy file, or nothing/`default` for the provider default. Anything else fails with the allowed list. Copilot's `auto` is not allowed, because it lets Copilot pick any model.

## Changing the list

Edit `scripts/models/config.json` in a pull request:

```json
"claude": { "allowed": ["claude-opus-5-5", "claude-sonnet-5-5"], "default": "claude-sonnet-5-5" }
```

Then run `node scripts/models/models.mjs check` (CI should run it too) so model settings in other config files still pass, and `list` to confirm the installed CLIs offer the new ids. Use ids that `discover` prints; never guess one.

### Local narrowing

`scripts/models/config.local.json` (gitignored) can **narrow** the list for your machine, for example to keep a laptop on Sonnet only, or to change your default within the allowed list:

```json
{ "providers": { "claude": { "allowed": ["claude-sonnet-5-5"], "default": "claude-sonnet-5-5" } } }
```

It cannot widen it. Entries the project policy does not allow, new providers and a default outside the narrowed list are ignored with a warning. The allowlist is project policy (cost, data handling and reproducibility of agent output are agreed for the team), so a local file must not be able to quietly opt one developer's pipeline runs into other models. To allow a model, change `config.json` in review. An empty local `allowed` list disables a provider on your machine.

## Discovery per CLI

Discovery tells you what the CLIs installed here can serve. It is cached per provider in `$(git rev-parse --git-common-dir)/models-cache.json` (shared by all worktrees) for `cacheTtlHours` (24); `--refresh` bypasses it. A CLI that is not installed is never cached, so installing one shows up immediately. `MODELS_CACHE_FILE` overrides the cache path.

| CLI | Mechanism | `source` | Limits |
| --- | --- | --- | --- |
| Claude Code | No list command (`claude --help` only documents `--model <alias or full name>`). With `ANTHROPIC_API_KEY` set (and no Bedrock/Vertex), `GET /v1/models` on `ANTHROPIC_BASE_URL` or api.anthropic.com. Otherwise a static list of ids known to Claude Code 2.1.318. | `api` or `static` | A claude.ai subscription login cannot call the models API, so most developers get `static`: not verified against their account. Bedrock and Vertex use other ids. |
| Copilot CLI | `copilot help config` lists the ids the `model` setting accepts. | `cli` | That is the list this CLI version knows, not your entitlement: organisation or enterprise policy can still refuse a model. Only the interactive `/model` picker shows the per-account list. |
| Codex CLI | `codex debug models` (refreshes the catalog for the signed-in account), falling back to `codex debug models --bundled` (catalog shipped with the binary). | `cli` or `bundled` | Hidden entries (`visibility: hide`) are marked `hidden`. The fallback is not verified against your account. |

`available` = allowed ∩ discovered. When discovery cannot be trusted (CLI missing, discovery failed, or a `static`/`bundled` list) `list` shows the allowed list marked `*` and a warning, rather than an empty list. An allowed model the installed CLI does not offer is listed in a warning (usually: update the CLI).

## Enforcement

- **Library.** `scripts/models/lib/models.mjs` exports `allowedModels(provider)`, `resolveModel(provider, requested)` (canonical id, or throws `ModelNotAllowedError` with `.allowed`; `ProviderDisabledError` for codex), `assertProviderUsable(provider)`, and the async `discoverModels(provider, {refresh})` and `availableModels(provider)`. The policy calls are synchronous and never spawn a process, so they are cheap enough to run on every agent call.
- **Pipeline.** Every headless agent run resolves its model through `resolveModel(cli, model)` before the CLI starts and passes the canonical id with `--model`/`-m`, so a run never falls back to the CLI's own default model. A model outside the policy, or the codex CLI, fails the run with the error above. A custom `PIPELINE_AGENT_CMD` is not checked: it is a command you wrote, and the pipeline cannot see which model it calls.
- **Implement model classes.** `modelClasses` in `scripts/implement/config.json` map small/medium/large to models per CLI (Claude: Sonnet 5.5, Sonnet 5.5, Opus 5.5; Copilot: the same with dots; Codex: none). Every value is resolved through the policy.
- **Check.** `node scripts/models/models.mjs check` scans `agent.models`, `modelClasses` and `implement.roles` in `scripts/*/config.json` and `config.local.json`, the `model:` front matter of `.github/agents/*.agent.md` (must be allowed for both Claude Code and Copilot, which read them), `.claude/agents/*.md` and `scripts/agents-claude.json`. `inherit` is always fine.
- **Interactive sessions.** The allowlist above binds the pipeline. Claude Code has an `availableModels` setting that restricts the `/model` picker and `--model`, but in a test with version 2.1.318 it had no effect from the project `.claude/settings.json` (`claude -p --model claude-haiku-5-5` still ran Haiku); it did apply through `--settings` (and is documented for managed and user settings), where a disallowed `--model` silently switches to an allowed default instead of failing. So it is not a substitute for the pipeline check. Copilot CLI and Codex have no model allowlist setting; their repository config (`.github/copilot/settings.json`, `.codex/config.toml`) can only set a default `model`. Organisation-wide restrictions belong in Claude Code managed settings and in the GitHub Copilot model policy.
