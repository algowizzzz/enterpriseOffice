import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { MoreVertical } from 'lucide-react';

export interface RowMenuItem {
  key: string;
  label: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

/**
 * The overflow menu behind one "⋯" per row: the enterprise pattern (Jira's
 * issue rows, ServiceNow's list actions) for a row that has more actions
 * than fit as buttons without the table turning into a wall of them, which
 * is exactly what a flat row of five or six buttons per document became.
 * One open menu at a time; it closes on an outside click or Escape, the way
 * a native menu does.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="row-menu" ref={ref}>
      <button
        type="button"
        className="row-menu-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreVertical size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="row-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`row-menu-item${item.danger ? ' danger' : ''}`}
              title={item.title}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
