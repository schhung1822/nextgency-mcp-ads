// Public legal pages (/privacy, /terms, /data-deletion): no session, no dashboard chrome. The URLs are pasted into
// developer apps (Meta App Dashboard, OpenAI) and fetched by their reviewers/crawlers, so the proxy matcher
// (src/proxy.ts) excludes them and nothing here calls requireUser().
import { BrandLogo, ThemeToggle } from "@/components/app"
import { legal as tl } from "@/lib/i18n/vi/legal"

import { LegalNav } from "./_components/legal-nav"

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="glass sticky top-0 z-20 rounded-none border-x-0 border-t-0 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <BrandLogo height={26} priority />
          <ThemeToggle className="size-10" />
        </div>
      </header>
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 pt-4 pb-10 [--page-gutter:1rem] sm:gap-6 sm:px-6 sm:pt-8 sm:[--page-gutter:1.5rem]"
      >
        <LegalNav />
        {children}
      </main>
      <footer className="border-t border-foreground/5 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground">
        <LegalNav variant="footer" />
        <p className="mt-3">{tl.footer}</p>
      </footer>
    </div>
  )
}
