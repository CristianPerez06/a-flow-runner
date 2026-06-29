/**
 * The typed UI <-> runner message contract.
 *
 * This is the load-bearing boundary: the UI and the runner communicate ONLY
 * through these messages, over a swappable transport (WebSocket today, possibly
 * Electron IPC later). The UI never imports runner internals; the runner never
 * assumes a particular UI. Keep this file transport-free.
 */

import type { Automation, Step } from "./steps.js";

export type RunStatus =
  | "idle"
  | "running"
  | "paused" // waiting on human input
  | "recording" // capturing a new automation
  | "completed"
  | "stopped"
  | "failed";

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

/** What the runner is asking the human for during a pause. */
export interface InputRequest {
  /** Correlates the human's response back to the awaiting step. */
  requestId: string;
  stepId: string;
  /** Human-readable prompt, e.g. "Enter the password for example.com". */
  label: string;
  /** `secret` masks the input in the UI and routes it through the keychain layer. */
  kind: "secret" | "text";
}

/* ------------------------------------------------------------------ */
/* Commands: UI -> runner                                             */
/* ------------------------------------------------------------------ */

export type ClientCommand =
  | { type: "startRun"; automation: Automation }
  | { type: "stopRun" }
  | { type: "resetRun" }
  | { type: "pauseRun" }
  | { type: "resumeRun" }
  /** Human's reply to a prior `inputRequired` event. */
  | { type: "provideInput"; requestId: string; value: string }
  /** Open a headed browser and capture the user's interactions into a step model. */
  | { type: "startRecording"; startUrl: string; name?: string }
  /** Finish recording and return the captured automation. */
  | { type: "stopRecording" };

/* ------------------------------------------------------------------ */
/* Events: runner -> UI                                               */
/* ------------------------------------------------------------------ */

export type ServerEvent =
  | { type: "runStarted"; automationId: string; totalSteps: number }
  | { type: "stepStarted"; stepId: string; index: number }
  | { type: "stepFinished"; stepId: string; index: number; status: StepStatus }
  | { type: "inputRequired"; request: InputRequest }
  | { type: "runFinished"; status: RunStatus }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  /** Full status snapshot, sent on connect and on meaningful transitions. */
  | { type: "state"; status: RunStatus; currentStepIndex: number | null }
  | { type: "recordingStarted"; startUrl: string }
  /** A single interaction was captured; streamed live so the UI can show the flow building. */
  | { type: "recordingStep"; step: Step; index: number }
  /** Recording ended (browser closed or stopped); carries the full captured automation. */
  | { type: "recordingFinished"; automation: Automation };
