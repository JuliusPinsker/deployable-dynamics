

# CubeSat Solar Panel Deployable Simulation Platform

## Overview
An interactive research platform comparing 4 CubeSat solar panel deployable configurations. Combines 3D animated visualization with quantitative comparison and report generation, running rigid-body hinge dynamics entirely in the browser.

---

## Page 1: Landing
- **Configuration selector**: long-edge, double long-edge, short-edge, short-edge + long-edge coupled
- **Panel material selector**: FR4 PCB, Al/Kapton flex, CFRP composite
- Links to the Simulation and Compare pages

## Page 2: Simulation
- **3D CubeSat model** (using Three.js / React Three Fiber) showing the selected configuration
- **Controls**:
  - Deploy / Reset
  - Playback speed control
  - Wireframe toggle
  - Panel-label toggle
- **Timing discrepancy (δt) input**: ns/µs/ms units, three presets (Ideal 0 ns, Nominal 250 µs, Worst-case 5 ms)
- **Live telemetry overlay**: angular velocity, deployment progress, contact torque, average required detumbling torque
- **Centre-of-mass indicator** (display only)

## Page 3: Compare
- All four configurations shown together for a single selected material and δt
- **Time-series charts**: total angular velocity, average required detumbling torque
- **Bar charts**: peak angular velocity, deployment settle time
- **Failure-mode selector**: one-stuck, two-adjacent-stuck, two-opposite-stuck, all-stuck (where applicable per configuration), with per-configuration impact cards

## Page 4: Report
- Full 42-scenario failure-mode sweep matrix at the active δt
- Configuration / failure-mode / material filters that narrow displayed rows without recomputing
- Summary statistics (mean values) and a maximum-torque analysis card
- PDF export

## Physics Engine (Browser-based)
- Rigid-body dynamics via Euler's rotational equation with gyroscopic coupling
- Each hinge modeled as a torsion spring with preload, viscous damping, Coulomb friction, and a penalty-based mechanical stop
- Coupled to the body via conservation of angular momentum
- Integrated with classical fourth-order Runge-Kutta at a fixed 1/1200 s timestep, not frame-rate-coupled

## Design & UX
- Dark mode support
- Responsive layout (desktop-first)

