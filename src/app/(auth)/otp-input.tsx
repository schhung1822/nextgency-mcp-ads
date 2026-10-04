"use client"

import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"

// 6 cells that fit a 320px phone inside the auth card (6×36 + gaps) and grow to 48px on ≥ sm screens.
const SLOT = "size-10 text-lg max-[359px]:size-9 sm:size-12 sm:text-xl"

export interface OtpInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  /** fires once all 6 digits are typed/pasted */
  onComplete?: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
  invalid?: boolean
  "aria-label"?: string
}

/** 6-digit one-time code input (split 3 + 3), used by the 2FA login and enrolment screens. */
export function OtpInput({ invalid, ...props }: OtpInputProps) {
  return (
    <InputOTP
      maxLength={6}
      inputMode="numeric"
      pattern="^[0-9]*$"
      autoComplete="one-time-code"
      containerClassName="justify-center gap-2"
      {...props}
    >
      <InputOTPGroup>
        {[0, 1, 2].map((i) => (
          <InputOTPSlot key={i} index={i} className={SLOT} aria-invalid={invalid || undefined} />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        {[3, 4, 5].map((i) => (
          <InputOTPSlot key={i} index={i} className={SLOT} aria-invalid={invalid || undefined} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  )
}
