import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
  const repoDir = join(workDir, repo);
  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  try {
    await runGit(workDir, ["clone", cloneUrl, repo]);
    await runGit(repoDir, [
      "fetch",
      "origin",
      `pull/${prNumber}/head:pr-${prNumber}`,
    ]);
    await runGit(repoDir, ["checkout", `pr-${prNumber}`]);
    return { workDir, repoDir };
  } catch (err) {
    await rm(workDir, { recursive: true, force: true });
    throw err;
  }
}
