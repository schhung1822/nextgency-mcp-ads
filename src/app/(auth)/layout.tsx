// Layout for the public auth screens (/login, /login/2fa, /setup) and the forced security steps
// (/security/enable-2fa, /security/change-password). The forced steps live here - not under (dashboard) -
// because the dashboard layout's requireUser() would redirect them to themselves (redirect loop).
//
// Phones (< sm): full-bleed - the whole screen is one solid surface (logo at the top, fields full width, no
// centred card on a gradient); the page scrolls when the soft keyboard covers part of the form.
// From sm: the centred glass card on the warm gradient.
import { ThemeToggle } from "@/components/app"
import { auth as tAuth } from "@/lib/i18n/vi/auth"

import { LegalNav } from "../(legal)/_components/legal-nav"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-svh flex-col max-sm:bg-card">
      <header className="absolute top-0 right-0 z-10 p-2 max-sm:pt-[max(0.5rem,env(safe-area-inset-top))] sm:static sm:flex sm:justify-end sm:p-4">
        <ThemeToggle className="size-10" />
      </header>
      {/* sm+: centred; phones: the card stretches over the full screen and the page scrolls with the keyboard */}
      <main className="flex flex-1 items-stretch justify-center sm:items-center sm:px-4 sm:pt-2 sm:pb-8">{children}</main>
      <footer className="flex flex-col items-center gap-2 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground">
        {/* public policy pages (Meta app review often starts from the sign-in page) */}
        <LegalNav variant="footer" />
        <p>{tAuth.footer}</p>
      </footer>
    </div>
  )
}
