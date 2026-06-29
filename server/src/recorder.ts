import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type {
  Automation,
  SelectorCandidate,
  ServerEvent,
  Step,
} from "@a-flow-runner/shared";
import { RECORDER_SCRIPT } from "./recorderScript.js";

const PROFILE_DIR = join(homedir(), ".a-flow-runner", "profile");

type Send = (event: ServerEvent) => void;

/** Shape reported by the injected browser script through the binding. */
interface RawEvent {
  kind: "click" | "fill" | "select";
  selectors: SelectorCandidate[];
  value?: string;
  isPassword?: boolean;
  intent: string;
}

/**
 * Captures a new automation by recording the user's interactions in a headed
 * browser. Reuses the same persistent profile as the runner, so logins carry
 * over. One recording at a time (and never concurrent with a run).
 */
export class RecorderSession {
  private context: BrowserContext | null = null;
  private steps: Step[] = [];
  private name = "Recorded automation";
  private finished = false;
  private seq = 0;

  constructor(private readonly send: Send) {}

  get isActive(): boolean {
    return this.context !== null;
  }

  async start(startUrl: string, name?: string): Promise<void> {
    if (this.isActive) {
      this.send({ type: "log", level: "warn", message: "A recording is already in progress." });
      return;
    }
    let url: string;
    try {
      url = new URL(startUrl).toString();
    } catch {
      this.send({ type: "log", level: "error", message: "A valid start URL is required." });
      return;
    }

    this.steps = [];
    this.finished = false;
    this.seq = 0;
    this.name = name?.trim() || `Recording of ${url}`;

    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
    });

    // The page calls this binding for every captured interaction.
    await this.context.exposeBinding("__a_flow_runner_record", (_source, raw: RawEvent) => {
      this.onEvent(raw);
    });
    await this.context.addInitScript({ content: RECORDER_SCRIPT });

    // Closing the browser window ends the recording.
    this.context.on("close", () => void this.finish());

    this.send({ type: "state", status: "recording", currentStepIndex: null });
    this.send({ type: "recordingStarted", startUrl: url });

    // The initial navigation is the first step.
    this.pushStep({
      id: this.nextId(),
      action: "goto",
      intent: `open ${url}`,
      selectors: [],
      value: { type: "literal", value: url },
    });

    const page = this.context.pages()[0] ?? (await this.context.newPage());
    await page.goto(url).catch((err) => {
      this.send({ type: "log", level: "error", message: `Could not open ${url}: ${String(err)}` });
    });
  }

  /** Stop a recording on request (closing the context triggers `finish`). */
  async stop(): Promise<void> {
    const ctx = this.context;
    if (ctx) await ctx.close().catch(() => {});
    // `finish` runs via the context 'close' handler.
  }

  private onEvent(raw: RawEvent): void {
    const step = this.toStep(raw);
    if (!step) return;

    const last = this.steps[this.steps.length - 1];
    if (shouldReplacePrevious(last, step)) {
      this.steps[this.steps.length - 1] = step;
      this.send({ type: "recordingStep", step, index: this.steps.length - 1 });
      return;
    }
    this.pushStep(step);
  }

  private toStep(raw: RawEvent): Step | null {
    if (raw.kind !== "click" && raw.selectors.length === 0) return null;
    const id = this.nextId();
    switch (raw.kind) {
      case "click":
        if (raw.selectors.length === 0) return null;
        return { id, action: "click", selectors: raw.selectors, intent: raw.intent };
      case "select":
        return {
          id,
          action: "select",
          selectors: raw.selectors,
          intent: raw.intent,
          value: { type: "literal", value: raw.value ?? "" },
        };
      case "fill":
        if (raw.isPassword) {
          // Never capture the secret — pause for the human at replay time instead.
          return { id, action: "fill", selectors: raw.selectors, intent: raw.intent, requiresHumanInput: true };
        }
        return {
          id,
          action: "fill",
          selectors: raw.selectors,
          intent: raw.intent,
          value: { type: "literal", value: raw.value ?? "" },
        };
    }
  }

  private pushStep(step: Step): void {
    this.steps.push(step);
    this.send({ type: "recordingStep", step, index: this.steps.length - 1 });
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.context = null;

    const automation: Automation = {
      id: randomUUID(),
      name: this.name,
      createdAt: new Date().toISOString(),
      steps: this.steps,
    };
    this.send({ type: "recordingFinished", automation });
    this.send({ type: "state", status: "idle", currentStepIndex: null });
  }

  private nextId(): string {
    return `s${++this.seq}`;
  }
}

function sameTarget(a: Step, b: Step): boolean {
  return a.selectors[0]?.selector === b.selectors[0]?.selector;
}

/**
 * Decide whether a newly captured step should replace the previous one rather
 * than append. We collapse when a `fill` lands on the same target as the
 * immediately preceding `fill` (repeated edits) or `click` (the focus-click
 * before typing). A click that opens a popup is followed by a click elsewhere,
 * so it is never collapsed and survives for replay.
 */
export function shouldReplacePrevious(prev: Step | undefined, next: Step): boolean {
  if (!prev || next.action !== "fill") return false;
  if (prev.action !== "fill" && prev.action !== "click") return false;
  return sameTarget(prev, next);
}
