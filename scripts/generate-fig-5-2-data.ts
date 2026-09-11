// Ground-truth data generator for thesis Figure 5.2 (hinge torque law).
// Calls the real hingeTorqueTotal() function from the engine directly —
// no reimplementation of the torque formula.
//
// Run via vite-node (ships with this repo's Vite/Vitest toolchain):
//   npx vite-node scripts/generate-fig-5-2-data.ts
import * as fs from 'fs';
import * as path from 'path';
import { hingeTorqueTotal } from '../src/lib/physics/engine';
import { DEFAULT_PARAMS } from '../src/lib/physics/types';
import type { HingeParams } from '../src/lib/physics/types';

const DATA_DIR = path.resolve(__dirname, '../data');

function writeCsv(filePath: string, header: string, rows: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [header, ...rows].join('\n') + '\n');
}

function main(): void {
    const h: HingeParams = DEFAULT_PARAMS.hinge;
    const stopAngleDeg = (h.stopAngle * 180) / Math.PI;

    console.log('Live DEFAULT_PARAMS.hinge values:');
    console.log(`  springConstant : ${h.springConstant} N·m/rad`);
    console.log(`  dampingCoeff   : ${h.dampingCoeff} N·m·s/rad`);
    console.log(`  frictionCoeff  : ${h.frictionCoeff} N·m`);
    console.log(`  preloadTorque  : ${h.preloadTorque} N·m`);
    console.log(`  stopAngle      : ${h.stopAngle} rad (${stopAngleDeg.toFixed(4)} deg)`);
    console.log(`  stopStiffness  : ${h.stopStiffness} N·m/rad`);
    console.log(`  stopDamping    : ${h.stopDamping} N·m·s/rad`);

    // ── Panel (A): quasi-static drive torque, 0 -> stopAngle at 0.25 deg res ──
    const aRows: string[] = [];
    const stepA = 0.25;
    for (let deg = 0; deg <= stopAngleDeg + 1e-9; deg += stepA) {
      const clampedDeg = Math.min(deg, stopAngleDeg);
      const theta = (clampedDeg * Math.PI) / 180;
      const { tau } = hingeTorqueTotal(theta, 0, h.stopAngle, h);
      aRows.push(`${clampedDeg.toFixed(4)},${tau}`);
    }
    writeCsv(
      path.join(DATA_DIR, 'fig5_2a_drive_torque.csv'),
      'theta_deg,torque_Nm',
      aRows,
    );

    // ── Panel (B): stop-reaction region, stopAngle -> stopAngle+10deg at 0.1 deg res ──
    const hNoStop: HingeParams = { ...h, stopStiffness: 0, stopDamping: 0 };
    const bRows: string[] = [];
    const stepB = 0.1;
    const verifyTable: { pen: number; total: number; sum: number }[] = [];
    for (let pen = 0; pen <= 10 + 1e-9; pen += stepB) {
      const thetaDeg = stopAngleDeg + pen;
      const theta = (thetaDeg * Math.PI) / 180;
      const { tau: torqueTotal } = hingeTorqueTotal(theta, 0, h.stopAngle, h);
      const { tau: torqueDriveOnly } = hingeTorqueTotal(theta, 0, h.stopAngle, hNoStop);
      const torqueStopIsolated = torqueTotal - torqueDriveOnly;
      bRows.push(
        `${thetaDeg.toFixed(4)},${torqueTotal},${torqueDriveOnly},${torqueStopIsolated}`,
      );
      if ([0, 2, 4, 6, 8].some((p) => Math.abs(pen - p) < 1e-6)) {
        verifyTable.push({ pen, total: torqueTotal, sum: torqueDriveOnly + torqueStopIsolated });
      }
    }
    writeCsv(
      path.join(DATA_DIR, 'fig5_2b_stop_reaction.csv'),
      'theta_deg,torque_total_Nm,torque_drive_only_Nm,torque_stop_isolated_Nm',
      bRows,
    );

    console.log('\nPanel (B) additive-model verification (Eq. 5.4/5.5):');
    console.log('  penetration_deg | torque_total_Nm | drive_only + stop_isolated');
    for (const { pen, total, sum } of verifyTable) {
      console.log(`  ${pen.toFixed(0).padStart(15)} | ${total.toFixed(9).padStart(16)} | ${sum.toFixed(9)}`);
    }
}

main();
