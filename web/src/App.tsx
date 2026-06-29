import { useEffect, useMemo, useRef, useState } from "react";
import type { Automation, Step, StepStatus } from "@a-flow-runner/shared";
import { useRunner } from "./useRunner.js";

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "·",
  running: "▶",
  passed: "✓",
  failed: "✗",
  skipped: "–",
};

/** A blank automation — the starting point until the user records, imports, or types one. */
function emptyAutomation(): Automation {
  return { id: "", name: "Untitled automation", createdAt: "", steps: [] };
}

export function App() {
  const runner = useRunner();
  const [startUrl, setStartUrl] = useState("https://the-internet.herokuapp.com/login");
  // The automation currently shown/run: a recording, an import, or hand-edited JSON.
  const [automation, setAutomation] = useState<Automation>(emptyAutomation);
  const [source, setSource] = useState<string>("empty");

  // Reset: stop any run, wipe the log/statuses, and clear the loaded automation.
  const resetAll = () => {
    runner.send({ type: "resetRun" });
    runner.clearLocal();
    setAutomation(emptyAutomation());
    setSource("empty");
  };

  // When a recording finishes, make it the active automation.
  useEffect(() => {
    if (runner.recordedAutomation) {
      setAutomation(runner.recordedAutomation);
      setSource("recorded");
    }
  }, [runner.recordedAutomation]);

  const recording = runner.status === "recording";
  const running = runner.status === "running" || runner.status === "paused";
  const busy = recording || running;

  return (
    <div className="app">
      <header className="topbar">
        <h1>a-flow-runner</h1>
        <div className="badges">
          <span className={`badge ${runner.connected ? "ok" : "off"}`}>
            {runner.connected ? "connected" : "disconnected"}
          </span>
          <span className={`badge status-${runner.status}`}>{runner.status}</span>
        </div>
      </header>

      <section className="panel record">
        <h2>Record</h2>
        {recording ? (
          <div className="row">
            <span className="recording-dot" /> Recording — interact in the browser window, then
            <button onClick={() => runner.send({ type: "stopRecording" })}>Stop recording</button>
          </div>
        ) : (
          <div className="row">
            <input
              type="url"
              value={startUrl}
              placeholder="https://example.com"
              onChange={(e) => setStartUrl(e.target.value)}
            />
            <button
              onClick={() => runner.send({ type: "startRecording", startUrl })}
              disabled={busy || !runner.connected || !startUrl.trim()}
            >
              Record
            </button>
          </div>
        )}
        {recording && <StepList steps={runner.recordingSteps} />}
      </section>

      <AutomationPanel
        automation={automation}
        onImport={(a) => {
          setAutomation(a);
          setSource("imported");
        }}
        onEdit={(a) => {
          setAutomation(a);
          setSource("edited");
        }}
        onReset={resetAll}
        disabled={busy}
      />

      <section className="panel">
        <div className="row spaced">
          <h2>{automation.name}</h2>
          <span className="muted">{source}</span>
        </div>

        <div className="controls">
          <button
            onClick={() => runner.send({ type: "startRun", automation })}
            disabled={busy || !runner.connected || automation.steps.length === 0}
          >
            Run
          </button>
          {runner.status === "running" && <button onClick={() => runner.send({ type: "pauseRun" })}>Pause</button>}
          {runner.status === "paused" && !runner.inputRequest && (
            <button onClick={() => runner.send({ type: "resumeRun" })}>Resume</button>
          )}
          <button onClick={() => runner.send({ type: "stopRun" })} disabled={!running}>
            Stop
          </button>
        </div>

        <StepList
          steps={automation.steps}
          stepStatuses={runner.stepStatuses}
          activeIndex={running ? runner.currentStepIndex : null}
        />
      </section>

      <section className="panel log">
        <h2>Log</h2>
        <pre>
          {runner.log.map((l, i) => (
            <div key={i} className={`line ${l.level}`}>
              {l.message}
            </div>
          ))}
        </pre>
      </section>

      {runner.inputRequest && (
        <InputModal
          label={runner.inputRequest.label}
          secret={runner.inputRequest.kind === "secret"}
          onSubmit={(value) => runner.send({ type: "provideInput", requestId: runner.inputRequest!.requestId, value })}
        />
      )}
    </div>
  );
}

