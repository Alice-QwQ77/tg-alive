import bigInt from "big-integer";
import { Buffer } from "buffer";
import { Api, utils } from "telegram";
import type { TelegramClient } from "telegram";
import { createTelegramWorkerClient } from "./telegram-session";

interface Env {
  SESSIONS?: KVNamespace;
  TG_API_ID?: string;
  TG_API_HASH?: string;
}

interface MediaTokenPayload {
  session: string;
  peer: string;
  messageId: number;
  expiresAt: number;
  file?: MediaFileDescriptor;
}

interface MediaTokenRecord {
  iv: string;
  data: string;
}

interface MediaFileDescriptor {
  type: "document" | "photo";
  id: string;
  accessHash: string;
  fileReference: string;
  thumbSize: string;
  dcId?: number;
  size: number;
  mimeType: string;
  fileName: string;
}

interface ByteRange {
  start: number;
  end: number;
}

const TOKEN_TTL_SECONDS = 1800;
const STREAM_CHUNK_BYTES = 1024 * 1024 * 4;
const TELEGRAM_PART_BYTES = 512 * 1024;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export async function handleMediaTokenRequest(request: Request, env: Env): Promise<Response> {
  if (!env.SESSIONS) {
    return mediaJson({ ok: false, error: "kv_not_configured" }, 501);
  }
  const apiId = Number(env.TG_API_ID || "");
  if (!Number.isFinite(apiId) || !env.TG_API_HASH) {
    return mediaJson({ ok: false, error: "telegram_api_not_configured" }, 501);
  }
  if (request.method !== "POST") {
    return mediaJson({ ok: false, error: "method_not_allowed" }, 405);
  }

  const body = (await request.json()) as {
    session?: string;
    peer?: string;
    messageId?: number;
  };

  const messageId = body.messageId;
  if (
    !body.session ||
    typeof body.session !== "string" ||
    body.session.length > 16_384 ||
    !body.peer ||
    !/^-?\d+$/.test(body.peer) ||
    !Number.isInteger(messageId) ||
    !messageId ||
    messageId <= 0
  ) {
    return mediaJson({ ok: false, error: "invalid_media_token_request" }, 400);
  }

  let resolvedFile: { session: string; file: MediaFileDescriptor };
  try {
    resolvedFile = await resolveMediaTokenFile(apiId, env.TG_API_HASH, body.session, body.peer, messageId);
  } catch (error) {
    const code = errorCode(error);
    return mediaJson({ ok: false, error: code }, errorStatus(code));
  }

  const token = randomToken();
  const payload: MediaTokenPayload = {
    session: resolvedFile.session,
    peer: body.peer,
    messageId,
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
    file: resolvedFile.file
  };

  await env.SESSIONS.put(`media:${token}`, JSON.stringify(await encryptPayload(payload, token)), {
    expirationTtl: TOKEN_TTL_SECONDS
  });

  return mediaJson({
    ok: true,
    url: `/api/media-stream?token=${encodeURIComponent(token)}`,
    expiresIn: TOKEN_TTL_SECONDS
  });
}

