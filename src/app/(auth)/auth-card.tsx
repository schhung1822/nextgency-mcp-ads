import type * as React from "react"
import { cn } from "cn"

import { BrandLogo, GlassCard } from "@/components/app"

export interface AuthCardProps {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  /** wider card for multi-step flows (2FA enrollment) */
  wide?: boolean
  className?: string
}

/** Glass card centred on the warm gradient: logo, title, one-sentence description, content. */
export function AuthCard({ title, description, children, wide, className }: AuthCardProps) {
  return (
    <GlassCard
      strong
      data-slot="auth-card"
      className={cn("w-full px-5 pt-14 pb-8 sm:p-8", wide ? "sm:max-w-[560px]" : "sm:max-w-[420px]", className)}
    >
      <div className="mb-6 flex flex-col items-center gap-4 text-center sm:mb-7">
        <BrandLogo height={36} priority />
        <div className="space-y-1.5">
          <h1 className="text-xl leading-7 font-semibold tracking-tight text-balance">{title}</h1>
          {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children}
    </GlassCard>
  )
}
