#!/usr/bin/env node
// PostToolUse hook (Edit|Write|MultiEdit): format the touched file with the project's Prettier.
// Cross-platform (Windows Git Bash / PowerShell / Linux). Never blocks: always exits 0.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const FORMATTABLE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".css", ".md", ".yml", ".yaml"]);
const SKIP_DIRS = ["node_modules", ".next", "dist", "drizzle", ".claude/docs/providers"];

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const filePath = input?.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const abs = path.resolve(projectDir, filePath);
  const rel = path.relative(projectDir, abs).split(path.sep).join("/");
  if (rel.startsWith("..") || SKIP_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) process.exit(0);
  if (!FORMATTABLE.has(path.extname(abs).toLowerCase()) || !existsSync(abs)) process.exit(0);

  const bin = path.join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "prettier.cmd" : "prettier");
  if (!existsSync(bin)) process.exit(0); // project not initialised yet

  spawnSync(bin, ["--write", "--log-level", "warn", abs], {
    cwd: projectDir,
    stdio: "ignore",
    shell: process.platform === "win32",
    timeout: 20_000,
  });
} catch {
  // formatting is best-effort
}
process.exit(0);
