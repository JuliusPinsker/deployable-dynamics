import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import jsPDFDefault, { jsPDF as jsPDFNamed } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { motion } from 'framer-motion';
import { MathUtils } from 'three';
import {
  generate48RowsAsync,
  filterRows,
  computeSummaryStats,
  REPORT_CONFIGS,
  REPORT_FAILURES,
  REPORT_MATERIALS,
  type ReportRow,
  type SummaryStats,
  type SimulationConfig,
  type FailureMode,
  type PanelMaterial,
} from '@/lib/physics/reportData';
import { DEFAULT_PARAMS } from '@/lib/physics/types';
import { Card, CardTitle, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const materialLabels: Record<PanelMaterial, string> = {
  fr4: 'FR4',
  'al-kapton': 'Al/Kapton',
  cfrp: 'CFRP',
};

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

  // The 48-scenario physics sweep takes ~27 s on first load (cached afterwards),
  // so it runs asynchronously — one scenario per event-loop turn — with progress
  // shown instead of freezing the page. Filter changes never re-run physics.
  const [allRows, setAllRows] = useState<ReportRow[] | null>(null);
  const [genProgress, setGenProgress] = useState({ done: 0, total: 48 });

  useEffect(() => {
    let cancelled = false;
    generate48RowsAsync((done, total) => {
      if (!cancelled) setGenProgress({ done, total });
    }).then(rows => {
      if (!cancelled) setAllRows(rows);
    });
    return () => { cancelled = true; };
  }, []);

  const filteredRows = useMemo(
    () => (allRows ? filterRows(allRows, selectedConfigs, selectedFailures, selectedMaterials) : []),
    [allRows, selectedConfigs, selectedFailures, selectedMaterials],
  );

  const stats = useMemo(
    () => computeSummaryStats(filteredRows),
    [filteredRows],
  );

  const scenarios = useMemo(
    () => filteredRows.map((row) => ({
      w_peak: row.peakOmegaDegPerS,
      E_det: row.eDetumbleMJ,
      t_deploy: row.deployTimeS,
      config: row.config,
      failureMode: row.failureMode,
      material: row.material,
    })),
    [filteredRows],
  );

  const {
    I_body,
    worst,
    omega_degs,
    omega_rads,
    delta_L,
    E_correct_mJ,
    rps,
    led_ms,
    deployTimeS,
  } = useMemo(() => {
    const p = DEFAULT_PARAMS;
    const Ix = (1 / 12) * p.bodyMass * (p.bodyHeight ** 2 + p.bodyDepth ** 2);
    const Iy = (1 / 12) * p.bodyMass * (p.bodyWidth ** 2 + p.bodyDepth ** 2);
    const Iz = (1 / 12) * p.bodyMass * (p.bodyWidth ** 2 + p.bodyHeight ** 2);
    const I_body = Math.max(Ix, Iy, Iz);

    const worst = [...scenarios].sort((a, b) => b.w_peak - a.w_peak)[0];
    const omega_degs = worst?.w_peak ?? 0;
    const omega_rads = MathUtils.degToRad(omega_degs);
    const delta_L = I_body * omega_rads;
    const E_correct_mJ = 0.5 * I_body * omega_rads ** 2 * 1000;
    const rps = omega_degs / 360;
    const led_ms = E_correct_mJ / 0.02;
    const deployTimeS = worst?.t_deploy ?? 0;

    return {
      I_body,
      worst,
      omega_degs,
      omega_rads,
      delta_L,
      E_correct_mJ,
      rps,
      led_ms,
      deployTimeS,
    };
  }, [scenarios]);

  const worstConfig = worst?.config ?? '--';
  const worstFailure = worst?.failureMode ?? '--';
  const worstMaterial = worst?.material
    ? materialLabels[worst.material] ?? worst.material
    : '--';

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
      w_peak: row.peakOmegaDegPerS,
      E_det: row.eDetumbleMJ,
      t_deploy: row.deployTimeS,
      config: row.config,
      failureMode: row.failureMode,
      material: row.material,
    }));

    const p = DEFAULT_PARAMS;
    const Ix = (1 / 12) * p.bodyMass * (p.bodyHeight ** 2 + p.bodyDepth ** 2);
    const Iy = (1 / 12) * p.bodyMass * (p.bodyWidth ** 2 + p.bodyDepth ** 2);
    const Iz = (1 / 12) * p.bodyMass * (p.bodyWidth ** 2 + p.bodyHeight ** 2);
    const I_body = Math.max(Ix, Iy, Iz);

    const worst = [...scenarios].sort((a, b) => b.w_peak - a.w_peak)[0];
    const omega_degs = worst?.w_peak ?? 0;
    const omega_rads = MathUtils.degToRad(omega_degs);
    const delta_L = I_body * omega_rads;
    const E_correct_mJ = 0.5 * I_body * omega_rads ** 2 * 1000;
    const rps = omega_degs / 360;
    const led_ms = E_correct_mJ / 0.02;
    const deployTimeS = worst?.t_deploy ?? 0;

    const PdfCtor = jsPDFNamed ?? (jsPDFDefault as typeof jsPDFNamed);
    const doc = new PdfCtor({ orientation: 'landscape' });

    doc.setFontSize(16);
    doc.text('CubeSat Deployment Report', 14, 16);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);

    const filterLine = `Configs: ${selectedConfigs.length}/4 · Failure Modes: ${selectedFailures.length}/4 · Materials: ${selectedMaterials.length}/3`;
    doc.text(filterLine, 14, 30);

    doc.setFontSize(11);
    doc.text('Summary Statistics:', 14, 40);
    doc.setFontSize(9);

    const statLines = [
      `Scenarios: ${stats.count}`,
      `Mean Final Angle: ${stats.meanFinalAngle.toFixed(2)} deg (±${stats.stdFinalAngle.toFixed(2)})`,
      `Mean E_detumble: ${stats.meanEDetumbleMJ.toFixed(3)} mJ (±${stats.stdEDetumbleMJ.toFixed(3)})`,
      `Mean Deploy Time: ${stats.meanDeployTimeS.toFixed(3)} s (±${stats.stdDeployTimeS.toFixed(3)})`,
      `Max Peak w: ${stats.maxPeakOmegaDegPerS.toFixed(2)} deg/s`,
    ];

    let yPos = 46;
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

    const blockStartY = y;
    const lineGap = 6;

    let yLeft = blockStartY;
    doc.text('Worst-Case Scenario (by peak angular rate):', 14, yLeft);
    yLeft += lineGap;
    doc.text(`  Config:   ${worst?.config ?? '--'}`, 14, yLeft);
    yLeft += lineGap;
    doc.text(`  Failure:  ${worst?.failureMode ?? '--'}`, 14, yLeft);
    yLeft += lineGap;
    doc.text(`  Material: ${worst?.material ?? '--'}`, 14, yLeft);
    yLeft += lineGap;
    doc.text(`  Peak rate: ${omega_degs.toFixed(2)} deg/s`, 14, yLeft);
    yLeft += lineGap;
    doc.text(`  (${omega_rads.toFixed(4)} rad/s)`, 14, yLeft);
    yLeft += lineGap;
    doc.text(`  = ${rps.toFixed(4)} full rotations/second`, 14, yLeft);
    yLeft += lineGap;

    let yMid = blockStartY;
    doc.text('Energy to Detumble:', 110, yMid);
    yMid += lineGap;
    doc.text('  E = 1/2 * I * omega^2', 110, yMid);
    yMid += lineGap;
    doc.text(`  I_body = ${(I_body * 1e4).toFixed(3)} x 10^-4 kg*m^2`, 110, yMid);
    yMid += lineGap;
    doc.text(`  omega  = ${omega_rads.toFixed(4)} rad/s`, 110, yMid);
    yMid += lineGap;
    doc.text('  -------------------------', 110, yMid);
    yMid += lineGap;
    doc.text(`  E = ${E_correct_mJ.toFixed(3)} mJ`, 110, yMid);
    yMid += lineGap;
    doc.text(`  ~ 20mW LED on for ${led_ms.toFixed(1)} ms`, 110, yMid);
    yMid += lineGap;

    let yRight = blockStartY;
    doc.text('Angular Impulse Required:', 200, yRight);
    yRight += lineGap;
    doc.text('  Delta_L = I * omega', 200, yRight);
    yRight += lineGap;
    doc.text(`  Delta_L = ${delta_L.toFixed(6)} kg*m^2/s`, 200, yRight);
    yRight += lineGap;
    yRight += lineGap;
    doc.text('  (Must be supplied by ADCS:', 200, yRight);
    yRight += lineGap;
    doc.text('   magnetorquer or reaction wheel)', 200, yRight);
    yRight += lineGap;

    y = Math.max(yLeft, yMid, yRight) + 4;
    doc.setDrawColor(180);
    doc.line(14, y, 283, y);
    y += 6;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.text(
      'Tumble onset coincides with deployment start (t = 0 s). Worst-case calculated deployment time '
        + `t90 = ${deployTimeS.toFixed(3)} s (first reach of 90% of the deployed panel angle - the `
        + 'same t_deploy,90 metric as the table). Prevention window, defined on that metric: '
        + `${deployTimeS.toFixed(3)} s.`,
      14,
      y,
    );
    y += 6;
    doc.text(
      'Method note: physics-driven torsional-hinge simulation (fixed 1/1200 s timestep); default hinge '
        + 'k/c are a sensitivity-tested engineering calibration (see src/lib/physics/calibration.ts), '
        + 'pending component-level torsion-spring and deployment testing.',
      14,
      y,
    );
    y += 10;

    doc.setDrawColor(180);
    doc.line(14, y, 283, y);
    y += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);

    const tableBody = filteredRows.map((row) => [
      row.config,
      row.failureMode,
      materialLabels[row.material] ?? row.material,
      row.panelMass.toFixed(3),
      row.finalAngleDeg.toFixed(2),
      row.finalOmegaDegPerS.toFixed(2),
      row.eDetumbleMJ.toFixed(3),
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
        'theta_final (deg)',
        'w_final (deg/s)',
        'E_det (mJ)',
        't_deploy,90 (s)',
        'w_peak (deg/s)',
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
        6: { cellWidth: 22 },
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
          <p className="text-sm text-muted-foreground">
            48-Scenario Sweep - Config x Failure Mode x Material
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
              Each of the 48 scenarios (4 configs × 4 failure modes × 3 materials) runs the full
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
                    {cfg}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Failure Mode</label>
              <div className="space-y-1 border rounded-md p-2">
                {REPORT_FAILURES.map((failure) => (
                  <label key={failure} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedFailures.includes(failure)}
                      onChange={() => toggleFailure(failure)}
                    />
                    {failure}
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
              Showing {filteredRows.length} of 48 scenarios
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
            <div className="text-xs uppercase text-muted-foreground">Mean E_detumble</div>
            <div className="text-xl font-semibold">
              {formatNumber(stats.meanEDetumbleMJ, 3)} mJ
            </div>
            <div className="text-xs text-muted-foreground">
              Std: {formatNumber(stats.stdEDetumbleMJ, 3)}
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
        <CardContent className="space-y-4 text-sm">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">Worst-Case Scenario</div>
              <div className="mt-2 space-y-1">
                <div>Config: {worstConfig}</div>
                <div>Failure: {worstFailure}</div>
                <div>Material: {worstMaterial}</div>
                <div className="pt-2">
                  Peak rate: {omega_degs.toFixed(2)} deg/s
                </div>
                <div>({omega_rads.toFixed(4)} rad/s)</div>
                <div className="pt-1">= {rps.toFixed(3)} full rotations/second</div>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">Energy to Detumble</div>
              <div className="mt-2 space-y-1">
                <div>E = 1/2 * I * omega^2</div>
                <div>I_body = {(I_body * 1e4).toFixed(3)} x 10^-4 kg*m^2</div>
                <div>omega = {omega_rads.toFixed(4)} rad/s</div>
                <div className="my-2 border-t" />
                <div className="text-lg font-semibold">E = {E_correct_mJ.toFixed(3)} mJ</div>
                <div className="text-xs text-muted-foreground">
                  Approx. equivalent to a 20 mW LED on for {led_ms.toFixed(1)} ms
                </div>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">Angular Impulse Required</div>
              <div className="mt-2 space-y-1">
                <div>Delta L = I * omega</div>
                <div>Delta L = {delta_L.toFixed(6)} kg*m^2/s</div>
                <div className="pt-2 text-xs text-muted-foreground">
                  This impulse must be provided by the ADCS (magnetorquer or reaction wheel) to fully
                  arrest the post-deployment tumble.
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4 text-sm">
            Tumble onset coincides with deployment start (t = 0 s). For the worst-case scenario,
            the calculated deployment time is t₉₀ = {deployTimeS.toFixed(3)} s — the first reach
            of 90% of the deployed panel angle, the same t_deploy,90 metric reported per scenario
            below (stop capture/latch occurs slightly later and is a different quantity).
            Prevention window, defined on that same metric: {deployTimeS.toFixed(3)} s.
          </div>

          <div className="rounded-lg border bg-card p-4 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Methodology &amp; limitations.</span>{' '}
            All results come from the physics-driven torsional spring-damper hinge simulation
            (deterministic fixed 1/1200 s timestep); deployment times are emergent simulation
            results, never prescribed. t_deploy,90 = first reach of 90% of the deployed angle.
            The default hinge stiffness and damping (k = 4.45e-4 N·m/rad, c = 2.23e-4 N·m·s/rad,
            free-travel ζ ≈ 0.30) are a sensitivity-tested engineering calibration
            (grid sweep in src/lib/physics/calibration.ts) — not vendor-qualified hinge values —
            pending component-level torsion-spring and deployment testing. Angular momentum is
            enforced by an iterative correction step; conservation figures are numerical
            diagnostics of this model, not flight-qualified claims.
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
                  <th className="text-right py-2 pr-4">theta_final (deg)</th>
                  <th className="text-right py-2 pr-4">w_final (deg/s)</th>
                  <th className="text-right py-2 pr-4">E_det (mJ)</th>
                  <th className="text-right py-2 pr-4">t_deploy,90 (s)</th>
                  <th className="text-right py-2">w_peak (deg/s)</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id} data-testid="report-row" className="border-b">
                    <td className="py-2 pr-4">{row.config}</td>
                    <td className="py-2 pr-4">{row.failureMode}</td>
                    <td className="py-2 pr-4">{materialLabels[row.material] ?? row.material}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(row.panelMass, 3)}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(row.finalAngleDeg, 2)}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(row.finalOmegaDegPerS, 2)}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(row.eDetumbleMJ, 3)}</td>
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
