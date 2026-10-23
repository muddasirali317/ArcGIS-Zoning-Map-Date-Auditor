import { useId } from 'react';

/**
 * Brand mark: a flat "map layers" stack (one filled top tile + two layer bands beneath), in the
 * dashboard's cyan→teal. Background is transparent (plain SVG). Unique gradient id per instance.
 */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  const u = useId().replace(/:/g, '');
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label="Zoning Map Date Auditor logo">
      <defs>
        <linearGradient id={`g${u}`} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" /><stop offset="1" stopColor="#2dd4bf" />
        </linearGradient>
      </defs>
      {/* top tile, filled */}
      <path d="M12 2 22 7 12 12 2 7Z" fill={`url(#g${u})`} />
      {/* two layer bands beneath */}
      <path d="M2 12 12 17 22 12" stroke="#2dd4bf" strokeWidth="2.1" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M2 17 12 22 22 17" stroke="#38bdf8" strokeWidth="2.1" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
