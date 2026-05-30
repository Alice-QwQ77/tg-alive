import {
  ArrowLeft,
  Check,
  Cloud,
  Download,
  FileText,
  Forward,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  LogOut,
  Music,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Server,
  ShieldCheck,
  Trash2,
  UserRound,
  Video,
  X
} from "lucide-react";
import { ChangeEvent, FormEvent, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events";
import { DeletedMessage } from "telegram/events/DeletedMessage";
import { EditedMessage } from "telegram/events/EditedMessage";
import { Raw } from "telegram/events/Raw";
import { UpdateConnectionState } from "telegram/network";
import {
  createTelegramRuntime,
  createMediaStreamUrl,
  deleteTelegramMessage,
  DialogSummary,
  downloadMessageMedia,
  downloadMessageThumbnail,
  editTelegramMessage,
  forwardTelegramMessage,
  formatError,
  loadLatestServiceCode,
  loadDialogs,
  loadMessages,
  markDialogAsRead,
  MessageMediaSummary,
  MessageSummary,
  probeGateway,
  resolveDialog,
  sendFileMessage,
  sendTextMessage,
  TelegramRuntime
} from "./lib/telegram";
import { APP_CONFIG, HAS_TELEGRAM_CONFIG } from "./lib/config";
import { hasCloudPassword, loadCloudSession, saveCloudSession } from "./lib/cloudSession";
import { clearSavedProfile, loadSavedProfile, saveProfile } from "./lib/storage";

const DPlayerVideo = lazy(() =>
  import("./components/DPlayerVideo").then((module) => ({ default: module.DPlayerVideo }))
);

type AuthPhase = "idle" | "restoring" | "sending" | "code" | "password" | "ready";
type RealtimeStatus = "idle" | "connected" | "syncing" | "reconnecting" | "offline" | "error";
const MESSAGE_PAGE_SIZE = 60;
const REALTIME_STATUS_LABELS: Record<RealtimeStatus, string> = {
  idle: "未连接",
  connected: "实时同步",
  syncing: "同步中",
  reconnecting: "正在重连",
  offline: "连接中断",
  error: "同步失败"
};

interface CredentialsForm {
  phone: string;
  cloudPassword: string;
  cloudSync: boolean;
}

interface MediaDownloadState {
  status: "loading" | "ready" | "stream" | "error";
  progress: number;
  fileName?: string;
  mimeType?: string;
  url?: string;
  error?: string;
}

interface ForwardDraft {
  message: MessageSummary;
  fromEntity: unknown;
  fromTitle: string;
}

type RealtimeEvent = NewMessage | EditedMessage | DeletedMessage;

interface RealtimeBinding {
  callback: (event: unknown) => void;
  event: RealtimeEvent | Raw;
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
  const [messageQuery, setMessageQuery] = useState("");
  const [mobileMessageSearchOpen, setMobileMessageSearchOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [peerQuery, setPeerQuery] = useState("");
  const [resolvingPeer, setResolvingPeer] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTarget, setReplyTarget] = useState<MessageSummary | null>(null);
  const [editingTarget, setEditingTarget] = useState<MessageSummary | null>(null);
  const [forwardDraft, setForwardDraft] = useState<ForwardDraft | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<number | null>(null);
  const [loadingServiceCode, setLoadingServiceCode] = useState(false);
  const [serviceMessage, setServiceMessage] = useState("");
  const [mediaDownloads, setMediaDownloads] = useState<Record<number, MediaDownloadState>>({});
  const [mediaPosters, setMediaPosters] = useState<Record<number, string>>({});
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("idle");
  const [isMobileView, setIsMobileView] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 760px)").matches
  );

  const runtimeRef = useRef<TelegramRuntime | null>(null);
  const pendingInputRef = useRef<((value: string) => void) | null>(null);
  const restoredRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeDialogRef = useRef<DialogSummary | null>(null);
  const isMobileViewRef = useRef(isMobileView);
  const messagesRef = useRef<MessageSummary[]>([]);
  const mediaDownloadsRef = useRef<Record<number, MediaDownloadState>>({});
  const mediaPostersRef = useRef<Record<number, string>>({});
  const loadingPostersRef = useRef<Set<number>>(new Set());
  const realtimeHandlersRef = useRef<RealtimeBinding[]>([]);
  const realtimeTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectingRef = useRef(false);
  const attemptRealtimeReconnectRef = useRef<() => Promise<void>>(async () => undefined);

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

  const filteredMessages = useMemo(() => {
    const normalizedQuery = messageQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return messages;
    }

    return messages.filter((message) => message.text.toLowerCase().includes(normalizedQuery));
  }, [messageQuery, messages]);

  const realtimeLabel = REALTIME_STATUS_LABELS[realtimeStatus];

  useEffect(() => {
    isMobileViewRef.current = isMobileView;
  }, [isMobileView]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const updateMobileView = () => setIsMobileView(query.matches);

    updateMobileView();
    query.addEventListener("change", updateMobileView);
    return () => query.removeEventListener("change", updateMobileView);
  }, []);

  useEffect(() => {
    if (!isMobileView && !activeDialogId && dialogs[0]) {
      setActiveDialogId(dialogs[0].id);
    }
  }, [activeDialogId, dialogs, isMobileView]);

  useEffect(() => {
    activeDialogRef.current = activeDialog;
  }, [activeDialog]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    mediaDownloadsRef.current = mediaDownloads;
  }, [mediaDownloads]);

  useEffect(() => {
    mediaPostersRef.current = mediaPosters;
  }, [mediaPosters]);

  useEffect(() => {
    messages.forEach((message) => {
      if (
        message.mediaInfo?.kind === "video" &&
        message.mediaInfo.thumbnail &&
        !mediaPosters[message.id] &&
        !loadingPostersRef.current.has(message.id)
      ) {
        void loadVideoPoster(message);
      }
    });
  }, [mediaPosters, messages]);

  const refreshDialogs = useCallback(async () => {
    const client = runtimeRef.current?.client;
    if (!client) {
      return;
    }

    setLoadingDialogs(true);
    try {
      const nextDialogs = await loadDialogs(client);
      setDialogs(nextDialogs);
      setActiveDialogId((current) => current || (isMobileViewRef.current ? "" : nextDialogs[0]?.id || ""));
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setLoadingDialogs(false);
    }
  }, []);

  const clearMediaDownloads = useCallback(() => {
    Object.values(mediaDownloadsRef.current).forEach((download) => {
      if (download.url?.startsWith("blob:")) {
        URL.revokeObjectURL(download.url);
      }
    });
    Object.values(mediaPostersRef.current).forEach((url) => URL.revokeObjectURL(url));
    mediaDownloadsRef.current = {};
    mediaPostersRef.current = {};
    loadingPostersRef.current.clear();
    setMediaDownloads({});
    setMediaPosters({});
  }, []);

  const refreshActiveMessages = useCallback(async (dialog: DialogSummary | null = activeDialogRef.current) => {
    const client = runtimeRef.current?.client;
    if (!client || !dialog) {
      return;
    }

    const visibleCount = Math.max(MESSAGE_PAGE_SIZE, messagesRef.current.length);
    const nextMessages = await loadMessages(client, dialog.entity, { limit: visibleCount });
    setMessages(nextMessages);
    setHasMoreMessages((current) =>
      messagesRef.current.length > MESSAGE_PAGE_SIZE ? current : nextMessages.length >= MESSAGE_PAGE_SIZE
    );
  }, []);

  const clearRealtimeReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleRealtimeReconnect = useCallback(() => {
    if (!runtimeRef.current || reconnectTimerRef.current !== null || reconnectingRef.current) {
      return;
    }

    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(30_000, 1200 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 400);
    setRealtimeStatus("reconnecting");
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void attemptRealtimeReconnectRef.current();
    }, delay);
  }, []);

  const attemptRealtimeReconnect = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || reconnectingRef.current) {
      return;
    }

    reconnectingRef.current = true;
    setRealtimeStatus("reconnecting");
    try {
      if (!runtime.client.connected) {
        await runtime.client.connect();
      }

      const authorized = await runtime.client.checkAuthorization();
      if (!authorized) {
        throw new Error("登录状态已失效");
      }

      reconnectAttemptRef.current = 0;
      setStatus("已连接");
      setError((current) => (current.startsWith("实时连接中断") ? "" : current));
      setRealtimeStatus("syncing");
      await refreshDialogs();
      await refreshActiveMessages();
      setRealtimeStatus("connected");
    } catch (caught) {
      reconnectAttemptRef.current += 1;
      setRealtimeStatus("offline");
      setStatus("连接中断，等待自动重连");
      setError(`实时连接中断，正在后台重连：${formatError(caught)}`);
      reconnectingRef.current = false;
      scheduleRealtimeReconnect();
    } finally {
      reconnectingRef.current = false;
    }
  }, [refreshActiveMessages, refreshDialogs, scheduleRealtimeReconnect]);

  useEffect(() => {
    attemptRealtimeReconnectRef.current = attemptRealtimeReconnect;
  }, [attemptRealtimeReconnect]);

  const cleanupRealtimeHandlers = useCallback(() => {
    if (realtimeTimerRef.current !== null) {
      window.clearTimeout(realtimeTimerRef.current);
      realtimeTimerRef.current = null;
    }
    clearRealtimeReconnectTimer();
    reconnectAttemptRef.current = 0;
    reconnectingRef.current = false;

    const client = runtimeRef.current?.client;
    if (client) {
      realtimeHandlersRef.current.forEach((binding) => {
        client.removeEventHandler(binding.callback, binding.event as never);
      });
    }
    realtimeHandlersRef.current = [];
  }, [clearRealtimeReconnectTimer]);

  const registerRealtimeHandlers = useCallback(
    (client: TelegramClient) => {
      cleanupRealtimeHandlers();

      const scheduleRefresh = () => {
        setRealtimeStatus("syncing");
        if (realtimeTimerRef.current !== null) {
          return;
        }

        realtimeTimerRef.current = window.setTimeout(() => {
          realtimeTimerRef.current = null;
          void (async () => {
            try {
              await refreshDialogs();
              await refreshActiveMessages();
              reconnectAttemptRef.current = 0;
              setRealtimeStatus("connected");
            } catch (caught) {
              setRealtimeStatus("error");
              setError(formatError(caught));
              scheduleRealtimeReconnect();
            }
          })();
        }, 400);
      };

      const handleConnectionState = (event: unknown) => {
        const state = readConnectionState(event);
        if (state === null) {
          return;
        }

        if (state === UpdateConnectionState.connected) {
          clearRealtimeReconnectTimer();
          reconnectAttemptRef.current = 0;
          setError((current) => (current.startsWith("实时连接中断") ? "" : current));
          setRealtimeStatus("connected");
          void refreshDialogs();
          void refreshActiveMessages();
          return;
        }

        setRealtimeStatus(state === UpdateConnectionState.broken ? "error" : "offline");
        scheduleRealtimeReconnect();
      };

      const bindings: RealtimeBinding[] = [
        { callback: scheduleRefresh, event: new NewMessage({}) },
        { callback: scheduleRefresh, event: new EditedMessage({}) },
        { callback: scheduleRefresh, event: new DeletedMessage({}) },
        { callback: handleConnectionState, event: new Raw({}) }
      ];

      bindings.forEach((binding) => {
        client.addEventHandler(binding.callback as never, binding.event as never);
      });
      realtimeHandlersRef.current = bindings;
      setRealtimeStatus("connected");
    },
    [
      cleanupRealtimeHandlers,
      clearRealtimeReconnectTimer,
      refreshActiveMessages,
      refreshDialogs,
      scheduleRealtimeReconnect
    ]
  );

  const openDialog = useCallback(
    async (dialog: DialogSummary) => {
      const client = runtimeRef.current?.client;
      if (!client) {
        return;
      }

      if (activeDialogId !== dialog.id) {
        setMessageQuery("");
        setMobileMessageSearchOpen(false);
        setReplyTarget(null);
        setEditingTarget(null);
        setDraft("");
        setSelectedFile(null);
        setUploadProgress(0);
        clearMediaDownloads();
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }

      setActiveDialogId(dialog.id);
      setLoadingMessages(true);
      setError("");
      try {
        const nextMessages = await loadMessages(client, dialog.entity, { limit: MESSAGE_PAGE_SIZE });
        setMessages(nextMessages);
        setHasMoreMessages(nextMessages.length >= MESSAGE_PAGE_SIZE);
        void markDialogAsRead(client, dialog.entity)
          .then(() => {
            setDialogs((currentDialogs) => {
              let changed = false;
              const nextDialogs = currentDialogs.map((currentDialog) => {
                if (currentDialog.id !== dialog.id || currentDialog.unreadCount === 0) {
                  return currentDialog;
                }

                changed = true;
                return { ...currentDialog, unreadCount: 0 };
              });

              return changed ? nextDialogs : currentDialogs;
            });
          })
          .catch(() => undefined);
      } catch (caught) {
        setError(formatError(caught));
      } finally {
        setLoadingMessages(false);
      }
    },
    [activeDialogId, clearMediaDownloads]
  );

  const finishAuthorized = useCallback(
    async (
      runtime: TelegramRuntime,
      currentCredentials: CredentialsForm,
      options: { persistCloud?: boolean } = {}
    ) => {
      runtimeRef.current = runtime;
      registerRealtimeHandlers(runtime.client);
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
    [refreshDialogs, registerRealtimeHandlers]
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
  }, [activeDialog, authPhase, openDialog]);

  useEffect(
    () => () => {
      cleanupRealtimeHandlers();
      clearMediaDownloads();
    },
    [cleanupRealtimeHandlers, clearMediaDownloads]
  );

  async function selectDialog(dialog: DialogSummary) {
    if (forwardDraft) {
      await forwardMessageToDialog(dialog);
      return;
    }

    await openDialog(dialog);
  }

  async function forwardMessageToDialog(dialog: DialogSummary) {
    const client = runtimeRef.current?.client;
    if (!client || !forwardDraft) {
      return;
    }

    setError("");
    try {
      await forwardTelegramMessage(client, dialog.entity, forwardDraft.fromEntity, forwardDraft.message.id);
      setForwardDraft(null);
      setServiceMessage(`已转发到 ${dialog.title}`);
      setDialogs((currentDialogs) => upsertDialog(dialog, currentDialogs));
      await refreshDialogs();
      await openDialog(dialog);
    } catch (caught) {
      setError(formatError(caught));
    }
  }

  async function submitPeer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = runtimeRef.current?.client;
    if (!client || !peerQuery.trim()) {
      return;
    }

    setResolvingPeer(true);
    setError("");
    try {
      const dialog = await resolveDialog(client, peerQuery);
      setDialogs((currentDialogs) => upsertDialog(dialog, currentDialogs));
      setPeerQuery("");
      setNewChatOpen(false);

      if (forwardDraft) {
        await forwardMessageToDialog(dialog);
      } else {
        await openDialog(dialog);
      }
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setResolvingPeer(false);
    }
  }

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
    const file = selectedFile;
    if (!client || !activeDialog || (!text && !file)) {
      return;
    }
    if (editingTarget && !text) {
      return;
    }

    setSendingMessage(true);
    setUploadProgress(0);
    setError("");
    try {
      if (editingTarget) {
        await editTelegramMessage(client, activeDialog.entity, editingTarget.id, text);
        setEditingTarget(null);
      } else if (file) {
        await sendFileMessage(client, activeDialog.entity, file, text, (progress) => {
          setUploadProgress(Math.round(Math.min(1, Math.max(0, progress)) * 100));
        }, replyTarget?.id);
        setSelectedFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      } else {
        await sendTextMessage(client, activeDialog.entity, text, replyTarget?.id);
      }

      setDraft("");
      setReplyTarget(null);
      setUploadProgress(0);
      setMessages(await loadMessages(client, activeDialog.entity));
      await refreshDialogs();
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setSendingMessage(false);
    }
  }

  async function loadOlderMessages() {
    const client = runtimeRef.current?.client;
    const oldestMessageId = messages[0]?.id;
    if (!client || !activeDialog || !oldestMessageId || loadingOlderMessages) {
      return;
    }

    setLoadingOlderMessages(true);
    setError("");
    try {
      const olderMessages = await loadMessages(client, activeDialog.entity, {
        limit: MESSAGE_PAGE_SIZE,
        offsetId: oldestMessageId
      });
      setMessages((currentMessages) => mergeMessages(olderMessages, currentMessages));
      setHasMoreMessages(olderMessages.length >= MESSAGE_PAGE_SIZE);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setLoadingOlderMessages(false);
    }
  }

  async function loadVideoPoster(message: MessageSummary) {
    const client = runtimeRef.current?.client;
    if (!client || !message.mediaInfo?.thumbnail || loadingPostersRef.current.has(message.id)) {
      return;
    }

    loadingPostersRef.current.add(message.id);
    try {
      const poster = await downloadMessageThumbnail(client, message);
      const url = URL.createObjectURL(poster);
      setMediaPosters((currentPosters) => {
        if (currentPosters[message.id]) {
          URL.revokeObjectURL(currentPosters[message.id]);
        }
        return { ...currentPosters, [message.id]: url };
      });
    } catch {
      // A poster is an enhancement; playback can still use the range stream.
    } finally {
      loadingPostersRef.current.delete(message.id);
    }
  }

  async function startVideoStream(message: MessageSummary) {
    const runtime = runtimeRef.current;
    if (!runtime || !activeDialog || mediaDownloads[message.id]?.status === "loading") {
      return;
    }

    setMediaDownloads((currentDownloads) => ({
      ...currentDownloads,
      [message.id]: {
        status: "loading",
        progress: 0,
        fileName: message.mediaInfo?.fileName,
        mimeType: message.mediaInfo?.mimeType
      }
    }));
    setError("");

    try {
      const stream = await createMediaStreamUrl(runtime.session.save(), activeDialog.id, message.id);
      setMediaDownloads((currentDownloads) => ({
        ...currentDownloads,
        [message.id]: {
          status: "stream",
          progress: 0,
          fileName: message.mediaInfo?.fileName,
          mimeType: message.mediaInfo?.mimeType,
          url: stream.url
        }
      }));
    } catch (caught) {
      setMediaDownloads((currentDownloads) => ({
        ...currentDownloads,
        [message.id]: {
          status: "error",
          progress: 0,
          fileName: message.mediaInfo?.fileName,
          mimeType: message.mediaInfo?.mimeType,
          error: formatError(caught)
        }
      }));
      setError(formatError(caught));
    }
  }

  async function downloadMedia(message: MessageSummary) {
    const client = runtimeRef.current?.client;
    if (!client || !message.mediaInfo?.downloadable || mediaDownloads[message.id]?.status === "loading") {
      return;
    }

    setMediaDownloads((currentDownloads) => ({
      ...currentDownloads,
      [message.id]: {
        status: "loading",
        progress: 0,
        fileName: message.mediaInfo?.fileName,
        mimeType: message.mediaInfo?.mimeType
      }
    }));
    setError("");

    try {
      const result = await downloadMessageMedia(client, message, (progress) => {
        setMediaDownloads((currentDownloads) => ({
          ...currentDownloads,
          [message.id]: {
            ...(currentDownloads[message.id] || { status: "loading" as const }),
            status: "loading",
            progress: Math.round(Math.min(1, Math.max(0, progress)) * 100)
          }
        }));
      });
      const url = URL.createObjectURL(result.blob);
      setMediaDownloads((currentDownloads) => {
        const previousUrl = currentDownloads[message.id]?.url;
        if (previousUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(previousUrl);
        }

        return {
          ...currentDownloads,
          [message.id]: {
            status: "ready",
            progress: 100,
            fileName: result.fileName,
            mimeType: result.mimeType,
            url
          }
        };
      });
    } catch (caught) {
      setMediaDownloads((currentDownloads) => ({
        ...currentDownloads,
        [message.id]: {
          status: "error",
          progress: 0,
          fileName: message.mediaInfo?.fileName,
          mimeType: message.mediaInfo?.mimeType,
          error: formatError(caught)
        }
      }));
      setError(formatError(caught));
    }
  }

  async function deleteMessage(messageId: number) {
    const client = runtimeRef.current?.client;
    if (!client || !activeDialog || deletingMessageId) {
      return;
    }

    setDeletingMessageId(messageId);
    setError("");
    try {
      await deleteTelegramMessage(client, activeDialog.entity, messageId);
      setMessages((currentMessages) => currentMessages.filter((message) => message.id !== messageId));
      if (replyTarget?.id === messageId) {
        setReplyTarget(null);
      }
      if (editingTarget?.id === messageId) {
        setEditingTarget(null);
      }
      setMediaDownloads((currentDownloads) => {
        if (currentDownloads[messageId]?.url?.startsWith("blob:")) {
          URL.revokeObjectURL(currentDownloads[messageId].url);
        }
        const nextDownloads = { ...currentDownloads };
        delete nextDownloads[messageId];
        return nextDownloads;
      });
      setMediaPosters((currentPosters) => {
        if (currentPosters[messageId]) {
          URL.revokeObjectURL(currentPosters[messageId]);
        }
        const nextPosters = { ...currentPosters };
        delete nextPosters[messageId];
        return nextPosters;
      });
      await refreshDialogs();
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setDeletingMessageId(null);
    }
  }

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFile(event.target.files?.[0] || null);
    setUploadProgress(0);
  }

  function clearSelectedFile() {
    setSelectedFile(null);
    setUploadProgress(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function closeMobileChat() {
    setActiveDialogId("");
    setMessages([]);
    setHasMoreMessages(false);
    setMessageQuery("");
    setMobileMessageSearchOpen(false);
    setReplyTarget(null);
    setEditingTarget(null);
    setSelectedFile(null);
    setUploadProgress(0);
    clearMediaDownloads();
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function startReply(message: MessageSummary) {
    setEditingTarget(null);
    setReplyTarget(message);
  }

  function startEdit(message: MessageSummary) {
    setReplyTarget(null);
    setEditingTarget(message);
    setDraft(message.text);
    setSelectedFile(null);
    setUploadProgress(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function startForward(message: MessageSummary) {
    if (!activeDialog) {
      return;
    }

    setForwardDraft({
      message,
      fromEntity: activeDialog.entity,
      fromTitle: activeDialog.title
    });
    setNewChatOpen(false);
  }

  function clearComposerContext() {
    setReplyTarget(null);
    setEditingTarget(null);
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
    cleanupRealtimeHandlers();
    clearMediaDownloads();
    runtimeRef.current = null;
    clearSavedProfile();
    setAuthPhase("idle");
    setDialogs([]);
    setMessages([]);
    setHasMoreMessages(false);
    setActiveDialogId("");
    setMobileMessageSearchOpen(false);
    setForwardDraft(null);
    setNewChatOpen(false);
    setPeerQuery("");
    setMe("");
    setRealtimeStatus("idle");
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
    <main className={`app-shell ${activeDialog ? "has-active-dialog" : "has-dialog-list"}`}>
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="account-pill">
            <UserRound size={18} aria-hidden="true" />
            <span>{me || "Telegram"}</span>
          </div>
          <div className="toolbar">
            <button
              className="icon-button"
              type="button"
              onClick={() => setNewChatOpen((current) => !current)}
              title="新聊天"
            >
              <Plus size={18} />
            </button>
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

        {newChatOpen ? (
          <form className="new-chat-form" onSubmit={submitPeer}>
            <input
              value={peerQuery}
              onChange={(event) => setPeerQuery(event.target.value)}
              placeholder="@username 或手机号"
            />
            <button type="submit" disabled={resolvingPeer || !peerQuery.trim()} title="打开">
              {resolvingPeer ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Send size={16} />}
            </button>
          </form>
        ) : null}

        {forwardDraft ? (
          <div className="forward-banner">
            <Forward size={17} aria-hidden="true" />
            <span>
              <strong>选择转发目标</strong>
              <span>{forwardDraft.message.text || `[${forwardDraft.fromTitle}]`}</span>
            </span>
            <button className="file-remove" type="button" onClick={() => setForwardDraft(null)} title="取消">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <nav className="dialog-list" aria-label="会话">
          {filteredDialogs.map((dialog) => (
            <button
              className={`dialog-item ${dialog.id === activeDialogId ? "is-active" : ""}`}
              type="button"
              key={dialog.id}
              onClick={() => void selectDialog(dialog)}
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
          {isMobileView && activeDialog ? (
            <button className="mobile-back-button" type="button" onClick={closeMobileChat} title="返回">
              <ArrowLeft size={22} aria-hidden="true" />
            </button>
          ) : null}
          <div className="chat-title">
            <h2>{activeDialog?.title || "选择会话"}</h2>
            {activeDialog ? (
              <p className={`connection-line is-${realtimeStatus}`}>
                <span className="connection-dot" aria-hidden="true" />
                <span>{`${kindLabel(activeDialog.kind)} · ${realtimeLabel}`}</span>
              </p>
            ) : (
              <p>{status}</p>
            )}
          </div>
          <div className={`chat-header-tools ${isMobileView && mobileMessageSearchOpen ? "has-mobile-search" : ""}`}>
            {activeDialog ? (
              <>
                {!isMobileView || mobileMessageSearchOpen ? (
                  <label className={`message-search ${isMobileView ? "is-mobile-open" : ""}`}>
                    <Search size={16} aria-hidden="true" />
                    <input
                      value={messageQuery}
                      onChange={(event) => setMessageQuery(event.target.value)}
                      placeholder="搜索消息"
                    />
                  </label>
                ) : null}
                {isMobileView ? (
                  <button
                    className="icon-button mobile-search-toggle"
                    type="button"
                    onClick={() => setMobileMessageSearchOpen((current) => !current)}
                    title={mobileMessageSearchOpen ? "关闭搜索" : "搜索消息"}
                  >
                    {mobileMessageSearchOpen ? <X size={18} aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
                  </button>
                ) : null}
              </>
            ) : null}
            {loadingMessages ? <Loader2 className="spin" size={20} aria-hidden="true" /> : null}
          </div>
        </header>

        <div className="message-list">
          {messages.length === 0 ? (
            <div className="empty-state">暂无消息</div>
          ) : (
            <>
              {!messageQuery.trim() && hasMoreMessages ? (
                <div className="history-loader">
                  <button type="button" onClick={() => void loadOlderMessages()} disabled={loadingOlderMessages}>
                    {loadingOlderMessages ? <Loader2 className="spin" size={15} aria-hidden="true" /> : null}
                    <span>加载更早消息</span>
                  </button>
                </div>
              ) : null}
              {filteredMessages.length === 0 ? (
                <div className="empty-state">没有匹配消息</div>
              ) : (
                filteredMessages.map((message) => {
                  const downloadState = mediaDownloads[message.id];
                  const canEdit = message.out && Boolean(message.text) && !message.mediaInfo;
                  const isVideo = message.mediaInfo?.mimeType.startsWith("video/") || message.mediaInfo?.kind === "video";
                  const posterUrl = mediaPosters[message.id];
                  return (
                    <article className={`message-bubble ${message.out ? "is-out" : "is-in"}`} key={message.id}>
                      <div className="message-content">
                        <p>{message.text || (message.media ? "[媒体消息]" : "[空消息]")}</p>
                        <span className="message-actions">
                          <button
                            className="message-action"
                            type="button"
                            onClick={() => startReply(message)}
                            title="回复"
                          >
                            <Reply size={14} aria-hidden="true" />
                          </button>
                          <button
                            className="message-action"
                            type="button"
                            onClick={() => startForward(message)}
                            title="转发"
                          >
                            <Forward size={14} aria-hidden="true" />
                          </button>
                          {canEdit ? (
                            <button
                              className="message-action"
                              type="button"
                              onClick={() => startEdit(message)}
                              title="编辑"
                            >
                              <Pencil size={14} aria-hidden="true" />
                            </button>
                          ) : null}
                          <button
                            className="message-action"
                            type="button"
                            disabled={deletingMessageId === message.id}
                            onClick={() => void deleteMessage(message.id)}
                            title="删除消息"
                          >
                            {deletingMessageId === message.id ? (
                              <Loader2 className="spin" size={14} aria-hidden="true" />
                            ) : (
                              <Trash2 size={14} aria-hidden="true" />
                            )}
                          </button>
                        </span>
                      </div>
                      {message.mediaInfo ? (
                        <div className="media-card">
                          {downloadState?.status === "ready" &&
                          downloadState.url &&
                          downloadState.mimeType?.startsWith("image/") ? (
                            <img className="media-preview" src={downloadState.url} alt="" />
                          ) : null}
                          {downloadState?.status === "stream" && downloadState.url && isVideo ? (
                            <Suspense
                              fallback={
                                <div className="video-loading">
                                  <Loader2 className="spin" size={20} aria-hidden="true" />
                                </div>
                              }
                            >
                              <DPlayerVideo url={downloadState.url} poster={posterUrl} />
                            </Suspense>
                          ) : null}
                          {downloadState?.status !== "stream" && posterUrl && isVideo ? (
                            <div className="video-poster">
                              <img src={posterUrl} alt="" />
                              <span>
                                <Video size={20} aria-hidden="true" />
                              </span>
                            </div>
                          ) : null}
                          {downloadState?.status === "ready" &&
                          downloadState.url &&
                          downloadState.mimeType?.startsWith("audio/") ? (
                            <audio className="audio-preview" src={downloadState.url} controls preload="metadata" />
                          ) : null}
                          <div className="media-row">
                            <span className={`media-icon media-icon-${message.mediaInfo.kind}`}>
                              {renderMediaIcon(message.mediaInfo.kind)}
                            </span>
                            <span className="media-meta">
                              <strong>{message.mediaInfo.label}</strong>
                              <span title={message.mediaInfo.fileName}>{message.mediaInfo.fileName}</span>
                            </span>
                            <button
                              className="media-download"
                              type="button"
                              disabled={
                                !message.mediaInfo.downloadable ||
                                downloadState?.status === "loading" ||
                                downloadState?.status === "ready" ||
                                downloadState?.status === "stream"
                              }
                              onClick={() => void (isVideo ? startVideoStream(message) : downloadMedia(message))}
                              title={isVideo ? "流式预览" : "下载媒体"}
                            >
                              {downloadState?.status === "loading" ? (
                                <span>{isVideo ? "准备" : `${downloadState.progress}%`}</span>
                              ) : (
                                <Download size={16} aria-hidden="true" />
                              )}
                            </button>
                            {downloadState?.status === "ready" && downloadState.url ? (
                              <a
                                className="media-link"
                                href={downloadState.url}
                                download={downloadState.fileName || message.mediaInfo.fileName}
                              >
                                保存
                              </a>
                            ) : null}
                            {downloadState?.status === "stream" && isVideo ? (
                              <button
                                className="media-link"
                                type="button"
                                onClick={() => void startVideoStream(message)}
                                title="刷新视频地址"
                              >
                                <RefreshCw size={14} aria-hidden="true" />
                              </button>
                            ) : null}
                          </div>
                          {downloadState?.status === "error" ? (
                            <div className="media-error">{downloadState.error || "下载失败"}</div>
                          ) : null}
                        </div>
                      ) : null}
                      <time>{message.date}</time>
                    </article>
                  );
                })
              )}
            </>
          )}
        </div>

        <div className="composer-area">
          {editingTarget || replyTarget ? (
            <div className={`composer-context ${editingTarget ? "is-editing" : ""}`}>
              {editingTarget ? <Pencil size={17} aria-hidden="true" /> : <Reply size={17} aria-hidden="true" />}
              <span>
                <strong>{editingTarget ? "编辑消息" : "回复消息"}</strong>
                <span>{(editingTarget || replyTarget)?.text || "[媒体消息]"}</span>
              </span>
              <button className="file-remove" type="button" onClick={clearComposerContext} title="取消">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {selectedFile ? (
            <div className="file-strip">
              <Paperclip size={17} aria-hidden="true" />
              <strong title={selectedFile.name}>{selectedFile.name}</strong>
              <span>{sendingMessage ? `${uploadProgress}%` : formatFileSize(selectedFile.size)}</span>
              <button
                className="file-remove"
                type="button"
                onClick={clearSelectedFile}
                disabled={sendingMessage}
                title="移除附件"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <form className="composer" onSubmit={sendMessage}>
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              onChange={selectFile}
              disabled={!activeDialog || sendingMessage || Boolean(editingTarget)}
              aria-label="选择附件"
            />
            <button
              className="attach-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!activeDialog || sendingMessage || Boolean(editingTarget)}
              title="添加附件"
            >
              <Paperclip size={19} aria-hidden="true" />
            </button>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={!activeDialog || sendingMessage}
              placeholder={editingTarget ? "编辑消息" : activeDialog ? "输入消息" : "先选择会话"}
            />
            <button
              className="send-button"
              type="submit"
              disabled={!activeDialog || (!draft.trim() && !selectedFile) || sendingMessage}
              title="发送"
            >
              {sendingMessage ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            </button>
          </form>
        </div>

        {error ? <div className="toast-error">{error}</div> : serviceMessage ? <div className="toast-info">{serviceMessage}</div> : null}
      </section>
    </main>
  );
}

function mergeMessages(olderMessages: MessageSummary[], currentMessages: MessageSummary[]): MessageSummary[] {
  const seen = new Set<number>();
  const merged: MessageSummary[] = [];

  [...olderMessages, ...currentMessages].forEach((message) => {
    if (seen.has(message.id)) {
      return;
    }

    seen.add(message.id);
    merged.push(message);
  });

  return merged;
}

function upsertDialog(dialog: DialogSummary, dialogs: DialogSummary[]): DialogSummary[] {
  const exists = dialogs.some((currentDialog) => currentDialog.id === dialog.id);
  if (exists) {
    return dialogs.map((currentDialog) => (currentDialog.id === dialog.id ? { ...currentDialog, ...dialog } : currentDialog));
  }

  return [dialog, ...dialogs];
}

function renderMediaIcon(kind: MessageMediaSummary["kind"]) {
  if (kind === "photo" || kind === "sticker") {
    return <ImageIcon size={18} aria-hidden="true" />;
  }

  if (kind === "video") {
    return <Video size={18} aria-hidden="true" />;
  }

  if (kind === "audio" || kind === "voice") {
    return <Music size={18} aria-hidden="true" />;
  }

  return <FileText size={18} aria-hidden="true" />;
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

function readConnectionState(event: unknown): number | null {
  if (event instanceof UpdateConnectionState) {
    return event.state;
  }

  if (!event || typeof event !== "object" || !("state" in event)) {
    return null;
  }

  const state = Number((event as { state: unknown }).state);
  return [UpdateConnectionState.disconnected, UpdateConnectionState.broken, UpdateConnectionState.connected].includes(
    state
  )
    ? state
    : null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
