---
title: Detumbling energy plan
description: Add detumbling energy telemetry and charting across simulation views.
ms.date: 2026-05-05
ms.topic: plan
---

## Plan

Add detumbling rotational kinetic energy (E_detumble) to SimulationFrame and 
display it in the Live Telemetry sidebar and simulation chart.

Files changed: engine.ts (SimulationFrame field plus eDetumble computation in
runFullSimulation), SimulationPage.tsx (compute and pass eDetumble),
TelemetryOverlay.tsx (sidebar row), ComparePage.tsx (chart series), and
related tests. No changes to stepSimulation, computeSystemCoM, or any other
function.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART A — engine.ts
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A1. Add eDetumble field to the SimulationFrame interface.
Find the SimulationFrame interface. Add this field AFTER the 
tipDeflectionDeg field (keep it the last field):

  /**
   * Rotational kinetic energy of the spacecraft body at this timestep (mJ).
   *
   * Defined as the scalar rotational KE of the body alone (not panels),
   * expressed in the body principal frame:
   *
   *   E = ½ · (Ixx·ωx² + Iyy·ωy² + Izz·ωz²)
   *
   * where ω components are the body angular velocity projected onto the
   * principal axes (body frame), and Ixx/Iyy/Izz are the diagonal
   * principal moments of inertia from bodyInertiaDiag().
   *
   * Converted to millijoules (× 1000) for readability in telemetry.
   *
   * During free tumble this value is constant (energy conserved).
   * During panel deployment it changes as angular momentum redistributes
   * between the body and deploying panels — a decrease indicates energy
   * being transferred into panel rotational motion (desirable for passive
   * detumbling via the "scissors" effect).
   *
   * In active B-dot detumbling this metric is the primary convergence
   * indicator — detumbling is complete when E_detumble → 0.
   *
   * Reference: Hughes, P. C. (1986). Spacecraft Attitude Dynamics.
   * Wiley, Chapter 4 — rotational kinetic energy of a rigid body.
   *
   * Units: millijoules (mJ)
   */
  eDetumble: number;

A2. Compute eDetumble inside the runFullSimulation frame push block.
Find the section inside runFullSimulation that pushes to frames[]
(the block starting with `frames.push({`).

BEFORE the frames.push() call, add this computation:

      // ── Rotational kinetic energy of body (E_detumble) ──────────────────
      // E = ½ · ω_body^T · I_body · ω_body  (body principal frame)
      // ω must be expressed in body frame: ω_body_local = q_body* ⊗ ω_world
      // Reference: Hughes (1986), Ch. 4, Eq. (4.2.3)
      const IbFrame = bodyInertiaDiag(params);
      const qBodyFrame = state._bodyQ ?? new Quaternion();
      const omegaWorldFrame = state.angularVelocity;
      const omegaBodyFrame = new Vector3(
        omegaWorldFrame.x,
        omegaWorldFrame.y,
        omegaWorldFrame.z,
      ).applyQuaternion(qBodyFrame.clone().conjugate());
      const eDetumbleMJ =
        0.5 *
        (IbFrame.x * omegaBodyFrame.x * omegaBodyFrame.x +
          IbFrame.y * omegaBodyFrame.y * omegaBodyFrame.y +
          IbFrame.z * omegaBodyFrame.z * omegaBodyFrame.z) *
        1000; // convert J → mJ

THEN inside frames.push({...}), add at the end (after tipDeflectionDeg):
  eDetumble: Math.round(eDetumbleMJ * 1000) / 1000,

Status: Done.
Tests: docker compose run --rm app npm run test -- src/test/engine.test.ts.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART B — SimulationPage.tsx: Live Telemetry sidebar row
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONTEXT: The Live Telemetry sidebar already has rows for ωx, ωy, ωz,
Deploy %, Contact Force, GG Torque, and Time. The current frame is
available as `currentFrame` (the last frame in the frames array) or
similar — find the correct variable name used to read angularVelocity
for the existing ω rows.

B1. Find the Live Telemetry sidebar rows. Add a new row for E_detumble
AFTER the GG Torque row and BEFORE the Time row:

  <div className="flex items-center justify-between py-0.5">
    <span className="text-xs text-muted-foreground">E detumble</span>
    <span
      className="text-xs font-mono font-semibold"
      style={{
        color: (() => {
          const e = currentFrame?.eDetumble ?? 0;
          if (e > 1)   return '#f97316'; // orange-500: high energy, active tumble
          if (e > 0.1) return '#eab308'; // yellow-500: moderate spin
          return '#22c55e';              // green-500: near-zero, detumbled
        })(),
      }}
    >
      {((currentFrame?.eDetumble) ?? 0).toFixed(3)} mJ
    </span>
  </div>

NOTE: Replace `currentFrame` with the actual variable name used in your
existing sidebar rows if it differs (check how ωx reads its value).

Implementation note: The Live Telemetry rows are rendered by TelemetryOverlay, and SimulationPage now passes the computed eDetumbleMJ value.

Status: Done.
Tests: docker compose run --rm app npm run test -- src/test/TelemetryOverlay.test.tsx src/test/SimulationPage.test.tsx.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PART C — SimulationPage.tsx: Add eDetumble line to the chart
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONTEXT: SimulationPage has a Recharts LineChart (or similar) that
already plots ωx/ωy/ωz and possibly GG Torque over time.
The frames array has type SimulationFrame[].

C1. Find where the chart data array is built from frames[]. Add
eDetumble to each data point mapping. Example — if the mapping looks like:
  frames.map(f => ({ time: f.time, wx: ..., wy: ..., ... }))
Add:
  eDetumble: f.eDetumble

C2. Find the chart series definitions (the <Line> or equivalent elements).
Add a new Line for eDetumble:

  <Line
    type="monotone"
    dataKey="eDetumble"
    stroke="#f97316"
    strokeWidth={1.5}
    dot={false}
    name="E detumble (mJ)"
    strokeDasharray="4 2"
  />

C3. If the chart has a <Legend> or <Tooltip>, eDetumble will appear
automatically. If the chart uses a separate Y-axis for different units,
add eDetumble to the RIGHT Y-axis (same side as GG Torque if present),
since it is in mJ — a different unit from rad/s.

Implementation note: The chart lives in the comparison dashboard, so the detumbling energy series was added to ComparePage.

Status: Done.
Tests: docker compose run --rm app npm run test -- src/test/ComparePage.test.tsx.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VERIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. npx tsc --noEmit — zero errors required.

2. Runtime sanity checks in browser console:
   - At t=0 with angular velocity = 0: eDetumble should read 0.000 mJ
   - With initial tumble ω₀ = [5, 5, 5] °/s converted to rad/s:
     ω_rad = 0.0873 rad/s each axis.
     Ib for 3U ≈ [3.3e-4, 9.7e-4, 9.7e-4] kg·m²
     E ≈ ½(3.3e-4 + 9.7e-4 + 9.7e-4)(0.0873²) ≈ 0.0097 mJ — very small.
     This is expected: a 3U CubeSat with gentle tumble has micro-joule energy.
   - eDetumble should stay roughly constant during panel deployment if
     ω₀ = 0 (no initial tumble), and change if ω₀ ≠ 0.

3. Visual checks:
   - Live Telemetry sidebar: new "E detumble" row appears between GG Torque
     and Time, showing mJ in orange/yellow/green depending on value.
   - Chart: dashed orange line appears for E_detumble data, scaling correctly
     on right Y-axis.
   - Colour transitions: toggle initial tumble on/off and verify the colour
     of the sidebar value responds to energy level.

Report TypeScript errors with full messages if any.
