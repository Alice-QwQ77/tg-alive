import { Buffer } from "buffer";
import { Api, TelegramClient, extensions } from "telegram";
import { ConnectionTCPObfuscated } from "telegram/network/connection/TCPObfuscated";
import { StringSession } from "telegram/sessions";
import { apiUrl } from "./config";

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

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
    networkSocket: RoutedWebSockets,
    useWSS: window.location.protocol === "https:",
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

export async function loadMessages(client: TelegramClient, entity: unknown): Promise<MessageSummary[]> {
  const messages = await client.getMessages(entity as never, { limit: 80 });
  return messages
    .map((message) => message as Api.Message)
    .filter((message) => message.className === "Message")
    .reverse()
    .map((message) => ({
      id: message.id,
      text: summarizeMessage(message),
      out: Boolean(message.out),
      date: formatUnixDate(message.date)
    }));
}

export async function sendTextMessage(
  client: TelegramClient,
  entity: unknown,
  text: string
): Promise<void> {
  await client.sendMessage(entity as never, { message: text });
}

export async function loadLatestServiceCode(client: TelegramClient): Promise<ServiceCodeSummary> {
  const serviceEntity = await client.getEntity(777000 as never);
  const messages = await client.getMessages(serviceEntity as never, { limit: 1 });
  const message = messages[0] as Api.Message | undefined;
  const text = summarizeMessage(message);
  const code = text.match(/\b\d{5,6}\b/)?.[0] || "";

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

function summarizeMessage(message?: Api.Message): string {
  if (!message) {
    return "";
  }

  if (message.message?.trim()) {
    return message.message.trim();
  }

  if (message.media) {
    return "[媒体消息]";
  }

  return "";
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
