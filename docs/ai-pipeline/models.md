# Model allowlist

The pipeline only calls the models this project allows. The policy is `agent.allowedModels` and `agent.modelIds` in `scripts/pipeline/config.json`, and every agent run checks its model through one function, `resolveModel` in `scripts/pipeline/lib/agents.mjs`, before its CLI starts. `scripts/models/models.mjs` shows the policy per agent CLI, what the CLIs on your machine can serve, resolves model names and checks every model configured elsewhere in the repo; it resolves through the same function, so it never disagrees with a run.

Current policy: **Claude Opus 5.5 and Claude Sonnet 5.5 on every CLI, plus Sol 6.1 on Copilot**, Sonnet 5.5 by default.

```json
"agent": {
  "allowedModels": ["opus", "sonnet", "sol"],
  "modelIds": {
    "claude": { "opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5" },
    "copilot": { "opus": "claude-opus-5.5", "sonnet": "claude-sonnet-5.5", "sol": "gpt-6.1-sol" }
  },
  "strictModels": true,
  "models": { "default": "sonnet" }
}
```

| Agent CLI | Allowed ids | Default |
| --- | --- | --- |
| `claude` (Claude Code) | `claude-opus-5-5`, `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `copilot` (GitHub Copilot CLI) | `claude-opus-5.5`, `claude-sonnet-5.5`, `gpt-6.1-sol` | `claude-sonnet-5.5` |
| `codex` (OpenAI Codex CLI) | none | none |

- **Aliases.** Configs and stages name models by alias (`opus`, `sonnet`, `sol`); `sol` (Sol 6.1) has an id only for Copilot, so a Claude Code run asked for `sol` is refused under `strictModels`; `modelIds` maps each alias to each CLI's own id. Claude Code spells versions with dashes, Copilot CLI with dots. The ids pin the version: Claude Code's own `opus` alias would follow the newest Opus, so the policy names `claude-opus-5-5`.
- **Strict.** With `strictModels`, a run with no model gets `agent.models.default`, and an alias with no id for the run's CLI is refused instead of falling back to the CLI's default model, so nothing outside the list ever runs. Without it (the pre-policy behaviour, and what the unit tests of other stages use), a missing id means the CLI's default.
- **Codex is refused.** Codex only serves OpenAI models, so `modelIds` has no entry for it and every run on it (`PIPELINE_AGENT_CLI=codex`, an implement role or PR-check model set with `"cli": "codex"`) fails before the CLI starts. To enable it, add OpenAI ids under `modelIds.codex` for aliases you add to `allowedModels` (Codex also serves `gpt-6.1-sol`, so mapping `sol` there would enable it for that alias only).
- `PIPELINE_MODEL_OVERRIDE=<alias>` forces one allowed alias for every agent, for experiments; it is checked like any other choice.

## Commands

```bash
npm run models                                       # = node scripts/models/models.mjs list
node scripts/models/models.mjs list --json
node scripts/models/models.mjs discover --refresh    # re-run discovery, ignoring the 24h cache
npm run models:check                                 # exit 1 if a configured model is not allowed
node scripts/models/models.mjs resolve --provider claude --model opus   # -> claude-opus-5-5
node scripts/models/models.mjs resolve --provider copilot               # -> claude-sonnet-5.5 (the default)
```

`resolve` accepts an allowed alias, a CLI id an allowed alias maps to for that CLI, or nothing/`default` for the default. Anything else (another CLI's spelling, a family the policy does not allow, Copilot's `auto`, which lets Copilot pick any model) fails with the allowed list.

## Changing the list

Edit `agent.allowedModels` and `agent.modelIds` in `scripts/pipeline/config.json` in a pull request, then run `npm run models:check` (CI runs it with the pipeline tests) so model settings in other configs still pass, and `npm run models` to confirm the installed CLIs offer the new ids. Use ids that `discover` prints; never guess one. An id mapped for an alias that is not in `allowedModels` is ignored with a warning.

There is no machine-local override: the allowlist is project policy (cost, data handling and reproducibility of agent output are agreed for the team). `scripts/models/config.json` only holds discovery settings (`cacheTtlHours`).

## Discovery per CLI

Discovery tells you what the CLIs installed here can serve. It is cached per CLI in `$(git rev-parse --git-common-dir)/models-cache.json` (shared by all worktrees) for `cacheTtlHours` (24); `--refresh` bypasses it. A CLI that is not installed is never cached, so installing one shows up immediately. `MODELS_CACHE_FILE` overrides the cache path.

| CLI | Mechanism | `source` | Limits |
| --- | --- | --- | --- |
| Claude Code | No list command (`claude --help` only documents `--model <alias or full name>`). With `ANTHROPIC_API_KEY` set (and no Bedrock/Vertex), `GET /v1/models` on `ANTHROPIC_BASE_URL` or api.anthropic.com. Otherwise a static list of ids known to Claude Code 2.1.318. | `api` or `static` | A claude.ai subscription login cannot call the models API, so most developers get `static`: not verified against their account. Bedrock and Vertex use other ids. |
| Copilot CLI | `copilot help config` lists the ids the `model` setting accepts. | `cli` | That is the list this CLI version knows, not your entitlement: organisation or enterprise policy can still refuse a model. Only the interactive `/model` picker shows the per-account list. |
| Codex CLI | `codex debug models` (refreshes the catalog for the signed-in account), falling back to `codex debug models --bundled` (catalog shipped with the binary). | `cli` or `bundled` | Hidden entries (`visibility: hide`) are marked `hidden`. The fallback is not verified against your account. |

`available` = allowed ∩ discovered. When discovery cannot be trusted (CLI missing, discovery failed, or a `static`/`bundled` list) `list` shows the allowed list marked `*` and a warning, rather than an empty list. An allowed model the installed CLI does not offer is listed in a warning (usually: update the CLI).

## Enforcement

- **Every run.** `runAgent` and `runAgentAsync` resolve the model through `resolveModel(config, alias, cli)` before building the CLI command and pass the CLI's id with `--model`/`-m`. A model outside the policy, or a CLI without allowed ids (Codex), fails the run with that error. A custom `PIPELINE_AGENT_CMD` gets the alias unchecked against a CLI: it is a command you wrote, and the pipeline cannot see which model it calls.
- **Config load.** `loadConfig` rejects an `agent.models.<role>` alias outside `allowedModels`.
- **Implement model classes.** `modelClasses` in `scripts/implement/config.json` map small/medium/large to aliases (`sonnet`, `sonnet`, `opus`). The implement harness checks every class a plan needs for the role's CLI when the plan is accepted, so a disallowed model fails the plan, not a pair halfway through.
- **PR check.** `prCheck.models.<cli>.<role>` in `scripts/pr-check/config.json` are checked the same way (a CLI's own ids are accepted when an allowed alias maps to them).
- **Library.** `scripts/models/lib/models.mjs` exports `loadPolicy()` (the per-CLI view of the pipeline config), `allowedModels(cli)`, `resolveModel(cli, requested)` (throws `ModelNotAllowedError` with `.allowed`, `ProviderDisabledError` for a CLI with no allowed ids), `assertProviderUsable(cli)`, and the async `discoverModels(cli, {refresh})` and `availableModels(cli)`.
- **Check.** `npm run models:check` scans `agent.models`, `modelClasses`, `implement.roles` and `prCheck.models` in `scripts/*/config.json` and `config.local.json`, the `model:` front matter of `.github/agents/*.agent.md` (must be allowed for both Claude Code and Copilot, which read them), `.claude/agents/*.md` and `scripts/agents-claude.json`. `inherit` is always fine.
- **Interactive sessions.** The allowlist binds the pipeline. Claude Code has an `availableModels` setting that restricts the `/model` picker and `--model`, but in a test with version 2.1.318 it had no effect from the project `.claude/settings.json` (`claude -p --model claude-haiku-5-5` still ran Haiku); it did apply through `--settings` (and is documented for managed and user settings), where a disallowed `--model` silently switches to an allowed default instead of failing. So it is not a substitute for the pipeline check. Copilot CLI and Codex have no model allowlist setting; their repository config (`.github/copilot/settings.json`, `.codex/config.toml`) can only set a default `model`. Organisation-wide restrictions belong in Claude Code managed settings and in the GitHub Copilot model policy.
