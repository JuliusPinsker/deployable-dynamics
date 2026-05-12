import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import LandingPage from '@/pages/LandingPage';

vi.mock('@/components/ui/theme-toggle', () => ({
  default: () => null,
}));

describe('LandingPage material picker', () => {
  it('renders presets and selects FR4 by default', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    const group = screen.getByRole('radiogroup', { name: 'Panel material' });
    const options = within(group).getAllByRole('radio');

    expect(options).toHaveLength(3);

    const fr4 = within(group).getByRole('radio', { name: /FR4 PCB/i });
    expect(fr4).toHaveAttribute('aria-checked', 'true');

    const cfrp = within(group).getByRole('radio', { name: /CFRP Composite/i });
    expect(cfrp).toHaveAttribute('aria-checked', 'false');
  });
});
