import { Buffer } from "buffer";
import { Api, TelegramClient, extensions, utils } from "telegram";
import { ConnectionTCPObfuscated } from "telegram/network/connection/TCPObfuscated";
import { StringSession } from "telegram/sessions";
import { apiUrl } from "./config";

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

// Intercept the global WebSocket constructor so that ALL WebSocket connections
// to Telegram DC servers are routed through our Worker proxy (/api/telegram-ws).
// This is more reliable than GramJS's networkSocket option because
// ConnectionTCPObfuscated may create sockets through a code path that
// bypasses the PromisedWebSockets.getWebSocketLink override.
const OriginalWebSocket = window.WebSocket;

function makeProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".web.telegram.org")) {
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams({
        host: parsed.hostname,
        port: parsed.port || "443",
        test: parsed.pathname.includes("_test") ? "1" : "0"
      });
      return `${wsProtocol}//${window.location.host}${apiUrl("/telegram-ws")}?${params.toString()}`;
    }
  } catch {
    // not a valid URL or not a Telegram host — pass through
  }
  return url;
}

const ProxiedWebSocket = function (
  this: WebSocket,
  url: string,
  protocols?: string | string[]
) {
  const proxyUrl = makeProxyUrl(url);
  if (protocols !== undefined) {
    return new OriginalWebSocket(proxyUrl, protocols);
  }
  return new OriginalWebSocket(proxyUrl);
} as unknown as typeof WebSocket;

Object.defineProperties(ProxiedWebSocket, {
  prototype: { value: OriginalWebSocket.prototype },
  CONNECTING: { value: OriginalWebSocket.CONNECTING },
  OPEN: { value: OriginalWebSocket.OPEN },
  CLOSING: { value: OriginalWebSocket.CLOSING },
  CLOSED: { value: OriginalWebSocket.CLOSED }
});

// Override the global WebSocket constructor.
window.WebSocket = ProxiedWebSocket;

export interface ClientCredentials {
  apiId: number;
  apiHash: string;
  session?: string;
}

export interface TelegramRuntime {
  client: TelegramClient;
  session: StringSession;
}

export interface DialogSummary {
  id: string;
  title: string;
  subtitle: string;
  unreadCount: number;
  date: string;
  kind: "user" | "group" | "channel" | "chat";
  entity: unknown;
}

export interface MessageSummary {
  id: number;
  text: string;
  out: boolean;
  date: string;
  media: boolean;
  mediaInfo: MessageMediaSummary | null;
  raw: Api.Message;
}

export interface MessageMediaSummary {
  kind: "photo" | "video" | "audio" | "voice" | "sticker" | "document" | "media";
  label: string;
  fileName: string;
  mimeType: string;
  downloadable: boolean;
  thumbnail: boolean;
}

export interface LoadMessagesOptions {
  limit?: number;
  offsetId?: number;
}

export interface MediaDownloadResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
}

export interface MediaStreamTokenResult {
  url: string;
  expiresIn: number;
}

export interface ServiceCodeSummary {
  code: string;
  text: string;
  date: string;
}

export class RoutedWebSockets extends extensions.PromisedWebSockets {
  override getWebSocketLink(ip: string, port: number, testServers: boolean): string {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      host: ip,
      port: String(port),
      test: testServers ? "1" : "0"
    });

    return `${wsProtocol}//${window.location.host}${apiUrl("/telegram-ws")}?${params.toString()}`;
  }
}

export function createTelegramRuntime(credentials: ClientCredentials): TelegramRuntime {
  const session = new StringSession(credentials.session || "");
  const client = new TelegramClient(session, credentials.apiId, credentials.apiHash, {
    connection: ConnectionTCPObfuscated,
    useWSS: true,
    connectionRetries: 4,
    requestRetries: 3,
    retryDelay: 1200,
    timeout: 14,
    deviceModel: "TG Alive Web",
    systemVersion: "Browser",
    appVersion: "0.1.0",
    langCode: "zh",
    systemLangCode: "zh-CN"
  });

  return { client, session };
}

export async function loadDialogs(client: TelegramClient): Promise<DialogSummary[]> {
  const dialogs = await client.getDialogs({ limit: 80 });

  return dialogs.map((dialog) => {
    const title = dialog.title || dialog.name || "未命名会话";
    const message = dialog.message as Api.Message | undefined;

    return {
      id: dialog.id?.toString() || `${title}-${dialog.date || 0}`,
      title,
      subtitle: summarizeMessage(message),
      unreadCount: dialog.unreadCount || 0,
      date: formatUnixDate(dialog.date),
      kind: dialog.isChannel ? "channel" : dialog.isGroup ? "group" : dialog.isUser ? "user" : "chat",
      entity: dialog.entity || dialog.inputEntity
    };
  });
}

export async function resolveDialog(client: TelegramClient, query: string): Promise<DialogSummary> {
  const value = query.trim();
  if (!value) {
    throw new Error("请输入用户名或手机号");
  }

  const entity = await client.getEntity(value as never);
  return dialogFromEntity(entity);
}

