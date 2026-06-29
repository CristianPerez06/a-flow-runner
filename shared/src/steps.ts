/**
 * The automation step model — the core data structure of a-flow-runner.
 *
 * A step carries enough to (a) replay deterministically today and (b) be
 * "healed" by an agent tomorrow without re-recording:
 *   - multiple `selectors` give replay resilience and the future agent options
 *   - `intent` is ignored by deterministic replay but consumed by the agent
 *     fallback to understand what the step was trying to achieve
 *   - `value` may reference a secret or a human prompt instead of a literal,
 *     which drives the just-in-time / human-in-the-loop flow
 */

export type StepAction =
  | "goto"
  | "click"
  | "fill"
  | "select"
  | "waitFor"
  | "assert";

/** A selector candidate. Ordered best-first; replay tries them in turn. */
export interface SelectorCandidate {
  /** Playwright selector engine + value, e.g. `role=button[name="Submit"]`, `[data-test=submit]`, `text=Log in`. */
  selector: string;
  /** Rough provenance, used for ranking/diagnostics (data-* > role > text > css). */
  kind: "data" | "role" | "text" | "css" | "other";
}

/** Resolve a step's value at run time. */
export type StepValue =
  /** A literal string typed/selected as-is. */
  | { type: "literal"; value: string }
  /** Pull from the OS keychain (or prompt-once) by reference; never persisted in the step. */
  | { type: "secret"; ref: string }
  /** Always ask the human at run time (OTP, ambiguous input). */
  | { type: "prompt"; label: string }
  /**
   * Ask the human, then weave their answer into `template`: every `{}`
   * placeholder is replaced with the (trimmed) input; if there's no `{}`,
   * the input is appended as a suffix. Used e.g. to build a magic-link URL
   * from a token the user pastes out of their email.
   */
  | { type: "promptTemplate"; label: string; template: string };

export interface Step {
  id: string;
  action: StepAction;
  /** For `goto`: the URL lives here. For others, the target element. */
  selectors: SelectorCandidate[];
  /** Present for `fill`/`select`/`goto`-style actions; absent for pure `click`/`waitFor`. */
  value?: StepValue;
  /** Natural-language goal of the step, e.g. "click the Submit button". Consumed by the agent fallback. */
  intent: string;
  /** When true, pause and ask the human before executing (passwords, OTP, CAPTCHA, a choice). */
  requiresHumanInput?: boolean;
  /**
   * For `fill` into a segmented input — e.g. a one-box-per-digit OTP field.
   * The value is resolved ONCE (a single prompt when {@link requiresHumanInput}
   * is set), then typed one character per target, in order. Each entry is a
   * single target with its own fallback candidates.
   */
  segments?: SelectorCandidate[][];
}

export interface Automation {
  id: string;
  name: string;
  /** ISO-8601. */
  createdAt: string;
  steps: Step[];
}
