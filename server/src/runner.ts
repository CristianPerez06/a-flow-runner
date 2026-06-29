import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page, type Locator, type Download } from "playwright";
import type {
  Automation,
  ClientCommand,
  RunStatus,
  ServerEvent,
  Step,
  StepStatus,
} from "@a-flow-runner/shared";
import { getSecret } from "./secrets.js";

const PROFILE_DIR = join(homedir(), ".a-flow-runner", "profile");
const DOWNLOADS_DIR = join(homedir(), "Downloads");
const STEP_TIMEOUT_MS = 15_000;
// Pace actions so an attended user can follow along in the headed browser.
const SLOW_MO_MS = 350;

type Send = (event: ServerEvent) => void;

/** A pending human-input request: its resolver is called when the UI replies. */
interface PendingInput {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

/**
 * Owns a single (one-at-a-time) automation run. Transport-agnostic: it receives
 * decoded {@link ClientCommand}s and emits {@link ServerEvent}s through `send`.
 */
export class RunnerSession {
  private status: RunStatus = "idle";
  private currentStepIndex: number | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private aborted = false;

  private pendingInputs = new Map<string, PendingInput>();
  private resumeWaiters: Array<() => void> = [];
  private requestSeq = 0;
  /** Downloads triggered during the run; awaited before the browser closes. */
  private pendingDownloads: Promise<void>[] = [];

  constructor(private readonly send: Send) {}

  get isActive(): boolean {
    return this.status === "running" || this.status === "paused";
  }

  /** Push the current status snapshot (also sent to freshly-connected clients). */
  snapshot(): void {
    this.send({ type: "state", status: this.status, currentStepIndex: this.currentStepIndex });
  }

  async handleCommand(cmd: ClientCommand): Promise<void> {
    switch (cmd.type) {
      case "startRun":
        await this.startRun(cmd.automation);
        break;
      case "stopRun":
        await this.stop("stopped");
        break;
      case "resetRun":
        await this.stop("stopped");
        this.setStatus("idle");
        this.currentStepIndex = null;
        this.snapshot();
        break;
      case "pauseRun":
        if (this.status === "running") this.setStatus("paused");
        break;
      case "resumeRun":
        if (this.status === "paused") {
          this.setStatus("running");
          this.resumeWaiters.splice(0).forEach((w) => w());
        }
        break;
      case "provideInput": {
        const pending = this.pendingInputs.get(cmd.requestId);
        if (pending) {
          this.pendingInputs.delete(cmd.requestId);
          pending.resolve(cmd.value);
        }
        break;
      }
    }
  }

  private setStatus(status: RunStatus): void {
    this.status = status;
    this.snapshot();
  }

  private async startRun(automation: Automation): Promise<void> {
    if (this.status === "running" || this.status === "paused") {
      this.log("warn", "A run is already in progress.");
      return;
    }
    // A previous successful run may have left its window open for inspection;
    // close it before launching a fresh one so windows don't pile up.
    if (this.context) await this.closeBrowser();
    this.aborted = false;
    this.currentStepIndex = null;
    this.pendingDownloads = [];
    this.setStatus("running");
    this.send({ type: "runStarted", automationId: automation.id, totalSteps: automation.steps.length });
    this.log("info", `Launching browser for "${automation.name}" (${automation.steps.length} steps)…`);

    try {
      this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: null,
        slowMo: SLOW_MO_MS,
        acceptDownloads: true,
      });
      // If the user closes the browser window mid-run, stop cleanly instead of crashing.
      this.context.on("close", () => {
        this.aborted = true;
      });
      // Save any file the page downloads (e.g. the generated invoice PDF).
      this.context.on("page", (p) => this.watchDownloads(p));
      const page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page = page;
      this.watchDownloads(page);
      await page.bringToFront().catch(() => {});

