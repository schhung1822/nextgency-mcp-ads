"use client"

import * as React from "react"
import Link from "next/link"
import {
  CircleArrowUp02Icon,
  Logout01Icon,
  MoreVerticalIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { common } from "@/lib/i18n/vi/common"

import { UpdateDot, UpdateLink, useHasUpdate, VersionLine } from "./app-version"
import { ThemeMenuItems } from "./theme-toggle"
import { TransparencyMenuItem } from "./transparency-toggle"

export interface AppUser {
  /** scopes per-user browser preferences (guide panel collapsed state) */
  id?: string
  name: string
  email: string
  role: "admin" | "staff"
  image?: string | null
}

export interface SignOutProps {
  /** server action (wired by the auth feature); rendered as a <form action> */
  signOutAction?: () => Promise<void>
  /** client handler alternative (e.g. authClient.signOut()) */
  onSignOut?: () => void | Promise<void>
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const first = parts[0][0] ?? ""
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : ""
  return (first + last).toUpperCase()
}

export function UserAvatar({
  user,
  className,
}: {
  user: AppUser
  className?: string
}) {
  return (
    <Avatar className={cn("size-8 rounded-xl after:rounded-xl", className)}>
      {user.image && (
        <AvatarImage src={user.image} alt="" className="rounded-xl" />
      )}
      <AvatarFallback className="rounded-xl bg-linear-135 from-primary-from to-primary-to text-xs font-semibold text-white">
        {initials(user.name)}
      </AvatarFallback>
    </Avatar>
  )
}

/** Avatar with a red dot when an admin has a newer release waiting (see app-version.tsx). */
export function UserAvatarWithUpdateDot({
  user,
  className,
}: {
  user: AppUser
  className?: string
}) {
  const hasUpdate = useHasUpdate()
  return (
    <span className="relative inline-flex shrink-0">
      <UserAvatar user={user} className={className} />
      {hasUpdate && <UpdateDot className="-top-0.5 -right-0.5 ring-sidebar" />}
    </span>
  )
}

export function UserIdentity({ user }: { user: AppUser }) {
  return (
    <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
      <span className="truncate font-medium">{user.name}</span>
      <span className="truncate text-xs text-muted-foreground">
        {user.email}
      </span>
    </div>
  )
}

/** Hidden <form action={signOutAction}> living OUTSIDE the menu content (which unmounts on select). */
export function useSignOut({ signOutAction, onSignOut }: SignOutProps) {
  const formRef = React.useRef<HTMLFormElement>(null)
  const form = signOutAction ? (
    <form ref={formRef} action={signOutAction} className="hidden" aria-hidden />
  ) : null
  const enabled = !!signOutAction || !!onSignOut
  const trigger = () => {
    if (signOutAction) formRef.current?.requestSubmit()
    else void onSignOut?.()
  }
  return { form, enabled, trigger }
}

function MenuBody({
  user,
  signOutEnabled,
  onSignOutSelect,
}: {
  user: AppUser
  signOutEnabled: boolean
  onSignOutSelect: () => void
}) {
  const hasUpdate = useHasUpdate()
  return (
    <>
      <DropdownMenuLabel className="p-0 font-normal">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <UserAvatar user={user} />
          <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{user.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {user.email}
            </span>
            <span className="mt-0.5 truncate text-xs text-brand-ink">
              {user.role === "admin"
                ? common.user.roleAdmin
                : common.user.roleStaff}
            </span>
          </div>
        </div>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem asChild>
          <Link href="/account">
            <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} aria-hidden />
            {common.nav.account}
          </Link>
        </DropdownMenuItem>
        {hasUpdate && (
          <DropdownMenuItem asChild>
            <UpdateLink className="font-medium text-brand-ink">
              <HugeiconsIcon
                icon={CircleArrowUp02Icon}
                strokeWidth={2}
                aria-hidden
              />
            </UpdateLink>
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        {common.user.appearance}
      </DropdownMenuLabel>
      <ThemeMenuItems />
      <TransparencyMenuItem />
      {signOutEnabled && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onSignOutSelect}>
            <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} aria-hidden />
            {common.user.signOut}
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      <VersionLine className="px-2 py-1.5" />
    </>
  )
}

/** Sidebar footer user button + menu (Tài khoản, Giao diện, Giảm trong suốt, Đăng xuất). */
export function SidebarUserMenu({
  user,
  isMobile,
  ...signOutProps
}: { user: AppUser; isMobile?: boolean } & SignOutProps) {
  const signOut = useSignOut(signOutProps)
  return (
    <>
      {signOut.form}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            aria-label={common.user.menu}
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <UserAvatarWithUpdateDot user={user} />
            <UserIdentity user={user} />
            <HugeiconsIcon
              icon={MoreVerticalIcon}
              strokeWidth={2}
              className="ml-auto size-4"
              aria-hidden
            />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-(--radix-dropdown-menu-trigger-width) min-w-72"
          side={isMobile ? "top" : "right"}
          align="end"
          sideOffset={8}
        >
          <MenuBody
            user={user}
            signOutEnabled={signOut.enabled}
            onSignOutSelect={signOut.trigger}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/** Compact avatar trigger for the top bar (used on mobile where the sidebar is a sheet). */
export function TopBarUserMenu({
  user,
  className,
  ...signOutProps
}: { user: AppUser; className?: string } & SignOutProps) {
  const signOut = useSignOut(signOutProps)
  return (
    <>
      {signOut.form}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={common.user.menu}
            className={cn(
              "flex size-10 items-center justify-center rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              className
            )}
          >
            <UserAvatarWithUpdateDot user={user} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-72">
          <MenuBody
            user={user}
            signOutEnabled={signOut.enabled}
            onSignOutSelect={signOut.trigger}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
