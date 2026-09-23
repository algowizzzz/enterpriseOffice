import type { JSX, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * An icon, and optionally a word beside it, inside a button whose accessible
 * name comes from elsewhere (a `title`/`aria-label`, or its own visible text
 * node placed after this). The icon is `aria-hidden`: it decorates a name
 * that already exists rather than supplying one, so adding or removing it
 * here never changes what a screen reader, or a test that queries by role
 * and accessible name, sees.
 */
export function IconLabel({ icon: Icon, size = 15, children }: { icon: LucideIcon; size?: number; children?: ReactNode }): JSX.Element {
  return (
    <>
      <Icon size={size} aria-hidden="true" />
      {children ? <span className="tool-word">{children}</span> : null}
    </>
  );
}