      for (let i = 0; i < automation.steps.length; i++) {
        if (this.aborted || page.isClosed()) break;
        await this.waitWhilePaused();
        if (this.aborted || page.isClosed()) break;

        this.currentStepIndex = i;
        const step = automation.steps[i]!;
        this.send({ type: "stepStarted", stepId: step.id, index: i });
        this.log("info", `Step ${i + 1}/${automation.steps.length}: ${step.intent}`);

        const startedAt = Date.now();
        let status: StepStatus = "passed";
        try {
          await this.executeStep(step, page);
        } catch (err) {
          // A closed page/context means the run was aborted, not that the step is bad.
          if (page.isClosed() || isClosedError(err)) {
            this.log("warn", `Step ${i + 1} skipped — browser was closed.`);
            this.send({ type: "stepFinished", stepId: step.id, index: i, status: "skipped" });
            break;
          }
          status = "failed";
          this.log("error", `Step ${i + 1} failed: ${errMessage(err)}`);
        }
        if (status === "passed") {
          this.log("info", `   ✓ done (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
        }
        this.send({ type: "stepFinished", stepId: step.id, index: i, status });

        if (status === "failed") {
          // Phase 1: a failed step ends the run. Phase 2 will hand off to the agent here.
          await this.finish("failed");
          return;
        }
      }

      if (!this.aborted && !page.isClosed()) {
        // A download triggered by the final click fires just after it resolves;
        // give it a moment to register before we tear the browser down.
        await page.waitForTimeout(1500).catch(() => {});
      }
      await this.finish(this.aborted || page.isClosed() ? "stopped" : "completed");
    } catch (err) {
      if (isClosedError(err)) {
        await this.finish("stopped");
      } else {
        this.log("error", `Run aborted: ${errMessage(err)}`);
        await this.finish("failed");
      }
    }
  }

  private async executeStep(step: Step, page: Page): Promise<void> {
    const value = await this.resolveValue(step);

    switch (step.action) {
      case "goto": {
        const url = value ?? step.selectors[0]?.selector;
        if (!url) throw new Error("goto step has no URL");
        this.log("info", `   → navigating to ${url}`);
        await page.goto(url, { timeout: STEP_TIMEOUT_MS });
        return;
      }
      case "click": {
        // `noWaitAfter` so a click that triggers a download/navigation doesn't block
        // the step waiting for it to "settle" (that was the 45s hang on Download).
        // Downloads are still captured by the persistent download handler.
        const sel = await this.onFirstSelector(step, page, (loc) =>
          loc.click({ timeout: STEP_TIMEOUT_MS, noWaitAfter: true }),
        );
        this.log("info", `   → clicked  ${sel}`);
        return;
      }
      case "fill": {
        if (step.segments?.length) {
          await this.fillSegments(step, page, value ?? "");
          this.log("info", `   → filled  ${step.segments.length} segment(s) with ${this.maskValue(step, value)}`);
          return;
        }
        const sel = await this.onFirstSelector(step, page, (loc) => loc.fill(value ?? "", { timeout: STEP_TIMEOUT_MS }));
        this.log("info", `   → filled  ${sel}  with ${this.maskValue(step, value)}`);
        return;
      }
      case "select": {
        const sel = await this.onFirstSelector(step, page, async (loc) => {
          await loc.selectOption(value ?? "", { timeout: STEP_TIMEOUT_MS });
        });
        this.log("info", `   → selected ${JSON.stringify(value ?? "")} in ${sel}`);
        return;
      }
      case "waitFor": {
        const sel = await this.onFirstSelector(step, page, (loc) => loc.waitFor({ timeout: STEP_TIMEOUT_MS }));
        this.log("info", `   → waited for ${sel}`);
        return;
      }
      case "assert": {
        const sel = await this.onFirstSelector(step, page, (loc) =>
          loc.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS }),
        );
        this.log("info", `   → asserted ${sel} is visible`);
        return;
      }
    }
  }

  /** Mask secret/human-input values; show normal values (truncated). */
  private maskValue(step: Step, value: string | undefined): string {
    if (step.requiresHumanInput || step.value?.type === "secret") return "••••• (hidden)";
    const v = value ?? "";
    return v.length > 40 ? JSON.stringify(v.slice(0, 40)) + "…" : JSON.stringify(v);
  }

  /**
   * Try each selector candidate in order; first one that succeeds wins. Flashes
   * a highlight on the matched element so the user can see what's being acted on.
   * Returns the selector that worked (for logging).
   */
  private async onFirstSelector(step: Step, page: Page, run: (loc: Locator) => Promise<void>): Promise<string> {
    if (step.selectors.length === 0) throw new Error(`${step.action} step has no selectors`);
    let lastErr: unknown;
    for (const cand of step.selectors) {
      try {
        const loc = page.locator(cand.selector).first();
        await this.flash(loc);
        await run(loc);
        return cand.selector;
      } catch (err) {
        if (isClosedError(err)) throw err; // don't try other selectors on a dead page
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("no selector matched");
  }

  /**
   * Fill a segmented input (one element per character, e.g. an OTP field).
   * Types the i-th character of `value` into the i-th segment, trying each
   * segment's selector candidates in order. A missing character clears its box.
   */
  private async fillSegments(step: Step, page: Page, value: string): Promise<void> {
    const segments = step.segments ?? [];
    for (let i = 0; i < segments.length; i++) {
      const candidates = segments[i]!;
      const ch = value[i] ?? "";
      let lastErr: unknown;
      let filled = false;
      for (const cand of candidates) {
        try {
          const loc = page.locator(cand.selector).first();
          await this.flash(loc);
          await loc.fill(ch, { timeout: STEP_TIMEOUT_MS });
          filled = true;
          break;
        } catch (err) {
          if (isClosedError(err)) throw err;
          lastErr = err;
        }
      }
      if (!filled) throw lastErr ?? new Error(`no selector matched for segment ${i + 1}`);
    }
  }

  /** Briefly outline the target element in the headed browser (best-effort). */
  private async flash(loc: Locator): Promise<void> {
    try {
      await loc.evaluate((el: any) => {
        const s = el && el.style;
        if (!s) return;
        const prev = s.outline;
        s.outline = "3px solid #f59e0b";
        s.outlineOffset = "2px";
        setTimeout(() => {
          s.outline = prev;
        }, 800);
      });
    } catch {
      /* element not present yet (e.g. waitFor) — skip the highlight */
    }
  }

  private watchDownloads(page: Page): void {
    page.on("download", (download) => {
      this.log("info", `   ⬇ download started ("${download.suggestedFilename()}") — generating/saving…`);
      this.pendingDownloads.push(this.saveDownload(download));
    });
  }

  private async saveDownload(download: Download): Promise<void> {
    const name = download.suggestedFilename() || "a-flow-runner-download";
    const dest = join(DOWNLOADS_DIR, name);
    const startedAt = Date.now();
    try {
      await download.saveAs(dest);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.log("info", `   ⬇ saved "${name}" → ${dest} (took ${secs}s)`);
    } catch (err) {
      this.log("error", `   download failed: ${errMessage(err)}`);
    }
  }

  /**
   * Resolve a step's value, pausing for the human when required:
   *  - `requiresHumanInput` always prompts (passwords, OTP, confirmations)
   *  - a `prompt` value always prompts
   *  - a `secret` value is read from the keychain, falling back to a prompt
   */
  private async resolveValue(step: Step): Promise<string | undefined> {
    const v = step.value;

    if (step.requiresHumanInput) {
      const label = v?.type === "prompt" ? v.label : `Input needed for: ${step.intent}`;
      const kind = v?.type === "secret" || v?.type === "prompt" ? "secret" : "text";
      return this.requestInput(step.id, label, kind);
    }
    if (!v) return undefined;

    switch (v.type) {
      case "literal":
        return v.value;
      case "prompt":
        return this.requestInput(step.id, v.label, "text");
      case "promptTemplate": {
        const input = (await this.requestInput(step.id, v.label, "text")).trim();
        return v.template.includes("{}") ? v.template.split("{}").join(input) : v.template + input;
      }
      case "secret": {
        const fromKeychain = await getSecret(v.ref);
        if (fromKeychain !== null) return fromKeychain;
        return this.requestInput(step.id, `Enter secret "${v.ref}"`, "secret");
      }
    }
  }

  /** Emit an inputRequired event and await the UI's reply (or abort). */
  private requestInput(stepId: string, label: string, kind: "secret" | "text"): Promise<string> {
    const requestId = `req-${++this.requestSeq}`;
    this.send({ type: "inputRequired", request: { requestId, stepId, label, kind } });
    this.setStatus("paused");
    return new Promise<string>((resolve, reject) => {
      this.pendingInputs.set(requestId, {
        resolve: (value) => {
          this.setStatus("running");
          resolve(value);
        },
        reject,
      });
    });
  }

  private waitWhilePaused(): Promise<void> {
    if (this.status !== "paused") return Promise.resolve();
    return new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }

  private async finish(status: RunStatus): Promise<void> {
    // Let downloads finish writing before we tear down the browser.
    if (this.pendingDownloads.length) {
      this.log("info", `Waiting for ${this.pendingDownloads.length} download(s) to save…`);
      await Promise.allSettled(this.pendingDownloads);
      this.pendingDownloads = [];
    }
    // Leave the window open after a clean finish so the user can inspect/test
    // the final page. Stops, failures, and aborts still tear the browser down.
    // A lingering window is closed when the next run starts (see startRun).
    if (status !== "completed") await this.closeBrowser();
    this.currentStepIndex = null;
    this.setStatus(status);
    this.send({ type: "runFinished", status });
  }

  private async stop(_status: RunStatus): Promise<void> {
    this.aborted = true;
    // Reject any awaiting input so the run loop can unwind.
    for (const [, p] of this.pendingInputs) p.reject(new Error("run stopped"));
    this.pendingInputs.clear();
    this.resumeWaiters.splice(0).forEach((w) => w());
    await this.closeBrowser();
  }

  private async closeBrowser(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.send({ type: "log", level, message });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when an error is caused by the browser/page/context having been closed. */
function isClosedError(err: unknown): boolean {
  const m = errMessage(err);
  return (
    m.includes("Target page, context or browser has been closed") ||
    m.includes("Target closed") ||
    m.includes("has been closed") ||
    m.includes("Browser has been closed")
  );
}
