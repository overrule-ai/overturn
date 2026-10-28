/** The Overturn mark (Pinwheel), drawn in the current text color. */
export function Logo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="8 8 48 48" className={className} aria-hidden="true" fill="currentColor">
      <path d="M32.000 32.000 L32.000 9.000 A11.500 11.500 0 0 1 32.000 32.000Z M32.000 32.000 L55.000 32.000 A11.500 11.500 0 0 1 32.000 32.000Z M32.000 32.000 L32.000 55.000 A11.500 11.500 0 0 1 32.000 32.000Z M32.000 32.000 L9.000 32.000 A11.500 11.500 0 0 1 32.000 32.000Z" />
    </svg>
  );
}
