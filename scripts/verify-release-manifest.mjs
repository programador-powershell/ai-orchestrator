import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [manifestPath, publicKeyPath] = process.argv.slice(2);
if (!manifestPath || !publicKeyPath) throw new Error("usage: node verify-release-manifest.mjs manifest.json public-key.pem");
const envelope = JSON.parse(readFileSync(manifestPath, "utf8"));
const payload = Buffer.from(envelope.payload, "base64");
const signature = Buffer.from(envelope.signature, "base64");
if (!verify(null, payload, createPublicKey(readFileSync(publicKeyPath)), signature)) throw new Error("invalid Ed25519 signature");
const parsed = JSON.parse(payload);
if (parsed.schemaVersion !== 1 || parsed.product !== "AI-BOT") throw new Error("incompatible release manifest");
console.log(`verified ${parsed.product} ${parsed.version}`);
