"use client"

import { Copy01Icon, RefreshIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { useCopy } from "@/components/app"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { common } from "@/lib/i18n/vi/common"
import { users as tUsers } from "@/lib/i18n/vi/users"
import { generateTempPassword } from "@/lib/schemas/users"

/**
 * Visible temp-password input with "generate" + "copy" buttons (admin sets it, then hands it over).
 * On phones the buttons collapse to icons so the whole password stays readable.
 */
export function TempPasswordField({
  id,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  invalid?: boolean
  describedBy?: string
}) {
  const { copy } = useCopy()
  return (
    <InputGroup className="h-10">
      <InputGroupInput
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        spellCheck={false}
        autoCapitalize="off"
        className="font-mono text-[13px]"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-1p-ignore
        data-lpignore="true"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="xs"
          className="hidden sm:flex"
          aria-label={tUsers.create.generate}
          onClick={() => onChange(generateTempPassword())}
        >
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} aria-hidden />
          {tUsers.create.generate}
        </InputGroupButton>
        <InputGroupButton
          size="icon-sm"
          className="sm:hidden"
          aria-label={tUsers.create.generate}
          onClick={() => onChange(generateTempPassword())}
        >
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} aria-hidden />
        </InputGroupButton>
        <InputGroupButton
          size="icon-sm"
          aria-label={`${common.copy}: ${tUsers.create.password}`}
          disabled={!value}
          onClick={() => void copy(value)}
        >
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
