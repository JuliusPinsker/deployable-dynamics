import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReportRow } from '@/lib/physics/reportData';
import { formatTorqueNm } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
//  Regression guard: the τ_avg,detumble card must select the MAXIMUM
//  averageRequiredDetumblingTorqueNm across the filtered rows, never the row
//  with peak angular velocity. Torque derives from angular momentum (velocity
//  × inertia), so a lower-ω row can still carry the higher required torque —
//  this fixture makes that split deterministic instead of relying on the
//  48-row physics sweep to happen to produce one.
// ─────────────────────────────────────────────────────────────────────────────

const ROW_A: ReportRow = {
  id: 'long-edge-all-stuck-fr4',
  config: 'long-edge',
  failureMode: 'all-stuck',
  material: 'fr4',
  panelMass: 0.032,
  finalAngleDeg: 90,
  finalOmegaDegPerS: 50,
  peakOmegaDegPerS: 100, // HIGHER peak ω
  averageRequiredDetumblingTorqueNm: 1e-8, // LOWER torque
  deployTimeS: 1.2,
};

const ROW_B: ReportRow = {
  id: 'short-edge-one-stuck-cfrp',
  config: 'short-edge',
  failureMode: 'one-stuck',
  material: 'cfrp',
  panelMass: 0.02,
  finalAngleDeg: 88,
  finalOmegaDegPerS: 8,
  peakOmegaDegPerS: 10, // LOWER peak ω
  averageRequiredDetumblingTorqueNm: 5e-7, // HIGHER torque
  deployTimeS: 1.5,
};

vi.mock('jspdf', () => {
  const mockDoc = {
    setFontSize: vi.fn(),
    setFont: vi.fn(),
    text: vi.fn(),
    setDrawColor: vi.fn(),
    line: vi.fn(),
    autoTable: vi.fn(),
    save: vi.fn(),
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    lastAutoTable: { finalY: 100 },
  };
  const jsPDF = vi.fn(() => mockDoc);
  return { jsPDF };
});

vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

vi.mock('@/lib/physics/reportData', async () => {
  const actual = await vi.importActual<typeof import('@/lib/physics/reportData')>(
    '@/lib/physics/reportData',
  );
  return {
    ...actual,
    generateReportRowsAsync: async (onProgress?: (done: number, total: number) => void) => {
      onProgress?.(2, 2);
      return [ROW_A, ROW_B];
    },
  };
});

import ReportPage from '@/pages/ReportPage';

const WrappedReportPage = () => (
  <MemoryRouter>
    <ReportPage />
  </MemoryRouter>
);

describe('ReportPage τ_avg,detumble card — max-torque selection', () => {
  it('selects row B (higher torque, lower peak ω), not row A (higher peak ω)', async () => {
    render(<WrappedReportPage />);

    await waitFor(() => {
      expect(screen.getAllByTestId('report-row')).toHaveLength(2);
    });

    // Sanity: row A really does have the higher peak ω in this fixture.
    expect(ROW_A.peakOmegaDegPerS).toBeGreaterThan(ROW_B.peakOmegaDegPerS);
    expect(ROW_B.averageRequiredDetumblingTorqueNm).toBeGreaterThan(
      ROW_A.averageRequiredDetumblingTorqueNm,
    );

    const expected = formatTorqueNm(ROW_B.averageRequiredDetumblingTorqueNm);
    const notExpected = formatTorqueNm(ROW_A.averageRequiredDetumblingTorqueNm);

    expect(screen.getByText(`τ_avg,detumble = ${expected} N·m`)).toBeInTheDocument();
    expect(screen.queryByText(`τ_avg,detumble = ${notExpected} N·m`)).not.toBeInTheDocument();
  });
});
