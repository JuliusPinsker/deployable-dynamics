---
title: CoM Implementation Plan
description: Phased implementation and validation tracking for Centre of Mass computation and visualization
author: GitHub Copilot
ms.date: 2026-04-24
ms.topic: how-to
---

## Phases

1. Phase 1: Engine CoM export
2. Phase 2: CubeSatViewer CoM render and overlay
3. Phase 3: SimulationPage toggle wiring
4. Phase 4: Type-check and runtime verification

## Status

| Phase | Scope | Status | Validation |
|---|---|---|---|
| 1 | Add `computeSystemCoM` and physics coverage tests | Completed | `docker compose run --rm app npm run test -- src/test/engine.test.ts` (8 passed) |
| 2 | Render CoM marker and telemetry in viewer | Completed | `docker compose run --rm app npm run test -- src/test/CubeSatViewer.test.tsx` (5 passed) |
| 3 | Wire `showCoM` toggle in simulation controls | Completed | `docker compose run --rm app npm run test -- src/test/SimulationPage.test.tsx` (1 passed) |
| 4 | Type-check and runtime sanity checks | Completed (type-check) | `docker compose run --rm app npx tsc --noEmit` (passed) |

## Phase Notes

### Phase 1

* Added and exported `computeSystemCoM` in `engine.ts`.
* Added targeted unit tests for:
  * symmetric stowed near-zero CoM
  * +Z CoM shift at long-edge 90 degree deployment
  * one-stuck asymmetric horizontal bias
  * all-stuck short-edge return to near-zero offset
* Result: complete.

### Phase 2

* Added `showCoM` support in the viewer props and imported `computeSystemCoM`.
* Added CoM marker rendering in the canvas scene with severity color logic.
* Added CoM telemetry HTML overlay with X, Y, Z, and scalar offset readout.
* Removed duplicate scene-level CoM memoization to avoid redundant calculations.
* Added viewer unit tests for CoM overlay visibility when `showCoM` is enabled and disabled.
* Result: complete.

### Phase 3

* Added `showCoM` state in simulation controls and wired it to `CubeSatViewer`.
* Added `Centre of Mass` toggle in the Controls card.
* Added targeted `SimulationPage` wiring unit test to verify toggle -> viewer prop flow.
* Added `ResizeObserver` mock in `src/test/setup.ts` so Radix components render in jsdom.
* Result: complete.

### Phase 4

* Type-check completed with no errors.
* Final targeted regression batch completed:
  * `docker compose run --rm app npm run test -- src/test/engine.test.ts src/test/CubeSatViewer.test.tsx src/test/SimulationPage.test.tsx`
  * Result: 14 tests passed.
* Manual runtime sanity checks are ready to execute in browser:
  * t=0 symmetric stowed offset near zero
  * long-edge 90 degree shift toward +Z
  * one-stuck non-zero horizontal components
  * all-stuck return near symmetric offset
  * visual marker color and telemetry overlay behavior
* Result: complete for automated checks; manual browser verification remains.
