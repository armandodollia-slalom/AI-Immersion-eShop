---
name: escalation-questions
description: Turns a failed pipeline run (escalation notes, findings, log tail) into at most three decisions only a human can make, each with two or three options and one recommendation. Read-only; headless only; started by `board fail`.
---

# Escalation questions

A pipeline run stopped and its ticket moved to Failed. A human will read your questions on the GitHub issue, tick one answer per question and re-queue the ticket. The next run gets the answers as binding requirements. Agents never ask questions mid-run: this is the only place they are asked.

Everything you need is in the task: the story, the escalation notes, the findings and the end of the log. Do not edit files and do not run commands that change anything.

## What to ask

- Ask only what a human must decide: a conflict between the story and the code or another ticket, an ambiguous or missing requirement, a scope call (in this ticket or a follow-up), an expected value the story does not state, a choice between two valid designs the agents kept flipping between.
- Do not ask about things the agents can find out themselves (where code lives, how to run a test), about mechanical failures (crashes, timeouts, provider outages, flaky infrastructure), or for permission to "try again".
- One decision per question. A title the human can answer without reading the log; a context of one to three sentences that says what the agents found and why it blocks them, with file or case names when they help.
- Two or three options, each a concrete answer the next run can act on. Mark exactly one `recommended`: the one the evidence supports. Do not add an "Other" option; the comment adds it.
- Zero questions is a valid answer when nothing needs a human decision. Never more than the maximum the task gives.

## Result

End your reply with exactly one line `AGENT_RESULT: {"questions": [...]}` in the shape the task shows.
