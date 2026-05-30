import { readTelegramServiceCode } from "./telegram-session";

interface Env {
  ALLOWED_ORIGINS?: string;
  SESSIONS?: KVNamespace;
  TG_API_ID?: string;
  TG_API_HASH?: string;
}

const TELEGRAM_WEB_HOSTS = new Set([
  "pluto.web.telegram.org",
  "venus.web.telegram.org",
  "aurora.web.telegram.org",
  "vesta.web.telegram.org",
  "flora.web.telegram.org",
  "pluto-1.web.telegram.org",
  "venus-1.web.telegram.org",
  "aurora-1.web.telegram.org",
  "vesta-1.web.telegram.org",
  "flora-1.web.telegram.org"
]);

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env)
      });
    }

    if (url.pathname === "/api/health") {
      return json(
        {
          ok: true,
          service: "tg-alive-gateway",
          upstream: "telegram-web-wss"
        },
        request,
        env
      );
    }

    if (url.pathname === "/api/session") {
      return handleSessionRequest(request, env);
    }

    if (url.pathname === "/api/session/refresh") {
      return handleSessionRefreshRequest(request, env);
    }

    if (url.pathname === "/api/telegram-code") {
      return handleTelegramCodeRequest(request, env);
    }

    if (url.pathname === "/api/telegram-ws") {
      return proxyTelegramWebSocket(request, env);
    }

    return json({ ok: false, error: "not_found" }, request, env, 404);
  }
} satisfies ExportedHandler<Env>;

async function proxyTelegramWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ ok: false, error: "websocket_upgrade_required" }, request, env, 426);
  }

  const url = new URL(request.url);
  const host = normalizeHost(url.searchParams.get("host"));
  const port = url.searchParams.get("port") || "443";
  const testServers = url.searchParams.get("test") === "1";

  if (!host || !TELEGRAM_WEB_HOSTS.has(host)) {
    return json({ ok: false, error: "telegram_host_not_allowed" }, request, env, 400);
  }

  if (port !== "80" && port !== "443") {
    return json({ ok: false, error: "telegram_port_not_allowed" }, request, env, 400);
  }

  const upstreamUrl = `https://${host}:${port}/apiws${testServers ? "_test" : ""}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.set("origin", `https://${host}`);

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers,
    signal: AbortSignal.timeout(12000)
  });

  const response = await fetch(upstreamRequest);
  const upstreamSocket = response.webSocket;
  if (response.status !== 101 || !upstreamSocket) {
    return json(
      {
        ok: false,
        error: "telegram_ws_rejected",
        status: response.status
      },
      request,
      env,
      502
    );
  }

  const pair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(pair) as [WebSocket, WebSocket];

  serverSocket.accept();
  upstreamSocket.accept();
  bridgeSockets(serverSocket, upstreamSocket);

  const protocol = selectWebSocketProtocol(request.headers.get("sec-websocket-protocol"));
  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
    headers: protocol ? { "sec-websocket-protocol": protocol } : undefined
  });
}

