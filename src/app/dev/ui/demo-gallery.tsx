"use client"

import * as React from "react"
import {
  Add01Icon,
  Delete02Icon,
  Download01Icon,
  McpServerIcon,
  MoreHorizontalIcon,
  Plug01Icon,
  Refresh01Icon,
  Activity01Icon,
  Alert02Icon,
  Wallet01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"

import {
  BrandLogo,
  BrandMark,
  BrandWordmark,
  ConfirmDialog,
  ContextualSaveBar,
  CopyField,
  createDataTableColumnHelper,
  DataTable,
  DateRangePicker,
  EmptyState,
  FilterBar,
  GlassCard,
  GlassCardDescription,
  GlassCardHeader,
  GlassCardTitle,
  getStatusMeta,
  HelpPanel,
  JsonViewer,
  KpiCard,
  PageHeader,
  PermissionBadges,
  PlatformBadge,
  PlatformIcon,
  RelativeTime,
  resolveDatePreset,
  SecretInput,
  StatusBadge,
  statusValues,
  Stepper,
  ThemeToggle,
  TransparencyToggle,
  type DateRangeValue,
  type FilterValues,
  type SortingState,
  type StatusKind,
} from "@/components/app"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatDate, formatDuration, formatNumber } from "@/lib/format"
import { PLATFORM_LABELS } from "@/lib/constants"
import { PLATFORMS } from "@/server/providers/types"

import {
  DEMO_CONNECTIONS,
  DEMO_ERROR_SPARK,
  DEMO_GUIDE,
  DEMO_JSON,
  DEMO_SPARK,
  demoLogPage,
  type DemoConnection,
  type DemoLog,
} from "./demo-data"

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div>
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Connections table (client mode)
// ---------------------------------------------------------------------------

