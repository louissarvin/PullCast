import { cnm } from '@/utils/style'

export type Grader = 'PSA' | 'BGS' | 'CGC' | 'SGC' | 'RAW'

interface GradeBadgeProps {
  grader: Grader
  grade: string | number | null
  /**
   * Show the gem-mint treatment:
   * PSA 10 → gold border; BGS Black Label → always has gold border.
   */
  gemMint?: boolean
  className?: string
}

// Grade colors scoped here per DESIGN.md §2.1 / §4.4.
// These hex values must NOT be used anywhere else in the UI.
const graderClasses: Record<Grader, string> = {
  // PSA: #D91E24 red + white text
  PSA: 'bg-[#D91E24] text-white',
  // BGS: gradient #000→#1A1A1A + gold — the ONE permitted gradient per DESIGN.md §4.4
  BGS: 'bg-gradient-to-b from-[#000000] to-[#1A1A1A] text-[#C0A15B] border border-[#C0A15B]',
  // CGC: #1D6BB4 blue + white text
  CGC: 'bg-[#1D6BB4] text-white',
  // SGC: #F2C94C yellow + dark ink
  SGC: 'bg-[#F2C94C] text-[#171412]',
  // Raw / ungraded
  RAW: 'bg-[var(--color-bg-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]',
}

export function GradeBadge({
  grader,
  grade,
  gemMint = false,
  className,
}: GradeBadgeProps) {
  const displayLabel = grade != null ? `${grader} ${grade}` : grader
  const isPsaGemMint = grader === 'PSA' && gemMint

  return (
    <span
      aria-label={displayLabel}
      className={cnm(
        'grade-badge inline-flex items-center',
        'h-5 px-2.5 rounded-[var(--radius-pill)]',
        'text-[11px] font-medium tracking-[0.06em] uppercase leading-none',
        graderClasses[grader],
        // PSA gem-mint gets extra gold border (BGS always has it via graderClasses)
        isPsaGemMint && 'border-[1.5px] border-[#F2C94C]',
        className,
      )}
    >
      <span aria-hidden="true">{displayLabel}</span>
    </span>
  )
}
