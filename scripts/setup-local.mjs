// Prepares a local, personal install: creates .dev.vars and applies D1 migrations to local state.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";

if (!existsSync(".dev.vars")) {
  copyFileSync(".dev.vars.example", ".dev.vars");
  console.log("Created .dev.vars from .dev.vars.example.");
}

const vars = readFileSync(".dev.vars", "utf8");
const key = /^OPENAI_API_KEY=(.*)$/m.exec(vars)?.[1]?.trim();
if (!key || key === "your_openai_api_key_here") {
  console.log("Add your OpenAI key to OPENAI_API_KEY in .dev.vars before you scan.");
}

execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "yard-sale-gold-db", "--local", "--config", "wrangler.local.jsonc"], {
  stdio: "inherit",
  env: { ...process.env, CI: "1" },
});
console.log("Local setup is done. Start the app with: npm run dev:local");
