import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

/**
 * Secure local vault for account metadata.
 * - Master secret: MANUS_STORE_SECRET env, or auto-generated file manus_profiles/.store_key
 * - Payload: AES-256-GCM (ciphertext + auth tag)
 */
function secretsDir(): string {
  const dir = path.resolve('manus_profiles');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function keyFilePath(): string {
  return path.join(secretsDir(), '.store_key');
}

export function getMasterSecret(): Buffer {
  const fromEnv = process.env.MANUS_STORE_SECRET?.trim();
  if (fromEnv) {
    return createHash('sha256').update(fromEnv).digest();
  }
  const keyPath = keyFilePath();
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    return createHash('sha256').update(raw).digest();
  }
  const generated = randomBytes(32).toString('base64url');
  fs.writeFileSync(keyPath, generated, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* windows may ignore */
  }
  console.log(`[secure-store] generated master key → ${keyPath}`);
  console.log('[secure-store] tip: set MANUS_STORE_SECRET to pin encryption across machines');
  return createHash('sha256').update(generated).digest();
}

function deriveKey(secret: Buffer, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LEN);
}

export function encryptJson(value: unknown): string {
  const secret = getMasterSecret();
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(secret, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // v1:salt:iv:tag:ciphertext (all base64url)
  return [
    'v1',
    salt.toString('base64url'),
    iv.toString('base64url'),
    tag.toString('base64url'),
    enc.toString('base64url'),
  ].join(':');
}

export function decryptJson<T = unknown>(blob: string): T {
  const parts = blob.split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted blob format');
  }
  const [, saltB64, ivB64, tagB64, dataB64] = parts;
  const secret = getMasterSecret();
  const salt = Buffer.from(saltB64, 'base64url');
  const key = deriveKey(secret, salt);
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}

export function fingerprintSecret(): string {
  const secret = getMasterSecret();
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

/** Redact JWT for logs */
export function redactToken(token: string): string {
  if (!token) return '';
  if (token.length < 16) return '***';
  return `${token.slice(0, 10)}…${token.slice(-4)}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
