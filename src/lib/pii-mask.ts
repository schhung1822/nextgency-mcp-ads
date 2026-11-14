// Masks customer contact details (phone numbers, e-mail addresses) in free text before it reaches the AI
// (owner decision 2026-11-15, Messenger messages of a Page: names are shown, contacts are masked).
// Phone: the last 3 digits stay visible ("[SĐT ẩn …678]") so the AI can still tell numbers apart / say "the customer
// left a number ending in 678" without reading it; e-mail: fully masked.

/** e-mail address (local@domain.tld), also inside punctuation / Vietnamese text */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * Vietnamese phone numbers: 0 / 84 / +84 followed by 8–10 more digits, digits optionally separated by one space,
 * dot or dash ("0912 345 678", "0912.345.678", "+84 912-345-678", "84912345678"). Not preceded / followed by another
 * digit, so prices ("1.500.000") and longer ids are left alone.
 */
const PHONE_VN = /(?<![\d+])(?:\+84|84|0)(?:[\s.-]?\d){8,10}(?![\d])/g

/** Other international numbers written with a leading + (e.g. +1 415 555 0101): 8–14 digits. */
const PHONE_INTL = /(?<![\d+])\+(?:[\s.-]?\d){8,14}(?![\d])/g

export interface MaskedText {
  text: string
  phones: number
  emails: number
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, "")
}

/** Text with phone numbers and e-mail addresses masked, plus how many of each were found. */
export function maskContactInfo(raw: string): MaskedText {
  let phones = 0
  let emails = 0
  let text = raw.replace(EMAIL, () => {
    emails++
    return "[email ẩn]"
  })
  const phone = (m: string) => {
    const d = digitsOf(m)
    // a VN number has 9-11 digits once written with 0 / 84 (0 + 9 = mobile, 0 + 10 = old landline)
    if (d.length < 9) return m
    phones++
    return `[SĐT ẩn …${d.slice(-3)}]`
  }
  text = text.replace(PHONE_VN, phone).replace(PHONE_INTL, phone)
  return { text, phones, emails }
}
