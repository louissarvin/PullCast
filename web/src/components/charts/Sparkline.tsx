interface SparklineProps {
  data: Array<number>
  width?: number
  height?: number
  className?: string
}

export function Sparkline({ data, width = 120, height = 36, className }: SparklineProps) {
  if (!data.length) return null

  const W = width
  const H = height
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const points = data
    .map((v, i) => {
      const x = data.length === 1 ? W / 2 : (i / (data.length - 1)) * W
      const y = H - ((v - min) / range) * (H - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      className={className ?? 'overflow-visible'}
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
