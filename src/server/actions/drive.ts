"use server"
// Server actions for Google Drive (Settings → Google Drive, Connections → tab "Google Drive", MCP Drive block).
// Thin: requireUserForAction → zod → service (role / owner checks, encryption, activity log in the same
// transaction) → revalidatePath. Never returns a private key, an API key or a resource key.
// Actions that reach Google are throttled per user; saving / deleting the SYSTEM credential re-authenticates.
import { revalidatePath } from "next/cache"
import type { z } from "zod"

import { fail, ok, type ActionResult } from "@/lib/action-result"
import { drive as driveErrors } from "@/lib/i18n/vi/drive"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import {
  createDriveSourceSchema,
  createPersonalDriveCredentialSchema,
  deleteSystemDriveCredentialSchema,
  driveCredentialIdSchema,
  driveSourceIdSchema,
  listDriveSourceFilesSchema,
  mcpDriveOptionsSchema,
  previewDriveSourceSchema,
  saveSystemDriveCredentialSchema,
  updateDriveSourceSchema,
  type DriveCredentialTestResult,
  type DriveFilesPage,
  type DriveRecheckResult,
  type DriveSheetPreview,
  type DriveSourceDto,
  type DriveSourceMcpUsage,
  type DriveSourcePreview,
  type McpDriveSourceOption,
  type SystemDriveCredentialDto,
} from "@/lib/schemas/drive"
import { safeErrorForLog } from "@/server/audit/safe-error"
import {
  ReauthError,
  requestReauthVerifier,
  requireReauth,
} from "@/server/auth/reauth"
import {
  AuthorizationError,
  requireUserForAction,
  type AppSession,
} from "@/server/auth/session"
import { consumeQuota } from "@/server/db/quota"
import { loadSystemDriveCredential } from "@/server/drive/store"
import {
  createPersonalDriveCredential,
  deletePersonalDriveCredential,
  deleteSystemDriveCredential,
  DriveServiceError,
  saveSystemDriveCredential,
  testPersonalDriveCredential,
  testSystemDriveCredential,
} from "@/server/services/drive-credentials"
import {
  createDriveSource,
  deleteDriveSource,
  getDriveSourceUsage,
  listDriveSourceFiles,
  listDriveSourceOptionsForMcp,
  previewDriveSheetRows,
  previewDriveSource,
  recheckDriveSource,
  updateDriveSource,
} from "@/server/services/drive-sources"
import { checkDisclaimerAccepted } from "@/server/services/disclaimers"

const m = driveUi.service
const CONNECTIONS = "/connections"
const SETTINGS = "/settings"
const MCP = "/mcp-servers"
const sourcePath = (id: string) => `/connections/drive/${id}`

function zodFail(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {}
  for (const i of error.issues) {
    const k = i.path.join(".") || "_"
    fieldErrors[k] ??= i.message
  }
  return fail(error.issues[0]?.message ?? m.invalidInput, fieldErrors)
}

function toFail(e: unknown): ActionResult<never> {
  if (e instanceof AuthorizationError) return fail(e.message)
  if (e instanceof DriveServiceError || e instanceof ReauthError)
    return fail(e.message, e.fieldErrors)
  // unexpected: log a redacted one-liner, show a generic Vietnamese message
  console.error("[actions/drive]", safeErrorForLog(e))
  return fail(m.generic)
}

/**
 * The services put every failure of the wizard's link check on `fieldErrors.link` (format, credential, permission,
 * Google). The wizard shows a field error under the link input and everything else as an Alert, so only the
 * link-FORMAT messages keep the `link` key here (UI review M3); the message itself (`error`) is unchanged.
 */
const LINK_FORMAT_ERRORS: ReadonlySet<string> = new Set([
  m.linkRequired,
  m.kindMismatchFolder,
  m.kindMismatchSheet,
  m.sheetGidRequired,
  `${driveErrors.errors.invalid_link.message} ${driveErrors.errors.invalid_link.hint}`,
  driveErrors.errors.invalid_link.message,
])

function linkFormatErrorsOnly<T>(r: ActionResult<T>): ActionResult<T> {
  if (r.ok || !r.fieldErrors?.link || LINK_FORMAT_ERRORS.has(r.fieldErrors.link))
    return r
  const { link: _notFormat, ...rest } = r.fieldErrors
  return fail(r.error, Object.keys(rest).length ? rest : undefined)
}

/**
 * Calls that reach Google with a credential (check, save, preview, create, recheck) are throttled per user: they
 * cost the project's quota and would otherwise let a script probe keys / folders at full speed. Browsing (file grid,
 * sheet preview) has its own, larger budget.
 */
const VERIFY_QUOTA = { scope: "drive-verify", max: 20, windowMs: 60_000 }
const BROWSE_QUOTA = { scope: "drive-browse", max: 60, windowMs: 60_000 }

