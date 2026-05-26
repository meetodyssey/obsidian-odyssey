import { createHash, randomBytes } from "crypto";

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64");
}

export function hashPasscode(passcode: string): string {
  return createHash("sha256").update(passcode, "utf8").digest("hex");
}

export function verifyPasscode(passcode: string, expectedHash: string): boolean {
  return Boolean(expectedHash) && hashPasscode(passcode) === expectedHash;
}
