// Truy cập chuỗi giao diện: import { t } from "@/lib/i18n"; t.common.save
import { account } from "./vi/account"
import { auth } from "./vi/auth"
import { common } from "./vi/common"
import { connections } from "./vi/connections"
import { connectionStatus } from "./vi/connection-status"
import { dashboard } from "./vi/dashboard"
import { guides } from "./vi/guides"
import { legal } from "./vi/legal"
import { logs } from "./vi/logs"
import { mcp } from "./vi/mcp"
import { reauth } from "./vi/reauth"
import { settings } from "./vi/settings"
import { updates } from "./vi/updates"
import { users } from "./vi/users"

export const t = { common, auth, users, account, connections, connectionStatus, mcp, logs, dashboard, settings, reauth, guides, updates, legal } as const
export type Messages = typeof t
