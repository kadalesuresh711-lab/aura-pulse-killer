/**
 * Insta Kill — a server-side stop switch for generation work.
 *
 * A browser refresh does not stop work the server already accepted: prompt
 * writing and panel rendering keep going upstream (burning API quota) while the
 * new page starts a second run. Every unit of work therefore runs inside a run
 * context stamped with the moment its run started, and killing raises an epoch:
 * any work whose run started at or before that epoch is aborted immediately and
 * refuses to make another upstream request.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export class KilledError extends Error {
  constructor(message = "Stopped by Insta Kill — this run was cancelled.") {
    super(message);
    this.name = "KilledError";
  }
}

type RunContext = { runAt: number };

const runStore = new AsyncLocalStorage<RunContext>();

/** Runs started at or before this timestamp are dead. */
let killEpoch = 0;

type LiveRequest = { runAt: number; controller: AbortController };
const live = new Set<LiveRequest>();

export function currentRunAt(): number | undefined {
  return runStore.getStore()?.runAt;
}

export function assertRunAlive(runAt: number | undefined = currentRunAt()): void {
  if (typeof runAt === "number" && runAt <= killEpoch) throw new KilledError();
}

/** Wraps one server handler so everything it awaits belongs to the same run. */
export function withRun<T>(runAt: number | undefined, fn: () => Promise<T>): Promise<T> {
  const at = typeof runAt === "number" && runAt > 0 ? runAt : Date.now();
  assertRunAlive(at);
  return runStore.run({ runAt: at }, fn);
}

/**
 * A signal for one upstream request: aborts on its own timeout, and instantly
 * when the run it belongs to is killed. Throws before the request is even made
 * if the run is already dead.
 */
export function killableSignal(timeoutMs: number): { signal: AbortSignal; release: () => void } {
  assertRunAlive();
  const runAt = currentRunAt() ?? Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  const entry: LiveRequest = { runAt, controller };
  live.add(entry);

  const timeout = AbortSignal.timeout(timeoutMs);
  const onTimeout = () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  if (timeout.aborted) onTimeout();
  else timeout.addEventListener("abort", onTimeout, { once: true });

  return {
    signal: controller.signal,
    release: () => {
      timeout.removeEventListener("abort", onTimeout);
      live.delete(entry);
    },
  };
}

/** Kills every run started up to now. Returns how many requests were aborted. */
export function killAllRuns(): { killedAt: number; aborted: number } {
  killEpoch = Date.now();
  let aborted = 0;
  for (const entry of [...live]) {
    if (entry.runAt <= killEpoch) {
      live.delete(entry);
      aborted++;
      try {
        entry.controller.abort(new KilledError());
      } catch {
        /* already gone */
      }
    }
  }
  console.log(`[kill] insta kill at ${killEpoch}: aborted ${aborted} in-flight request(s)`);
  return { killedAt: killEpoch, aborted };
}

export function liveRequestCount(): number {
  return live.size;
}
