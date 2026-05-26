import { App, normalizePath, TFile } from "obsidian";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { ShadowIndexData, ShadowIndexEntry } from "../types";
import { nowIso } from "../utils/time";

interface EncryptedEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class ShadowIndexStore {
  private data: ShadowIndexData = emptyShadowIndex();

  constructor(
    private readonly app: App,
    private readonly dir: string,
    private readonly secret: string
  ) {}

  get entryCount(): number {
    return Object.keys(this.data.entries).length;
  }

  get entries(): Record<string, ShadowIndexEntry> {
    return this.data.entries;
  }

  async ensureInitialized(): Promise<void> {
    await this.ensureFolder(this.root);
    if (!(await this.app.vault.adapter.exists(this.indexPath))) {
      await this.save(emptyShadowIndex());
    }
  }

  async load(): Promise<ShadowIndexData> {
    if (!(await this.app.vault.adapter.exists(this.indexPath))) {
      this.data = emptyShadowIndex();
      return this.data;
    }
    const raw = await this.readRaw(this.indexPath);
    if (!raw.trim()) {
      this.data = emptyShadowIndex();
      return this.data;
    }
    try {
      this.data = decryptShadowIndex(raw, this.secret);
    } catch {
      this.data = emptyShadowIndex();
    }
    return this.data;
  }

  async save(data: ShadowIndexData): Promise<void> {
    this.data = data;
    await this.writeRaw(this.indexPath, encryptShadowIndex(data, this.secret));
  }

  async replaceEntries(entries: ShadowIndexEntry[]): Promise<void> {
    const next: ShadowIndexData = {
      version: 1,
      rebuiltAt: nowIso(),
      entries: Object.fromEntries(entries.map(entry => [entry.id, entry]))
    };
    await this.save(next);
  }

  async clear(): Promise<void> {
    await this.save(emptyShadowIndex());
  }

  private get root(): string {
    return normalizePath(this.dir || ".odyssey");
  }

  private get indexPath(): string {
    return normalizePath(`${this.root}/index.enc`);
  }

  private async readRaw(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) return this.app.vault.read(file);
    const adapter = this.app.vault.adapter as unknown as { read?: (path: string) => Promise<string> };
    if (adapter.read) return adapter.read(normalizePath(path));
    return "";
  }

  private async writeRaw(path: string, content: string): Promise<void> {
    await this.ensureParent(path);
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
      return;
    }
    try {
      await this.app.vault.create(normalized, content);
    } catch (error) {
      const existing = this.app.vault.getAbstractFileByPath(normalized);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
        return;
      }
      const adapter = this.app.vault.adapter as unknown as { write?: (path: string, content: string) => Promise<void> };
      if (adapter.write) {
        await adapter.write(normalized, content);
        return;
      }
      throw error;
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const idx = normalizePath(path).lastIndexOf("/");
    if (idx > 0) await this.ensureFolder(path.slice(0, idx));
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.app.vault.adapter.exists(normalized)) return;
    if (this.app.vault.getAbstractFileByPath(normalized)) return;
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    try {
      await this.app.vault.createFolder(normalized);
    } catch (error) {
      if (isAlreadyExistsError(error)) return;
      if (await this.app.vault.adapter.exists(normalized)) return;
      throw error;
    }
  }
}

export function emptyShadowIndex(): ShadowIndexData {
  return { version: 1, rebuiltAt: nowIso(), entries: {} };
}

export function encryptShadowIndex(data: ShadowIndexData, secret: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final()
  ]);
  const envelope: EncryptedEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
  return JSON.stringify(envelope, null, 2);
}

export function decryptShadowIndex(raw: string, secret: string): ShadowIndexData {
  const envelope = JSON.parse(raw) as EncryptedEnvelope;
  if (envelope.algorithm !== "aes-256-gcm" || envelope.kdf !== "scrypt") {
    throw new Error("Unsupported Shadow Index format");
  }
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const key = scryptSync(secret, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as ShadowIndexData;
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists/i.test(message);
}
