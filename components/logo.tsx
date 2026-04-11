import Link from 'next/link'

interface LogoProps {
  href?: string
  size?: 'sm' | 'md'
}

export function Logo({ href = '/', size = 'md' }: LogoProps) {
  const iconSize = size === 'sm' ? 'w-6 h-6' : 'w-7 h-7'
  const textSize = size === 'sm' ? 'text-base' : 'text-lg'

  return (
    <Link href={href} className="flex items-center gap-1.5">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className={iconSize}
        stroke="#22c55e"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="1 4 1 10 7 10" />
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
      </svg>
      <span className={`font-semibold text-slate-900 ${textSize}`}>
        win<span className="text-green-500">back</span>
      </span>
    </Link>
  )
}
