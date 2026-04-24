---
title: Compare Page Failure Scenario Enhancement Plan
description: Phase-by-phase implementation and validation log for ComparePage failure scenarios
author: GitHub Copilot
ms.date: 2026-04-23
ms.topic: how-to
keywords:
    - compare page
    - failure scenarios
    - vitest
    - phased delivery
estimated_reading_time: 5
---

## Phase Status

| Phase | Scope                                          | Status      | Validation |
|-------|------------------------------------------------|-------------|------------|
| 1     | Add all-stuck anomaly option and stuck mapping | Completed   | Passed     |
| 2     | Add warning banner and scenario descriptions   | Completed   | Passed     |
| 3     | Add FAILURE MODE chart badge                   | Completed   | Passed     |
| 4     | Add failure impact summary section             | Completed   | Passed     |
| 5     | Final consistency and TypeScript validation    | Completed   | Passed     |

## Phase 1: Add New Anomaly Option and Stuck Mapping

### Scope

* Keep the existing anomaly select intact.
* Add `all-stuck` as a new select item.
* Ensure `stuckConfig` returns `[0, 1, 2, 3, 4, 5]` for `all-stuck`.

### Completion Log

* Status: Completed
* Validation command:

```bash
docker compose run --rm app npm run test -- src/test/ComparePage.test.tsx -t "phase 1"
```

* Result: 1 test passed, 0 failed

## Phase 2: Add Failure Scenario Info Banner

### Scope

* Add `AlertTriangle` icon banner below header controls when `anomaly !== 'none'`.
* Use exact scenario description strings from the implementation request.
* Render per-config stuck badges from `CONFIGURATIONS` and computed `stuckCount`.

### Completion Log

* Status: Completed
* Validation command:

```bash
docker compose run --rm app npm run test -- src/test/ComparePage.test.tsx -t "phase 2"
```

* Result: 4 tests passed, 0 failed

## Phase 3: Add FAILURE MODE Badge to Angular Velocity Card

### Scope

* Append the amber `FAILURE MODE` badge inline in the Angular Velocity card title.
* Render only when `anomaly !== 'none'`.

### Completion Log

* Status: Completed
* Validation command:

```bash
docker compose run --rm app npm run test -- src/test/ComparePage.test.tsx -t "phase 3"
```

* Result: 1 test passed, 0 failed

## Phase 4: Add Failure Mode Impact Summary Section

### Scope

* Add bottom summary card for anomaly mode only.
* Show per-config stuck and deployed panel counts.
* Derive coupling level from stuck panel fraction.
* Add deploy success bar with threshold colors.

### Completion Log

* Status: Completed
* Validation command:

```bash
docker compose run --rm app npm run test -- src/test/ComparePage.test.tsx -t "phase 4"
```

* Result: 1 test passed, 0 failed

## Phase 5: Final Consistency Validation

### Scope

* Confirm no engine changes were introduced.
* Confirm `runFullSimulation(config, params, 8, stuckConfig)` signature remains unchanged.
* Confirm anomaly state, `stuckConfig` memo, and `allSimData` memo remain coherent.

### Completion Log

* Status: Completed
* Validation commands:

```bash
docker compose run --rm app npm run test -- src/test/ComparePage.test.tsx
```

* Additional checks:
    * `src/pages/ComparePage.tsx` has no TypeScript errors.
    * `src/test/ComparePage.test.tsx` has no TypeScript errors.
    * `runFullSimulation(config, params, 8, stuckConfig)` signature remains unchanged.
* Result: 7 tests passed, 0 failed