async function throttle(
  session: AppSession,
  q: { scope: string; max: number; windowMs: number } = VERIFY_QUOTA
): Promise<ActionResult<never> | null> {
  const r = await consumeQuota(q.scope, session.user.id, q.max, q.windowMs)
  return r.allowed ? null : fail(m.throttled)
}

function revalidateDrive(sourceId?: string) {
  revalidatePath(CONNECTIONS)
  revalidatePath(SETTINGS)
  revalidatePath(MCP)
  if (sourceId) revalidatePath(sourcePath(sourceId))
}

/** Re-auth (password + TOTP when 2FA is on) through the shared gate; failures counted + logged under `action`. */
async function reauthSystemCredential(
  session: AppSession,
  action:
    | "drive_credential.create"
    | "drive_credential.update"
    | "drive_credential.delete",
  credentialId: string | null,
  fields: { password: string; code?: string }
): Promise<void> {
  await requireReauth(
    { id: session.user.id, email: session.user.email, role: session.user.role },
    {
      action,
      target: { type: "drive_credential", id: credentialId },
      metadata: { kind: "system" },
    },
    await requestReauthVerifier(session.user, fields),
    { sessionId: session.sessionId }
  )
}

// ---------------------------------------------------------------------------
// System credential (admin)
// ---------------------------------------------------------------------------

/** Settings → Google Drive "Lưu": {serviceAccountJson?, apiKey?, clearApiKey?, password, code?}. */
export async function saveSystemDriveCredentialAction(
  input: unknown
): Promise<ActionResult<SystemDriveCredentialDto>> {
  try {
    const session = await requireUserForAction({ role: "admin" })
    const parsed = saveSystemDriveCredentialSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttle(session)
    if (throttled) return throttled
    const existing = await loadSystemDriveCredential()
    await reauthSystemCredential(
      session,
      existing ? "drive_credential.update" : "drive_credential.create",
      existing?.id ?? null,
      parsed.data
    )
    const res = await saveSystemDriveCredential(session.user, {
      serviceAccountJson: parsed.data.serviceAccountJson,
      apiKey: parsed.data.apiKey,
      clearApiKey: parsed.data.clearApiKey,
    })
    revalidateDrive()
    return ok(res, m.done.credentialSaved)
  } catch (e) {
    return toFail(e)
  }
}

/** Settings → Google Drive "Kiểm tra" (stored credential). */
export async function testSystemDriveCredentialAction(): Promise<
  ActionResult<DriveCredentialTestResult>
> {
  try {
    const session = await requireUserForAction({ role: "admin" })
    const throttled = await throttle(session)
    if (throttled) return throttled
    const res = await testSystemDriveCredential(session.user)
    revalidateDrive()
    return ok(res, res.ok ? m.done.credentialTested : undefined)
  } catch (e) {
    return toFail(e)
  }
}

/** Settings → Google Drive "Xoá": {password, code?}. Refused while sources use it. */
export async function deleteSystemDriveCredentialAction(
  input: unknown
): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction({ role: "admin" })
    const parsed = deleteSystemDriveCredentialSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const existing = await loadSystemDriveCredential()
    if (!existing) return fail(m.credentialNotFound)
    await reauthSystemCredential(
      session,
      "drive_credential.delete",
      existing.id,
      parsed.data
    )
    await deleteSystemDriveCredential(session.user)
    revalidateDrive()
    return ok(undefined, m.done.credentialDeleted)
  } catch (e) {
    return toFail(e)
  }
}

// ---------------------------------------------------------------------------
// Personal credentials
// ---------------------------------------------------------------------------

export async function createPersonalDriveCredentialAction(
  input: unknown
): Promise<ActionResult<{ id: string; clientEmail: string }>> {
  try {
    const session = await requireUserForAction()
    const parsed = createPersonalDriveCredentialSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttle(session)
    if (throttled) return throttled
    const res = await createPersonalDriveCredential(session.user, parsed.data)
    revalidatePath(CONNECTIONS)
    return ok(res, m.done.personalCreated)
  } catch (e) {
    return toFail(e)
  }
}

export async function testPersonalDriveCredentialAction(
  input: unknown
): Promise<ActionResult<DriveCredentialTestResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = driveCredentialIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttle(session)
    if (throttled) return throttled
    const res = await testPersonalDriveCredential(
      session.user,
      parsed.data.credentialId
    )
    revalidatePath(CONNECTIONS)
    return ok(res, res.ok ? m.done.credentialTested : undefined)
  } catch (e) {
    return toFail(e)
  }
}

