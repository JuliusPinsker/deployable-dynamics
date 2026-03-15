# deployable-dynamics

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](src/)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](src/)
[![Three.js](https://img.shields.io/badge/Three.js-r3f-black?logo=threedotjs)](src/components/CubeSatViewer.tsx)
[![Vite](https://img.shields.io/badge/build-Vite-646cff?logo=vite)](vite.config.ts)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-38bdf8?logo=tailwindcss)](tailwind.config.ts)
[![Docker](https://img.shields.io/badge/docker-ready-2496ed?logo=docker)](Dockerfile)
[![Tests](https://img.shields.io/badge/tests-Playwright%20%2B%20Vitest-green?logo=playwright)](playwright.config.ts)

> A browser-based 3D simulator for studying how timing discrepancies between deployable solar panel hinges induce tumbling and attitude disturbances on a 3U CubeSat — complete with a scientific report export at the end of each simulation run.

## What It Does

Deployable Dynamics investigates how asynchronous hinge release affects spacecraft attitude. Each simulation run lets you choose a deployment strategy (panel arrangement) and a timing delta — the deliberate or accidental offset between individual hinge release times. The physics engine propagates the resulting angular momentum imbalance into the spacecraft body in real time, visualised as a tumbling 3D model in the browser. At the end of every run a comprehensive scientific report is generated, summarising angular velocity profiles, induced rotation rates, and an assessment of attitude recovery feasibility.

## Deployment Strategies

Four canonical panel arrangements are available, each producing a different tumbling signature under the same timing delta:

| Strategy | Panels | Tumbling risk | Notes |
|---|---|---|---|
| **Long-edge** | 2 | Low | Symmetric along Z-axis; near-zero induced rotation when delta ≈ 0 |
| **Double long-edge** | 4 | Medium | Two accordion assemblies; sequential release amplifies roll |
| **Short-edge** | 4 | High | Asymmetric momentum transfer; strong pitch coupling |
| **Coupled** | 8 | Very high | Four mixed assemblies; multi-axis tumbling for large deltas |

## Timing Delta Parameter

The key independent variable is the **timing delta** δt (ms) — the staggered release offset applied between successive hinges. A delta of 0 ms represents ideal synchronous deployment; increasing δt models hinge latch failures, burn-wire delay variance, or manufacturing tolerances. The simulator sweeps δt from 0 to a configurable maximum, recording attitude state at each step.

## Physics Engine

The engine (`src/lib/physics/engine.ts`) models each hinge as a torsional spring-damper. All torques are in N·m; angular quantities in radians.

- **Spring torque**: `τ = k · (θ_stop − θ)` — preloaded torsion spring driving deployment
- **Damping**: `τ_d = −c · dθ/dt` — viscous damping; overdamped deployment in ~2 s
- **Mechanical stop**: contact model (`k_stop`, `c_stop`) halts panel at 90°
- **Coulomb friction**: static friction on each hinge axle
- **Attitude coupling**: panel angular momentum transferred to spacecraft body (conservation of angular momentum)
- **Timing offset injection**: each hinge release is delayed by `n × δt` where n is the hinge index
- **Kinematic mode**: deterministic ease-out profile for baseline/reference runs

### Default Spacecraft Parameters (3U CubeSat)

| Parameter | Value |
|---|---|
| Body dimensions | 100 × 100 × 340.5 mm |
| Body mass | 4.0 kg |
| Panel mass | 0.3 kg each |
| Panel thickness | 2.5 mm (sandwich) |
| Hinge spring constant | 0.02 N·m/rad |
| Damping coefficient | 0.08 N·m·s/rad |
| Deployment target angle | 90° (π/2 rad) |
| Default deploy duration | ~2.0 s per hinge |

## Scientific Report

After each simulation run the app generates a downloadable report containing:

- **Run metadata**: strategy, δt value, spacecraft parameters
- **Angular velocity time series**: ω_x, ω_y, ω_z plotted over the full deployment window
- **Peak induced rotation rate** per axis
- **Attitude deviation** from nominal nadir-pointing at end of deployment
- **Tumbling classification**: stable / recoverable / unrecoverable based on configurable thresholds
- **Comparison table** across multiple δt values if a sweep was run

## App Pages

- **Landing** — strategy selector and timing delta input
- **Simulation** — live 3D viewer with real-time attitude telemetry and hinge state overlay
- **Compare** — side-by-side multi-run comparison across strategies or δt values
- **Report** — full scientific report viewer with export to PDF/JSON

## Quickstart

> **Prerequisites**: Node.js ≥18 (local dev) or Docker.

### Local Development

```bash
git clone https://github.com/JuliusPinsker/deployable-dynamics.git
cd deployable-dynamics
npm install
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

### Docker

```bash
docker compose up
```

Served on `http://localhost:8080`.

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 18 + TypeScript |
| 3D rendering | Three.js via React Three Fiber + Drei |
| Styling | Tailwind CSS + shadcn/ui |
| Build | Vite |
| Testing | Vitest (unit) + Playwright (e2e) |
| Containerisation | Docker + Docker Compose |

## Project Structure

```
src/
├── components/
│   ├── CubeSatViewer.tsx      # Three.js 3D model, panels, orientation widgets
│   ├── TelemetryOverlay.tsx   # Live attitude telemetry HUD
│   └── ReportViewer.tsx       # Scientific report renderer
├── lib/physics/
│   ├── engine.ts              # Hinge dynamics + attitude integration
│   ├── panelLayouts.ts        # Panel geometry per deployment strategy
│   ├── timingDelta.ts         # Timing offset injection per hinge
│   └── types.ts               # Simulation types + default parameters
└── pages/
    ├── LandingPage.tsx        # Strategy + delta configuration
    ├── SimulationPage.tsx     # Main simulation view
    ├── ComparePage.tsx        # Multi-run comparison
    └── ReportPage.tsx         # Report export page
```

## License

MIT — see [LICENSE](LICENSE) if present.