/** Parse + shape-check a JSON string into an Automation, or throw with a friendly message. */
function parseAutomation(text: string): Automation {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.name !== "string" || !Array.isArray(parsed.steps)) {
    throw new Error("not a valid automation (need name + steps[])");
  }
  return parsed as Automation;
}

function AutomationPanel(props: {
  automation: Automation;
  onImport: (a: Automation) => void;
  onEdit: (a: Automation) => void;
  onReset: () => void;
  disabled: boolean;
}) {
  const json = useMemo(() => JSON.stringify(props.automation, null, 2), [props.automation]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The editor's working text. Kept local so a half-typed (invalid) edit isn't lost.
  const [draft, setDraft] = useState(json);
  // The last JSON we pushed upstream; lets us tell our own echo apart from an
  // external change (import, record, reset) so we only refresh the editor for the latter.
  const lastEmitted = useRef(json);
  useEffect(() => {
    if (json === lastEmitted.current) return; // our own edit coming back — keep the user's text
    setDraft(json);
    setError(null);
    lastEmitted.current = json;
  }, [json]);

  const edit = (text: string) => {
    setDraft(text);
    try {
      const parsed = parseAutomation(text);
      setError(null);
      lastEmitted.current = JSON.stringify(parsed, null, 2);
      props.onEdit(parsed);
    } catch (e) {
      // Hold the invalid text and surface the problem; don't push it upstream.
      setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy to clipboard.");
    }
  };

  const download = () => {
    const safeName = props.automation.name.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "automation";
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = (file: File) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        props.onImport(parseAutomation(String(reader.result)));
      } catch (e) {
        setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    reader.readAsText(file);
  };

  return (
    <section className="panel">
      <div className="row spaced">
        <h2>Automation (JSON)</h2>
        <div className="row">
          <button onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
          <button onClick={download}>Download .json</button>
          <button onClick={() => fileInput.current?.click()} disabled={props.disabled}>
            Import…
          </button>
          <button className="danger" onClick={props.onReset} disabled={props.disabled}>
            Reset
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      {error && <div className="line error">{error}</div>}
      <textarea
        className={`json ${error ? "invalid" : ""}`}
        value={draft}
        onChange={(e) => edit(e.target.value)}
        disabled={props.disabled}
        spellCheck={false}
      />
      <p className="muted">
        {props.automation.steps.length} steps. Edit the JSON directly to tweak values or selectors — valid
        changes apply to the next run. Copy or download to save it; Import a saved .json to run it later.
      </p>
    </section>
  );
}

/** A short, human-readable summary of a step's value for the steps list. */
function describeValue(step: Step): string | null {
  if (step.segments?.length) return `${step.segments.length}-part input`;
  const v = step.value;
  if (!v) return null;
  switch (v.type) {
    case "literal":
      return step.requiresHumanInput ? "•••••" : v.value;
    case "secret":
      return `secret: ${v.ref}`;
    case "prompt":
      return "prompt";
    case "promptTemplate":
      return "prompt → url";
  }
}

function StepList(props: {
  steps: Step[];
  stepStatuses?: Record<string, StepStatus>;
  activeIndex?: number | null;
}) {
  if (props.steps.length === 0) return <p className="muted">No steps yet.</p>;
  return (
    <ol className="steps">
      {props.steps.map((step, i) => {
        const st = props.stepStatuses?.[step.id] ?? "pending";
        const active = props.activeIndex === i;
        const value = describeValue(step);
        return (
          <li key={step.id} className={`step ${st} ${active ? "active" : ""}`}>
            <span className={`mark ${st}`}>{STATUS_LABEL[st]}</span>
            <span className="intent">{step.intent}</span>
            {value !== null && <span className="value" title={value}>{value}</span>}
            {step.requiresHumanInput && <span className="hitl">human</span>}
            <span className="action">{step.action}</span>
          </li>
        );
      })}
    </ol>
  );
}

function InputModal(props: { label: string; secret: boolean; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit(value);
          setValue("");
        }}
      >
        <label>{props.label}</label>
        <input
          autoFocus
          type={props.secret ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit">Continue</button>
      </form>
    </div>
  );
}
