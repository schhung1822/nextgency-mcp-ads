// Public API of the notification module (Telegram). No "next/*" imports: safe for src/server/mcp/** and the worker.
// None of the notify* / enqueue functions throws - a Telegram problem never breaks an ad operation.
export {
  buildAiMessage,
  escapeHtml,
  MAX_DYNAMIC_TEXT,
  type NotifyChange,
} from "./format"
export {
  enqueueNotification,
  type EnqueueNotificationInput,
  type EnqueueNotificationResult,
} from "./enqueue"
export { sendChannelMessageNow, type SendNowResult } from "./deliver"
export {
  notifyConnectionHealth,
  notifyMcpWrite,
  notifyUpdateAvailable,
  type NotifyMcpWriteInput,
} from "./events"
