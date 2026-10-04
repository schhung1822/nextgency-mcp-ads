// Shared next/font instances. Imported by both the root layout and global-error so the font CSS is one
// chunk (a second Inter() call would emit a duplicate stylesheet that every page preloads unused).
import { Geist_Mono, Inter } from "next/font/google"

export const inter = Inter({
  subsets: ["latin", "vietnamese"],
  variable: "--font-sans",
  display: "swap",
})

export const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})
