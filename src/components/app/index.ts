// Shared app components (design system: .claude/docs/06-ui-design-system.md).
export { AppShell, type AppShellProps, type AppUser } from "./app-shell"
export { AppVersionProvider, useAppVersion } from "./app-version"
export {
  BrandLogo,
  BrandMark,
  BrandWordmark,
  type BrandLogoProps,
  type BrandMarkProps,
  type BrandWordmarkProps,
} from "./brand-logo"
export {
  CommandPalette,
  type CommandPaletteGroup,
  type CommandPaletteItem,
  type CommandPaletteProps,
} from "./command-palette"
export { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog"
export {
  ContextualSaveBar,
  type ContextualSaveBarProps,
} from "./contextual-save-bar"
export { CopyField, type CopyFieldProps } from "./copy-field"
export {
  createDataTableColumnHelper,
  DataTable,
  dataTableFeatures,
  type DataTableColumnDef,
  type DataTableColumnMeta,
  type DataTableFeatures,
  type DataTableProps,
  type DataTableRow,
  type DataTableServerPagination,
  type RowSelectionState,
  type SortingState,
} from "./data-table"
export {
  addDays,
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  detectDatePreset,
  formatDateRangeLabel,
  resolveDatePreset,
  todayIn,
  type DatePreset,
  type DatePresetOrCustom,
  type DateRangeValue,
  type PresetOptions,
} from "./date-range"
export { DateRangePicker, type DateRangePickerProps } from "./date-range-picker"
export { EmptyState, type EmptyStateProps } from "./empty-state"
export { NoticeTicker } from "./notice-ticker"
export {
  FilterBar,
  type FilterBarProps,
  type FilterDef,
  type FilterOption,
  type FilterValues,
} from "./filter-bar"
export {
  GlassCard,
  GlassCardDescription,
  GlassCardHeader,
  GlassCardTitle,
  type GlassCardProps,
} from "./glass-card"
export { BottomNav } from "./bottom-nav"
export { GuideBody } from "./guide-body"
export { HelpPanel, type HelpPanelProps } from "./help-panel"
export { JsonViewer, type JsonViewerProps } from "./json-viewer"
export { KpiCard, type KpiCardProps, type KpiDelta } from "./kpi-card"
export { KpiSparkline, type KpiSparklineProps } from "./kpi-sparkline"
export {
  BOTTOM_NAV_ITEMS,
  bottomMenuItemsForRole,
  buildBreadcrumbs,
  isBottomMenuActive,
  isNavActive,
  NAV_ACCOUNT,
  NAV_ADMIN,
  NAV_MAIN,
  navItemsForRole,
  type AppRole,
  type BottomNavItem,
  type Crumb,
  type NavIconKey,
  type NavItem,
} from "./nav"
export { NAV_ICONS } from "./nav-icons"
export { PageGuide } from "./page-guide"
export {
  PageHeader,
  type PageHeaderAction,
  type PageHeaderProps,
} from "./page-header"
export {
  PermissionBadges,
  type PermissionBadgesProps,
} from "./permission-badges"
export { PlatformBadge, type PlatformBadgeProps } from "./platform-badge"
export {
  BrandIcon,
  PLATFORM_COLOR_CLASS,
  PlatformIcon,
  platformLabel,
  type BrandIconProps,
  type BrandMarkName,
  type PlatformIconProps,
} from "./platform-icon"
export { RelativeTime, type RelativeTimeProps } from "./relative-time"
export { ReauthDialog, type ReauthDialogTexts } from "./reauth-dialog"
export {
  EMPTY_REAUTH,
  ReauthFields,
  reauthComplete,
  reauthPayload,
  type ReauthValues,
} from "./reauth-fields"
export { SecretInput, type SecretInputProps } from "./secret-input"
export {
  getStatusMeta,
  statusValues,
  type AccountStatusValue,
  type ConnectionStatus,
  type LogStatus,
  type McpStatus,
  type ObjectStatus,
  type StatusKind,
  type StatusMeta,
  type StatusTone,
} from "./status"
export {
  STATUS_TONE_CLASSES,
  StatusBadge,
  type StatusBadgeProps,
} from "./status-badge"
export { Stepper, type StepperProps, type StepperStep } from "./stepper"
export { THEME_OPTIONS, ThemeMenuItems, ThemeToggle } from "./theme-toggle"
export {
  TRANSPARENCY_INIT_SCRIPT,
  TRANSPARENCY_STORAGE_KEY,
} from "./transparency"
export { TransparencyScript } from "./transparency-script"
export { InlineScript, ssrOnlyScriptType } from "./inline-script"
export {
  TransparencyMenuItem,
  TransparencyToggle,
  useReducedTransparency,
  useTransparencySync,
  type TransparencyToggleProps,
} from "./transparency-toggle"
export { useCopy } from "./use-copy"
export {
  initials,
  SidebarUserMenu,
  TopBarUserMenu,
  type SignOutProps,
} from "./user-menu"
