import type { Metadata } from "next"

import { legal as tl } from "@/lib/i18n/vi/legal"
import { getPublicLegalInfo } from "@/server/services/legal"

import { LegalDocument } from "../_components/legal-document"

// Public page (no session): see (legal)/layout.tsx.
export const metadata: Metadata = {
  title: tl.metaTitle.dataDeletion,
  description: tl.metaDescription.dataDeletion,
}

export default async function DataDeletionPage() {
  const info = await getPublicLegalInfo()
  return <LegalDocument page="dataDeletion" info={info} />
}
