import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (err) {
    const execErr = err as { stderr?: string; message: string };
    throw new Error(
      `git ${args.join(" ")} failed: ${(execErr.stderr ?? execErr.message).trim()}`,
    );
  }
}

export async function preparePrWorkspace(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ workDir: string; repoDir: string }> {
  const workDir = await mkdtemp(join(tmpdir(), "glados-"));
  // Never let a repository name become workspace policy (for example,
  // a repository named ".cursor" containing sandbox.json).
  const checkoutDir = "repository";
  const repoDir = join(workDir, checkoutDir);
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
  // Pass auth only to network commands. It is neither logged in arguments nor
  // persisted in .git/config where the local review agent could read it.
  const authEnv = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth}`,
    GIT_LFS_SKIP_SMUDGE: "1",
  };

  try {
    await runGit(workDir, ["clone", cloneUrl, checkoutDir], authEnv);
    await runGit(
      repoDir,
      ["fetch", "origin", `pull/${prNumber}/head:pr-${prNumber}`],
      authEnv,
    );
    await runGit(
      repoDir,
      ["checkout", `pr-${prNumber}`],
      { GIT_LFS_SKIP_SMUDGE: "1" },
    );
    return { workDir, repoDir };
  } catch (err) {
    await rm(workDir, { recursive: true, force: true });
    throw err;
  }
}

export async function withPrWorkspace<T>(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  run: (repoDir: string) => Promise<T>,
): Promise<T> {
  const workspace = await preparePrWorkspace(owner, repo, prNumber, token);
  try {
    return await run(workspace.repoDir);
  } finally {
    try {
      await rm(workspace.workDir, { recursive: true, force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Could not clean workspace: ${message}`);
    }
  }
}

/** Serialize processing of one PR across overlapping local CLI runs. */
export async function withPrLock<T>(
  owner: string,
  repo: string,
  prNumber: number,
  run: () => Promise<T>,
): Promise<T> {
  const lockRoot = join(tmpdir(), "glados-pr-locks");
  await mkdir(lockRoot, { recursive: true });
  const key = createHash("sha256")
    .update(`${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}`)
    .digest("hex");
  const lockPath = join(lockRoot, key);

  await acquireLock(lockPath);
  try {
    return await run();
  } finally {
    try {
      await rm(lockPath, { recursive: true, force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Could not release PR lock: ${message}`);
    }
  }
}

async function acquireLock(lockPath: string, retried = false): Promise<void> {
  try {
    await mkdir(lockPath);
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
    if (!retried && (await isStaleLock(lockPath))) {
      await rm(lockPath, { recursive: true, force: true });
      return acquireLock(lockPath, true);
    }
    throw new Error("This pull request is already being processed");
  }

  try {
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
  } catch (err) {
    await rm(lockPath, { recursive: true, force: true });
    throw err;
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as { pid?: unknown };
    if (typeof owner.pid === "number") {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (err) {
        if (errorCode(err) === "ESRCH") return true;
        return false;
      }
    }
  } catch {
    // A creator may not have written metadata yet; only reap old remnants.
  }

  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000;
  } catch (err) {
    return errorCode(err) === "ENOENT";
  }
}

function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}
