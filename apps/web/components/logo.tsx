/** The Overturn mark: an angular flip, drawn in the current text color. */
export function Logo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="14 7 74 76" className={className} aria-hidden="true" fill="currentColor">
      <path d="M18 31 47 10 57 17 57 31 71 31 84 43 84 57 55 80 44 73 44 59 30 59 17 47Z" />
      <path d="M31 34 47 22 47 42 68 42 72 46 72 53 54 67 54 48 33 48 29 44Z" className="fill-background" />
    </svg>
  );
}
