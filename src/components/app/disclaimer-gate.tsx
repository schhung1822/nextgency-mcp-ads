"use client"

// Blocking "Miễn trừ trách nhiệm" popup in front of a create flow (thêm kết nối / tạo MCP). The flow below stays
// mounted but inert (its mount effects run - e.g. the TikTok auth_code is taken out of the address bar at once) until
// the user has scrolled the text to the end, waited the minimum reading time, ticked the checkbox and the server
// recorded the acceptance. Cancel / Esc / ✕ leave the page; clicking outside does nothing. Shown once per user, kind
// and version: the page passes `alreadyAccepted` when the server found this user's acceptance of the current version.
// The server refuses the create anyway without that acceptance (src/server/services/disclaimers.ts) - this popup is
// the UX half.
import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Rich } from "@/components/app/rich-text"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { ActionResult } from "@/lib/action-result"
import {
  DISCLAIMER_HANDOFF_KEY,
  DISCLAIMER_VERSIONS,
  disclaimerGate,
  disclaimerVersionDate,
  handoffAccepted,
  readProgress,
  type DisclaimerHandoff,
  type DisclaimerKind,
} from "@/lib/disclaimers"
import { disclaimers as t } from "@/lib/i18n/vi/disclaimers"

type Phase = "checking" | "open" | "accepted"

export interface DisclaimerGateProps {
  kind: DisclaimerKind
  /** where "Huỷ" / Esc / ✕ go (the list page of the flow) */
  cancelHref: string
  /** server action recording the acceptance (acceptDisclaimerAction) */
  accept: (input: unknown) => Promise<ActionResult<unknown>>
  /**
   * Pages of the SAME flow reachable from links inside `children` (the /connections/new chooser → Telegram / Google
   * Drive): a click on such a link hands this acceptance over once (client-side fallback - the next page's server
   * component normally finds the acceptance already).
   */
  handoffTo?: string[]
  /** nothing to set up on this page (e.g. no connection to build an MCP from): render the children as they are */
  disabled?: boolean
  /** The server found this user's acceptance of the current version (any time): do not show the popup. */
  alreadyAccepted?: boolean
  children: React.ReactNode
}

function readHandoff(kind: DisclaimerKind): { accepted: boolean; present: boolean } {
  try {
    const raw = window.sessionStorage.getItem(DISCLAIMER_HANDOFF_KEY)
    return {
      accepted: handoffAccepted(raw, kind, window.location.pathname, Date.now()),
      present: raw !== null,
    }
  } catch {
    return { accepted: false, present: false }
  }
}

function dropHandoff() {
  try {
    window.sessionStorage.removeItem(DISCLAIMER_HANDOFF_KEY)
  } catch {
    /* storage blocked */
  }
}

