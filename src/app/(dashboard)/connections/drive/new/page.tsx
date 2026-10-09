import type { Metadata } from "next"

import { PageHeader } from "@/components/app"
import { driveUi } from "@/lib/i18n/vi/drive-ui"
import { requireUser } from "@/server/auth/session"
import {
  getDriveSystemInfo,
  listPersonalDriveCredentials,
} from "@/server/services/drive-credentials"

import { DriveSourceWizard } from "./_components/drive-source-wizard"

const m = driveUi.wizard

export const metadata: Metadata = { title: m.metaTitle }

export default async function NewDriveSourcePage() {
  const { user } = await requireUser()
  // DTOs only: the system email + flags, own service accounts (email + key hint) - never a key
  const [system, personal] = await Promise.all([
    getDriveSystemInfo(),
    listPersonalDriveCredentials(user),
  ])
  return (
    <div className="flex w-full flex-col">
      {/* the guide follows the wizard step (DriveSourceWizard mounts it) */}
      <PageHeader
        title={m.title}
        description={m.description}
        backHref="/connections?tab=drive"
      />
      <DriveSourceWizard
        isAdmin={user.role === "admin"}
        system={system}
        // a source can only use the viewer's OWN service account (admins see everybody's in the list page)
        ownCredentials={personal.filter((c) => c.isMine)}
      />
    </div>
  )
}
