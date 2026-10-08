import type { Metadata, Viewport } from "next"
import "./globals.css"
import { fontMono, inter } from "./fonts"
import { TransparencyScript } from "@/components/app/transparency-script"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Every page depends on the signed-in session or live data: never prerender at build time.
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: { default: "Ads MCP · noti.vn", template: "%s · Ads MCP" },
  description:
    "Kết nối tài khoản quảng cáo Meta, TikTok, Google Ads (gồm YouTube), OpenAI Ads với Claude, ChatGPT, Gemini qua MCP.",
  icons: { icon: "/brand/favicon.png" },
  robots: { index: false, follow: false },
}

// viewport-fit=cover lets the shell use env(safe-area-inset-*) (notch / home indicator); the browser
// chrome follows the OS colour scheme (the in-app theme toggle cannot reach <meta name="theme-color">).
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfaf9" },
    { media: "(prefers-color-scheme: dark)", color: "#141010" },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="vi"
      suppressHydrationWarning
      className={cn("font-sans antialiased", inter.variable, fontMono.variable)}
    >
      <head>
        <TransparencyScript />
      </head>
      <body>
        <ThemeProvider>
          <TooltipProvider>
            {children}
            <Toaster position="bottom-center" richColors />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