export async function deletePersonalDriveCredentialAction(
  input: unknown
): Promise<ActionResult<undefined>> {
  try {
    const session = await requireUserForAction()
    const parsed = driveCredentialIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    await deletePersonalDriveCredential(session.user, parsed.data.credentialId)
    revalidatePath(CONNECTIONS)
    return ok(undefined, m.done.personalDeleted)
  } catch (e) {
    return toFail(e)
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Wizard "Kiểm tra": every registration check, saves nothing. */
export async function previewDriveSourceAction(
  input: unknown
): Promise<ActionResult<DriveSourcePreview>> {
  try {
    const session = await requireUserForAction()
    const parsed = previewDriveSourceSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttle(session)
    if (throttled) return throttled
    return ok(await previewDriveSource(session.user, parsed.data))
  } catch (e) {
    return linkFormatErrorsOnly(toFail(e))
  }
}

/** Wizard "Lưu" (checks run again). */
export async function createDriveSourceAction(
  input: unknown
): Promise<ActionResult<{ id: string; source: DriveSourceDto }>> {
  try {
    const session = await requireUserForAction()
    const parsed = createDriveSourceSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    // "Miễn trừ trách nhiệm" (kết nối) accepted: current version, last 12 h
    const disclaimer = await checkDisclaimerAccepted(session.user.id, "connection")
    if (!disclaimer.ok) return fail(disclaimer.error)
    const throttled = await throttle(session)
    if (throttled) return throttled
    const res = await createDriveSource(session.user, parsed.data, {
      disclaimerVersion: disclaimer.version,
    })
    revalidateDrive(res.id)
    return ok(res, m.done.sourceCreated)
  } catch (e) {
    return linkFormatErrorsOnly(toFail(e))
  }
}

export async function updateDriveSourceAction(
  input: unknown
): Promise<ActionResult<DriveSourceDto>> {
  try {
    const session = await requireUserForAction()
    const parsed = updateDriveSourceSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttle(session)
    if (throttled) return throttled
    const res = await updateDriveSource(session.user, parsed.data)
    revalidateDrive(parsed.data.sourceId)
    return ok(res, m.done.sourceUpdated)
  } catch (e) {
    return toFail(e)
  }
}

/** "Kiểm tra lại". */
export async function recheckDriveSourceAction(
  input: unknown
): Promise<ActionResult<DriveRecheckResult>> {
  try {
    const session = await requireUserForAction()
    const parsed = driveSourceIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttle(session)
    if (throttled) return throttled
    const res = await recheckDriveSource(session.user, parsed.data.sourceId)
    revalidateDrive(parsed.data.sourceId)
    return ok(res, res.ok ? m.done.sourceRechecked : undefined)
  } catch (e) {
    return toFail(e)
  }
}

/** MCPs that lose the source if it is deleted (delete dialog). */
export async function driveSourceUsageAction(
  input: unknown
): Promise<ActionResult<DriveSourceMcpUsage[]>> {
  try {
    const session = await requireUserForAction()
    const parsed = driveSourceIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    return ok(await getDriveSourceUsage(session.user, parsed.data.sourceId))
  } catch (e) {
    return toFail(e)
  }
}

export async function deleteDriveSourceAction(
  input: unknown
): Promise<
  ActionResult<{ affectedMcpIds: string[]; affectedMcpCount: number }>
> {
  try {
    const session = await requireUserForAction()
    const parsed = driveSourceIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const res = await deleteDriveSource(session.user, parsed.data.sourceId)
    revalidateDrive()
    return ok(res, m.done.sourceDeleted)
  } catch (e) {
    return toFail(e)
  }
}

/** Folder grid page ("Tải thêm", sub-folder navigation, image/video filter). */
export async function listDriveSourceFilesAction(
  input: unknown
): Promise<ActionResult<DriveFilesPage>> {
  try {
    const session = await requireUserForAction()
    const parsed = listDriveSourceFilesSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttle(session, BROWSE_QUOTA)
    if (throttled) return throttled
    return ok(await listDriveSourceFiles(session.user, parsed.data))
  } catch (e) {
    return toFail(e)
  }
}

/** Sheet detail: first rows + status counts. */
export async function previewDriveSheetRowsAction(
  input: unknown
): Promise<ActionResult<DriveSheetPreview>> {
  try {
    const session = await requireUserForAction()
    const parsed = driveSourceIdSchema.safeParse(input)
    if (!parsed.success) return zodFail(parsed.error)
    const throttled = await throttle(session, BROWSE_QUOTA)
    if (throttled) return throttled
    return ok(await previewDriveSheetRows(session.user, parsed.data.sourceId))
  } catch (e) {
    return toFail(e)
  }
}

/**
 * Options of the MCP "Google Drive" block: for a new MCP (owner = viewer) or an existing one ({mcpId}: its owner -
 * the viewer must be allowed to edit it). Pages may also call listDriveSourcesForMcpScope directly.
 */
export async function listMcpDriveSourceOptionsAction(
  input?: unknown
): Promise<ActionResult<McpDriveSourceOption[]>> {
  try {
    const session = await requireUserForAction()
    const parsed = mcpDriveOptionsSchema.safeParse(input ?? {})
    if (!parsed.success) return zodFail(parsed.error)
    return ok(await listDriveSourceOptionsForMcp(session.user, parsed.data.mcpId))
  } catch (e) {
    return toFail(e)
  }
}