export async function loadMessages(
  client: TelegramClient,
  entity: unknown,
  options: LoadMessagesOptions = {}
): Promise<MessageSummary[]> {
  const messages = await client.getMessages(entity as never, {
    limit: options.limit ?? 80,
    offsetId: options.offsetId ?? 0
  });

  return messages
    .map((message) => message as Api.Message)
    .filter((message) => message.className === "Message")
    .reverse()
    .map(toMessageSummary);
}

export async function sendTextMessage(
  client: TelegramClient,
  entity: unknown,
  text: string,
  replyTo?: number
): Promise<void> {
  await client.sendMessage(entity as never, { message: text, replyTo });
}

export async function sendFileMessage(
  client: TelegramClient,
  entity: unknown,
  file: File,
  caption: string,
  onProgress: (progress: number) => void,
  replyTo?: number
): Promise<void> {
  await client.sendFile(entity as never, {
    file,
    caption,
    replyTo,
    workers: 1,
    progressCallback: onProgress
  } as never);
}

export async function editTelegramMessage(
  client: TelegramClient,
  entity: unknown,
  messageId: number,
  text: string
): Promise<void> {
  await client.editMessage(entity as never, {
    message: messageId,
    text
  });
}

export async function deleteTelegramMessage(
  client: TelegramClient,
  entity: unknown,
  messageId: number
): Promise<void> {
  await client.deleteMessages(entity as never, [messageId], { revoke: true });
}

export async function forwardTelegramMessage(
  client: TelegramClient,
  targetEntity: unknown,
  fromEntity: unknown,
  messageId: number
): Promise<void> {
  await client.forwardMessages(targetEntity as never, {
    messages: [messageId],
    fromPeer: fromEntity as never
  });
}

export async function markDialogAsRead(client: TelegramClient, entity: unknown): Promise<void> {
  await client.markAsRead(entity as never);
}

export async function downloadMessageMedia(
  client: TelegramClient,
  message: MessageSummary,
  onProgress: (progress: number) => void
): Promise<MediaDownloadResult> {
  if (!message.mediaInfo?.downloadable) {
    throw new Error("此媒体暂不支持下载");
  }

  const buffer = await client.downloadMedia(message.raw, {
    progressCallback: (
      downloaded: number | { toString(): string },
      total: number | { toString(): string }
    ) => {
      const receivedBytes = Number(downloaded.toString());
      const totalBytes = Number(total.toString());
      onProgress(totalBytes > 0 ? receivedBytes / totalBytes : 0);
    }
  } as never);

  if (!buffer || typeof buffer === "string") {
    throw new Error("媒体下载失败");
  }

  const bytes = new Uint8Array(Buffer.from(buffer));
  return {
    blob: new Blob([bytes], { type: message.mediaInfo.mimeType }),
    fileName: message.mediaInfo.fileName,
    mimeType: message.mediaInfo.mimeType
  };
}

export async function downloadMessageThumbnail(client: TelegramClient, message: MessageSummary): Promise<Blob> {
  if (!message.mediaInfo?.thumbnail) {
    throw new Error("此媒体没有可用缩略图");
  }

  const buffer = await client.downloadMedia(message.raw, { thumb: 0 } as never);
  if (!buffer || typeof buffer === "string") {
    throw new Error("缩略图下载失败");
  }

  const bytes = new Uint8Array(Buffer.from(buffer));
  return new Blob([bytes], { type: "image/jpeg" });
}

export async function createMediaStreamUrl(
  session: string,
  peer: string,
  messageId: number
): Promise<MediaStreamTokenResult> {
  const response = await fetch(apiUrl("/media-token"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ session, peer, messageId })
  });

  if (!response.ok) {
    throw new Error("视频流地址创建失败");
  }

  const data = (await response.json()) as { url?: string; expiresIn?: number };
  if (!data.url) {
    throw new Error("视频流地址无效");
  }

  return {
    url: data.url,
    expiresIn: data.expiresIn || 0
  };
}

export async function loadLatestServiceCode(client: TelegramClient): Promise<ServiceCodeSummary> {
  const serviceEntity = await client.getEntity(777000 as never);
  const messages = await client.getMessages(serviceEntity as never, { limit: 1 });
  const message = messages[0] as Api.Message | undefined;
  const text = summarizeMessage(message);
  const code = extractLoginCode(text);

  return {
    code,
    text,
    date: formatUnixDate(message?.date)
  };
}

export async function probeGateway(): Promise<boolean> {
  const response = await fetch(apiUrl("/health"), { cache: "no-store" });
  if (!response.ok) {
    return false;
  }

  const data = (await response.json()) as { ok?: boolean };
  return data.ok === true;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/_/g, " ");
  }

  return String(error);
}

function toMessageSummary(message: Api.Message): MessageSummary {
  const mediaInfo = getMessageMediaInfo(message);

  return {
    id: message.id,
    text: summarizeMessage(message, mediaInfo),
    out: Boolean(message.out),
    date: formatUnixDate(message.date),
    media: Boolean(message.media),
    mediaInfo,
    raw: message
  };
}