export function DisclaimerGate({
  kind,
  cancelHref,
  accept,
  handoffTo = [],
  disabled = false,
  alreadyAccepted = false,
  children,
}: DisclaimerGateProps) {
  const router = useRouter()
  const doc = t.docs[kind]
  const version = DISCLAIMER_VERSIONS[kind]
  const titleId = React.useId()
  const [phase, setPhase] = React.useState<Phase>(
    alreadyAccepted ? "accepted" : "checking"
  )
  const [openedAt, setOpenedAt] = React.useState(0)
  const [now, setNow] = React.useState(0)
  const [progress, setProgress] = React.useState(0)
  const [reachedEnd, setReachedEnd] = React.useState(false)
  const [checked, setChecked] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)
  const [endEl, setEndEl] = React.useState<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)

  // decide once, on the client: handed over from the chooser of the same flow, or ask
  React.useEffect(() => {
    const handed = readHandoff(kind)
    const t0 = Date.now()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads sessionStorage, which only exists after mount
    setOpenedAt(t0)
    setNow(t0)
    setPhase(handed.accepted || alreadyAccepted ? "accepted" : "open")
    if (!handed.present) return
    // one-shot: used up right after this mount (deferred, so a StrictMode re-run of this effect reads the same value)
    const id = window.setTimeout(dropHandoff, 0)
    return () => window.clearTimeout(id)
  }, [kind, alreadyAccepted])

  const gate = disclaimerGate({ reachedEnd, openedAt, now, checked, pending })

  // countdown of the minimum reading time
  React.useEffect(() => {
    if (phase !== "open" || gate.secondsLeft === 0) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [phase, gate.secondsLeft])

  // "read to the end" = the end mark became visible inside the scroll region (also true when nothing overflows)
  React.useEffect(() => {
    if (!scrollEl || !endEl || reachedEnd) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setReachedEnd(true)
      },
      { root: scrollEl, threshold: 0.9 }
    )
    io.observe(endEl)
    return () => io.disconnect()
  }, [scrollEl, endEl, reachedEnd])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setProgress(readProgress(el.scrollTop, el.scrollHeight, el.clientHeight))
  }

  const cancel = () => {
    if (pending) return
    router.push(cancelHref)
  }

  const confirm = () => {
    if (!gate.canConfirm) return
    setError(null)
    startTransition(async () => {
      let r: ActionResult<unknown>
      try {
        r = await accept({ kind, version })
      } catch {
        setError(t.errors.generic)
        return
      }
      if (!r.ok) {
        setError(r.error)
        return
      }
      setPhase("accepted")
    })
  }

  // hand the acceptance over when a link of the same flow is followed
  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (phase !== "accepted" || handoffTo.length === 0) return
    const a = (e.target as Element | null)?.closest?.("a[href]")
    if (!(a instanceof HTMLAnchorElement)) return
    let to: string
    try {
      const u = new URL(a.href, window.location.href)
      if (u.origin !== window.location.origin) return
      to = u.pathname
    } catch {
      return
    }
    if (!handoffTo.includes(to)) return
    const h: DisclaimerHandoff = { kind, version, at: Date.now(), to }
    try {
      window.sessionStorage.setItem(DISCLAIMER_HANDOFF_KEY, JSON.stringify(h))
    } catch {
      /* storage blocked: the next page simply asks again */
    }
  }

  if (disabled) return <>{children}</>

  const locked = phase !== "accepted"
  const status = !reachedEnd
    ? t.dialog.readHint
    : gate.secondsLeft > 0
      ? t.dialog.countdown(gate.secondsLeft)
      : t.dialog.readDone

  return (
    <>
      <div
        inert={locked}
        aria-hidden={locked || undefined}
        onClickCapture={onClickCapture}
        data-disclaimer={phase}
      >
        {children}
      </div>
      <Dialog
        open={phase === "open"}
        onOpenChange={(o) => {
          if (!o) cancel()
        }}
      >
        <DialogContent
          aria-labelledby={titleId}
          ref={contentRef}
          onInteractOutside={(e) => e.preventDefault()}
          // focus the dialog itself (screen readers read the title); Tab reaches the scrollable text next
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            contentRef.current?.focus()
          }}
          className="flex h-[calc(100dvh-0.5rem)] flex-col gap-0 overflow-hidden p-0 pb-0 sm:h-auto sm:max-h-[calc(100dvh-4rem)] sm:max-w-2xl sm:gap-0 sm:p-0"
        >
          <DialogHeader className="gap-1.5 px-5 pt-5 pr-14 pb-4 sm:px-6 sm:pt-6">
            <DialogTitle
              id={titleId}
              className="text-lg leading-snug font-semibold text-balance"
            >
              {doc.title}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              {t.dialog.versionLine(version, disclaimerVersionDate(version))}
            </p>
            <DialogDescription>{doc.summary}</DialogDescription>
          </DialogHeader>

          <div
            ref={setScrollEl}
            role="region"
            aria-label={t.dialog.regionLabel}
            tabIndex={0}
            onScroll={onScroll}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-y bg-muted/30 px-5 py-4 text-sm leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-6"
          >
            <div className="flex flex-col gap-3 text-pretty">
              {doc.intro.map((p, i) => (
                <p key={i}>
                  <Rich text={p} />
                </p>
              ))}
            </div>
            {doc.sections.map((s) => (
              <section
                key={s.id}
                className="mt-5"
              >
                <h3
                  id={`disc-${kind}-${s.id}`}
                  className="mb-2 text-sm font-semibold text-foreground"
                >
                  {s.title}
                </h3>
                {s.paragraphs?.map((p, i) => (
                  <p key={i} className="mt-2 text-pretty first:mt-0">
                    <Rich text={p} />
                  </p>
                ))}
                {s.items && (
                  <ul className="flex list-disc flex-col gap-1.5 pl-5 text-pretty marker:text-muted-foreground">
                    {s.items.map((it, i) => (
                      <li key={i}>
                        <Rich text={it} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
            <p className="mt-5 text-pretty">{doc.closing}</p>
            <p className="mt-3 text-muted-foreground">
              {t.dialog.linksLead}{" "}
              <Link
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground underline underline-offset-3"
              >
                {t.dialog.terms}
              </Link>
              {" · "}
              <Link
                href="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground underline underline-offset-3"
              >
                {t.dialog.privacy}
              </Link>{" "}
              <span className="sr-only">{t.dialog.newTab}</span>
            </p>
            <div
              ref={setEndEl}
              className="mt-5 flex items-center gap-3 text-xs text-muted-foreground"
            >
              <span className="h-px flex-1 bg-border" aria-hidden />
              {t.dialog.endMark}
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>
          </div>

          <div className="flex flex-col gap-4 px-5 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-6">
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <p className="text-xs font-medium text-muted-foreground">
                {status}
              </p>
              {!reachedEnd && (
                <Progress
                  value={progress}
                  aria-label={t.dialog.progressLabel}
                  className="h-1.5"
                />
              )}
            </div>
            <Field
              orientation="horizontal"
              data-disabled={!gate.canCheck || undefined}
            >
              <Checkbox
                id={`disclaimer-${kind}-agree`}
                checked={gate.canCheck && checked}
                disabled={!gate.canCheck || pending}
                onCheckedChange={(v) => setChecked(v === true)}
              />
              <FieldContent>
                <FieldLabel
                  htmlFor={`disclaimer-${kind}-agree`}
                  className="leading-snug font-medium"
                >
                  {t.dialog.checkbox}
                </FieldLabel>
                {!gate.canCheck && (
                  <FieldDescription className="text-xs">
                    {t.dialog.checkboxLockedHint}
                  </FieldDescription>
                )}
              </FieldContent>
            </Field>
            {error && (
              <Alert variant="destructive">
                <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={cancel}
                disabled={pending}
              >
                {t.dialog.cancel}
              </Button>
              <Button
                type="button"
                variant="brand"
                onClick={confirm}
                disabled={!gate.canConfirm}
              >
                {pending && <Spinner />}
                {pending ? t.dialog.confirming : t.dialog.confirm}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