async function handleSessionRequest(request: Request, env: Env): Promise<Response> {
  if (!env.SESSIONS) {
    return json({ ok: false, error: "kv_not_configured" }, request, env, 501);
  }

  if (request.method === "GET") {
    const key = readSessionKey(request);
    if (!key) {
      return json({ ok: false, error: "invalid_session_key" }, request, env, 400);
    }

    const stored = await env.SESSIONS.get<StoredSession>(sessionKey(key), "json");
    if (!stored) {
      return json({ ok: false, error: "session_not_found" }, request, env, 404);
    }

    return json({ ok: true, record: stored.record }, request, env);
  }

  if (request.method === "PUT") {
    const body = (await request.json()) as {
      key?: string;
      verifier?: string;
      record?: unknown;
    };
    if (
      !body.key ||
      !isValidSessionKey(body.key) ||
      !body.verifier ||
      !isValidSessionKey(body.verifier) ||
      !isValidSessionRecord(body.record)
    ) {
      return json({ ok: false, error: "invalid_session_record" }, request, env, 400);
    }

    const existing = await env.SESSIONS.get<StoredSession>(sessionKey(body.key), "json");
    if (existing && existing.verifier !== body.verifier) {
      return json({ ok: false, error: "session_password_mismatch" }, request, env, 409);
    }

    await env.SESSIONS.put(
      sessionKey(body.key),
      JSON.stringify({
        verifier: body.verifier,
        record: body.record,
        updatedAt: new Date().toISOString()
      } satisfies StoredSession)
    );
    return json({ ok: true }, request, env);
  }

  if (request.method === "DELETE") {
    const key = readSessionKey(request);
    if (!key) {
      return json({ ok: false, error: "invalid_session_key" }, request, env, 400);
    }

    const verifier = request.headers.get("x-session-verifier");
    const existing = await env.SESSIONS.get<StoredSession>(sessionKey(key), "json");
    if (existing && existing.verifier !== verifier) {
      return json({ ok: false, error: "session_password_mismatch" }, request, env, 409);
    }

    await env.SESSIONS.delete(sessionKey(key));
    return json({ ok: true }, request, env);
  }

  return json({ ok: false, error: "method_not_allowed" }, request, env, 405);
}

async function handleSessionRefreshRequest(request: Request, env: Env): Promise<Response> {
  if (!env.SESSIONS) {
    return json({ ok: false, error: "kv_not_configured" }, request, env, 501);
  }

  if (request.method !== "GET") {
    return json({ ok: false, error: "method_not_allowed" }, request, env, 405);
  }

  const url = new URL(request.url);
  const phone = url.searchParams.get("phone");
  const secret = url.searchParams.get("key") || request.headers.get("x-session-refresh-key");

  if (!phone || !secret) {
    return json({ ok: false, error: "missing_phone_or_key" }, request, env, 400);
  }

  const key = await createSessionKey(phone);
  const verifier = await createSessionVerifier(phone, secret);
  const existing = await env.SESSIONS.get<StoredSession>(sessionKey(key), "json");

  if (!existing) {
    return json({ ok: false, error: "session_not_found" }, request, env, 404);
  }

  if (existing.verifier !== verifier) {
    return json({ ok: false, error: "session_password_mismatch" }, request, env, 403);
  }

  const updatedAt = new Date().toISOString();
  await env.SESSIONS.put(
    sessionKey(key),
    JSON.stringify({
      ...existing,
      updatedAt
    } satisfies StoredSession)
  );

  return json(
    {
      ok: true,
      refreshed: "kv",
      telegram: false,
      updatedAt
    },
    request,
    env
  );
}

async function handleTelegramCodeRequest(request: Request, env: Env): Promise<Response> {
  if (!env.SESSIONS) {
    return json({ ok: false, error: "kv_not_configured" }, request, env, 501);
  }

  if (request.method !== "GET") {
    return json({ ok: false, error: "method_not_allowed" }, request, env, 405);
  }

  const apiId = Number(env.TG_API_ID);
  if (!Number.isFinite(apiId) || !env.TG_API_HASH) {
    return json({ ok: false, error: "telegram_api_not_configured" }, request, env, 501);
  }

  const url = new URL(request.url);
  const phone = url.searchParams.get("phone");
  const secret = url.searchParams.get("key") || request.headers.get("x-session-refresh-key");

  if (!phone || !secret) {
    return json({ ok: false, error: "missing_phone_or_key" }, request, env, 400);
  }

  const key = await createSessionKey(phone);
  const verifier = await createSessionVerifier(phone, secret);
  const existing = await env.SESSIONS.get<StoredSession>(sessionKey(key), "json");

  if (!existing) {
    return json({ ok: false, error: "session_not_found" }, request, env, 404);
  }

  if (existing.verifier !== verifier) {
    return json({ ok: false, error: "session_password_mismatch" }, request, env, 403);
  }

  if (!isValidSessionRecord(existing.record)) {
    return json({ ok: false, error: "invalid_stored_session_record" }, request, env, 500);
  }

  const session = await decryptSessionRecord(existing.record as CloudSessionRecord, secret);
  const serviceCode = await readTelegramServiceCode(apiId, env.TG_API_HASH, session);
  const sessionChanged = Boolean(serviceCode.session && serviceCode.session !== session);
  const record = sessionChanged
    ? await encryptSessionRecord(serviceCode.session, secret)
    : existing.record;
  const updatedAt = new Date().toISOString();

  await env.SESSIONS.put(
    sessionKey(key),
    JSON.stringify({
      verifier,
      record,
      updatedAt
    } satisfies StoredSession)
  );

  return json(
    {
      ok: true,
      code: serviceCode.code,
      text: serviceCode.text,
      date: serviceCode.date,
      sessionRefreshed: sessionChanged,
      updatedAt
    },
    request,
    env
  );
}

