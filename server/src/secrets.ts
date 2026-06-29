/**
 * Just-in-time secret access via the OS keychain.
 *
 * Secrets are never persisted in automations or browser profiles. They are
 * read from the keychain at the moment a step needs them; if absent, the
 * runner falls back to asking the human (handled in the runner, not here).
 *
 * keytar is a native module; we import it lazily so the server can still boot
 * (e.g. for a build/typecheck) on a machine where the native binary is missing.
 */

const SERVICE = "a-flow-runner";

type Keytar = typeof import("keytar");
let keytarPromise: Promise<Keytar | null> | null = null;

async function loadKeytar(): Promise<Keytar | null> {
  if (!keytarPromise) {
    keytarPromise = import("keytar")
      .then((m) => (m.default ?? m) as Keytar)
      .catch((err) => {
        console.warn(`[secrets] keychain unavailable: ${String(err)}`);
        return null;
      });
  }
  return keytarPromise;
}

/** Returns the secret for `ref`, or null if the keychain has none (or is unavailable). */
export async function getSecret(ref: string): Promise<string | null> {
  const keytar = await loadKeytar();
  if (!keytar) return null;
  return keytar.getPassword(SERVICE, ref);
}

/** Stores a secret under `ref` (used when the human supplies one and opts to remember it). */
export async function setSecret(ref: string, value: string): Promise<void> {
  const keytar = await loadKeytar();
  if (!keytar) throw new Error("keychain unavailable");
  await keytar.setPassword(SERVICE, ref, value);
}