function dialogFromEntity(entity: unknown): DialogSummary {
  const typedEntity = entity as Api.User | Api.Chat | Api.Channel;
  const title = entityTitle(typedEntity);

  return {
    id: utils.getPeerId(typedEntity as never),
    title,
    subtitle: entitySubtitle(typedEntity),
    unreadCount: 0,
    date: "",
    kind: entityKind(typedEntity),
    entity: typedEntity
  };
}

function entityTitle(entity: Api.User | Api.Chat | Api.Channel): string {
  if (entity instanceof Api.User) {
    return [entity.firstName, entity.lastName].filter(Boolean).join(" ") || entity.username || "未命名联系人";
  }

  if (entity instanceof Api.Chat || entity instanceof Api.Channel) {
    return entity.title || "未命名会话";
  }

  return "未命名会话";
}

function entitySubtitle(entity: Api.User | Api.Chat | Api.Channel): string {
  if (entity instanceof Api.User && entity.username) {
    return `@${entity.username}`;
  }

  if (entity instanceof Api.Channel && entity.username) {
    return `@${entity.username}`;
  }

  return "新会话";
}

function entityKind(entity: Api.User | Api.Chat | Api.Channel): DialogSummary["kind"] {
  if (entity instanceof Api.User) {
    return "user";
  }

  if (entity instanceof Api.Channel) {
    return entity.megagroup ? "group" : "channel";
  }

  if (entity instanceof Api.Chat) {
    return "group";
  }

  return "chat";
}

function summarizeMessage(message?: Api.Message, mediaInfo?: MessageMediaSummary | null): string {
  if (!message) {
    return "";
  }

  if (message.message?.trim()) {
    return message.message.trim();
  }

  const resolvedMediaInfo = mediaInfo ?? getMessageMediaInfo(message);
  if (resolvedMediaInfo) {
    return `[${resolvedMediaInfo.label}]`;
  }

  return "";
}

function getMessageMediaInfo(message: Api.Message): MessageMediaSummary | null {
  const media = message.media;
  if (!media) {
    return null;
  }

  if (media instanceof Api.MessageMediaPhoto) {
    return {
      kind: "photo",
      label: "图片",
      fileName: `photo-${message.id}.jpg`,
      mimeType: "image/jpeg",
      downloadable: Boolean(media.photo),
      thumbnail: Boolean(media.photo)
    };
  }

  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const document = media.document;
    const filenameAttribute = document.attributes.find(
      (attribute) => attribute instanceof Api.DocumentAttributeFilename
    );
    const mimeType = document.mimeType || "application/octet-stream";
    const kind = getDocumentKind(document, mimeType);

    return {
      kind,
      label: mediaLabel(kind),
      fileName:
        filenameAttribute instanceof Api.DocumentAttributeFilename
          ? filenameAttribute.fileName
          : defaultMediaFileName(message.id, mimeType, kind),
      mimeType,
      downloadable: true,
      thumbnail: Boolean(document.thumbs?.length)
    };
  }

  return {
    kind: "media",
    label: "媒体",
    fileName: `media-${message.id}.bin`,
    mimeType: "application/octet-stream",
    downloadable: false,
    thumbnail: false
  };
}

function getDocumentKind(document: Api.Document, mimeType: string): MessageMediaSummary["kind"] {
  if (document.attributes.some((attribute) => attribute instanceof Api.DocumentAttributeSticker)) {
    return "sticker";
  }

  const audioAttribute = document.attributes.find((attribute) => attribute instanceof Api.DocumentAttributeAudio);
  if (audioAttribute instanceof Api.DocumentAttributeAudio) {
    return audioAttribute.voice ? "voice" : "audio";
  }

  if (document.attributes.some((attribute) => attribute instanceof Api.DocumentAttributeVideo)) {
    return "video";
  }

  if (mimeType.startsWith("image/")) {
    return "photo";
  }

  return "document";
}

function mediaLabel(kind: MessageMediaSummary["kind"]): string {
  if (kind === "photo") {
    return "图片";
  }
  if (kind === "video") {
    return "视频";
  }
  if (kind === "audio") {
    return "音频";
  }
  if (kind === "voice") {
    return "语音";
  }
  if (kind === "sticker") {
    return "贴纸";
  }
  if (kind === "document") {
    return "文件";
  }
  return "媒体";
}

function defaultMediaFileName(id: number, mimeType: string, kind: MessageMediaSummary["kind"]): string {
  const extension = mimeTypeExtension(mimeType) || (kind === "photo" ? "jpg" : "bin");
  return `${kind}-${id}.${extension}`;
}

function mimeTypeExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "video/mp4": "mp4",
    "video/webm": "webm"
  };

  return extensions[mimeType] || "";
}

function extractLoginCode(text: string): string {
  const candidate = text.match(/(?:^|[^\d])((?:\d-?){5,7})(?=$|[^\d])/)?.[1] || "";
  return candidate.replace(/-/g, "");
}

function formatUnixDate(value?: number): string {
  if (!value) {
    return "";
  }

  const date = new Date(value * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "2-digit", day: "2-digit" })
  }).format(date);
}
