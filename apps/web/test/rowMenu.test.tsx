import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowMenu } from '../src/components/RowMenu';

describe('RowMenu', () => {
  it('is closed until the trigger is clicked, then shows its items', async () => {
    const user = userEvent.setup();
    render(<RowMenu label="Actions for Q1 report" items={[{ key: 'open', label: 'Open', onSelect: vi.fn() }]} />);
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions for Q1 report' }));
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
  });

  it('runs the item and closes the menu when one is chosen', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<RowMenu label="Actions" items={[{ key: 'delete', label: 'Delete', onSelect, danger: true }]} />);

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('closes when something outside it is clicked', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Elsewhere</button>
        <RowMenu label="Actions" items={[{ key: 'open', label: 'Open', onSelect: vi.fn() }]} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<RowMenu label="Actions" items={[{ key: 'open', label: 'Open', onSelect: vi.fn() }]} />);
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('does not run a disabled item', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <RowMenu
        label="Actions"
        items={[{ key: 'run', label: 'Run analysis', onSelect, disabled: true }]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: 'Run analysis' })).toBeDisabled();
  });
});
