import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import jsPDFDefault, { jsPDF as jsPDFNamed } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { motion } from 'framer-motion';
import {
  generateReportRowsAsync,
  filterRows,
  computeSummaryStats,
  REPORT_CONFIGS,
  REPORT_FAILURES,
  REPORT_MATERIALS,
  CONFIG_FAILURE_MODES,
  type ReportRow,
  type SummaryStats,
  type SimulationConfig,
  type FailureMode,
  type PanelMaterial,
} from '@/lib/physics/reportData';
import { DETUMBLING_TIME_REQUIREMENT_S } from '@/lib/physics/engine';
import { formatTorqueNm } from '@/lib/utils';
import { Card, CardTitle, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const materialLabels: Record<PanelMaterial, string> = {
  fr4: 'FR4',
  'al-kapton': 'Al/Kapton',
  cfrp: 'CFRP',
};

// Only the coupled config's raw id needs a friendlier phrase; the internal identifier
// 'short-edge-long-edge' is unchanged everywhere else (routing, physics, other configs).
const configLabels: Partial<Record<SimulationConfig, string>> = {
  'short-edge-long-edge': 'short-edge with long-edge coupling',
};

// Display-only "-stuck" suffix for the two-panel modes; internal values stay
// 'two-adjacent'/'two-opposite' (consistent with ComparePage/SimulationPage).
const failureModeLabels: Record<FailureMode, string> = {
  'one-stuck': 'one-stuck',
  'two-adjacent': 'two-adjacent-stuck',
  'two-opposite': 'two-opposite-stuck',
  'all-stuck': 'all-stuck',
};

// Reader-facing column labels for the on-screen table — Greek symbols paired with a
// plain-English qualifier (matching ComparePage's "Peak ω (°/s)" convention) and the
// site-wide t₉₀ notation (matching this same page's Summary Statistics card), instead
// of internal-identifier-style names like "theta_final"/"w_final"/"t_deploy,90".
// τ_avg,detumble is unchanged — it is already reader-facing and pinned by
// detumblingTerminology.test.ts / ReportPage.test.tsx's terminology tests.
const screenColumnLabels = {
  finalAngle: 'Final θ (deg)',
  finalOmega: 'Final ω (deg/s)',
  deployTime: 't₉₀ (s)',
  peakOmega: 'Peak ω (deg/s)',
};

// PDF-safe equivalents: jsPDF's standard fonts cannot render τ, θ, ω, or subscript
// digits, so these spell the same reader-facing labels in ASCII (matching the
// existing "tau_avg,detumble" precedent already used for the pinned torque column).
const pdfColumnLabels = {
  finalAngle: 'Final theta (deg)',
  finalOmega: 'Final omega (deg/s)',
  deployTime: 't90 (s)',
  peakOmega: 'Peak omega (deg/s)',
};

// Display-only ordering for the Scenario Results table and PDF export: grouped by
// configuration (REPORT_CONFIGS order), then by the defined failure-mode order
// (REPORT_FAILURES), then by material order (FR4, Al/Kapton, CFRP — REPORT_MATERIALS).
// Purely a presentation sort — scenario generation, filtering, and every computed
// value are untouched.
const configOrder = new Map(REPORT_CONFIGS.map((cfg, i) => [cfg, i]));
const failureModeOrder = new Map(REPORT_FAILURES.map((mode, i) => [mode, i]));
const materialOrder = new Map(REPORT_MATERIALS.map((material, i) => [material, i]));

function compareForDisplay(a: ReportRow, b: ReportRow): number {
  const configDiff = (configOrder.get(a.config) ?? 0) - (configOrder.get(b.config) ?? 0);
  if (configDiff !== 0) return configDiff;
  const failureDiff = (failureModeOrder.get(a.failureMode) ?? 0) - (failureModeOrder.get(b.failureMode) ?? 0);
  if (failureDiff !== 0) return failureDiff;
  return (materialOrder.get(a.material) ?? 0) - (materialOrder.get(b.material) ?? 0);
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '--';
  return value.toFixed(digits);
}

export function ReportPage() {
  const navigate = useNavigate();
  const [isExporting, setIsExporting] = useState(false);
  const [selectedConfigs, setSelectedConfigs] = useState<SimulationConfig[]>(REPORT_CONFIGS);
  const [selectedFailures, setSelectedFailures] = useState<FailureMode[]>(REPORT_FAILURES);
  const [selectedMaterials, setSelectedMaterials] = useState<PanelMaterial[]>(REPORT_MATERIALS);

  // The 42-scenario physics sweep takes ~24 s on first load (cached afterwards),
  // so it runs asynchronously — one scenario per event-loop turn — with progress
  // shown instead of freezing the page. Filter changes never re-run physics.
  const [allRows, setAllRows] = useState<ReportRow[] | null>(null);
  const [genProgress, setGenProgress] = useState({ done: 0, total: 42 });

  useEffect(() => {
    let cancelled = false;
    generateReportRowsAsync((done, total) => {
      if (!cancelled) setGenProgress({ done, total });
    }).then(rows => {
      if (!cancelled) setAllRows(rows);
    });
    return () => { cancelled = true; };
  }, []);

  // Failure modes actually valid for the currently selected configuration(s) — an
  // empty selection means "all configs", mirroring filterRows's own empty-means-all
  // semantics. long-edge (2 panels) only supports one-stuck/all-stuck, so selecting
  // only long-edge collapses this to 2 modes instead of the full 4.
  const applicableFailureModes = useMemo(() => {
    const configsInScope = selectedConfigs.length === 0 ? REPORT_CONFIGS : selectedConfigs;
    const applicable = new Set<FailureMode>();
    for (const cfg of configsInScope) {
      for (const mode of CONFIG_FAILURE_MODES[cfg]) applicable.add(mode);
    }
    return REPORT_FAILURES.filter((mode) => applicable.has(mode));
  }, [selectedConfigs]);

  // Reconcile the Failure Mode selection whenever the applicable set changes (e.g. the
  // Configuration filter narrows to long-edge only) — a hidden/invalid selection must
  // never silently zero out the visible rows. Falls back to "select all applicable
  // modes" only if every previously-selected mode became invalid; otherwise leaves the
  // selection (and its object identity) untouched.
  useEffect(() => {
    setSelectedFailures((prev) => {
      const stillValid = prev.filter((f) => applicableFailureModes.includes(f));
      if (prev.length === stillValid.length) return prev;
      return stillValid.length > 0 ? stillValid : applicableFailureModes;
    });
  }, [applicableFailureModes]);

  const filteredRows = useMemo(
    () => (allRows ? filterRows(allRows, selectedConfigs, selectedFailures, selectedMaterials) : []),
    [allRows, selectedConfigs, selectedFailures, selectedMaterials],
  );

  // Display-only ordering for the table and PDF — grouped by configuration, then the
  // defined failure-mode order, then material order. Does not affect filteredRows
  // (still used for stats/summary, where order is irrelevant).
  const displayRows = useMemo(
    () => [...filteredRows].sort(compareForDisplay),
    [filteredRows],
  );

  const stats = useMemo(
    () => computeSummaryStats(filteredRows),
    [filteredRows],
  );

  const scenarios = useMemo(
    () => filteredRows.map((row) => ({
      w_peak: row.peakOmegaDegPerS,
      tau_avg_req: row.averageRequiredDetumblingTorqueNm,
      t_deploy: row.deployTimeS,
      config: row.config,
      failureMode: row.failureMode,
      material: row.material,
    })),
    [filteredRows],
  );

  // Reported τ_avg,detumble: the MAXIMUM averageRequiredDetumblingTorqueNm across the
  // filtered rows. This is NOT necessarily the row with peak angular velocity — torque
  // derives from angular momentum (velocity × inertia), so a lower-ω row can still have
  // the highest required torque. Each row already carries its own trajectory maximum of
  // the internal body angular momentum divided by T_REQ.
  const tau_avg_req = useMemo(
    () => scenarios.reduce((max, s) => Math.max(max, s.tau_avg_req), 0),
    [scenarios],
  );

  const toggleConfig = (cfg: SimulationConfig) => {
    setSelectedConfigs((prev) =>
      prev.includes(cfg) ? prev.filter(c => c !== cfg) : [...prev, cfg],
    );
  };

  const toggleFailure = (failure: FailureMode) => {
    setSelectedFailures((prev) =>
      prev.includes(failure) ? prev.filter(f => f !== failure) : [...prev, failure],
    );
  };

  const toggleMaterial = (material: PanelMaterial) => {
    setSelectedMaterials((prev) =>
      prev.includes(material) ? prev.filter(m => m !== material) : [...prev, material],
    );
  };

  const resetFilters = () => {
    setSelectedConfigs(REPORT_CONFIGS);
    setSelectedFailures(REPORT_FAILURES);
    setSelectedMaterials(REPORT_MATERIALS);
  };

  const exportToPDF = () => {
    setIsExporting(true);
    const scenarios = filteredRows.map((row) => ({
      tau_avg_req: row.averageRequiredDetumblingTorqueNm,
    }));

    // Same selection the page uses: the maximum averageRequiredDetumblingTorqueNm across
    // the filtered rows — not the row with peak angular velocity.
    const tau_avg_req = scenarios.reduce((max, s) => Math.max(max, s.tau_avg_req), 0);

    const PdfCtor = jsPDFNamed ?? (jsPDFDefault as typeof jsPDFNamed);
    const doc = new PdfCtor({ orientation: 'landscape' });

    doc.setFontSize(16);
    doc.text('CubeSat Deployment Report', 14, 16);
    doc.setFontSize(10);
    doc.text(
      '42-Scenario Failure-Mode Sweep Across Four Panel Configurations and Three Material Presets',
      14,
      23,
    );
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 29);

    const filterLine = `Configs: ${selectedConfigs.length}/4 · Failure Modes: ${selectedFailures.length}/4 · Materials: ${selectedMaterials.length}/3`;
    doc.text(filterLine, 14, 35);

    doc.setFontSize(11);
    doc.text('Summary Statistics:', 14, 45);
    doc.setFontSize(9);

    const statLines = [
      `Scenarios: ${stats.count}`,
      `Mean Final Angle: ${stats.meanFinalAngle.toFixed(2)} deg (±${stats.stdFinalAngle.toFixed(2)})`,
      `Mean tau_avg,detumble: ${formatTorqueNm(stats.meanAverageRequiredDetumblingTorqueNm)} N·m`
        + ` (±${formatTorqueNm(stats.stdAverageRequiredDetumblingTorqueNm)})`,
      `Mean Deploy Time: ${stats.meanDeployTimeS.toFixed(3)} s (±${stats.stdDeployTimeS.toFixed(3)})`,
      `Max Peak w: ${stats.maxPeakOmegaDegPerS.toFixed(2)} deg/s`,
    ];

    let yPos = 51;
    for (const line of statLines) {
      doc.text(line, 14, yPos);
      yPos += 5;
    }

    let y = yPos + 2;
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('Detumbling Correction Analysis', 14, y);
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    const lineGap = 6;

    doc.text('tau_avg,detumble (N·m):', 14, y);
    y += lineGap;
    doc.text(`  tau_avg,detumble = H_remove,max / ${DETUMBLING_TIME_REQUIREMENT_S} s`, 14, y);
    y += lineGap;
    doc.text('  ------------------------', 14, y);
    y += lineGap;
    doc.text(`  tau_avg,detumble = ${formatTorqueNm(tau_avg_req)} N·m`, 14, y);
    y += lineGap + 4;

    doc.setDrawColor(180);
    doc.line(14, y, 283, y);
    y += 6;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.text(
      'tau_avg,detumble denotes the average required detumbling torque. '
        + `tau_avg,detumble = H_remove,max / ${DETUMBLING_TIME_REQUIREMENT_S} s. Unit: N·m.`,
      14,
      y,
    );
    y += 6;
    doc.text(
      'This value equals the maximum deployment-induced body angular momentum divided by an '
        + 'assumed 5,400 s one-orbit LEO detumbling allocation. It is an average ADCS sizing '
        + 'requirement, not a simulated actuator torque.',
      14,
      y,
    );
    y += 10;

    doc.setDrawColor(180);
    doc.line(14, y, 283, y);
    y += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);

    const tableBody = displayRows.map((row) => [
      configLabels[row.config] ?? row.config,
      failureModeLabels[row.failureMode] ?? row.failureMode,
      materialLabels[row.material] ?? row.material,
      row.panelMass.toFixed(3),
      row.finalAngleDeg.toFixed(2),
      row.finalOmegaDegPerS.toFixed(2),
      formatTorqueNm(row.averageRequiredDetumblingTorqueNm),
      row.deployTimeS.toFixed(3),
      row.peakOmegaDegPerS.toFixed(2),
    ]);

    autoTable(doc, {
      startY: y,
      head: [[
        'Config',
        'Failure',
        'Material',
        'Mass (kg)',
        pdfColumnLabels.finalAngle,
        pdfColumnLabels.finalOmega,
        'tau_avg,detumble (N·m)',
        pdfColumnLabels.deployTime,
        pdfColumnLabels.peakOmega,
      ]],
      body: tableBody,
      theme: 'grid',
      styles: { fontSize: 7, cellPadding: 1 },
      columnStyles: {
        0: { cellWidth: 20 },
        1: { cellWidth: 20 },
        2: { cellWidth: 20 },
        3: { cellWidth: 18 },
        4: { cellWidth: 22 },
        5: { cellWidth: 22 },
        6: { cellWidth: 34 },
        7: { cellWidth: 22 },
        8: { cellWidth: 22 },
      },
    });

    doc.save('deployable-dynamics-report.pdf');
    setIsExporting(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="min-h-screen bg-background p-6"
    >
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Deployment Report</h1>
          <p className="text-base font-medium text-foreground/80">
            42-Scenario Failure-Mode Sweep Across Four Panel Configurations and Three Material Presets
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate('/compare')}>
            Back to Compare
          </Button>
          <Button onClick={exportToPDF} disabled={isExporting || !allRows}>
            {isExporting ? 'Exporting...' : 'Export PDF'}
          </Button>
        </div>
      </div>

      {!allRows && (
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="text-sm font-medium">
              Running physics-driven scenario sweep… {genProgress.done}/{genProgress.total}
            </div>
            <div className="w-full bg-secondary rounded-full h-1.5 mt-2">
              <div
                className="bg-primary h-1.5 rounded-full transition-all"
                style={{ width: `${(genProgress.done / Math.max(1, genProgress.total)) * 100}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              The report evaluates a 42-scenario failure-mode sweep across four panel
              configurations and three material presets. The number of valid failure cases
              depends on the number and arrangement of panels in each configuration. The
              long-edge configuration contains two panels; therefore, it has no separate
              adjacent-pair and opposite-pair failure cases. Each scenario runs the full
              torsional-hinge dynamics at the fixed 1/1200 s physics timestep. Results are cached
              for this session.
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Configuration</label>
              <div className="space-y-1 border rounded-md p-2">
                {REPORT_CONFIGS.map((cfg) => (
                  <label key={cfg} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedConfigs.includes(cfg)}
                      onChange={() => toggleConfig(cfg)}
                    />
                    {configLabels[cfg] ?? cfg}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Failure Mode</label>
              <div className="space-y-1 border rounded-md p-2">
                {applicableFailureModes.map((failure) => (
                  <label key={failure} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedFailures.includes(failure)}
                      onChange={() => toggleFailure(failure)}
                    />
                    {failureModeLabels[failure] ?? failure}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Material</label>
              <div className="space-y-1 border rounded-md p-2">
                {REPORT_MATERIALS.map((material) => (
                  <label key={material} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedMaterials.includes(material)}
                      onChange={() => toggleMaterial(material)}
                    />
                    {materialLabels[material] ?? material}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              Showing {filteredRows.length} of 42 scenarios
            </div>
            <Button variant="outline" onClick={resetFilters}>
              Reset Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Summary Statistics</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Scenarios</div>
            <div className="text-xl font-semibold">{stats.count}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Mean Final Angle</div>
            <div className="text-xl font-semibold">
              {formatNumber(stats.meanFinalAngle, 2)} deg
            </div>
            <div className="text-xs text-muted-foreground">
              Std: {formatNumber(stats.stdFinalAngle, 2)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Mean τ_avg,detumble</div>
            <div className="text-xl font-semibold">
              {formatTorqueNm(stats.meanAverageRequiredDetumblingTorqueNm)} N·m
            </div>
            <div className="text-xs text-muted-foreground">
              Std: {formatTorqueNm(stats.stdAverageRequiredDetumblingTorqueNm)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Mean Deploy Time (t₉₀)</div>
            <div className="text-xl font-semibold">
              {formatNumber(stats.meanDeployTimeS, 3)} s
            </div>
            <div className="text-xs text-muted-foreground">
              Std: {formatNumber(stats.stdDeployTimeS, 3)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Max Peak w</div>
            <div className="text-xl font-semibold">
              {formatNumber(stats.maxPeakOmegaDegPerS, 2)} deg/s
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Detumbling Correction Analysis</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <div className="rounded-lg border bg-card p-4">
            <div className="text-xs uppercase text-muted-foreground">τ_avg,detumble (N·m)</div>
            <div className="mt-2 space-y-1">
              <div className="text-lg font-semibold">
                τ_avg,detumble = {formatTorqueNm(tau_avg_req)} N·m
              </div>
              <div className="pt-2 text-sm text-foreground/80">
                τ_avg,detumble denotes the average required detumbling torque.
                τ_avg,detumble = H_remove,max / {DETUMBLING_TIME_REQUIREMENT_S.toLocaleString()} s.
                Unit: N·m.
              </div>
              <div className="pt-2 text-sm text-foreground/80">
                This value equals the maximum deployment-induced body angular momentum divided
                by an assumed 5,400 s one-orbit LEO detumbling allocation. It is an average
                ADCS sizing requirement, not a simulated actuator torque.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scenario Results</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4">Config</th>
                  <th className="text-left py-2 pr-4">Failure</th>
                  <th className="text-left py-2 pr-4">Material</th>
                  <th className="text-right py-2 pr-4">Mass (kg)</th>
                  <th className="text-right py-2 pr-4">{screenColumnLabels.finalAngle}</th>
                  <th className="text-right py-2 pr-4">{screenColumnLabels.finalOmega}</th>
                  <th className="text-right py-2 pr-4">τ_avg,detumble (N·m)</th>
                  <th className="text-right py-2 pr-4">{screenColumnLabels.deployTime}</th>
                  <th className="text-right py-2">{screenColumnLabels.peakOmega}</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row) => (
                  <tr key={row.id} data-testid="report-row" className="border-b">
                    <td className="py-2 pr-4">{configLabels[row.config] ?? row.config}</td>
                    <td className="py-2 pr-4">{failureModeLabels[row.failureMode] ?? row.failureMode}</td>
                    <td className="py-2 pr-4">{materialLabels[row.material] ?? row.material}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(row.panelMass, 3)}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(row.finalAngleDeg, 2)}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(row.finalOmegaDegPerS, 2)}</td>
                    <td className="py-2 pr-4 text-right">
                      {formatTorqueNm(row.averageRequiredDetumblingTorqueNm)}
                    </td>
                    <td className="py-2 pr-4 text-right">{formatNumber(row.deployTimeS, 3)}</td>
                    <td className="py-2 text-right">{formatNumber(row.peakOmegaDegPerS, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export default ReportPage;
