import type { ResyncRequest, ServerMessage } from "./protocol";
import type { RepoStore } from "./store";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 5000;

/** ws(s)://<same host>/ws, carrying the page's ?t= token if present. */
export function wsUrlFromLocation(loc: Pick<Location, "protocol" | "host" | "search">): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(loc.search).get("t");
  const query = token ? `?t=${encodeURIComponent(token)}` : "";
  return `${proto}//${loc.host}/ws${query}`;
}

/** Delay before reconnect attempt `attempt` (0-based): 250ms doubling, capped at 5s. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 16));
}

/**
 * Keeps a WebSocket open to the Orion server and feeds every message into
 * `store`. Returns a function that closes the socket and stops reconnecting.
 */
export function connect(
  store: RepoStore,
  opts?: { url?: string; onStatus?: (s: ConnectionStatus) => void },
): () => void {
  const url = opts?.url ?? wsUrlFromLocation(window.location);
  const onStatus = opts?.onStatus ?? (() => {});
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;

  const open = (): void => {
    let awaitingSnapshot = false;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
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
      if (msg.type === "snapshot") awaitingSnapshot = false;
      const res = store.apply(msg);
      if (!res.ok && !awaitingSnapshot) {
        awaitingSnapshot = true;
        const req: ResyncRequest = { type: "resync" };
        ws.send(JSON.stringify(req));
      }
    };
    ws.onclose = () => {
      if (stopped || socket !== ws) return;
      onStatus("reconnecting");
      timer = setTimeout(open, backoffMs(attempt));
      attempt++;
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
