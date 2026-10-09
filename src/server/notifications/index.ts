// Public API of the notification module (Telegram). No "next/*" imports: safe for src/server/mcp/** and the worker.
// None of the notify* / enqueue functions throws - a Telegram problem never breaks an ad operation.
export {
  buildAiCaption,
  buildAiMessage,
  escapeHtml,
  MAX_DYNAMIC_TEXT,
  type NotifyChange,
} from "./format"
export {
  creditFooter,
  TELEGRAM_CREDIT_URL,
  type CreditFooter,
} from "./credit"
export {
  formatFileSize,
  isTelegramMediaError,
  mediaPreviewLabel,
  prepareAttachment,
  TELEGRAM_CAPTION_TEXT_MAX,
  TELEGRAM_PHOTO_MAX_BYTES,
  TELEGRAM_TEXT_FILE_MAX_BYTES,
  TELEGRAM_UPLOAD_MAX_BYTES,
  TelegramMediaError,
  withMediaSlot,
  type AttachmentSource,
  type OutgoingMedia,
  type OutgoingMediaKind,
  type SendAs,
  type TelegramMediaErrorCode,
} from "./media"
export {
  enqueueNotification,
  type EnqueueNotificationInput,
  type EnqueueNotificationResult,
} from "./enqueue"
export {
  findDeliveryByDedupeKey,
  sendChannelMessageNow,
  type DeliveryRef,
  type SendNowResult,
} from "./deliver"
export {
  notifyConnectionHealth,
  notifyMcpWrite,
  notifyUpdateAvailable,
  type NotifyMcpWriteInput,
} from "./events"
