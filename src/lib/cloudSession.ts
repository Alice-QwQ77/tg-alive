import { apiUrl } from "./config";

export interface CloudSessionRecord {
  v: 1;
  alg: "PBKDF2-SHA256+A256GCM";
  salt: string;
  iv: string;
  data: string;
  updatedAt: string;
}

interface CloudSessionPayload {
  key: string;
  verifier: string;
  record: CloudSessionRecord;
}

interface SessionEnvelope {
  session: string;
}

const KEY_PREFIX = "tg-alive/session/v1";
const VERIFIER_PREFIX = "tg-alive/session-verifier/v1";
const PBKDF2_ITERATIONS = 210_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function loadCloudSession(phone: string, password: string): Promise<string | null> {
  const key = await createSessionKey(phone);
  const response = await fetch(apiUrl(`/session?key=${encodeURIComponent(key)}`), {
    cache: "no-store"
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error("云端会话读取失败");
  }

  const payload = (await response.json()) as { record: CloudSessionRecord };
  const envelope = await decryptRecord(payload.record, password);
  return envelope.session;
}

export async function saveCloudSession(phone: string, password: string, session: string): Promise<void> {
  const payload: CloudSessionPayload = {
    key: await createSessionKey(phone),
    verifier: await createSessionVerifier(phone, password),
    record: await encryptRecord({ session }, password)
  };
  const response = await fetch(apiUrl("/session"), {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    if (response.status === 409) {
      throw new Error("云端记录已存在，且同步密码不匹配");
    }
    throw new Error("云端会话保存失败");
  }
}

export async function deleteCloudSession(phone: string, password: string): Promise<void> {
  const key = await createSessionKey(phone);
  const verifier = await createSessionVerifier(phone, password);
  const response = await fetch(apiUrl(`/session?key=${encodeURIComponent(key)}`), {
    method: "DELETE",
    headers: {
      "x-session-verifier": verifier
    }
  });

  if (!response.ok && response.status !== 404) {
    throw new Error("云端会话删除失败");
  }
}

export function hasCloudPassword(password: string): boolean {
  return password.trim().length >= 8;
}

async function createSessionKey(phone: string): Promise<string> {
  return sha256Base64url(`${KEY_PREFIX}/${normalizePhone(phone)}`);
}

async function createSessionVerifier(phone: string, password: string): Promise<string> {
  return sha256Base64url(`${VERIFIER_PREFIX}/${normalizePhone(phone)}/${password}`);
}

async function encryptRecord(envelope: SessionEnvelope, password: string): Promise<CloudSessionRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const plaintext = encoder.encode(JSON.stringify(envelope));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  );

  return {
    v: 1,
    alg: "PBKDF2-SHA256+A256GCM",
    salt: bytesToBase64url(salt),
    iv: bytesToBase64url(iv),
    data: bytesToBase64url(new Uint8Array(ciphertext)),
    updatedAt: new Date().toISOString()
  };
}

async function decryptRecord(record: CloudSessionRecord, password: string): Promise<SessionEnvelope> {
  try {
    const salt = base64urlToBytes(record.salt);
    const iv = base64urlToBytes(record.iv);
    const ciphertext = base64urlToBytes(record.data);
    const key = await deriveKey(password, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
    return JSON.parse(decoder.decode(plaintext)) as SessionEnvelope;
  } catch {
    throw new Error("同步密码不正确或云端会话已损坏");
  }
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveKey"
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64url(new Uint8Array(digest));
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s()-]/g, "");
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
