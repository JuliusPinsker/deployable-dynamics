---
title: Step 7 Report Page Implementation
description: Plan to add report data helper, report page UI, and PDF export.
author: GitHub Copilot
ms.date: 2026-05-13
ms.topic: how-to
keywords:
  * report
  * pdf
  * simulation
estimated_reading_time: 7
---

## Goal

Create a report page that runs a 42-scenario failure-mode sweep across four panel configurations and three material presets, and summarizes the results in a scientific table with PDF export.

## Scope

* src/lib/physics/engine.ts
* src/lib/physics/types.ts
* src/pages/ReportPage.tsx
* src/App.tsx
* src/pages/LandingPage.tsx

## Required changes

* Install `jspdf` and `jspdf-autotable` using Docker Compose.
* Add `ReportRow` and `computeReportData` near `runFullSimulation` in the engine.
* Build a report table that covers every configuration, failure mode, and material.
* Render all required metrics with consistent numeric formatting.
* Add a PDF export action using `jspdf-autotable`.
* Wire the report route and add navigation access.

## Report columns

* Configuration
* Failure mode
* Material
* Panel mass (kg)
* Final attitude coupling (deg)
* Final detumble energy (mJ)
* Max angular velocity during deployment (deg/s)
* Final center of mass offset (mm)
* Total deployment time (s)

## Implementation steps

* [x] Add tests for `computeReportData` to validate numeric extraction and rounding.
* [x] Add a report page test that asserts 42 rows and the export action.
* [x] Install dependencies with `docker compose run --rm app npm install jspdf jspdf-autotable --save-dev`.
* [x] Implement `ReportRow` and `computeReportData` in the engine using the provided logic.
* [x] Create `ReportPage.tsx` and generate the 42-scenario failure-mode sweep across four panel configurations and three material presets from config, failure mode, and material lists.
* [x] Render the summary table and ensure stable labels and units.
* [x] Add the PDF export handler using `jspdf-autotable`.
* [x] Add the report route and landing page link.

## Data to capture

* Capture the current `runFullSimulation` signature and output frame shape before editing.
* Record any exceptions in `computeSystemCoM` and fall back to `0` when the CoM is not computable.

## Verification

```bash
docker compose run --rm app npx tsc --noEmit
```

```bash
docker compose run --rm app npm run test -- src/test/engine.test.ts
```

```bash
docker compose run --rm app npm run test -- src/test/ReportPage.test.tsx
```

## Notes

The report evaluates a 42-scenario failure-mode sweep across four panel configurations and
three material presets. The number of valid failure cases depends on the number and
arrangement of panels in each configuration. The long-edge configuration contains two
panels; therefore, it has no separate adjacent-pair and opposite-pair failure cases — it
generates only one-stuck and all-stuck. Nominal deployment is not a failure mode; it remains
available as an interactive baseline on the Simulation and Compare pages, outside this
failure-only report matrix.
