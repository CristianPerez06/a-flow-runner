---
name: review-automation
description: >-
  Review an a-flow-runner automation JSON file after a user has added it, and
  propose suggestions — with a focus on safety (no hardcoded passwords, OTP
  codes, tokens, or other secrets) plus selector resilience and run correctness.
  Use when the user asks to review / check / audit an automation or "script"
  they just added, or mentions a task by name (e.g. "review the ripio-login
  automation"). Reviews only; it proposes fixes and applies them only if asked.
---

# Review automation

An afterward review pass for automation files that a user has authored or
recorded. It does **not** create automations — it reviews an existing one and
proposes suggestions, prioritising safety.

## Inputs

1. **Ask which task to review** if the user didn't already name it: "Which
   automation should I review? (a task name or a path to its `.json`)".
2. Resolve the name to a file:
   - Look in `automations/` and the repo root for `<kebab-name>.json`.
   - If not found by filename, read candidate `.json` files and match the
     automation's `name` field (case-insensitive, fuzzy) against what the user said.
   - If still ambiguous, list the candidates you found and ask the user to pick.

## What to check

Read the file, confirm it is valid JSON, and check it against the step model in
`shared/src/steps.ts` (the source of truth: actions `goto | click | fill |
select | waitFor | assert`; value types `literal | secret | prompt |
promptTemplate`; optional `requiresHumanInput` and `segments`).

### 🔴 Safety — secrets must never be hardcoded (the main job)

A secret in a `literal` value gets committed to the repo. Flag and propose the
safe form for each:

- **Passwords** — a `fill` whose target selector/name contains `password`,
  `passwd`, or `pwd` must use `"requiresHumanInput": true` with **no `value`**.
  Flag any `literal` value on such a field.
- **OTP / 2FA codes** — targets containing `otp`, `mfa`, `2fa`, `pin`, or
  `code` must be prompted, not literal. For one-box-per-digit inputs, propose a
  single `fill` with `requiresHumanInput: true`, `value.type: "prompt"`, and a
  `segments` array (one entry per box). Also propose this when you see several
  consecutive single-character `literal` fills into `*_input_1..N` style inputs.
- **Magic-link / verification tokens** — propose `goto` with
  `value.type: "promptTemplate"` (prompt for the token, weave it into the URL
  template). Never hardcode the token. The template's base URL is fine; only the
  token should be prompted.
- **Other secret-looking literals** — flag any `literal` value (or a selector/
  field) containing `token`, `secret`, `apikey`/`api_key`, `cvv`, `card`, or a
  value that looks like a JWT/long random string.

### 🟡 Privacy & portability

- **Emails / usernames** hardcoded as `literal` → suggest `value.type: "prompt"`
  so the file isn't tied to one person and PII isn't committed.
- Any other personal data baked into a `literal` (account numbers, phone, DOB).

### 🟢 Correctness & resilience

- Every non-`goto` step has at least one selector; `goto` has a URL in `value`.
- A `fill` step has a `value`, `requiresHumanInput`, or `segments` — otherwise it
  fills an empty string (probably a mistake).
- Prefer **multiple selector candidates**, best-first (`data-testid` → `id` →
  `role` → `text`). Flag steps whose only selector is a brittle `nth-child`/long
  CSS path.
- The flow ends with an **`assert`** success check (e.g. a logged-in element is
  visible) so a green run means it truly worked. Suggest adding one if missing.
- `name` is meaningful; the file lives in `automations/` with a kebab-case name.

## Output

Produce a concise report grouped by severity, each item with: the **step id**,
the **issue**, and the **concrete fix** (show the corrected JSON snippet). End
with a one-line verdict (e.g. "1 secret to fix before committing; 2 nice-to-haves").

Then **offer** to apply the fixes — do not edit the file unless the user says yes.
When applying, change only what was agreed and re-validate the JSON afterward.

## Example finding

> 🔴 **s3 — hardcoded email in a `literal`** (`login_email_input`)
> Personal data committed to the repo. Prompt for it at run time instead:
> ```json
> "intent": "enter your account email",
> "requiresHumanInput": true,
> "value": { "type": "prompt", "label": "Enter your Ripio account email" }
> ```
