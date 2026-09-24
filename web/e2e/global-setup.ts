import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// orion prints its tokenised URL on stdout; this is the first line that matches.
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/;

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

/** Resolves with the first URL orion prints, rejecting if it exits or stays silent. */
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
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (!found) reject(new Error(`orion exited (code ${code}) before printing its URL:\n${seen}`));
    });
  });
}

function stop(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
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

export default async function globalSetup(): Promise<() => Promise<void>> {
  const bin = path.join(repoRoot, "bin", "orion");
  if (!existsSync(bin)) {
    throw new Error(`${bin} does not exist. Run \`make build\` in ${repoRoot} first.`);
  }
  const work = mkdtempSync(path.join(tmpdir(), "orion-e2e-"));
  // The demo also creates a sibling `nebula.wt`, so removing `work` cleans up both.
  const demoDir = path.join(work, "nebula");
  execFileSync("go", ["run", "./scripts/demo", "--once", "--dir", demoDir, "--seed", "1"], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });

  const port = await freePort();
  const orion = spawn(bin, [demoDir, "--no-open", "--port", String(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let url: string;
  try {
    url = await waitForUrl(orion, 20_000);
  } catch (err) {
    await stop(orion);
    rmSync(work, { recursive: true, force: true });
    throw err;
  }
  process.env.ORION_URL = url;
  process.env.ORION_DEMO_DIR = demoDir;

  return async () => {
    await stop(orion);
    rmSync(work, { recursive: true, force: true });
  };
}