const conn = createDataTableColumnHelper<DemoConnection>()
const connectionColumns = conn.columns([
  conn.accessor("name", {
    header: "Tên",
    cell: ({ row }) => (
      <span className="flex items-center gap-2 font-medium">
        <PlatformIcon platform={row.original.platform} colored />
        {row.original.name}
      </span>
    ),
  }),
  conn.accessor("platform", {
    header: "Nền tảng",
    cell: ({ getValue }) => <PlatformBadge platform={getValue()} />,
  }),
  conn.accessor("owner", { header: "Người tạo" }),
  conn.accessor("accounts", {
    header: "TKQC",
    meta: { align: "end", className: "tabular-nums" },
  }),
  conn.accessor("status", {
    header: "Trạng thái",
    cell: ({ getValue }) => (
      <StatusBadge kind="connection" status={getValue()} />
    ),
  }),
  conn.accessor("tokenExpiresAt", {
    header: "Hạn token",
    cell: ({ getValue }) => {
      const v = getValue()
      return (
        <span className="tabular-nums">{v ? formatDate(v) : "Không hạn"}</span>
      )
    },
    sortUndefined: "last",
  }),
  conn.accessor("checkedAt", {
    header: "Kiểm tra lúc",
    cell: ({ getValue }) => (
      <RelativeTime value={getValue()} className="text-muted-foreground" />
    ),
  }),
  conn.display({
    id: "actions",
    header: () => <span className="sr-only">Hành động</span>,
    meta: { align: "end", className: "w-12" },
    cell: ({ row }) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Hành động cho ${row.original.name}`}
          >
            <HugeiconsIcon
              icon={MoreHorizontalIcon}
              strokeWidth={2}
              aria-hidden
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() =>
              toast.success(`Đang kiểm tra lại "${row.original.name}"…`)
            }
          >
            <HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} aria-hidden />
            Kiểm tra lại
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => toast.error("Chỉ là bản demo")}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} aria-hidden />
            Xoá kết nối
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  }),
])

function ConnectionsDemo() {
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<FilterValues>({})
  const [open, setOpen] = React.useState<DemoConnection | null>(null)
  const [tab, setTab] = React.useState("all")

  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return DEMO_CONNECTIONS.filter((c) => {
      if (tab !== "all" && c.platform !== tab) return false
      if (q && !c.name.toLowerCase().includes(q)) return false
      const st = filters.status ?? []
      if (st.length && !st.includes(c.status)) return false
      const pl = filters.platform ?? []
      if (pl.length && !pl.includes(c.platform)) return false
      return true
    })
  }, [search, filters, tab])

  return (
    <Card className="gap-0 py-0">
      <Tabs value={tab} onValueChange={setTab} className="gap-0">
        <div className="overflow-x-auto border-b px-3 pt-3">
          <TabsList variant="line">
            <TabsTrigger value="all">Tất cả</TabsTrigger>
            {PLATFORMS.map((p) => (
              <TabsTrigger key={p} value={p}>
                <PlatformIcon platform={p} />
                {PLATFORM_LABELS[p]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={tab} className="flex flex-col">
          <div className="border-b p-3">
            <FilterBar
              search={{
                value: search,
                onChange: setSearch,
                placeholder: "Tìm theo tên kết nối…",
              }}
              filters={[
                {
                  id: "status",
                  label: "Trạng thái",
                  options: statusValues("connection").map((s) => ({
                    value: s,
                    label: getStatusMeta("connection", s).label,
                    count: DEMO_CONNECTIONS.filter((c) => c.status === s)
                      .length,
                  })),
                },
                {
                  id: "platform",
                  label: "Nền tảng",
                  options: PLATFORMS.map((p) => ({
                    value: p,
                    label: PLATFORM_LABELS[p],
                    icon: <PlatformIcon platform={p} colored />,
                  })),
                },
              ]}
              values={filters}
              onValuesChange={setFilters}
              end={
                <Button variant="outline" size="sm">
                  <HugeiconsIcon
                    icon={Download01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  Xuất CSV
                </Button>
              }
            />
          </div>
          <DataTable
            ariaLabel="Danh sách kết nối"
            columns={connectionColumns}
            data={data}
            getRowId={(r) => r.id}
            defaultSorting={[{ id: "name", desc: false }]}
            pageSize={5}
            enableRowSelection
            onRowClick={setOpen}
            activeRowId={open?.id}
            bulkActions={(rows, clear) => (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    toast.success(`Đang kiểm tra lại ${rows.length} kết nối…`)
                    clear()
                  }}
                >
                  <HugeiconsIcon
                    icon={Refresh01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  Kiểm tra lại
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => toast.error("Chỉ là bản demo")}
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  Xoá
                </Button>
              </>
            )}
            empty={
              <EmptyState
                title="Không tìm thấy kết nối"
                description="Thử bỏ bớt bộ lọc hoặc đổi từ khoá tìm kiếm."
                icon={Plug01Icon}
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFilters({})
                      setSearch("")
                      setTab("all")
                    }}
                  >
                    Xoá bộ lọc
                  </Button>
                }
              />
            }
            renderMobileCard={(c) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <PlatformIcon platform={c.platform} colored />
                    <span className="truncate">{c.name}</span>
                  </span>
                  <StatusBadge kind="connection" status={c.status} />
                </div>
                <p className="text-[13px] text-muted-foreground">
                  {c.owner} · {c.accounts} TKQC ·{" "}
                  <RelativeTime value={c.checkedAt} />
                </p>
              </div>
            )}
          />
        </TabsContent>
      </Tabs>
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-md">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <PlatformIcon
                    platform={open.platform}
                    colored
                    className="size-5"
                  />
                  {open.name}
                </SheetTitle>
                <SheetDescription>
                  {PLATFORM_LABELS[open.platform]} · {open.accounts} tài khoản
                  quảng cáo
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6">
                <div className="flex flex-wrap gap-2">
                  <StatusBadge kind="connection" status={open.status} />
                  <PlatformBadge platform={open.platform} />
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Người tạo</dt>
                  <dd>{open.owner}</dd>
                  <dt className="text-muted-foreground">Hạn token</dt>
                  <dd className="tabular-nums">
                    {open.tokenExpiresAt
                      ? formatDate(open.tokenExpiresAt)
                      : "Không hạn"}
                  </dd>
                  <dt className="text-muted-foreground">Kiểm tra lúc</dt>
                  <dd>
                    <RelativeTime value={open.checkedAt} />
                  </dd>
                </dl>
                <JsonViewer
                  label="Dữ liệu kết nối (đã ẩn token)"
                  data={{ ...open, credential_hint: "EAAB…x9Q2" }}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Logs table (server / keyset mode)
// ---------------------------------------------------------------------------

const log = createDataTableColumnHelper<DemoLog>()
const logColumns = log.columns([
  log.accessor("at", {
    header: "Thời gian",
    cell: ({ getValue }) => <RelativeTime value={getValue()} />,
  }),
  log.accessor("mcp", { header: "MCP", enableSorting: false }),
  log.accessor("client", { header: "Client", enableSorting: false }),
  log.accessor("tool", {
    header: "Tool",
    enableSorting: false,
    cell: ({ getValue }) => (
      <code className="font-mono text-xs">{getValue()}</code>
    ),
  }),
  log.accessor("platform", {
    header: "Nền tảng",
    enableSorting: false,
    cell: ({ getValue }) => <PlatformBadge platform={getValue()} iconOnly />,
  }),
  log.accessor("status", {
    header: "Trạng thái",
    enableSorting: false,
    cell: ({ getValue }) => <StatusBadge kind="log" status={getValue()} />,
  }),
  log.accessor("durationMs", {
    header: "Thời lượng",
    meta: { align: "end", className: "tabular-nums" },
    cell: ({ getValue }) => formatDuration(getValue()),
  }),
])

function LogsDemo() {
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "at", desc: true },
  ])
  const [rows, setRows] = React.useState<DemoLog[]>(() => demoLogPage(0).rows)
  const [cursor, setCursor] = React.useState<number | null>(
    () => demoLogPage(0).nextCursor
  )
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [range, setRange] = React.useState<DateRangeValue>(() =>
    resolveDatePreset("last7")
  )
  const [selected, setSelected] = React.useState<DemoLog | null>(null)

  const sorted = React.useMemo(() => {
    // pretend the server sorted for us
    const s = sorting[0]
    if (!s) return rows
    const dir = s.desc ? -1 : 1
    return [...rows].sort((a, b) =>
      a[s.id as keyof DemoLog] > b[s.id as keyof DemoLog] ? dir : -dir
    )
  }, [rows, sorting])

  return (
    <Card className="gap-0 py-0">
      <div className="border-b p-3">
        <FilterBar
          end={
            <span className="text-[13px] text-muted-foreground tabular-nums">
              {formatNumber(rows.length)} dòng đã tải
            </span>
          }
        >
          <DateRangePicker value={range} onChange={(v) => setRange(v)} />
        </FilterBar>
      </div>
      <DataTable
        mode="server"
        ariaLabel="Nhật ký MCP"
        columns={logColumns}
        data={sorted}
        getRowId={(r) => r.id}
        sorting={sorting}
        onSortingChange={setSorting}
        onRowClick={setSelected}
        activeRowId={selected?.id}
        serverPagination={{
          hasNextPage: cursor !== null,
          loadingMore,
          onLoadMore: () => {
            if (cursor === null) return
            setLoadingMore(true)
            setTimeout(() => {
              const page = demoLogPage(cursor)
              setRows((r) => [...r, ...page.rows])
              setCursor(page.nextCursor)
              setLoadingMore(false)
            }, 600)
          },
        }}
      />
      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.tool}</SheetTitle>
                <SheetDescription>
                  {selected.mcp} · {selected.client}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6">
                <StatusBadge kind="log" status={selected.status} />
                <JsonViewer
                  label="Request / Response"
                  data={DEMO_JSON}
                  defaultExpandDepth={2}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Wizard + form
// ---------------------------------------------------------------------------

const WIZARD_STEPS = [
  { title: "Tên", description: "Đặt tên dễ nhớ" },
  { title: "Nền tảng & tài khoản", description: "Chọn TKQC" },
  { title: "Quyền", description: "Xem, sửa, tạo…" },
  { title: "Bảo vệ", description: "Xác nhận 2 bước" },
]

function WizardDemo() {
  const [step, setStep] = React.useState(1)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tạo MCP</CardTitle>
        <CardDescription>
          Stepper ngang, bấm bước đã xong để quay lại.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Stepper steps={WIZARD_STEPS} current={step} onStepClick={setStep} />
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nội dung bước {step + 1}: {WIZARD_STEPS[step]?.title ?? "Hoàn tất"}
        </div>
        <div className="flex justify-between">
          <Button
            variant="outline"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Quay lại
          </Button>
          <Button
            onClick={() => setStep((s) => Math.min(WIZARD_STEPS.length, s + 1))}
            disabled={step >= WIZARD_STEPS.length}
          >
            Tiếp tục
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function FormDemo() {
  const initial = { name: "BM chính", token: "" }
  const [form, setForm] = React.useState(initial)
  const [saving, setSaving] = React.useState(false)
  const dirty = form.name !== initial.name || form.token !== initial.token
  return (
    <div className="flex flex-col">
      <ContextualSaveBar
        open={dirty}
        saving={saving}
        onDiscard={() => setForm(initial)}
        onSave={() => {
          setSaving(true)
          setTimeout(() => {
            setSaving(false)
            toast.success("Đã lưu thay đổi")
          }, 800)
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>Thông tin kết nối</CardTitle>
          <CardDescription>
            Sửa một ô để thấy thanh &quot;Có thay đổi chưa lưu&quot;.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="demo-name">Tên kết nối</FieldLabel>
              <Input
                id="demo-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <FieldDescription>
                Tên giúp bạn nhận ra kết nối trong danh sách.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="demo-token">Access token</FieldLabel>
              <SecretInput
                id="demo-token"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
                placeholder="Dán token mới…"
                savedHint="EAAB…x9Q2"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="demo-json">
                Service account JSON (nhiều dòng)
              </FieldLabel>
              <SecretInput
                id="demo-json"
                multiline
                placeholder='{"type": "service_account", …}'
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="demo-link">Link MCP</FieldLabel>
              <CopyField
                id="demo-link"
                label="Link MCP"
                value="https://ads.example.com/mcp/amcp_7Yh2kQ9xR4tLm8Vb"
              />
              <FieldDescription>
                Ai có link này đều dùng được MCP. Không chia sẻ công khai.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

const FIVE_MINUTES_AGO = new Date(Date.now() - 5 * 60_000)
const YESTERDAY = new Date(Date.now() - 26 * 3_600_000)

const STATUS_KINDS: { kind: StatusKind; label: string }[] = [
  { kind: "connection", label: "Kết nối" },
  { kind: "mcp", label: "MCP" },
  { kind: "log", label: "Nhật ký" },
  { kind: "object", label: "Chiến dịch / nhóm / quảng cáo" },
  { kind: "account", label: "Tài khoản quảng cáo" },
]

export function DemoGallery() {
  const [range, setRange] = React.useState<DateRangeValue | null>(null)
  const [showEmpty, setShowEmpty] = React.useState(true)

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-10">
      <PageHeader
        breadcrumbs={[
          { label: "Dev", href: "/dev/ui" },
          { label: "Thư viện giao diện" },
        ]}
        title="Thư viện giao diện"
        description="Mọi component dùng chung của Ads MCP với dữ liệu mẫu - chỉ có ở môi trường phát triển."
        titleMeta={<Badge variant="outline">Dev</Badge>}
        secondaryActions={[
          {
            label: "Xuất CSV",
            icon: Download01Icon,
            onSelect: () => toast("Đang xuất CSV…"),
          },
          {
            label: "Làm mới",
            icon: Refresh01Icon,
            onSelect: () => toast.success("Đã làm mới"),
          },
          {
            label: "Xoá dữ liệu mẫu",
            icon: Delete02Icon,
            destructive: true,
            onSelect: () => toast.error("Chỉ là bản demo"),
          },
        ]}
        primaryAction={
          <Button
            variant="brand"
            onClick={() => toast.success("Bắt đầu tạo MCP")}
          >
            <HugeiconsIcon
              icon={Add01Icon}
              strokeWidth={2}
              data-icon="inline-start"
              aria-hidden
            />
            Tạo MCP
          </Button>
        }
      />

      <Section
        id="kpi"
        title="Thẻ số liệu (glass)"
        description="Hàng KPI ở trang Tổng quan."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <KpiCard
            label="Kết nối"
            value="6"
            hint="2 cảnh báo"
            hintTone="warning"
            icon={Plug01Icon}
            href="/connections"
          />
          <KpiCard
            label="Tài khoản QC"
            value={formatNumber(24)}
            hint="2 nền tảng"
            icon={Wallet01Icon}
          />
          <KpiCard
            label="MCP hoạt động"
            value="5"
            hint="1 đã tắt"
            icon={McpServerIcon}
          />
          <KpiCard
            label="Lượt gọi 24h"
            value={formatNumber(1284)}
            delta={{ value: 12.4, label: "so với hôm qua" }}
            icon={Activity01Icon}
            sparkline={DEMO_SPARK}
          />
          <KpiCard
            label="Tỉ lệ lỗi"
            value="1,2%"
            delta={{
              value: 0.3,
              positiveIsGood: false,
              label: "so với hôm qua",
            }}
            icon={Alert02Icon}
            sparkline={DEMO_ERROR_SPARK}
            sparklineColor="var(--destructive)"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Đang tải" value="" loading />
        </div>
      </Section>

      <Section
        id="buttons"
        title="Nút"
        description="Mỗi trang chỉ có 1 nút brand (hành động chính)."
      >
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button variant="brand">Thêm kết nối</Button>
            <Button variant="brand" disabled>
              Đang khoá
            </Button>
            <Button>Mặc định</Button>
            <Button variant="outline">Viền</Button>
            <Button variant="secondary">Phụ</Button>
            <Button variant="ghost">Ẩn nền</Button>
            <Button variant="destructive">Xoá</Button>
            <Button variant="link">Liên kết</Button>
            <ThemeToggle />
          </CardContent>
        </Card>
      </Section>

      <Section
        id="badges"
        title="Huy hiệu trạng thái"
        description="StatusBadge cho mọi loại trạng thái, PlatformBadge, PermissionBadges."
      >
        <Card>
          <CardContent className="flex flex-col gap-4">
            {STATUS_KINDS.map(({ kind, label }) => (
              <div
                key={kind}
                className="flex flex-col gap-2 sm:flex-row sm:items-center"
              >
                <span className="w-56 shrink-0 text-sm text-muted-foreground">
                  {label}
                </span>
                <div className="flex flex-wrap gap-2">
                  {statusValues(kind).map((s) => (
                    <StatusBadge key={s} kind={kind} status={s} />
                  ))}
                </div>
              </div>
            ))}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="w-56 shrink-0 text-sm text-muted-foreground">
                Nền tảng
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {PLATFORMS.map((p) => (
                  <PlatformBadge key={p} platform={p} />
                ))}
                {PLATFORMS.map((p) => (
                  <PlatformBadge key={`${p}-i`} platform={p} iconOnly />
                ))}
                {PLATFORMS.map((p) => (
                  <PlatformIcon
                    key={`${p}-m`}
                    platform={p}
                    className="size-5"
                    title={PLATFORM_LABELS[p]}
                  />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="w-56 shrink-0 text-sm text-muted-foreground">
                Quyền MCP
              </span>
              <PermissionBadges
                permissions={[
                  "read",
                  "status",
                  "update",
                  "copy",
                  "create",
                  "delete",
                ]}
                withDescriptions
              />
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section
        id="connections"
        title="Bảng (chế độ client)"
        description="Tabs làm view, tìm kiếm, lọc, sắp xếp, chọn nhiều → thanh hành động nổi, bấm dòng → Sheet."
      >
        <ConnectionsDemo />
      </Section>

      <Section
        id="logs"
        title="Bảng (chế độ server, keyset)"
        description="Sắp xếp được kiểm soát + nút “Tải thêm”."
      >
        <LogsDemo />
      </Section>

      <Section id="empty" title="Trạng thái trống">
        <Card>
          <CardContent>
            {showEmpty ? (
              <EmptyState
                icon={Plug01Icon}
                title="Chưa có kết nối nào"
                description="Thêm kết nối đầu tiên để bắt đầu điều khiển quảng cáo bằng AI."
                action={
                  <Button variant="brand" onClick={() => setShowEmpty(false)}>
                    <HugeiconsIcon
                      icon={Add01Icon}
                      strokeWidth={2}
                      data-icon="inline-start"
                      aria-hidden
                    />
                    Thêm kết nối
                  </Button>
                }
                secondaryAction={<Button variant="ghost">Xem hướng dẫn</Button>}
              />
            ) : (
              <Button variant="outline" onClick={() => setShowEmpty(true)}>
                Hiện lại trạng thái trống
              </Button>
            )}
          </CardContent>
        </Card>
      </Section>

      <Section id="wizard" title="Wizard & biểu mẫu">
        <WizardDemo />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <FormDemo />
          </div>
          <HelpPanel
            guide={DEMO_GUIDE}
            platform="meta"
            title="Cách lấy token Meta"
          />
        </div>
      </Section>

      <Section id="pickers" title="Chọn khoảng thời gian">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3">
            <DateRangePicker value={range} onChange={(v) => setRange(v)} />
            <span className="text-sm text-muted-foreground tabular-nums">
              Giá trị: {range ? `${range.from} → ${range.to}` : "(chưa chọn)"}
            </span>
          </CardContent>
        </Card>
      </Section>

      <Section id="dialogs" title="Hộp thoại xác nhận">
        <Card>
          <CardContent className="flex flex-wrap gap-3">
            <ConfirmDialog
              trigger={<Button variant="destructive">Xoá MCP…</Button>}
              title='Xoá MCP "Báo cáo hằng ngày"?'
              description="Link MCP sẽ ngừng hoạt động ngay lập tức với mọi AI đang dùng."
              destructive
              confirmText="Báo cáo hằng ngày"
              confirmLabel="Xoá MCP"
              onConfirm={() =>
                new Promise((r) => setTimeout(r, 700)).then(() =>
                  toast.success("Đã xoá MCP")
                )
              }
            />
            <ConfirmDialog
              trigger={<Button variant="outline">Xoay key…</Button>}
              title="Xoay key MCP?"
              description="Link cũ ngừng hoạt động; bạn cần dán link mới vào Claude/ChatGPT."
              confirmLabel="Xoay key"
              onConfirm={() => toast.success("Đã tạo link mới")}
            />
          </CardContent>
        </Card>
      </Section>

      <Section
        id="json"
        title="JSON viewer"
        description="Văn bản luôn được escape - thử chuỗi <script> bên dưới."
      >
        <JsonViewer label="Request" data={DEMO_JSON} />
      </Section>

      <Section id="glass" title="Glass card & thương hiệu">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <GlassCard className="flex flex-col gap-4">
            <GlassCardHeader>
              <span className="flex size-10 items-center justify-center rounded-2xl bg-success/12 text-success-strong">
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  strokeWidth={2}
                  aria-hidden
                />
              </span>
              <GlassCardTitle>
                Đã tạo MCP &quot;Báo cáo hằng ngày&quot;
              </GlassCardTitle>
              <GlassCardDescription>
                Dán link này vào Claude, ChatGPT hoặc Gemini để bắt đầu.
              </GlassCardDescription>
            </GlassCardHeader>
            <CopyField
              label="Link MCP"
              value="https://ads.example.com/mcp/amcp_7Yh2kQ9xR4tLm8Vb"
            />
            <p className="flex items-start gap-2 text-[13px] text-warning-strong">
              <HugeiconsIcon
                icon={Alert02Icon}
                strokeWidth={2}
                className="mt-0.5 size-4 shrink-0"
                aria-hidden
              />
              Ai có link này đều dùng được MCP. Không chia sẻ công khai.
            </p>
          </GlassCard>
          <Card>
            <CardHeader>
              <CardTitle>Logo & giao diện</CardTitle>
              <CardDescription>
                Logo đổi theo theme; tuỳ chọn giảm trong suốt lưu trên trình
                duyệt.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center gap-6">
                <BrandLogo height={32} />
                <span className="flex items-center gap-2">
                  <BrandMark size={36} />
                  <BrandWordmark />
                </span>
                <BrandWordmark
                  gradient
                  withByline={false}
                  className="text-2xl"
                />
              </div>
              <TransparencyToggle />
              <p className="text-sm text-muted-foreground">
                Thời gian tương đối: <RelativeTime value={FIVE_MINUTES_AGO} /> ·{" "}
                <RelativeTime value={YESTERDAY} />
              </p>
            </CardContent>
          </Card>
        </div>
      </Section>
    </div>
  )
}