function normalizeHost(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.trim().toLowerCase().replace(/:\d+$/, "");
}

function json(data: unknown, request: Request, env: Env, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(request, env)
    }
  });
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("origin");
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);

  if (!origin || allowed.length === 0) {
    return {
      "access-control-allow-origin": origin || "*",
      "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, sec-websocket-protocol",
      vary: "Origin"
    };
  }

  if (!allowed.includes(origin)) {
    return {
      "access-control-allow-origin": "null",
      vary: "Origin"
    };
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, sec-websocket-protocol",
    vary: "Origin"
  };
}

function parseAllowedOrigins(value?: string): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  client.addEventListener("message", (event) => {
    sendIfOpen(upstream, event.data);
  });
  upstream.addEventListener("message", (event) => {
    sendIfOpen(client, event.data);
  });

  client.addEventListener("close", () => closeIfOpen(upstream));
  client.addEventListener("error", () => closeIfOpen(upstream));
  upstream.addEventListener("close", () => closeIfOpen(client));
  upstream.addEventListener("error", () => closeIfOpen(client));
}

function sendIfOpen(socket: WebSocket, data: string | ArrayBuffer): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}

function closeIfOpen(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}

function selectWebSocketProtocol(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

interface StoredSession {
  verifier: string;
  record: unknown;
  updatedAt: string;
}

interface CloudSessionRecord {
  v: 1;
  alg: "PBKDF2-SHA256+A256GCM";
  salt: string;
  iv: string;
  data: string;
  updatedAt: string;
}

const PBKDF2_ITERATIONS = 210_000;

function readSessionKey(request: Request): string | null {
  const key = new URL(request.url).searchParams.get("key");
  return key && isValidSessionKey(key) ? key : null;
}

function sessionKey(key: string): string {
  return `session:${key}`;
}

function isValidSessionKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isValidSessionRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.alg === "PBKDF2-SHA256+A256GCM" &&
    typeof record.salt === "string" &&
    typeof record.iv === "string" &&
    typeof record.data === "string" &&
    typeof record.updatedAt === "string"
  );
}

async function createSessionKey(phone: string): Promise<string> {
  return sha256Base64url(`tg-alive/session/v1/${normalizePhone(phone)}`);
}

async function createSessionVerifier(phone: string, secret: string): Promise<string> {
  return sha256Base64url(`tg-alive/session-verifier/v1/${normalizePhone(phone)}/${secret}`);
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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

async function decryptSessionRecord(record: CloudSessionRecord, secret: string): Promise<string> {
  try {
    const key = await deriveAesKey(secret, base64urlToBytes(record.salt));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64urlToBytes(record.iv) as BufferSource },
      key,
      base64urlToBytes(record.data) as BufferSource
    );
    const envelope = JSON.parse(new TextDecoder().decode(plaintext)) as { session?: string };
    if (!envelope.session) {
      throw new Error("missing_session");
    }

    return envelope.session;
  } catch {
    throw new Error("session_decrypt_failed");
  }
}

async function encryptSessionRecord(session: string, secret: string): Promise<CloudSessionRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(secret, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify({ session }));
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

async function deriveAesKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, [
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

function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
