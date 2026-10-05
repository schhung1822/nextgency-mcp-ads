import type { Metadata } from "next"

import { legal as tl } from "@/lib/i18n/vi/legal"
import { getPublicLegalInfo } from "@/server/services/legal"

import { LegalDocument } from "../_components/legal-document"

// Public page (no session): see (legal)/layout.tsx.
export const metadata: Metadata = {
  title: tl.metaTitle.terms,
  description: tl.metaDescription.terms,
}

export default async function TermsPage() {
  const info = await getPublicLegalInfo()
  return <LegalDocument page="terms" info={info} />
}
