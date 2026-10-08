// Credential validation + account discovery (listAccessibleCustomers → customer → customer_client tree).
import { isProviderError } from "../errors"
import type { AccountStatus, AdAccountInfo, ConnectionContext, CredentialCheck } from "../types"
import { getToken } from "./auth"
import { field, str, type GoogleAdsClient } from "./client"
import { clientFor } from "./context"
import { ADWORDS_SCOPE, type GoogleAdsCredentials } from "./credentials"

type CCtx = ConnectionContext<GoogleAdsCredentials>

/** Max sub-manager customer_client queries per discovery (each costs 1 op of the daily quota). */
const MAX_MANAGER_QUERIES = 30

const CUSTOMER_QUERY =
  "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status, customer.test_account FROM customer LIMIT 1"

const CLIENT_QUERY =
  "SELECT customer_client.client_customer, customer_client.id, customer_client.descriptive_name, customer_client.currency_code, " +
  "customer_client.time_zone, customer_client.manager, customer_client.status, customer_client.level, customer_client.test_account, customer_client.hidden " +
  "FROM customer_client WHERE customer_client.level <= 1 AND customer_client.status = 'ENABLED'"

export function mapCustomerStatus(raw: string | null): AccountStatus {
  switch (raw) {
    case "ENABLED":
      return "active"
    case "CANCELED":
    case "CLOSED":
      return "closed"
    case "SUSPENDED":
      return "disabled"
    default:
      return "unknown"
  }
}

export interface Discovery {
  accounts: AdAccountInfo[]
  /** customer id → login-customer-id (root through which it is reachable) */
  loginMap: Record<string, string>
  roots: string[]
  errors: string[]
}

export async function discoverAccounts(client: GoogleAdsClient, creds: GoogleAdsCredentials): Promise<Discovery> {
  const roots = creds.login_customer_id ? [creds.login_customer_id] : await client.listAccessibleCustomers()
  const byId = new Map<string, AdAccountInfo>()
  const loginMap: Record<string, string> = {}
  const errors: string[] = []
  let managerQueries = 0

  for (const root of roots) {
    if (byId.has(root)) continue
    let rootRow
    try {
      const page = await client.search(root, CUSTOMER_QUERY, null, { loginCustomerId: root })
      rootRow = page.results[0]
    } catch (e) {
      errors.push(`${root}: ${isProviderError(e) ? e.userMessageVi : "lỗi không xác định"}`)
      byId.set(root, {
        externalId: root,
        name: root,
        currency: "",
        timezone: "UTC",
        status: "unknown",
        statusRaw: isProviderError(e) ? String(e.upstream?.code ?? e.code) : "ERROR",
        isManager: false,
        parentExternalId: null,
        extra: { error: isProviderError(e) ? e.code : "unknown", loginCustomerId: root },
      })
      continue
    }
    if (!rootRow) continue
    const isManager = field(rootRow, "customer.manager") === true
    byId.set(root, {
      externalId: root,
      name: str(rootRow, "customer.descriptive_name") ?? root,
      currency: str(rootRow, "customer.currency_code") ?? "",
      timezone: str(rootRow, "customer.time_zone") ?? "UTC",
      status: mapCustomerStatus(str(rootRow, "customer.status")),
      statusRaw: str(rootRow, "customer.status") ?? "UNKNOWN",
      isManager,
      parentExternalId: null,
      extra: { testAccount: field(rootRow, "customer.test_account") === true, level: 0, loginCustomerId: root, reportable: !isManager },
    })
    loginMap[root] = root
    if (!isManager) continue

    // BFS over the manager hierarchy, level <= 1 per manager so we know each account's direct parent.
    const queue = [root]
    const visited = new Set<string>()
    while (queue.length) {
      const manager = queue.shift()!
      if (visited.has(manager)) continue
      visited.add(manager)
      if (managerQueries >= MAX_MANAGER_QUERIES) {
        errors.push(`Dừng khám phá ở ${MAX_MANAGER_QUERIES} tài khoản quản lý để tiết kiệm hạn mức API.`)
        break
      }
      managerQueries++
      let rows
      try {
        rows = (await client.searchAll(manager, CLIENT_QUERY, { loginCustomerId: root, maxRows: 20_000 })).rows
      } catch (e) {
        errors.push(`${manager}: ${isProviderError(e) ? e.userMessageVi : "lỗi không xác định"}`)
        continue
      }
      for (const r of rows) {
        const level = Number(field(r, "customer_client.level") ?? 0)
        const id = str(r, "customer_client.id")
        if (!id || level !== 1 || byId.has(id)) continue
        const childIsManager = field(r, "customer_client.manager") === true
        byId.set(id, {
          externalId: id,
          name: str(r, "customer_client.descriptive_name") ?? id,
          currency: str(r, "customer_client.currency_code") ?? "",
          timezone: str(r, "customer_client.time_zone") ?? "UTC",
          status: mapCustomerStatus(str(r, "customer_client.status")),
          statusRaw: str(r, "customer_client.status") ?? "UNKNOWN",
          isManager: childIsManager,
          parentExternalId: manager,
          extra: {
            testAccount: field(r, "customer_client.test_account") === true,
            hidden: field(r, "customer_client.hidden") === true,
            loginCustomerId: root,
            reportable: !childIsManager,
          },
        })
        loginMap[id] = root
        if (childIsManager) queue.push(id)
      }
    }
  }

  let accounts = [...byId.values()]
  const allow = creds.customer_ids
  if (allow.length) {
    const rootSet = new Set(roots)
    accounts = accounts.filter((a) => allow.includes(a.externalId) || (a.isManager && rootSet.has(a.externalId)))
  }
  return { accounts, loginMap, roots, errors }
}

