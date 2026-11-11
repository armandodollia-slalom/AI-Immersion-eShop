---
story: BUG-5
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/47"
story-sha: 42d0e6f2a522
plan-sha: 5f0ec17f782c
verified-score: 9
verified-at: "2026-11-11T10:47:46.053Z"
verified-by: qe-plan@09234f3a/456099fb
automation-sha: 1a8d9200df6d
automation-plan-sha: 5f0ec17f782c
automation-score: 9
automation-verified-at: "2026-11-11T12:07:08.009Z"
---
# Test plan: BUG-5 [FE - WebApp] - Open redirect after sign-in through a protocol-relative returnUrl

Covers the WebApp `/user/login` redirect after sign-in: protocol-relative and backslash return URLs must fall back to `/`, local paths are still honoured, plus the acceptance criteria on the e2e spec and flow docs.

| ID | Title | Type | Layer | Covers |
| ---- | ------- | ------ | ------- | -------- |
| TC-BUG-5-01 | Protocol-relative returnUrl //evil.example redirects to the home page | sad | e2e | Expected, fix rule |
| TC-BUG-5-02 | returnUrl /\evil.example redirects to the home page | sad | e2e | fix rule (backslash) |
| TC-BUG-5-03 | Absolute returnUrl falls back to the home page | sad | e2e | Expected |
| TC-BUG-5-04 | Base-relative returnUrl item/7 is honoured | happy | e2e | Decisions |
| TC-BUG-5-05 | Single-leading-slash returnUrl /item/7 is honoured | happy | e2e | fix rule |
| TC-BUG-5-06 | No returnUrl redirects to the home page | happy | e2e | Expected |
| TC-BUG-5-07 | auth-login spec passes with the test.fixme marker removed | happy | e2e | Acceptance |
| TC-BUG-5-08 | Bug row removed from the bugs table in testing/flows | happy | unit | Acceptance |

## Out of scope

- `~/` prefix, whitespace and control-character inputs (only in Implementation Notes).
- Anonymous access to `/user/login` (Identity redirect, covered by the existing spec).

## Open questions

- Expected redirect for `~/path`, whitespace-padded and control-character return URLs is stated only in Implementation Notes, not the requirements; no cases written.
