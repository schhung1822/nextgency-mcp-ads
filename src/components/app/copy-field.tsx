"use client"

import * as React from "react"
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { common } from "@/lib/i18n/vi/common"

import { useCopy } from "./use-copy"

export interface CopyFieldProps {
  value: string
  /** accessible label of the readonly input (e.g. "Link MCP") */
  label: string
  id?: string
  /** monospace text (default true) */
  mono?: boolean
  /** text on the button; default "Sao chép". Set `iconOnly` for a compact button. */
  buttonLabel?: string
  iconOnly?: boolean
  /** toast text; default "Đã sao chép" */
  toastMessage?: string
  onCopied?: () => void
  className?: string
}

/** Readonly input + copy button + "Đã sao chép" toast. Clicking the input selects all. */
export function CopyField({
  value,
  label,
  id,
  mono = true,
  buttonLabel = common.copy,
  iconOnly,
  toastMessage,
  onCopied,
  className,
}: CopyFieldProps) {
  const autoId = React.useId()
  const inputId = id ?? autoId
  const { copied, copy } = useCopy({ toastMessage })
  return (
    <InputGroup className={cn("h-10 bg-card", className)}>
      <InputGroupInput
        id={inputId}
        readOnly
        value={value}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => e.currentTarget.select()}
        className={cn("truncate", mono && "font-mono text-[13px]")}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size={iconOnly ? "icon-sm" : "sm"}
          variant={iconOnly ? "ghost" : "secondary"}
          aria-label={iconOnly ? `${buttonLabel}: ${label}` : undefined}
          onClick={async () => {
            if (await copy(value)) onCopied?.()
          }}
          className={cn(!iconOnly && "h-8 px-3")}
        >
          <HugeiconsIcon
            icon={copied ? Tick02Icon : Copy01Icon}
            strokeWidth={2}
            className={cn("size-4", copied && "text-success")}
            aria-hidden
          />
          {!iconOnly && <span>{copied ? common.copied : buttonLabel}</span>}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