export async function handleMediaStreamRequest(request: Request, env: Env): Promise<Response> {
  if (!env.SESSIONS) {
    return mediaJson({ ok: false, error: "kv_not_configured" }, 501);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return mediaJson({ ok: false, error: "method_not_allowed" }, 405);
  }

  const apiId = Number(env.TG_API_ID || "");
  if (!Number.isFinite(apiId) || !env.TG_API_HASH) {
    return mediaJson({ ok: false, error: "telegram_api_not_configured" }, 501);
  }

  const token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    return mediaJson({ ok: false, error: "invalid_media_token" }, 400);
  }

  const stored = await env.SESSIONS.get<MediaTokenRecord>(`media:${token}`, "json");
  if (!stored) {
    return mediaJson({ ok: false, error: "media_token_expired" }, 404);
  }

  const payload = await decryptPayload(stored, token);
  if (payload.expiresAt < Date.now()) {
    await env.SESSIONS.delete(`media:${token}`);
    return mediaJson({ ok: false, error: "media_token_expired" }, 404);
  }

  let file = payload.file;
  if (!file) {
    try {
      file = (await resolveMediaTokenFile(apiId, env.TG_API_HASH, payload.session, payload.peer, payload.messageId)).file;
    } catch (error) {
      const code = errorCode(error);
      return mediaJson({ ok: false, error: code }, errorStatus(code));
    }
  }

  const range = parseRange(request.headers.get("range"), file.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: {
        "content-range": `bytes */${file.size}`,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=60"
      }
    });
  }

  const end = Math.min(range.end, range.start + STREAM_CHUNK_BYTES - 1);
  const contentLength = end - range.start + 1;
  const partial = Boolean(request.headers.get("range")) || contentLength < file.size;
  const responseHeaders = mediaStreamHeaders(file, range.start, end, contentLength, partial);

  if (request.method === "HEAD") {
    return new Response(null, {
      status: partial ? 206 : 200,
      headers: responseHeaders
    });
  }

  const { client } = createTelegramWorkerClient(apiId, env.TG_API_HASH, payload.session);

  try {
    await client.connect();
    const stream = createTelegramFileStream(client, file, range.start, contentLength);
    return new Response(stream, {
      status: partial ? 206 : 200,
      headers: responseHeaders
    });
  } catch (error) {
    await client.disconnect();
    const code = errorCode(error);
    return mediaJson({ ok: false, error: code }, errorStatus(code));
  }
}

async function resolveMediaTokenFile(
  apiId: number,
  apiHash: string,
  sessionString: string,
  peer: string,
  messageId: number
): Promise<{ session: string; file: MediaFileDescriptor }> {
  const { client, session } = createTelegramWorkerClient(apiId, apiHash, sessionString);

  try {
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (!authorized) {
      throw new Error("stored_session_unauthorized");
    }

    const entity = await client.getEntity(bigInt(peer) as never);
    const messages = await client.getMessages(entity as never, { ids: messageId });
    const message = messages[0] as Api.Message | undefined;
    if (!message?.media) {
      throw new Error("media_message_not_found");
    }

    return {
      session: session.save(),
      file: describeMediaFile(message)
    };
  } finally {
    await client.disconnect();
  }
}

function createTelegramFileStream(
  client: TelegramClient,
  file: MediaFileDescriptor,
  start: number,
  contentLength: number
): ReadableStream<Uint8Array> {
  const location = restoreFileLocation(file);
  const iteratorLimit = Math.ceil(contentLength / TELEGRAM_PART_BYTES);
  let disconnected = false;

  async function disconnectOnce() {
    if (disconnected) {
      return;
    }

    disconnected = true;
    await client.disconnect();
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = 0;
      try {
        for await (const chunk of client.iterDownload({
          file: location,
          offset: bigInt(start),
          limit: iteratorLimit,
          chunkSize: TELEGRAM_PART_BYTES,
          requestSize: TELEGRAM_PART_BYTES,
          fileSize: bigInt(file.size),
          dcId: file.dcId
        })) {
          const bytes = new Uint8Array(chunk);
          const remaining = contentLength - sent;
          if (remaining <= 0) {
            break;
          }

          const nextBytes = bytes.byteLength > remaining ? bytes.slice(0, remaining) : bytes;
          sent += nextBytes.byteLength;
          controller.enqueue(nextBytes);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        await disconnectOnce();
      }
    },
    cancel() {
      void disconnectOnce();
    }
  });
}

function parseRange(value: string | null, size: number): ByteRange | null {
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }

  if (!value) {
    return { start: 0, end: size - 1 };
  }

  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    return null;
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }

    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return null;
  }

  const end = Math.min(requestedEnd, size - 1);
  return { start, end };
}

