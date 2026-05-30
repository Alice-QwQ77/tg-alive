import { TelegramClient, Api } from "telegram";
import { Buffer } from "buffer";
import { ConnectionTCPObfuscated } from "telegram/network/connection/TCPObfuscated";
import { StringSession } from "telegram/sessions";

export interface TelegramServiceCodeResult {
  code: string;
  text: string;
  date: string;
  session: string;
}

export async function readTelegramServiceCode(
  apiId: number,
  apiHash: string,
  sessionString: string
): Promise<TelegramServiceCodeResult> {
  const { client, session } = createTelegramWorkerClient(apiId, apiHash, sessionString);

  try {
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (!authorized) {
      throw new Error("stored_session_unauthorized");
    }

    const serviceEntity = await client.getEntity(777000 as never);
    const messages = await client.getMessages(serviceEntity as never, { limit: 1 });
    const message = messages[0] as Api.Message | undefined;
    const text = message?.message?.trim() || "";
    const code = extractLoginCode(text);

    return {
      code,
      text,
      date: message?.date ? new Date(message.date * 1000).toISOString() : "",
      session: session.save()
    };
  } finally {
    await client.disconnect();
  }
}

export function createTelegramWorkerClient(
  apiId: number,
  apiHash: string,
  sessionString: string
): { client: TelegramClient; session: StringSession } {
  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connection: ConnectionTCPObfuscated,
    networkSocket: WorkerFetchWebSockets as never,
    useWSS: true,
    connectionRetries: 1,
    requestRetries: 1,
    retryDelay: 800,
    timeout: 12,
    autoReconnect: false,
    deviceModel: "TG Alive Worker",
    systemVersion: "Cloudflare Workers",
    appVersion: "0.1.0",
    langCode: "zh",
    systemLangCode: "zh-CN"
  });

  return { client, session };
}

function extractLoginCode(text: string): string {
  const candidate = text.match(/(?:^|[^\d])((?:\d-?){5,7})(?=$|[^\d])/)?.[1] || "";
  return candidate.replace(/-/g, "");
}

class WorkerFetchWebSockets {
  client?: WebSocket;
  stream = Buffer.alloc(0);
  closed = true;
  canRead: Promise<boolean> = Promise.resolve(false);
  resolveRead?: (value: boolean) => void;

  getWebSocketLink(ip: string, port: number, testServers: boolean): string {
    return `https://${ip}:${port}/apiws${testServers ? "_test" : ""}`;
  }

  async connect(port: number, ip: string, testServers = false): Promise<this> {
    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    this.closed = false;

    const response = await fetch(this.getWebSocketLink(ip, port, testServers), {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "binary"
      }
    });

    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`telegram_websocket_failed_${response.status}`);
    }

    this.client = response.webSocket;
    this.client.accept();
    this.receive();
    return this;
  }

  async readExactly(number: number): Promise<Buffer> {
    let readData = Buffer.alloc(0);
    while (true) {
      const chunk = await this.read(number);
      readData = Buffer.concat([readData, chunk]);
      number -= chunk.length;
      if (!number) {
        return readData;
      }
    }
  }

  async read(number: number): Promise<Buffer> {
    if (this.closed) {
      throw new Error("WebSocket was closed");
    }

    await this.canRead;
    if (this.closed) {
      throw new Error("WebSocket was closed");
    }

    const data = this.stream.slice(0, number);
    this.stream = this.stream.slice(number);
    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }

    return data;
  }

  async readAll(): Promise<Buffer> {
    if (this.closed || !(await this.canRead)) {
      throw new Error("WebSocket was closed");
    }

    const data = this.stream;
    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    return data;
  }

  write(data: Buffer): void {
    if (this.closed || !this.client) {
      throw new Error("WebSocket was closed");
    }

    this.client.send(data);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.client?.close();
  }

  receive(): void {
    this.client?.addEventListener("message", async (message) => {
      const data = await messageToBuffer(message.data);
      this.stream = Buffer.concat([this.stream, data]);
      this.resolveRead?.(true);
    });
    this.client?.addEventListener("close", () => {
      this.closed = true;
      this.resolveRead?.(false);
    });
    this.client?.addEventListener("error", () => {
      this.closed = true;
      this.resolveRead?.(false);
    });
  }

  toString(): string {
    return "WorkerFetchWebSockets";
  }
}

async function messageToBuffer(data: string | ArrayBuffer | Blob): Promise<Buffer> {
  if (typeof data === "string") {
    return Buffer.from(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  return Buffer.from(await data.arrayBuffer());
}
