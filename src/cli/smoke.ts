import { Agent, CursorAgentError } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error("Set CURSOR_API_KEY first:");
  console.error("  export CURSOR_API_KEY='cursor_...'");
  process.exit(1);
}

const prompt = process.argv.slice(2).join(" ") || "List the top-level files in this repo.";

try {
  const result = await Agent.prompt(prompt, {
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: process.cwd() },
  });

  if (result.status === "error") {
    console.error(`run failed: ${result.id}`);
    process.exit(2);
  }

  console.log(result.result ?? "(no text output)");
} catch (err) {
  if (err instanceof CursorAgentError) {
    console.error(
      `startup failed: ${err.message}, retryable=${err.isRetryable}`,
    );
    process.exit(1);
  }
  throw err;
}
