// Renders one legal page: Vietnamese first, then the English version (for Meta/OpenAI app reviewers).
// All text is plain React text (escaped) - operator name/contact come from admin settings, never as HTML.
import { Card, CardContent } from "@/components/ui/card"
import { legal as tl, type LegalBlock, type LegalDoc, type LegalLang } from "@/lib/i18n/vi/legal"
import type { LegalInfo, LegalPageKey } from "@/lib/legal"

const LINK_CLASS =
  "rounded-sm font-medium text-brand-ink underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

function Contact({ info, lang, subject }: { info: LegalInfo; lang: LegalLang; subject?: string }) {
  const c = tl.contact[lang]
  if (!info.contactEmail) return <p>{c.fallback(info.domain)}</p>
  const href = `mailto:${info.contactEmail}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`
  return (
    <p>
      {c.label}:{" "}
      <a href={href} className={`${LINK_CLASS} break-all`}>
        {info.contactEmail}
      </a>
    </p>
  )
}

function Block({ block, info, lang, subject }: { block: LegalBlock; info: LegalInfo; lang: LegalLang; subject?: string }) {
  switch (block.kind) {
    case "p":
      return <p>{block.text}</p>
    case "ul":
      return (
        <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">
          {block.items.map((item, i) => (
            <li key={i} className="pl-1">
              {item}
            </li>
          ))}
        </ul>
      )
    case "ol":
      return (
        <ol className="flex list-decimal flex-col gap-2 pl-5 marker:text-muted-foreground">
          {block.items.map((item, i) => (
            <li key={i} className="pl-1">
              {item}
            </li>
          ))}
        </ol>
      )
    case "contact":
      return <Contact info={info} lang={lang} subject={subject} />
  }
}

function DocBody({
  doc,
  info,
  lang,
  sectionHeading: H,
  subject,
}: {
  doc: LegalDoc
  info: LegalInfo
  lang: LegalLang
  sectionHeading: "h2" | "h3"
  subject?: string
}) {
  return (
    <>
      {doc.intro.map((text, i) => (
        <p key={i}>{text}</p>
      ))}
      {doc.sections.map((s) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="flex scroll-mt-20 flex-col gap-3">
          <H id={`${s.id}-title`} className="pt-2 text-base leading-6 font-semibold tracking-tight text-foreground sm:text-lg">
            {s.title}
          </H>
          {s.blocks.map((b, i) => (
            <Block key={i} block={b} info={info} lang={lang} subject={subject} />
          ))}
        </section>
      ))}
    </>
  )
}

export function LegalDocument({ page, info }: { page: LegalPageKey; info: LegalInfo }) {
  const vi = tl.docs[page].vi(info)
  const en = tl.docs[page].en(info)
  const subject = page === "dataDeletion" ? tl.deletionMailSubject : undefined
  return (
    <Card>
      <CardContent className="px-5 py-2 sm:px-8 sm:py-4">
        <article className="flex flex-col gap-4 text-[15px] leading-7 text-foreground/90">
          <header className="flex flex-col gap-2 border-b pb-5">
            <h1 className="text-2xl leading-8 font-semibold tracking-tight text-balance text-foreground sm:text-[28px] sm:leading-9">
              {vi.title}
            </h1>
            <p className="text-sm text-muted-foreground">
              {tl.updatedLabel.vi}: <time dateTime={tl.updatedAtIso}>{tl.updatedAt}</time>
              <span aria-hidden> · </span>
              {tl.operatorLabel.vi}: {info.orgName}
            </p>
            <p className="text-sm">
              <a href="#english" lang="en" className={LINK_CLASS}>
                {tl.englishJump} ↓
              </a>
            </p>
          </header>

          <DocBody doc={vi} info={info} lang="vi" sectionHeading="h2" subject={subject} />

          <section
            id="english"
            lang="en"
            aria-labelledby="english-title"
            className="mt-6 flex scroll-mt-20 flex-col gap-4 border-t pt-8"
          >
            <header className="flex flex-col gap-2">
              <p className="text-xs font-semibold tracking-wide text-brand-ink uppercase">{tl.englishHeading}</p>
              <h2 id="english-title" className="text-xl leading-7 font-semibold tracking-tight text-foreground sm:text-2xl">
                {en.title}
              </h2>
              <p className="text-sm text-muted-foreground">
                {tl.updatedLabel.en}: <time dateTime={tl.updatedAtIso}>{tl.updatedAtEn}</time>
                <span aria-hidden> · </span>
                {tl.operatorLabel.en}: {info.orgName}
              </p>
            </header>
            <DocBody doc={en} info={info} lang="en" sectionHeading="h3" subject={subject} />
          </section>
        </article>
      </CardContent>
    </Card>
  )
}
