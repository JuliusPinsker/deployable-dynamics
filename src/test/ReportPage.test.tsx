import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import ReportPage from '@/pages/ReportPage';

vi.mock('jspdf', () => {
  const mockDoc = {
    setFontSize: vi.fn(),
    setFont: vi.fn(),
    text: vi.fn(),
    autoTable: vi.fn(),
    save: vi.fn(),
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    lastAutoTable: { finalY: 100 },
  };
  const jsPDF = vi.fn(() => mockDoc);
  return { jsPDF };
});

vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

const WrappedReportPage = () => (
  <MemoryRouter>
    <ReportPage />
  </MemoryRouter>
);

describe('ReportPage', () => {
  it('renders 48 scenario rows', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        const rows = screen.getAllByTestId('report-row');
        expect(rows).toHaveLength(48);
      },
      { timeout: 15000 },
    );
  });

  it('exports the report to PDF', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => screen.getAllByTestId('report-row'),
      { timeout: 15000 },
    );

    const exportBtn = screen.getByRole('button', { name: /export pdf/i });
    fireEvent.click(exportBtn);

    const { jsPDF } = await import('jspdf');
    expect(jsPDF).toHaveBeenCalled();
  });
});
