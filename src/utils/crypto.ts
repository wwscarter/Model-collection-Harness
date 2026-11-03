import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type EncryptionKeyProvider = () => Buffer | string;

let keyProvider: EncryptionKeyProvider | undefined;

/**
 * Set the key source used by API-key encryption. Call this once during app startup
 * before constructing ModelStorage. A provider is evaluated for every operation so
 * a provider backed by Electron safeStorage can load its wrapped key lazily.
 */
export function configureEncryptionKeyProvider(provider: EncryptionKeyProvider): void {
  keyProvider = provider;
}

/** Alias useful in tests and in integrations that prefer the shorter name. */
export const setEncryptionKeyProvider = configureEncryptionKeyProvider;

/** Clear a configured provider (primarily useful for isolated test processes). */
export function resetEncryptionKeyProvider(): void {
  keyProvider = undefined;
}

function normalizeKey(value: Buffer | string): Buffer {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : /^[0-9a-f]{64}$/i.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("AMD encryption key must be exactly 32 bytes (64 hex or base64 characters)");
  }
  return key;
}

function getEncryptionKey(): Buffer {
  if (keyProvider) return normalizeKey(keyProvider());

  const configured = process.env.AMD_ENCRYPTION_KEY;
  if (configured) return normalizeKey(configured);

  throw new Error(
    "No persistent encryption key configured. Set AMD_ENCRYPTION_KEY or call " +
      "configureEncryptionKeyProvider() with an Electron safeStorage-backed provider.",
  );
}

/** Encrypt an API key as `iv:ciphertext:authTag` using AES-256-GCM. */
export function encryptAPIKey(apiKey: string): string {
  if (typeof apiKey !== "string") throw new TypeError("API key must be a string");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ciphertext.toString("hex")}:${authTag.toString("hex")}`;
}

/** Decrypt a value produced by encryptAPIKey and fail closed on tampering. */
export function decryptAPIKey(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted API key format");
  const [ivHex, ciphertextHex, authTagHex] = parts;
  if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]*$/i.test(ciphertextHex) || !/^[0-9a-f]+$/i.test(authTagHex)) {
    throw new Error("Invalid encrypted API key encoding");
  }
  const iv = Buffer.from(ivHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  if (iv.length !== 12 || authTag.length !== 16) throw new Error("Invalid encrypted API key metadata");

  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface ElectronSafeStorageProviderOptions {
  /** Path to a file containing the safeStorage-wrapped 32-byte key. */
  keyPath: string;
  /** Electron's `safeStorage` object, injected to keep this module testable in Node. */
  safeStorage: SafeStorageLike;
}

/**
 * Build a persistent key provider backed by Electron's OS credential store.
 * The key file contains only safeStorage ciphertext and is created with owner-only
 * permissions. The function throws when safeStorage is unavailable instead of
 * silently falling back to a process-random key that would break after a restart.
 */
export function createElectronSafeStorageKeyProvider({
  keyPath,
  safeStorage,
}: ElectronSafeStorageProviderOptions): EncryptionKeyProvider {
  let cached: Buffer | undefined;
  return () => {
    if (cached) return cached;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is unavailable");
    }

    const directory = path.dirname(keyPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(keyPath)) {
      const wrapped = fs.readFileSync(keyPath);
      const raw = safeStorage.decryptString(wrapped);
      cached = normalizeKey(raw);
      return cached;
    }

    const generated = crypto.randomBytes(32);
    const wrapped = safeStorage.encryptString(generated.toString("hex"));
    const temporary = `${keyPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, wrapped, { mode: 0o600 });
    fs.renameSync(temporary, keyPath);
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Some filesystems do not support chmod; safeStorage ciphertext remains opaque.
    }
    cached = generated;
    return cached;
  };
}