export async function listAccounts(ctx: CCtx): Promise<AdAccountInfo[]> {
  const client = clientFor(ctx)
  return (await discoverAccounts(client, ctx.credentials)).accounts
}

export async function validateCredentials(ctx: CCtx): Promise<CredentialCheck> {
  const creds = ctx.credentials
  // 1) mint a token (throws auth_invalid with a Vietnamese hint on invalid_grant)
  await getToken(creds, { connectionId: ctx.connectionId, signal: ctx.signal, onUpstream: ctx.onUpstream, forceRefresh: true })
  const client = clientFor(ctx)
  // 2) listAccessibleCustomers (ignores login-customer-id)
  const accessible = await client.listAccessibleCustomers()
  const warnings: string[] = []
  const meta: Record<string, unknown> = {
    auth_type: creds.auth_type,
    login_customer_id: creds.login_customer_id,
    accessible_customer_ids: accessible,
  }
  if (creds.auth_type === "service_account") {
    meta.client_email = creds.client_email
    meta.project_id = creds.project_id
  }
  if (!accessible.length && !creds.login_customer_id) {
    warnings.push(
      creds.auth_type === "service_account"
        ? `Service account ${creds.client_email} chưa được thêm vào tài khoản Google Ads nào. Vào Google Ads → Admin → Access and security → Users → thêm email này (quyền Standard).`
        : "Tài khoản Google này chưa có quyền truy cập tài khoản Google Ads nào."
    )
  }
  if (creds.login_customer_id && accessible.length && !accessible.includes(creds.login_customer_id)) {
    warnings.push(
      `login_customer_id ${creds.login_customer_id} không nằm trong danh sách tài khoản truy cập trực tiếp (${accessible.join(", ")}). Nếu gặp lỗi quyền, hãy kiểm tra lại ID của MCC.`
    )
  }
  if (creds.developer_token) {
    warnings.push("Developer token đã bị Google bỏ từ 09/09/2026 - app không gửi nữa (giá trị cũ được bỏ qua, không cần nhập lại).")
  }
  if (creds.auth_type === "oauth_refresh_token") {
    warnings.push("Nhớ để OAuth consent screen ở trạng thái “In production”, nếu không refresh token sẽ hết hạn sau 7 ngày.")
  }
  // 3a) With an explicit MCC: accounts in its tree use the MCC header, directly-accessible accounts outside the
  //     tree map to themselves (loginCustomerIdFor reads this map before falling back to the MCC).
  if (creds.login_customer_id) {
    try {
      const d = await discoverAccounts(client, creds)
      const map: Record<string, string> = { ...d.loginMap }
      for (const id of accessible) if (!map[id]) map[id] = id
      meta.login_customer_map = map
      warnings.push(...d.errors)
    } catch (e) {
      warnings.push(`Không đọc được cây tài khoản: ${isProviderError(e) ? e.userMessageVi : "lỗi không xác định"}`)
    }
  }
  // 3b) Without an explicit MCC id, remember through which root each account is reachable.
  if (!creds.login_customer_id && accessible.length) {
    try {
      const d = await discoverAccounts(client, creds)
      meta.login_customer_map = d.loginMap
      meta.manager_ids = d.accounts.filter((a) => a.isManager).map((a) => a.externalId)
      warnings.push(...d.errors)
    } catch (e) {
      warnings.push(`Không đọc được cây tài khoản: ${isProviderError(e) ? e.userMessageVi : "lỗi không xác định"}`)
    }
  }
  return { valid: true, tokenExpiresAt: null, scopes: [ADWORDS_SCOPE], warnings, meta }
}
