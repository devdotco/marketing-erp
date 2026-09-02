// AES-256-GCM encryption for OAuth credentials stored in Integration.encryptedCredentials
// Requires: ENCRYPTION_KEY env var — 32 random bytes as a 64-char hex string
// Generate: openssl rand -hex 32

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(keyHex, "hex");
}

export async function encrypt(plaintext: string): Promise<string> {
  const { createCipheriv, randomBytes } = await import("crypto");
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Format: iv(24 hex) + authTag(32 hex) + ciphertext(hex)
  return iv.toString("hex") + authTag.toString("hex") + encrypted.toString("hex");
}

export async function decrypt(ciphertext: string): Promise<string> {
  const { createDecipheriv } = await import("crypto");
  const key = getKey();
  const iv = Buffer.from(ciphertext.slice(0, 24), "hex");
  const authTag = Buffer.from(ciphertext.slice(24, 56), "hex");
  const encrypted = Buffer.from(ciphertext.slice(56), "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export async function encryptCredentials(credentials: Record<string, unknown>): Promise<string> {
  return encrypt(JSON.stringify(credentials));
}

export async function decryptCredentials<T = Record<string, unknown>>(encrypted: string): Promise<T> {
  const raw = await decrypt(encrypted);
  return JSON.parse(raw) as T;
}
