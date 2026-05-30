import {
  Check,
  Cloud,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldCheck,
  UserRound
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TelegramClient } from "telegram";
import {
  createTelegramRuntime,
  DialogSummary,
  formatError,
  loadLatestServiceCode,
  loadDialogs,
  loadMessages,
  MessageSummary,
  probeGateway,
  sendTextMessage,
  TelegramRuntime
} from "./lib/telegram";
import { APP_CONFIG, HAS_TELEGRAM_CONFIG } from "./lib/config";
import { hasCloudPassword, loadCloudSession, saveCloudSession } from "./lib/cloudSession";
import { clearSavedProfile, loadSavedProfile, saveProfile } from "./lib/storage";

type AuthPhase = "idle" | "restoring" | "sending" | "code" | "password" | "ready";

interface CredentialsForm {
  phone: string;
  cloudPassword: string;
  cloudSync: boolean;
}

export function App() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("idle");
  const [credentials, setCredentials] = useState<CredentialsForm>({
    phone: "",
    cloudPassword: APP_CONFIG.defaultSessionPassword,
    cloudSync: true
  });
  const [gatewayOk, setGatewayOk] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordHint, setPasswordHint] = useState("");
  const [status, setStatus] = useState("等待连接");
  const [error, setError] = useState("");
  const [me, setMe] = useState("");
  const [dialogs, setDialogs] = useState<DialogSummary[]>([]);
  const [activeDialogId, setActiveDialogId] = useState("");
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [loadingServiceCode, setLoadingServiceCode] = useState(false);
  const [serviceMessage, setServiceMessage] = useState("");

  const runtimeRef = useRef<TelegramRuntime | null>(null);
  const pendingInputRef = useRef<((value: string) => void) | null>(null);
  const restoredRef = useRef(false);

  const activeDialog = useMemo(
    () => dialogs.find((dialog) => dialog.id === activeDialogId) || null,
    [activeDialogId, dialogs]
  );

  const filteredDialogs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return dialogs;
    }

    return dialogs.filter((dialog) => dialog.title.toLowerCase().includes(normalizedQuery));
  }, [dialogs, query]);

  const refreshDialogs = useCallback(async () => {
    const client = runtimeRef.current?.client;
    if (!client) {
      return;
    }

    setLoadingDialogs(true);
    try {
      const nextDialogs = await loadDialogs(client);
      setDialogs(nextDialogs);
      setActiveDialogId((current) => current || nextDialogs[0]?.id || "");
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setLoadingDialogs(false);
    }
  }, []);

  const openDialog = useCallback(async (dialog: DialogSummary) => {
    const client = runtimeRef.current?.client;
    if (!client) {
      return;
    }

    setActiveDialogId(dialog.id);
    setLoadingMessages(true);
    setError("");
    try {
      setMessages(await loadMessages(client, dialog.entity));
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const finishAuthorized = useCallback(
    async (
      runtime: TelegramRuntime,
      currentCredentials: CredentialsForm,
      options: { persistCloud?: boolean } = {}
    ) => {
      runtimeRef.current = runtime;
      setAuthPhase("ready");
      setStatus("已连接");
      setError("");

      const user = await runtime.client.getMe();
      setMe(user.username ? `@${user.username}` : [user.firstName, user.lastName].filter(Boolean).join(" "));

      saveProfile({
        phone: currentCredentials.phone,
        cloudSync: currentCredentials.cloudSync
      });

      if (options.persistCloud !== false && currentCredentials.cloudSync) {
        try {
          await saveCloudSession(
            currentCredentials.phone,
            currentCredentials.cloudPassword,
            runtime.session.save()
          );
          setStatus("已连接，云端会话已保存");
        } catch (caught) {
          setStatus("已连接，云端保存失败");
          setError(formatError(caught));
        }
      }

      await refreshDialogs();
    },
    [refreshDialogs]
  );

  const restoreCloudSession = useCallback(
    async (nextCredentials: CredentialsForm) => {
      if (!HAS_TELEGRAM_CONFIG || !APP_CONFIG.apiId) {
        setError("缺少 VITE_TG_API_ID 或 VITE_TG_API_HASH");
        return;
      }

      if (!nextCredentials.phone.trim()) {
        setError("请填写手机号");
        return;
      }

      if (!hasCloudPassword(nextCredentials.cloudPassword)) {
        setError("云端同步密码至少需要 8 位");
        return;
      }

      setAuthPhase("restoring");
      setStatus("正在读取云端会话");
      setError("");

      try {
        const session = await loadCloudSession(nextCredentials.phone, nextCredentials.cloudPassword);
        if (!session) {
          throw new Error("未找到云端会话");
        }

        const runtime = createTelegramRuntime({
          apiId: APP_CONFIG.apiId,
          apiHash: APP_CONFIG.apiHash,
          session
        });
        await runtime.client.connect();
        const authorized = await runtime.client.checkAuthorization();
        if (!authorized) {
          throw new Error("云端会话已失效");
        }

        await finishAuthorized(runtime, nextCredentials, { persistCloud: false });
        const refreshedSession = runtime.session.save();
        if (nextCredentials.cloudSync && refreshedSession && refreshedSession !== session) {
          try {
            await saveCloudSession(nextCredentials.phone, nextCredentials.cloudPassword, refreshedSession);
            setStatus("已连接，会话已刷新");
          } catch (caught) {
            setError(formatError(caught));
          }
        }
      } catch (caught) {
        setAuthPhase("idle");
        setStatus("恢复失败");
        setError(formatError(caught));
      }
    },
    [finishAuthorized]
  );

  const restoreSavedSession = useCallback(async () => {
    const saved = loadSavedProfile();
    if (!saved || !saved.cloudSync || !APP_CONFIG.defaultSessionPassword) {
      return;
    }

    const nextCredentials = {
      phone: saved.phone,
      cloudPassword: APP_CONFIG.defaultSessionPassword,
      cloudSync: saved.cloudSync
    };
    setCredentials(nextCredentials);
    await restoreCloudSession(nextCredentials);
  }, [restoreCloudSession]);

  useEffect(() => {
    if (restoredRef.current) {
      return;
    }
    restoredRef.current = true;

    void probeGateway()
      .then(setGatewayOk)
      .catch(() => setGatewayOk(false));
    void restoreSavedSession();
  }, [restoreSavedSession]);

  useEffect(() => {
    if (!activeDialog || authPhase !== "ready") {
      return;
    }

    void openDialog(activeDialog);
    const timer = window.setInterval(() => {
      void openDialog(activeDialog);
    }, 12000);

    return () => window.clearInterval(timer);
  }, [activeDialog, authPhase, openDialog]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!HAS_TELEGRAM_CONFIG || !APP_CONFIG.apiId) {
      setError("缺少 VITE_TG_API_ID 或 VITE_TG_API_HASH");
      return;
    }

    if (!credentials.phone.trim()) {
      setError("请填写手机号");
      return;
    }

    if (credentials.cloudSync && !hasCloudPassword(credentials.cloudPassword)) {
      setError("云端同步密码至少需要 8 位");
      return;
    }

    setAuthPhase("sending");
    setStatus("正在发送验证码");

    try {
      const runtime = createTelegramRuntime({
        apiId: APP_CONFIG.apiId,
        apiHash: APP_CONFIG.apiHash
      });
      runtimeRef.current = runtime;

      await runtime.client.start({
        phoneNumber: async () => credentials.phone.trim(),
        phoneCode: async (isCodeViaApp) => {
          setAuthPhase("code");
          setStatus(isCodeViaApp ? "验证码已发送到 Telegram 应用" : "验证码已通过短信发送");
          return waitForUserInput();
        },
        password: async (hint) => {
          setPasswordHint(hint || "");
          setAuthPhase("password");
          setStatus("需要两步验证密码");
          return waitForUserInput();
        },
        onError: async (caught) => {
          setError(formatError(caught));
          return true;
        }
      });

      await finishAuthorized(runtime, credentials);
    } catch (caught) {
      setAuthPhase("idle");
      setStatus("登录失败");
      setError(formatError(caught));
    }
  }

  function waitForUserInput(): Promise<string> {
    return new Promise((resolve) => {
      pendingInputRef.current = resolve;
    });
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = code.trim();
    if (!value) {
      return;
    }
    pendingInputRef.current?.(value);
    pendingInputRef.current = null;
    setCode("");
    setAuthPhase("sending");
    setStatus("正在验证");
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password) {
      return;
    }
    pendingInputRef.current?.(password);
    pendingInputRef.current = null;
    setPassword("");
    setAuthPhase("sending");
    setStatus("正在验证");
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = runtimeRef.current?.client;
    const text = draft.trim();
    if (!client || !activeDialog || !text) {
      return;
    }

    setSendingMessage(true);
    setError("");
    try {
      await sendTextMessage(client, activeDialog.entity, text);
      setDraft("");
      setMessages(await loadMessages(client, activeDialog.entity));
      await refreshDialogs();
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setSendingMessage(false);
    }
  }

  async function readServiceCode() {
    const client = runtimeRef.current?.client;
    if (!client) {
      return;
    }

    setLoadingServiceCode(true);
    setError("");
    setServiceMessage("");
    try {
      const result = await loadLatestServiceCode(client);
      if (!result.text) {
        setServiceMessage("没有读取到 777000 服务消息");
        return;
      }

      setServiceMessage(
        result.code
          ? `服务验证码：${result.code}${result.date ? ` · ${result.date}` : ""}`
          : result.text
      );
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setLoadingServiceCode(false);
    }
  }

  async function logout() {
    const client: TelegramClient | undefined = runtimeRef.current?.client;
    runtimeRef.current = null;
    clearSavedProfile();
    setAuthPhase("idle");
    setDialogs([]);
    setMessages([]);
    setActiveDialogId("");
    setMe("");
    setStatus("已清除本机会话");
    setError("");

    try {
      await client?.disconnect();
    } catch {
      // Local logout should not be blocked by a failed disconnect.
    }
  }

  if (authPhase !== "ready") {
    return (
      <main className="login-page">
        <section className="login-panel">
          <div className="brand-row">
            <div className="brand-mark">
              <Send size={24} aria-hidden="true" />
            </div>
            <div>
              <h1>Telegram</h1>
              <p>TG Alive</p>
            </div>
          </div>

          <div className={`gateway-badge ${gatewayOk ? "is-ok" : gatewayOk === false ? "is-bad" : ""}`}>
            <Server size={16} aria-hidden="true" />
            <span>{gatewayOk === null ? "检测网关" : gatewayOk ? "网关正常" : "网关不可用"}</span>
          </div>

          {authPhase === "code" ? (
            <form className="form-stack" onSubmit={submitCode}>
              <label>
                <span>验证码</span>
                <input
                  autoFocus
                  inputMode="numeric"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="12345"
                />
              </label>
              <button className="primary-button" type="submit">
                <Check size={18} aria-hidden="true" />
                <span>验证</span>
              </button>
            </form>
          ) : authPhase === "password" ? (
            <form className="form-stack" onSubmit={submitPassword}>
              <label>
                <span>两步验证密码{passwordHint ? ` · ${passwordHint}` : ""}</span>
                <input
                  autoFocus
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button className="primary-button" type="submit">
                <KeyRound size={18} aria-hidden="true" />
                <span>继续</span>
              </button>
            </form>
          ) : (
            <form className="form-stack" onSubmit={handleLogin}>
              {!HAS_TELEGRAM_CONFIG ? (
                <div className="error-line">缺少 VITE_TG_API_ID 或 VITE_TG_API_HASH</div>
              ) : null}
              <label>
                <span>手机号</span>
                <input
                  value={credentials.phone}
                  onChange={(event) => setCredentials({ ...credentials, phone: event.target.value })}
                  placeholder="+8613800000000"
                />
              </label>
              <label>
                <span>云端同步密码</span>
                <input
                  type="password"
                  value={credentials.cloudPassword}
                  onChange={(event) => setCredentials({ ...credentials, cloudPassword: event.target.value })}
                  placeholder="至少 8 位"
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={credentials.cloudSync}
                  onChange={(event) => setCredentials({ ...credentials, cloudSync: event.target.checked })}
                />
                <span>云端保存登录状态</span>
              </label>
              <div className="button-row">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={authPhase === "sending" || authPhase === "restoring"}
                  onClick={() => void restoreCloudSession(credentials)}
                >
                  {authPhase === "restoring" ? (
                    <Loader2 className="spin" size={18} aria-hidden="true" />
                  ) : (
                    <Cloud size={18} aria-hidden="true" />
                  )}
                  <span>恢复</span>
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={authPhase === "sending" || authPhase === "restoring"}
                >
                  {authPhase === "sending" ? (
                    <Loader2 className="spin" size={18} aria-hidden="true" />
                  ) : (
                    <ShieldCheck size={18} aria-hidden="true" />
                  )}
                  <span>登录</span>
                </button>
              </div>
            </form>
          )}

          <div className="status-line">{status}</div>
          {error ? <div className="error-line">{error}</div> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="account-pill">
            <UserRound size={18} aria-hidden="true" />
            <span>{me || "Telegram"}</span>
          </div>
          <div className="toolbar">
            <button className="icon-button" type="button" onClick={() => void refreshDialogs()} title="刷新">
              {loadingDialogs ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            </button>
            <button className="icon-button" type="button" onClick={() => void readServiceCode()} title="服务验证码">
              {loadingServiceCode ? <Loader2 className="spin" size={18} /> : <KeyRound size={18} />}
            </button>
            <button className="icon-button" type="button" onClick={() => void logout()} title="退出">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <label className="search-box">
          <Search size={17} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" />
        </label>

        <nav className="dialog-list" aria-label="会话">
          {filteredDialogs.map((dialog) => (
            <button
              className={`dialog-item ${dialog.id === activeDialogId ? "is-active" : ""}`}
              type="button"
              key={dialog.id}
              onClick={() => void openDialog(dialog)}
            >
              <span className={`avatar avatar-${dialog.kind}`}>{makeInitials(dialog.title)}</span>
              <span className="dialog-main">
                <span className="dialog-title-row">
                  <strong>{dialog.title}</strong>
                  <time>{dialog.date}</time>
                </span>
                <span className="dialog-preview">{dialog.subtitle || " "}</span>
              </span>
              {dialog.unreadCount ? <span className="unread">{dialog.unreadCount}</span> : null}
            </button>
          ))}
        </nav>
      </aside>

      <section className="chat-pane">
        <header className="chat-header">
          <div>
            <h2>{activeDialog?.title || "选择会话"}</h2>
            <p>{activeDialog ? kindLabel(activeDialog.kind) : status}</p>
          </div>
          {loadingMessages ? <Loader2 className="spin" size={20} aria-hidden="true" /> : null}
        </header>

        <div className="message-list">
          {messages.length === 0 ? (
            <div className="empty-state">暂无消息</div>
          ) : (
            messages.map((message) => (
              <article className={`message-bubble ${message.out ? "is-out" : "is-in"}`} key={message.id}>
                <p>{message.text || "[空消息]"}</p>
                <time>{message.date}</time>
              </article>
            ))
          )}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!activeDialog || sendingMessage}
            placeholder={activeDialog ? "输入消息" : "先选择会话"}
          />
          <button className="send-button" type="submit" disabled={!activeDialog || !draft.trim() || sendingMessage} title="发送">
            {sendingMessage ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          </button>
        </form>

        {error ? <div className="toast-error">{error}</div> : serviceMessage ? <div className="toast-info">{serviceMessage}</div> : null}
      </section>
    </main>
  );
}

function makeInitials(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function kindLabel(kind: DialogSummary["kind"]): string {
  if (kind === "channel") {
    return "频道";
  }
  if (kind === "group") {
    return "群组";
  }
  if (kind === "user") {
    return "联系人";
  }
  return "聊天";
}