function describeMediaFile(message: Api.Message): MediaFileDescriptor {
  const fileInfo = utils.getFileInfo(message);
  const size = Number(fileInfo.size?.toString() || "0");
  if (!fileInfo.location || !Number.isFinite(size) || size <= 0) {
    throw new Error("media_size_unknown");
  }

  const location = fileInfo.location;
  const common = {
    dcId: fileInfo.dcId,
    size,
    mimeType: messageMimeType(message),
    fileName: messageFileName(message)
  };

  if (location instanceof Api.InputDocumentFileLocation) {
    return {
      ...common,
      type: "document",
      id: location.id.toString(),
      accessHash: location.accessHash.toString(),
      fileReference: bytesToBase64url(location.fileReference),
      thumbSize: location.thumbSize || ""
    };
  }

  if (location instanceof Api.InputPhotoFileLocation) {
    return {
      ...common,
      type: "photo",
      id: location.id.toString(),
      accessHash: location.accessHash.toString(),
      fileReference: bytesToBase64url(location.fileReference),
      thumbSize: location.thumbSize || ""
    };
  }

  throw new Error("media_location_unsupported");
}

function restoreFileLocation(file: MediaFileDescriptor): Api.TypeInputFileLocation {
  const fileReference = Buffer.from(base64urlToBytes(file.fileReference));

  if (file.type === "document") {
    return new Api.InputDocumentFileLocation({
      id: bigInt(file.id),
      accessHash: bigInt(file.accessHash),
      fileReference,
      thumbSize: file.thumbSize
    });
  }

  return new Api.InputPhotoFileLocation({
    id: bigInt(file.id),
    accessHash: bigInt(file.accessHash),
    fileReference,
    thumbSize: file.thumbSize
  });
}

function mediaStreamHeaders(
  file: MediaFileDescriptor,
  start: number,
  end: number,
  contentLength: number,
  partial: boolean
): Headers {
  const headers = new Headers({
    "content-type": file.mimeType,
    "content-length": String(contentLength),
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=300, no-transform",
    "x-content-type-options": "nosniff"
  });

  if (partial) {
    headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
  }

  if (file.fileName) {
    headers.set(
      "content-disposition",
      `inline; filename="${sanitizeHeaderFileName(file.fileName)}"; filename*=UTF-8''${encodeURIComponent(
        file.fileName
      )}`
    );
  }

  return headers;
}

function messageMimeType(message: Api.Message): string {
  if (message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document) {
    return message.media.document.mimeType || "application/octet-stream";
  }

  if (message.media instanceof Api.MessageMediaPhoto) {
    return "image/jpeg";
  }

  return "application/octet-stream";
}

function messageFileName(message: Api.Message): string {
  if (message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document) {
    const filenameAttribute = message.media.document.attributes.find(
      (attribute) => attribute instanceof Api.DocumentAttributeFilename
    );

    if (filenameAttribute instanceof Api.DocumentAttributeFilename) {
      return filenameAttribute.fileName;
    }
  }

  const extension = messageMimeType(message).split("/")[1] || "bin";
  return `media-${message.id}.${extension}`;
}

function sanitizeHeaderFileName(fileName: string): string {
  return fileName.replace(/["\r\n\\]/g, "_").replace(/[^\x20-\x7E]/g, "_");
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(code: string): number {
  if (code === "stored_session_unauthorized") {
    return 403;
  }

  if (code === "media_message_not_found" || code === "media_token_expired") {
    return 404;
  }

  if (
    code === "media_size_unknown" ||
    code === "media_location_unsupported" ||
    code === "invalid_media_token_request"
  ) {
    return 400;
  }

  return 500;
}

async function encryptPayload(payload: MediaTokenPayload, token: string): Promise<MediaTokenRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await tokenKey(token);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext);

  return {
    iv: bytesToBase64url(iv),
    data: bytesToBase64url(new Uint8Array(data))
  };
}

async function decryptPayload(record: MediaTokenRecord, token: string): Promise<MediaTokenPayload> {
  const key = await tokenKey(token);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlToBytes(record.iv) as BufferSource },
    key,
    base64urlToBytes(record.data) as BufferSource
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as MediaTokenPayload;
}

async function tokenKey(token: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tg-alive/media/${token}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function randomToken(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

function mediaJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
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
