import type { ResyncRequest, ServerMessage, Snapshot } from "./protocol";
import type { RepoStore } from "./store";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "stopped";

/**
 * Consecutive failed reconnects (~23s of backoff) after which we show
 * "stopped" rather than "reconnecting". Orion's auth token and cookie now
 * persist across restarts, so this is just a UI cue that the wait has gone
 * on a while — reconnecting keeps retrying underneath, and a restarted
 * Orion picks the page back up as soon as it's listening again.
 */
export const STOPPED_AFTER_FAILURES = 8;

const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 5000;

/** ws(s)://<same host>/ws, carrying the page's ?t= token if present. */
export function wsUrlFromLocation(loc: Pick<Location, "protocol" | "host" | "search">): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(loc.search).get("t");
  const query = token ? `?t=${encodeURIComponent(token)}` : "";
  return `${proto}//${loc.host}/ws${query}`;
}

/**
 * Identifies which repo a snapshot describes, so a reconnect that lands on a
 * different repo (orion restarted serving repo B where it used to serve
 * repo A, on the same port) can be told apart from one that lands back on
 * the same repo. The main worktree's path is stable across restarts of the
 * same repo; `repo.name` is a fallback for the case no worktree is main.
 */
export function repoIdentity(s: Pick<Snapshot, "repo" | "worktrees">): string {
  return s.worktrees.find((w) => w.isMain)?.path ?? s.repo.name;
}

/** Delay before reconnect attempt `attempt` (0-based): 250ms doubling, capped at 5s. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 16));
}

/** Status to show after `failures` consecutive closes without a successful open. */
export function statusAfterClose(failures: number): ConnectionStatus {
  return failures >= STOPPED_AFTER_FAILURES ? "stopped" : "reconnecting";
}

/**
 * Keeps a WebSocket open to the Orion server and feeds every message into
 * `store`. Retries forever (quietly past "stopped") since the server may
 * simply have restarted with the same persistent token. Returns a function
 * that closes the socket and stops reconnecting.
 */
export function connect(
  store: RepoStore,
  opts?: {
    url?: string;
    onStatus?: (s: ConnectionStatus) => void;
    onReconnect?: () => void;
    onSnapshot?: (s: Snapshot) => void;
  },
): () => void {
  const url = opts?.url ?? wsUrlFromLocation(window.location);
  const onStatus = opts?.onStatus ?? (() => {});
  const onReconnect = opts?.onReconnect ?? (() => {});
  const onSnapshot = opts?.onSnapshot ?? (() => {});
  let attempt = 0;
  let stopped = false;
  let hadOpenSocket = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;

  const open = (): void => {
    let awaitingSnapshot = false;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      // Only a genuine reconnect (a prior socket was open, then closed) —
      // not the very first connect of this page load.
      if (hadOpenSocket) onReconnect();
      hadOpenSocket = true;
      onStatus("open");
    };
    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type !== "snapshot" && msg.type !== "patch") return;
      if (msg.type === "snapshot") {
        awaitingSnapshot = false;
        // Before applying: a reload triggered here (a different repo than
        // this page started with) replaces the page before the store, and
        // any rendered UI, ever pick up the new repo's data.
        onSnapshot(msg);
      }
      const res = store.apply(msg);
      if (!res.ok && !awaitingSnapshot) {
        awaitingSnapshot = true;
        const req: ResyncRequest = { type: "resync" };
        ws.send(JSON.stringify(req));
      }
    };
    ws.onclose = () => {
      if (stopped || socket !== ws) return;
      timer = setTimeout(open, backoffMs(attempt));
      attempt++;
      onStatus(statusAfterClose(attempt));
    };
  };

  onStatus("connecting");
  open();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    socket?.close();
  };
}
