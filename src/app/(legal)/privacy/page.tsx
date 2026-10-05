import type { Metadata } from "next"

import { legal as tl } from "@/lib/i18n/vi/legal"
import { getPublicLegalInfo } from "@/server/services/legal"

import { LegalDocument } from "../_components/legal-document"

// Public page (no session): see (legal)/layout.tsx.
export const metadata: Metadata = {
  title: tl.metaTitle.privacy,
  description: tl.metaDescription.privacy,
}

export default async function PrivacyPage() {
  const info = await getPublicLegalInfo()
  return <LegalDocument page="privacy" info={info} />
}
