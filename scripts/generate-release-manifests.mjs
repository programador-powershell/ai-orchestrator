import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((item, index, all) => item.startsWith("--") ? [item.slice(2), all[index + 1]] : null)
    .filter(Boolean)
);

for (const name of ["version", "base-url", "publisher", "desktop", "output"]) {
  if (!args[name]) throw new Error(`Missing --${name}`);
}
if (Boolean(args.updater) !== Boolean(args["updater-signature"])) {
  throw new Error("--updater and --updater-signature must be provided together");
}

const fileComponent = (id, optional, path) => ({
  id,
  optional,
  url: `${args["base-url"].replace(/\/$/, "")}/${basename(path)}`,
  size: statSync(path).size,
  sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
});

const components = [fileComponent("desktop", false, args.desktop)];
if (args["runtime-cpu"]) components.push(fileComponent("runtime-cpu", true, args["runtime-cpu"]));
if (args["runtime-vulkan"]) components.push(fileComponent("runtime-vulkan", true, args["runtime-vulkan"]));

const payload = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  product: "AI-Orchestrator",
  channel: args.version.includes("-") ? "beta" : "stable",
  version: args.version.replace(/^v/, ""),
  minimumBootstrapperVersion: "0.1.0",
  publishedAt: new Date().toISOString(),
  publisher: args.publisher,
  components
}));

let privateKeyValue = process.env.INSTALLER_MANIFEST_PRIVATE_KEY;
if (!privateKeyValue) throw new Error("INSTALLER_MANIFEST_PRIVATE_KEY is required");
if (!privateKeyValue.includes("BEGIN")) privateKeyValue = Buffer.from(privateKeyValue, "base64").toString("utf8");
const signature = sign(null, payload, createPrivateKey(privateKeyValue));
const installerManifest = { payload: payload.toString("base64"), signature: signature.toString("base64") };
writeFileSync(resolve(args.output, "installer-manifest.json"), `${JSON.stringify(installerManifest, null, 2)}\n`);

if (args.updater) {
  const updaterSignature = readFileSync(args["updater-signature"], "utf8").trim();
  const latest = {
    version: args.version.replace(/^v/, ""),
    notes: "Atualização do AI-Orchestrator",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: updaterSignature,
        url: `${args["base-url"].replace(/\/$/, "")}/${basename(args.updater)}`
      }
    }
  };
  writeFileSync(resolve(args.output, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
}
