import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import jsPDFDefault, { jsPDF as jsPDFNamed } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { motion } from 'framer-motion';
import {
  getFilteredRows,
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

  const filteredRows = useMemo(
    () => getFilteredRows(selectedConfigs, selectedFailures, selectedMaterials),
    [selectedConfigs, selectedFailures, selectedMaterials],
  );

  const stats = useMemo(
    () => computeSummaryStats(filteredRows),
    [filteredRows],
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
      startY: yPos + 2,
      head: [[
        'Config',
        'Failure',
        'Material',
        'Mass (kg)',
        'theta_final (deg)',
        'w_final (deg/s)',
        'E_det (mJ)',
        't_deploy (s)',
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
          <Button onClick={exportToPDF} disabled={isExporting}>
            {isExporting ? 'Exporting...' : 'Export PDF'}
          </Button>
        </div>
      </div>

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
            <div className="text-xs uppercase text-muted-foreground">Mean Deploy Time</div>
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
                  <th className="text-right py-2 pr-4">t_deploy (s)</th>
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
