# a-flow-runner

A local-first, **attended** browser-automation assistant. You record web tasks
that have no API or MCP, then replay them in a **real browser you can watch** —
and the automation **pauses to ask you** whenever it needs a password, OTP, or a
judgment call, instead of having secrets pre-stored.

The name: it records a flow once, then *runs* that flow on your behalf — while
you (the principal) step in for the manual moments.

## Architecture

Two browsers, one local Node service — no Electron, no Docker.

```
Your browser (a tab)          Local Node service              Automation
 Orchestrator UI  ◄──WS───►  Runner + secrets  ──Playwright──►  headed Chromium
 (Vite + React)    localhost  (keytar keychain)
```

Workspaces:

- `shared/` — the typed UI↔runner **message contract** + the **step model**.
  This is the load-bearing boundary; UI and runner talk only through it, so an
  Electron port later is a repackaging, not a rewrite.
- `server/` — Node + TS service: http (serves the built UI) + `ws` + the
  Playwright **runner** + `keytar` secrets.
- `web/` — Vite + React control panel (step list, log, controls, HITL modal).

## Develop

```bash
pnpm install
pnpm --filter @a-flow-runner/server exec playwright install chromium    # one-time: download the browser

# terminal 1 — the Node service (runner + ws) on :4319
pnpm dev

# terminal 2 — the Vite UI on :5319 (proxies /ws to the service)
pnpm dev:web
```

Open http://localhost:5319. The panel starts empty — record, import, or type an
automation, then run it:

- **Record**: type a start URL and click **Record**. A headed Chromium opens;
  click and type as usual. Each interaction is captured as a structured step
  with several selector candidates. Password fields are captured as
  `requiresHumanInput` steps with **no value** — the secret is never recorded.
  Close the window (or click **Stop recording**) and the captured automation
  appears, ready to run.
- **Edit**: the automation is shown as **editable JSON** above the step list.
  Tweak values or selectors directly — valid edits apply to the next run and the
  step list updates live. **Copy** / **Download** to save it, **Import** to load
  a saved `.json`, **Reset** to clear everything back to empty.
- **Run**: a headed Chromium opens and replays the flow, **pausing at any
  human-input step** to ask you to type the value. After a successful run the
  window stays open so you can inspect the result (Stop/Reset or the next Run
  closes it).

## Automations & the step model

An automation is `{ id, name, createdAt, steps[] }`. Each step is a structured,
replayable action — see `shared/src/steps.ts` for the source of truth.

- **Actions**: `goto`, `click`, `fill`, `select`, `waitFor`, `assert`.
  - `assert` waits for the target to be visible; if it isn't, the step (and run)
    fails. Handy as a final success check.
  - `fill` with a `segments` list types **one character per target** from a
    single value — for one-box-per-digit OTP inputs, so the user is prompted once
    and all boxes are filled at once.
- **Values** (`value`): how a step's input is resolved at run time —
  - `literal` — used as-is.
  - `secret` — read from the OS keychain (`keytar`) by ref, prompting once if absent.
  - `prompt` — always ask the human at run time (OTP, ambiguous input).
  - `promptTemplate` — ask the human, then weave the answer into a template
    (every `{}` is replaced; with no `{}` the input is appended). Used e.g. to
    build a magic-link URL from a token the user pastes from their email.
- **`requiresHumanInput: true`** pauses and asks before the step runs; the value
  is masked in the UI and never persisted (passwords, OTP, confirmations).

## Production-style run

```bash
pnpm build      # builds shared, web, then server
pnpm start      # service serves the built UI on :4319
```

## Status

Phase 1 — in progress:
- ✅ Deterministic replay in a headed browser
- ✅ Human-in-the-loop pause/resume (passwords, OTP, prompts)
- ✅ Recorder: capture interactions into the step model (multi-selector,
  password-safe)
- ✅ `assert` steps, segmented (OTP) fills, and `promptTemplate` (magic-link) values
- ✅ Editable JSON in the UI + Copy / Download / Import to save and reload
- ⬜ Persist automations to disk server-side (save/load library)

Phase 2 (agent fallback / self-healing) — not started. The step model already
carries `intent` and multiple `selectors` to support it without re-recording.
See the plan file.
