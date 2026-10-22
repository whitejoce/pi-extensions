import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readConfigEnvFile } from "../extensions/web-search/client.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-package-"));
const checkout = join(root, "checkout");
const relocated = join(root, "搬移后的包");
const agentDir = join(root, "personal-agent");
const cwd = join(root, "work");
const envNames = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_NOTIFY_DOT", "PI_NOTIFY_DOT_DEBUG", "PI_NOTIFY_DOT_PROBE", "WT_SESSION"];
const environment = new Map(envNames.map((name) => [name, process.env[name]]));

try {
  mkdirSync(checkout);
  mkdirSync(agentDir);
  mkdirSync(cwd);
  cpSync(join(repository, "extensions"), join(checkout, "extensions"), { recursive: true });
  cpSync(join(repository, "skills"), join(checkout, "skills"), { recursive: true });
  cpSync(join(repository, "package.json"), join(checkout, "package.json"));
  renameSync(checkout, relocated);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  for (const name of ["PI_NOTIFY_DOT", "PI_NOTIFY_DOT_DEBUG", "PI_NOTIFY_DOT_PROBE"]) delete process.env[name];
  process.env.WT_SESSION = "package-test";

  const manifest = JSON.parse(readFileSync(join(relocated, "package.json"), "utf8"));
  const expected = manifest.pi.extensions.map((entry: string) => resolve(relocated, entry)).sort();
  assert.equal(expected.length, 10);
  const manager = new DefaultPackageManager({
    cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [relocated] }),
  });
  const resources = await manager.resolve();
  // Pi also discovers personal skills outside agentDir (for example ~/.agents).
  const skills = resources.skills.filter((entry) => entry.enabled && entry.metadata.packageRoot === relocated);
  assert.equal(skills.length, 1, "the package exposes exactly the upgrade-review skill");
  const skillPath = skills[0].path;
  const skillDirectory = skillPath.endsWith("SKILL.md") ? resolve(skillPath, "..") : skillPath;
  assert.equal(skillDirectory, join(relocated, "skills", "pi-upgrade-review"));
  const skillText = readFileSync(join(skillDirectory, "SKILL.md"), "utf8");
  assert.match(skillText, /^name: pi-upgrade-review$/m);
  assert.match(skillText, /^disable-model-invocation: true$/m);
  for (const reference of ["review-checklist.md", "report-template.md"]) {
    assert.ok(existsSync(join(skillDirectory, "references", reference)), "skill references survive relocation");
  }
  const paths = resources.extensions.filter((entry) => entry.enabled).map((entry) => entry.path).sort();
  assert.deepEqual(paths, expected, "Pi loads exactly the ten declared entries, excluding helpers and tests");
  const loaded = await discoverAndLoadExtensions(paths, cwd, agentDir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 10, "all package-relative imports load after relocation");
  const plugins = loaded.extensions.find((entry) => basename(entry.path) === "plugin-manager.ts");
  assert.ok(plugins?.commands.has("plugins"), "the relocated package registers /plugins");

  if (process.platform === "win32") {
    const native = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
    const calls: unknown[][] = [];
    const spawn = mock.method(native, "spawn", (...args: unknown[]) => {
      calls.push(args);
      throw new Error("Headless test: no foreground probe is executed");
    });
    const stdout = mock.method(process.stdout, "write", () => true);
    syncBuiltinESMExports();
    try {
      const extension = loaded.extensions.find((entry) => basename(entry.path) === "notify-dot.ts")!;
      const context = {
        mode: "tui",
        sessionManager: { getSessionId: () => "test", getCwd: () => cwd, getSessionName: () => "test" },
        ui: { onTerminalInput: () => () => {}, setTitle: () => {} },
      };
      for (const handler of extension.handlers.get("agent_settled") ?? []) {
        await handler({ type: "agent_settled", aborted: false }, context);
      }
      assert.equal(calls.length, 1);
      const args = calls[0][1] as string[];
      const script = args[args.indexOf("-File") + 1];
      assert.equal(script, join(relocated, "extensions", "notify-dot", "foreground-check.ps1"));
      assert.ok(existsSync(script), "the probe uses the script shipped with this relocated package");
      for (const handler of extension.handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown", reason: "quit" }, context);
      }
    } finally {
      spawn.mock.restore();
      stdout.mock.restore();
      syncBuiltinESMExports();
    }
  }

  const config = join(agentDir, "config", "pi-extensions", ".env.web-search");
  mkdirSync(join(agentDir, "config", "pi-extensions"), { recursive: true });
  writeFileSync(config, "api_key=test-personal\nbase_url=https://personal.example\n", "utf8");
  const before = readFileSync(config);
  assert.equal(readConfigEnvFile().api_key, "test-personal");
  rmSync(relocated, { recursive: true, force: true });
  mkdirSync(relocated);
  cpSync(join(repository, "extensions"), join(relocated, "extensions"), { recursive: true });
  assert.deepEqual(readFileSync(config), before, "replacing the package tree leaves personal configuration intact");
  assert.equal(readConfigEnvFile().api_key, "test-personal");
  console.log("Native extension/skill discovery, relocated loading, probe resource and persistent configuration passed");
} finally {
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
