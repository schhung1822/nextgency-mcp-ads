"use client"

import * as React from "react"
import { ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { common } from "@/lib/i18n/vi/common"

export interface SecretInputProps extends Omit<
  React.ComponentProps<"input">,
  "type" | "defaultValue" | "autoComplete" | "value" | "onChange"
> {
  /** controlled value - must start empty; NEVER pass a stored secret back to the client */
  value?: string
  onChange?: React.ChangeEventHandler<HTMLInputElement | HTMLTextAreaElement>
  /** masked hint of the stored secret (e.g. "EAAB…x9Q2"), shown as helper text instead of prefilling */
  savedHint?: string
  /** multi-line secret (JSON key, long token) - masked with CSS when hidden */
  multiline?: boolean
  rows?: number
  className?: string
  inputClassName?: string
}

/**
 * Password-style field for tokens/secrets: show/hide toggle, autocomplete off, never prefilled.
 * Works with react-hook-form `Controller` (`{...field}`) or uncontrolled with `name`.
 */
export const SecretInput = React.forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  SecretInputProps
>(function SecretInput(
  { savedHint, multiline, rows = 4, className, inputClassName, id, ...props },
  ref
) {
  const [visible, setVisible] = React.useState(false)
  const autoId = React.useId()
  const inputId = id ?? autoId
  const hintId = `${inputId}-hint`
  const describedBy =
    [props["aria-describedby"], savedHint ? hintId : undefined]
      .filter(Boolean)
      .join(" ") || undefined
  const toggle = (
    <InputGroupAddon
      align={multiline ? "block-end" : "inline-end"}
      className={cn(multiline && "justify-end")}
    >
      <InputGroupButton
        size={multiline ? "xs" : "icon-xs"}
        // 24px icon button → +8px invisible hit area on every side (touch target ≥ 40px)
        className="relative after:absolute after:-inset-2"
        aria-label={visible ? common.secret.hideLabel : common.secret.showLabel}
        aria-pressed={visible}
        aria-controls={inputId}
        onClick={() => setVisible((v) => !v)}
      >
        <HugeiconsIcon
          icon={visible ? ViewOffSlashIcon : ViewIcon}
          strokeWidth={2}
          aria-hidden
        />
        {multiline && (
          <span>{visible ? common.secret.hide : common.secret.show}</span>
        )}
      </InputGroupButton>
    </InputGroupAddon>
  )
  const shared = {
    id: inputId,
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "off",
    spellCheck: false,
    "data-1p-ignore": true,
    "data-lpignore": "true",
    "aria-describedby": describedBy,
  } as const
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <InputGroup className={cn(multiline && "rounded-2xl")}>
        {multiline ? (
          <InputGroupTextarea
            {...(props as React.ComponentProps<"textarea">)}
            {...shared}
            ref={ref as React.Ref<HTMLTextAreaElement>}
            rows={rows}
            className={cn(
              "font-mono text-[13px] break-all",
              !visible && "[-webkit-text-security:disc] [text-security:disc]",
              inputClassName
            )}
          />
        ) : (
          <InputGroupInput
            {...props}
            {...shared}
            ref={ref as React.Ref<HTMLInputElement>}
            type={visible ? "text" : "password"}
            className={cn("font-mono text-[13px]", inputClassName)}
          />
        )}
        {toggle}
      </InputGroup>
      {savedHint && (
        <p id={hintId} className="text-[13px] text-muted-foreground">
          {common.secret.savedHint(savedHint)}
        </p>
      )}
    </div>
  )
})
