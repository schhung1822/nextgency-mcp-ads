"use client"

import * as React from "react"
import { ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { auth as tAuth } from "@/lib/i18n/vi/auth"

export type PasswordInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  /** classes for the outer group (e.g. height) */
  groupClassName?: string
  /** accessible names of the toggle (default: "Hiện/Ẩn mật khẩu") */
  toggleLabels?: { show: string; hide: string }
}

/**
 * Password field with a show/hide toggle (40px high - comfortable touch target). Works with react-hook-form
 * `Controller` (`{...field}`). Pass the right `autoComplete` ("current-password" | "new-password").
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { className, groupClassName, toggleLabels, id, ...props },
  ref
) {
  const [visible, setVisible] = React.useState(false)
  const autoId = React.useId()
  const inputId = id ?? autoId
  return (
    <InputGroup className={cn("h-10", groupClassName)}>
      <InputGroupInput
        {...props}
        ref={ref}
        id={inputId}
        type={visible ? "text" : "password"}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={className}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-sm"
          aria-label={
            visible ? (toggleLabels?.hide ?? tAuth.login.hidePassword) : (toggleLabels?.show ?? tAuth.login.showPassword)
          }
          aria-pressed={visible}
          aria-controls={inputId}
          onClick={() => setVisible((v) => !v)}
        >
          <HugeiconsIcon icon={visible ? ViewOffSlashIcon : ViewIcon} strokeWidth={2} aria-hidden />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
})
