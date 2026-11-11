# Agent instructions

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- graphify-out/ is built locally (gitignored except the semantic cache). If graphify-out/graph.json is missing, run `scripts/graphify-build.sh` first (no API cost, a few seconds; replays the shared semantic cache), then follow the rules below.
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- graphify-out/cache/semantic/ is committed and shared, so everyone gets the LLM-extracted doc/image nodes without an API key. After adding or changing docs or images (.md, .pdf, diagrams), run `scripts/graphify-build.sh --extract` and commit only the new files under graphify-out/cache/semantic/. Never commit anything else in graphify-out/.

## Code intelligence (LSP)

The MCP server `lsp` exposes language servers for C#, TypeScript/JavaScript, bash, JSON, YAML, CSS and HTML (`docs/code-intelligence.md`). graphify stays the entry point: use it first to find where to look and for investigations (architecture, where things live, relationships). Use the `lsp` tools for precise work at code graphify or a read already located:

- Before changing existing code, confirm it with LSP when available: `lsp_goto_definition` and `lsp_hover` for the real definition and signature, `lsp_find_references` for every caller before you change a signature or behavior.
- After every edit, run `lsp_diagnostics` on the edited files (Claude Code also reports new errors after edits automatically).
- Rename with `lsp_rename` (`dry_run: true` first) instead of search and replace.
- Paths are absolute and inside your own checkout; line and column are 1-indexed. If a call answers "C# language server unavailable", do not retry in a loop: use graphify and grep.

## AI development pipeline

Stories go through the agent pipeline described in `docs/ai-pipeline/README.md` (architecture review, then QE test plans and automated tests).

- When you start implementing a story, run `node scripts/pipeline/pipeline.mjs start <KEY>` (for example `PROMO-3`).
- When your line of work for that story is complete, run `node scripts/pipeline/pipeline.mjs done` before you finish. The Stop hook then runs an architecture review. If it blocks with findings, fix them and finish again; tests are written automatically after approval.
- Do not edit `tests/plans/`, `.agent-metrics/` or `.github/agents/lessons/` by hand; the pipeline owns them. Commit them together with the work they describe.
