import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(join(tmpdir(), "ai-orchestrator-release-"));
const desktop = join(directory, "desktop-setup.exe");
const updater = join(directory, "desktop.nsis.zip");
const updaterSignature = `${updater}.sig`;
writeFileSync(desktop, "signed desktop fixture");
writeFileSync(updater, "signed updater fixture");
writeFileSync(updaterSignature, "tauri-signature-fixture");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const result = spawnSync(process.execPath, [
  resolve("scripts/generate-release-manifests.mjs"),
  "--version", "v1.2.3", "--base-url", "https://example.invalid/releases/v1.2.3",
  "--publisher", "AI-Orchestrator Test Publisher", "--desktop", desktop,
  "--updater", updater, "--updater-signature", updaterSignature, "--output", directory
], {
  encoding: "utf8",
  env: { ...process.env, INSTALLER_MANIFEST_PRIVATE_KEY: privateKeyPem }
});
if (result.status !== 0) throw new Error(result.stderr || result.stdout);

const envelope = JSON.parse(readFileSync(join(directory, "installer-manifest.json"), "utf8"));
const payload = Buffer.from(envelope.payload, "base64");
const signature = Buffer.from(envelope.signature, "base64");
if (!verify(null, payload, publicKey, signature)) throw new Error("valid manifest signature was rejected");
const tampered = Buffer.from(payload);
tampered[0] ^= 1;
if (verify(null, tampered, publicKey, signature)) throw new Error("tampered manifest was accepted");
const parsed = JSON.parse(payload);
if (parsed.product !== "AI-Orchestrator" || parsed.components[0].size !== 22) throw new Error("release payload contract mismatch");
const latest = JSON.parse(readFileSync(join(directory, "latest.json"), "utf8"));
if (!latest.platforms["windows-x86_64"].url.endsWith("desktop.nsis.zip")) throw new Error("updater URL mismatch");

const manifestOnlyDirectory = mkdtempSync(join(tmpdir(), "ai-orchestrator-bootstrapper-"));
const manifestOnly = spawnSync(process.execPath, [
  resolve("scripts/generate-release-manifests.mjs"),
  "--version", "v1.2.4-beta.1", "--base-url", "https://example.invalid/releases/v1.2.4-beta.1",
  "--publisher", "AI-Orchestrator Test Publisher", "--desktop", desktop,
  "--output", manifestOnlyDirectory
], {
  encoding: "utf8",
  env: { ...process.env, INSTALLER_MANIFEST_PRIVATE_KEY: privateKeyPem }
});
if (manifestOnly.status !== 0) throw new Error(manifestOnly.stderr || manifestOnly.stdout);
if (!existsSync(join(manifestOnlyDirectory, "installer-manifest.json"))) throw new Error("manifest-only release was not generated");
if (existsSync(join(manifestOnlyDirectory, "latest.json"))) throw new Error("unsigned updater metadata must not be generated");

console.log("release manifest: signature, tamper rejection, bootstrapper-only beta and updater contract passed");
