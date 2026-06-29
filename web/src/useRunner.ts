import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Automation,
  ClientCommand,
  InputRequest,
  RunStatus,
  ServerEvent,
  Step,
  StepStatus,
} from "@a-flow-runner/shared";

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
}

export interface RunnerState {
  connected: boolean;
  status: RunStatus;
  currentStepIndex: number | null;
  stepStatuses: Record<string, StepStatus>;
  log: LogLine[];
  /** The outstanding human-input request, if the runner is waiting on us. */
  inputRequest: InputRequest | null;
  /** Steps captured so far in the current recording (live). */
  recordingSteps: Step[];
  /** The most recently finished recording, ready to run. */
  recordedAutomation: Automation | null;
  send: (cmd: ClientCommand) => void;
  /** Wipe client-only UI state (log, step statuses, pending input, current step). */
  clearLocal: () => void;
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export function useRunner(): RunnerState {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [currentStepIndex, setCurrentStepIndex] = useState<number | null>(null);
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>({});
  const [log, setLog] = useState<LogLine[]>([]);
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null);
  const [recordingSteps, setRecordingSteps] = useState<Step[]>([]);
  const [recordedAutomation, setRecordedAutomation] = useState<Automation | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (ev) => {
        let event: ServerEvent;
        try {
          event = JSON.parse(ev.data as string) as ServerEvent;
        } catch {
          return;
        }
        applyEvent(event);
      };
    };

    const applyEvent = (event: ServerEvent) => {
      switch (event.type) {
        case "state":
          setStatus(event.status);
          setCurrentStepIndex(event.currentStepIndex);
          break;
        case "runStarted":
          setStepStatuses({});
          setInputRequest(null);
          setLog((l) => [...l, { level: "info", message: `Run started (${event.totalSteps} steps).` }]);
          break;
        case "stepStarted":
          setCurrentStepIndex(event.index);
          setStepStatuses((s) => ({ ...s, [event.stepId]: "running" }));
          break;
        case "stepFinished":
          setStepStatuses((s) => ({ ...s, [event.stepId]: event.status }));
          break;
        case "inputRequired":
          setInputRequest(event.request);
          break;
        case "runFinished":
          setInputRequest(null);
          setLog((l) => [...l, { level: "info", message: `Run finished: ${event.status}.` }]);
          break;
        case "log":
          setLog((l) => [...l, { level: event.level, message: event.message }]);
          break;
        case "recordingStarted":
          setRecordingSteps([]);
          setRecordedAutomation(null);
          setLog((l) => [...l, { level: "info", message: `Recording started at ${event.startUrl}.` }]);
          break;
        case "recordingStep":
          setRecordingSteps((prev) => {
            const next = prev.slice();
            next[event.index] = event.step;
            return next;
          });
          break;
        case "recordingFinished":
          setRecordedAutomation(event.automation);
          setLog((l) => [
            ...l,
            { level: "info", message: `Recording finished: ${event.automation.steps.length} steps.` },
          ]);
          break;
      }
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((cmd: ClientCommand) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
  }, []);

  const clearLocal = useCallback(() => {
    setLog([]);
    setStepStatuses({});
    setInputRequest(null);
    setCurrentStepIndex(null);
  }, []);

  // Clear a satisfied input request locally once we answer.
  useEffect(() => {
    if (status !== "paused") setInputRequest(null);
  }, [status]);

  return {
    connected,
    status,
    currentStepIndex,
    stepStatuses,
    log,
    inputRequest,
    recordingSteps,
    recordedAutomation,
    send,
    clearLocal,
  };
}
