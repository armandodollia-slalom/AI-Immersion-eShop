---
story: BUG-16
story-issue: "https://github.com/armandodollia-slalom/AI-Immersion-eShop/issues/38"
story-sha: 1e79147e77ad
plan-sha: b23f9b521f01
verified-score: 9
verified-at: "2026-11-11T16:29:36.560Z"
verified-by: qe-plan@c3934e11/456099fb
automation-sha: 49d270faaf2a
automation-plan-sha: b23f9b521f01
automation-score: 9
automation-verified-at: "2026-11-11T17:22:31.232Z"
---
# Test plan: BUG-16 Webhooks.API accepts numeric event names outside the allowed list

Scope: `POST /api/webhooks` event validation in Webhooks.API (`WebhookSubscriptionRequest.Validate`). Numeric strings that do not map to a `WebhookType` member must be rejected with 400 `<value> is invalid event name`; valid names keep working. All cases run at the functional layer on the test stack with the `webhooks-subscriptions` scenario (alice owns subscriptions 1 and 2, bob owns 3).

| ID | Title | Type | Layer | Covers |
| --- | --- | --- | --- | --- |
| TC-BUG-16-01 | Numeric event "99" is rejected with 400 and not stored | sad | functional | Expected; Steps to Reproduce |
| TC-BUG-16-02 | Valid event name OrderShipped is still accepted | happy | functional | Regression: valid names |
| TC-BUG-16-03 | Numeric string mapping to a defined member ("1") is still accepted | happy | functional | Implementation Notes: decision on TryParse semantics |
| TC-BUG-16-04 | Non-numeric unknown event name is rejected | sad | functional | Validation of event names outside WebhookType |

## Out of scope

- Removing the `test.fixme` marker, the spec file's other tests, and the `testing/flows/` bugs-table row: repository changes checked in review, not runtime behavior.
- Other fields (url, grant url) and authentication: not changed by this bug.

## Open questions

- The story does not say what happens for negative or zero numbers (`"0"`, `"-1"`) or out-of-range-for-int values; no case written. They are undefined members, so the literal reading would reject them.
