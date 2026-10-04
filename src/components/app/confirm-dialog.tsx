"use client"

import * as React from "react"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { cn } from "cn"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { common } from "@/lib/i18n/vi/common"

export interface ConfirmDialogProps {
  /** element that opens the dialog (uncontrolled usage) */
  trigger?: React.ReactNode
  /** controlled usage */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: string
  description?: React.ReactNode
  /** extra content between description and footer */
  children?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** rose/destructive styling + warning icon + "không thể hoàn tác" note */
  destructive?: boolean
  /** user must type this exact text (e.g. the resource name) before confirming */
  confirmText?: string
  /**
   * Runs on confirm. If it returns a promise the button shows a spinner and the dialog closes
   * only after it resolves; if it rejects/throws (or returns `false`) the dialog stays open.
   */
  onConfirm: () => unknown | Promise<unknown>
}

/** Confirmation for dangerous actions (delete, rotate key, reset 2FA…), optionally "type the name". */
export function ConfirmDialog({
  trigger,
  open: openProp,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = common.confirm,
  cancelLabel = common.cancel,
  destructive,
  confirmText,
  onConfirm,
}: ConfirmDialogProps) {
  const [openState, setOpenState] = React.useState(false)
  const open = openProp ?? openState
  const [typed, setTyped] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const inputId = React.useId()

  const setOpen = (next: boolean) => {
    if (pending) return
    if (!next) setTyped("")
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }

  const matches = !confirmText || typed.trim() === confirmText
  const handleConfirm = async () => {
    if (!matches || pending) return
    setPending(true)
    let ok = true
    try {
      const result = await onConfirm()
      ok = result !== false
    } catch {
      ok = false
    } finally {
      setPending(false)
    }
    if (ok) {
      setTyped("")
      if (openProp === undefined) setOpenState(false)
      onOpenChange?.(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          {destructive && (
            <AlertDialogMedia className="size-12 bg-destructive/10 text-destructive">
              <HugeiconsIcon
                icon={Alert02Icon}
                strokeWidth={2}
                className="size-6"
                aria-hidden
              />
            </AlertDialogMedia>
          )}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {(description || destructive) && (
            <AlertDialogDescription>
              {description}
              {destructive && (
                <span className="mt-1 block font-medium text-destructive-strong">
                  {common.confirmDialog.irreversible}
                </span>
              )}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        {confirmText && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void handleConfirm()
            }}
          >
            <Label
              htmlFor={inputId}
              className="text-sm font-normal text-muted-foreground"
            >
              {common.confirmDialog.typeToConfirm(confirmText)}
            </Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed.length > 0 && !matches ? true : undefined}
              className="font-mono"
            />
          </form>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {cancelLabel}
          </AlertDialogCancel>
          <Button
            variant={destructive ? "default" : "brand"}
            disabled={!matches || pending}
            onClick={() => void handleConfirm()}
            className={cn(
              destructive &&
                "bg-destructive-solid text-white hover:bg-destructive-solid/90 focus-visible:ring-destructive/30"
            )}
          >
            {pending && <Spinner aria-hidden />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
