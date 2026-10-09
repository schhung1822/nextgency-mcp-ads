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
  InputGroupTextarea,
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
  /**
   * long values that must stay readable on a phone (e.g. a service account email): the text wraps onto more lines
   * instead of being cut off (a read-only auto-sized textarea, still a labelled form control)
   */
  wrap?: boolean
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
  wrap,
  className,
}: CopyFieldProps) {
  const autoId = React.useId()
  const inputId = id ?? autoId
  const { copied, copy } = useCopy({ toastMessage })
  return (
    <InputGroup
      className={cn(
        "bg-card",
        wrap ? "min-h-10 pointer-coarse:min-h-12" : "h-10 pointer-coarse:h-12",
        className
      )}
    >
      {wrap ? (
        <InputGroupTextarea
          id={inputId}
          readOnly
          rows={1}
          value={value}
          aria-label={label}
          spellCheck={false}
          autoComplete="off"
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "min-h-0 [field-sizing:content] py-2.5 leading-5 break-all",
            mono && "font-mono text-[13px]"
          )}
        />
      ) : (
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
      )}
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size={iconOnly ? "icon-sm" : "sm"}
          variant={iconOnly ? "ghost" : "secondary"}
          aria-label={iconOnly ? `${buttonLabel}: ${label}` : undefined}
          onClick={async () => {
            if (await copy(value)) onCopied?.()
          }}
          className={cn(
            !iconOnly && "h-8 px-3",
            // touch: a 40px target (the group grows to 48px around it)
            "pointer-coarse:h-10",
            iconOnly && "pointer-coarse:w-10"
          )}
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
