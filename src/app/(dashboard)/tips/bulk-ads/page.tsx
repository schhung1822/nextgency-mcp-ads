import type { Metadata } from "next"

import { PageGuide } from "@/components/app"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { guides as tg } from "@/lib/i18n/vi/guides"
import { tips as t } from "@/lib/i18n/vi/tips"
import { requireUser } from "@/server/auth/session"

import { PrepareChecklist } from "../_components/prepare-checklist"
import {
  FaqList,
  ResultChecks,
  SafetyNotes,
  StepList,
  TipAlert,
  TipBullets,
  TipIntro,
  TipToc,
} from "../_components/tip-blocks"
import { BulkBuilder } from "./_components/bulk-builder"
import { SheetTemplate } from "./_components/sheet-template"

export const metadata: Metadata = { title: t.pages["bulk-ads"].metaTitle }

const b = t.bulk
const toc = t.shared.toc

/** Section anchors of this tip ("Trên trang này"). */
const IDS = {
  prepare: "chuan-bi",
  steps: "tung-buoc",
  sheet: "mau-sheet",
  builder: "soan-cau-lenh",
  faq: "loi-thuong-gap",
  safety: "an-toan",
} as const

/** Tip "Tạo quảng cáo số lượng lớn": many ads from Google Drive media driven by a Google Sheet (every role, static). */
export default async function BulkAdsTipPage() {
  await requireUser()

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageGuide guide={tg.tipsBulkAds} />
      <TipToc
        items={[
          { id: IDS.prepare, label: toc.prepare },
          { id: IDS.steps, label: toc.steps },
          { id: IDS.sheet, label: toc.sheet },
          { id: IDS.builder, label: toc.builder },
          { id: IDS.faq, label: toc.faq },
          { id: IDS.safety, label: toc.safety },
        ]}
      />
      <TipIntro
        title={b.title}
        description={b.description}
        who={b.who}
        result={b.result}
        flowLabel={b.flowLabel}
        flow={b.flow}
      >
        <TipAlert
          tone="safety"
          title={b.safetyAlertTitle}
          items={b.safetyAlert}
        />
      </TipIntro>
      <PrepareChecklist
        id={IDS.prepare}
        storageKey="bulk-ads"
        items={b.prepare}
      />
      <StepList id={IDS.steps} steps={b.steps} />
      <SheetTemplate id={IDS.sheet} />
      <Card id={IDS.builder} className="scroll-mt-24">
        <CardHeader>
          <CardTitle>{b.builder.title}</CardTitle>
          <CardDescription>{b.builder.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <BulkBuilder />
        </CardContent>
      </Card>
      <ResultChecks
        items={b.check}
        links={[
          { label: b.openLogs, href: "/logs" },
          { label: b.openDrive, href: "/connections?tab=drive" },
        ]}
      />
      <TipBullets title={b.tipsTitle} items={b.tips} />
      <FaqList id={IDS.faq} items={b.faq} />
      <SafetyNotes id={IDS.safety} items={b.safety} />
    </div>
  )
}
