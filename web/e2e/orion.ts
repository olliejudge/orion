import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// orion prints its tokenised URL on stdout; this is the first line that matches.
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/;

export interface Orion {
  /** The tokenised URL orion printed. */
  url: string;
  /** Main worktree of the synthetic demo repo orion is serving. */
  demoDir: string;
  /** Stops orion and deletes the demo repo (and its sibling `.wt` dir). */
  stop: () => Promise<void>;
}

/** Asks the OS for a free TCP port on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

/** Resolves with the first URL orion prints, rejecting if it fails to start, exits or stays silent. */
function waitForUrl(proc: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    let found = false;
    const timer = setTimeout(() => {
      reject(new Error(`orion printed no URL within ${timeoutMs} ms. Output so far:\n${seen}`));
    }, timeoutMs);
    // Keep draining stdout after the match so orion never blocks on a full pipe.
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (found) return;
      seen += chunk.toString();
      const m = URL_PATTERN.exec(seen);
      if (m) {
        found = true;
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (!found) reject(new Error(`orion exited (code ${code}) before printing its URL:\n${seen}`));
    });
  });
}

function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) {
      resolve();
      return;
    }
    const kill = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    proc.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    proc.kill("SIGINT");
  });
}

/**
 * Builds a fresh synthetic demo repo (`scripts/demo --once`) in a temp dir and
 * starts `bin/orion` on it. Whatever fails, nothing is left running or on disk.
 */
export async function startOrion(): Promise<Orion> {
  const bin = path.join(repoRoot, "bin", "orion");
  if (!existsSync(bin)) {
    throw new Error(`${bin} does not exist. Run \`make build\` in ${repoRoot} first.`);
  }
  const work = mkdtempSync(path.join(tmpdir(), "orion-e2e-"));
  let proc: ChildProcess | undefined;
  const stop = async (): Promise<void> => {
    if (proc) await stopProcess(proc);
    rmSync(work, { recursive: true, force: true });
  };
  try {
    // The demo also creates a sibling `nebula.wt`, so removing `work` cleans up both.
    const demoDir = path.join(work, "nebula");
    execFileSync("go", ["run", "./scripts/demo", "--once", "--dir", demoDir, "--seed", "1"], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 120_000,
    });
    const port = await freePort();
    // Orion persists its auth token under the OS config dir (see
    // cmd/orion/main.go's tokenPath, derived from os.UserConfigDir()), which
    // reads $HOME on macOS and $XDG_CONFIG_HOME (falling back to $HOME) on
    // Linux. Point both at a directory inside this run's temp work dir so
    // the e2e suite never creates or reads the developer's real
    // ~/Library/Application Support/orion/token (or $XDG_CONFIG_HOME
    // equivalent).
    const fakeHome = path.join(work, "home");
    mkdirSync(fakeHome, { recursive: true });
    proc = spawn(bin, [demoDir, "--no-open", "--port", String(port)], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: fakeHome },
    });
    const url = await waitForUrl(proc, 20_000);
    return { url, demoDir, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
