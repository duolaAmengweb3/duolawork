import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertArtifactPath } from "../local/data-policy.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  out = path.join(root, "release/Agent Hub.app");
await assertArtifactPath(out);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.rm(out, { recursive: true, force: true });
execFileSync("/usr/bin/ditto", [
  path.join(root, "node_modules/electron/dist/Electron.app"),
  out,
]);
const appDir = path.join(out, "Contents/Resources/app");
await fs.mkdir(appDir, { recursive: true });
for (const name of ["dist", "desktop", "local", "shared"])
  await fs.cp(path.join(root, name), path.join(appDir, name), {
    recursive: true,
  });
await fs.writeFile(
  path.join(appDir, "package.json"),
  JSON.stringify({
    name: "agent-hub-local",
    version: "0.1.0",
    main: "desktop/main.cjs",
    type: "module",
  }),
);
// Only desktop runtime dependencies; no Cloudflare credentials, source tests, or build caches.
for (const name of ["playwright-core", "undici"])
  await fs.cp(
    path.join(root, "node_modules", name),
    path.join(appDir, "node_modules", name),
    { recursive: true },
  );
const plist = path.join(out, "Contents/Info.plist");
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Set :CFBundleDisplayName Agent Hub",
  plist,
]);
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Set :CFBundleName Agent Hub",
  plist,
]);
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Set :CFBundleIdentifier com.duola.agenthub",
  plist,
]);
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", out]);
console.log("本机可运行构建：" + out + "（本机签名，尚无 Developer ID 公证）");

// Acceptance uses temporary workerd/D1 and a mock test keychain, never production profiles.
execFileSync(process.execPath, [path.join(root, "tests/v1-desktop.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    HUB_TEST_EXECUTABLE: path.join(out, "Contents/MacOS/Electron"),
  },
  stdio: "inherit",
});
