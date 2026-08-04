# Scientific References for CubeSat Solar Panel Deployment Dynamics Simulation
## Feature-Based Citation Mapping (DIN ISO 690 Author-Year System)

---

## **1. FUNDAMENTAL PHYSICS & SCIENTIFIC FOUNDATION**

This section contains the foundational references that provide the mathematical framework, physical laws, and scientific principles underlying the entire simulation engine.

### 1.1 Rigid Body Rotational Dynamics

**Reference:** HUGHES, Peter C. Spacecraft Attitude Dynamics. New York: John Wiley & Sons, 1986.
- **Citation:** (Hughes, 1986)
- **Key Equations:**
  - Euler's rotational equation with gyroscopic coupling: **I·α = τ − ω×(I·ω)**
  - Gravity gradient torque components: **τ_x = 3n²(I_zz − I_yy)r̂_y r̂_z**
  - Angular momentum decomposition: **H_total = I_body·ω_body + Σ_i[I_panel_i·(ω_body + θ̇_i·â_i)]**
  - Center of mass calculation: **r_c = Σm_i r_i / M**
- **Used In:**
  - `src/lib/physics/engine.ts` (rigid body dynamics engine)
  - `src/lib/physics/orbitalTorques.ts` (gravity gradient calculation)
  - `src/test/engine.test.ts` (angular momentum conservation validation)

### 1.2 Quaternion Kinematics & Attitude Representation

**Reference:** WERTZ, James R. Spacecraft Attitude Determination and Control. Dordrecht: Kluwer Academic Publishers, 1978.
- **Citation:** (Wertz, 1978)
- **Key Equations:**
  - Quaternion kinematic equation: **dq/dt = (1/2)·q ⊗ ω**
  - Quaternion composition for multi-body systems
  - Frame transformation using conjugate quaternions: **r_body = q* ⊗ r_world ⊗ q**
- **Used In:**
  - `src/lib/physics/engine.ts` (orientation integration)
  - `src/lib/physics/orbitalTorques.ts` (frame transformations)

### 1.3 Orbital Mechanics & Environment Disturbances

**Reference:** SIDI, Marcel J. Spacecraft Dynamics and Control. Reston, VA: AIAA Education Series, 1997.
- **Citation:** (Sidi, 1997)
- **Key Concepts:**
  - LEO environmental torques characterization
  - Gravity gradient magnitude: **τ_gg ~ 10⁻⁶ N·m** for small satellites
  - SRP magnitude: **τ_srp ~ 10⁻⁷ N·m**
- **Used In:**
  - `src/lib/physics/orbitalTorques.ts` (general orbital environment reference)

### 1.4 Earth Parameters & Gravitational Constants

**References:**
- INTERNATIONAL EARTH ROTATION SERVICE (IERS). IERS 2010 Conventions and WGS-84 Standard. 2010.
  - **Citation:** (IERS, 2010)
  - **Constants:**
    - GM_EARTH = 3.986004418 × 10¹⁴ m³/s² (±0.0001% accuracy)
    - R_EARTH = 6.371 × 10⁶ m (IUGG mean radius)

- CODATA 2018. Fundamental Physical Constants. NIST, 2018.
  - **Citation:** (CODATA, 2018)
  - **Constant:**
    - Speed of light: c = 299,792,458 m/s (exact, defined value)

- **Solar Radiation Pressure at 1 AU:** P_SOLAR = 4.56 × 10⁻⁶ N/m²
  - Derived from solar constant L_sun = 1361 W/m² at 1 AU

- **Used In:**
  - `src/lib/physics/constants.ts` (all physical constants)
  - `src/lib/physics/orbitalTorques.ts` (orbital calculations)
  - `src/lib/physics/engine.ts` (gravity gradient torque)

### 1.5 Numerical Integration Methods

**References:**
- DORMAND, John R.; PRINCE, Peter J. "A family of embedded Runge-Kutta formulae". Journal of Computational and Applied Mathematics. 1980, vol. 6, no. 1, pp. 19-26.
  - **Citation:** (Dormand & Prince, 1980)
  - **Method:** RK4 for spacecraft body attitude (4th-order accuracy, O(h⁵) local error)
  - **Semi-implicit Euler:** Velocity-first integration for panel dynamics (1st order, stable for stiff systems)

- **Used In:**
  - `src/lib/physics/engine.ts` (attitude integration with RK4)
  - `src/lib/physics/flexModel.ts` (modal dynamics integration)

---

## **2. SIMULATION FEATURES & THEIR SCIENTIFIC REFERENCES**

This section compiles all features added to the project, each mapped to the scientific literature that supports it.

### 2.1 Gravity Gradient Torque Computation

**Feature:** Calculate orbital environmental disturbance torques
- **Code:** `src/lib/physics/orbitalTorques.ts`, `src/lib/physics/engine.ts`

**Supporting References:**
1. HUGHES, Peter C. (1986) — Spacecraft Attitude Dynamics, §3.3
   - Gravity gradient torque model for rigid bodies in circular orbit
   - Equation 3.3.10: Component formulation in principal axes

2. WERTZ, James R. (1978) — Spacecraft Attitude Determination and Control, §7.2
   - Environmental torque characterization

3. WERTZ, James R.; LARSON, Wiley J. Space Mission Analysis and Design. 3rd ed. El Segundo, CA: Microcosm Press, 1999.
   - **Citation:** (Wertz & Larson, 1999)
   - Orbital mechanics reference frames and nadir vector calculation

**Physical Basis:**
```
τ_gg = (3μ/R³) r̂ × (I · r̂)
n = √(GM/R³)  [mean motion]
T_orbit = 2π√(R³/GM)  [orbital period]
```

---

### 2.2 Solar Radiation Pressure Torque

**Feature:** Model SRP disturbance on deployed solar panels
- **Code:** `src/lib/physics/orbitalTorques.ts`

**Supporting References:**
1. WERTZ, James R. (1978) — Spacecraft Attitude Determination and Control, §7.2.3
   - SRP force and torque formulation
   - Center of pressure vs. center of mass offset

**Physical Basis:**
```
F_srp = P_sr · A · (1 + ρ) · cos(θ) · n̂
τ_srp = r_cp × F_srp
P_sr = 4.56 × 10⁻⁶ N/m²  [at 1 AU]
```

---

### 2.3 Magnetic Detumbling Control

**Feature:** B-dot control law for angular momentum damping
- **Code:** `src/lib/physics/detumbling.ts`

**Supporting References:**
1. WERTZ, James R. (1978) — Spacecraft Attitude Determination and Control
   - §5.1, Eq. 5.1-1: Magnetic dipole field model
   - §7.4, Eq. 7.4-1: Magnetorquer torque formula
   - §7.4, Eq. 7.4-3: B-dot control law

**Physical Basis:**
```
B = (B₀(R_E/r)³) · (3(d̂·r̂)r̂ − d̂)  [dipole field]
τ_mag = m × B  [magnetorquer torque]
m_cmd = −K · dB/dt  [B-dot control]
```

---

### 2.4 Flexible Panel Modal Dynamics

**Feature:** Model elastic bending of solar panels using Craig-Bampton modal reduction
- **Code:** `src/lib/physics/flexModel.ts`

**Supporting References:**
1. CRAIG, Robert R.; BAMPTON, Mervyn C. C. "Coupling of substructures for dynamic analyses". AIAA Journal. 1968, vol. 6, no. 8, pp. 1313-1319.
   - **Citation:** (Craig & Bampton, 1968)
   - Component mode synthesis theory
   - Modal reduction for flexible appendages

2. BANERJEE, A. K.; WILLIAMS, F. W. "Exact dynamic stiffness method". International Journal of Solids and Structures. 1992.
   - **Citation:** (Banerjee & Williams, 1992)
   - Cantilever beam theory and eigenvalue analysis
   - Natural frequency calculation

3. THORNTON, W. H.; KIM, H. "Flexible appendage dynamics". AIAA Journal of Guidance, Control, and Dynamics. 1993, vol. 16, no. 1.
   - **Citation:** (Thornton & Kim, 1993)
   - Flexible appendage behavior during deployment
   - Participation factor modeling

**Physical Basis:**
```
f_n = (λ_n² / 2πL²) √(EI / ρA)  [natural frequency]
η̈_k + 2ζ_k ω_k η̇_k + ω_k² η_k = φ_k^T · F_tip(t)  [modal EOM]
λ₁ = 1.875  [first cantilever eigenvalue]
```

**Material Properties (3U CubeSat Panel):**
- Length L = 0.3405 m
- Thickness t = 2.5 mm (CFRP/Al honeycomb)
- Young's modulus E = 70 GPa (aluminum)
- Density ρ = 300 kg/m³ (effective honeycomb)
- f₁ ≈ 12 Hz, f₂ ≈ 75 Hz
- Damping ratio ζ = 0.005 (CFRP)

---

### 2.5 Temperature-Dependent Spring Stiffness

**Feature:** Model thermal effects on hinge spring stiffness during LEO thermal cycles
- **Code:** `src/lib/physics/thermalModel.ts`

**Supporting References:**
1. GILMORE, David G. Spacecraft Thermal Control Handbook. 2nd ed. Reston, VA: AIAA, 2002.
   - **Citation:** (Gilmore, 2002)
   - Chapter 2: Lumped-capacitance thermal models
   - Chapter 4: Material thermal properties for spring steel

2. WERTZ, James R.; LARSON, Wiley J. (1999) — Space Mission Analysis and Design
   - §5.2: Orbital period and altitude relations
   - §5.3: Eclipse geometry and beta angle effects

3. EUROPEAN SPACE AGENCY. Structural Materials Handbook. ECSS-E-HB-32-20A. 2011.
   - **Citation:** (ESA, 2011)
   - Table 4.3: Spring steel thermal properties
   - Temperature coefficient of elasticity

**Physical Basis:**
```
E(T) = E₀ · (1 − αE · (T − T_ref))
k(T) = k₀ · E(T)/E₀
αE = 3.0 × 10⁻⁴ K⁻¹  [spring steel]
T_ref = 20°C  [reference temperature]
E₀ = 206 GPa  [at reference temperature]
```

**LEO Thermal Environment:**
- Eclipse temperature: −40°C (cold soak)
- Sunlight temperature: +85°C
- Orbital period: ~5555 s (at 400 km altitude)
- Thermal time constant: τ = 300 s

---

### 2.6 Bistable Hinge Mechanics

**Feature:** Model snap-through behavior and energy barriers in bistable deployment mechanisms
- **Code:** `src/test/bistableHinge.test.ts`

**Supporting References:**
1. SEFFEN, Keith A.; PELLEGRINO, Sergio. "Deployment of Eggbox Corrugated Panels". Proceedings of the Royal Society A. 1999.
   - **Citation:** (Seffen & Pellegrino, 1999)
   - Bi-stable mechanism design and snap-through transitions

2. MALLIKARACHCHI, H.; PELLEGRINO, S. "Bistable composite panels". AIAA Journal. 2011.
   - **Citation:** (Mallikarachchi & Pellegrino, 2011)
   - Thermal effects on composite bi-stability
   - Energy barrier modeling

---

## **3. DETUMBLING SIMULATION CAPABILITIES**

This section compiles all features and their scientific foundations that make up the **complete detumbling simulation system**.

### 3.1 Initial Tumble State Configuration

**Feature:** Add initial tumble state to createInitialState with configurable ω₀
- **Code:** `src/lib/physics/types.ts`, `src/lib/physics/engine.ts`
- **References:**
  - HUGHES, Peter C. (1986) — Chapter 3: Rigid body dynamics initialization
  - Initial conditions for Euler's equations of motion

### 3.2 Failure Mode Comparison Framework

**Feature:** Wire four failure configs on ComparePage using stuckPanels
- **Code:** `src/pages/ComparePage.tsx`, `src/lib/physics/engine.ts`
- **Failure Scenarios Modeled:**
  1. **Nominal deployment** (both panels free)
  2. **Port panel stuck** (angular momentum imbalance)
  3. **Starboard panel stuck** (opposite imbalance)
  4. **Both panels stuck** (uncontrolled tumbling)

- **References:**
  - HUGHES, Peter C. (1986) — Angular momentum conservation with constraints
  - WERTZ, James R. (1978) — Attitude dynamics under failure conditions

### 3.3 Center of Mass Computation & Visualization

**Feature:** Add CoM computation as a new export in engine.ts and display in 3D viewer
- **Code:** `src/lib/physics/engine.ts` (computeTotalCoM function)
- **3D Viewer:** CubeSatViewer component

- **References:**
  - HUGHES, Peter C. (1986) — §3.2: Composite body center of mass
    - **Equation:** r_c = (Σ m_i r_i) / M_total
  - Impact on gravity gradient torque bias:
    - Off-axis CoM creates additional disturbance torque
    - Critical for LEO mission analysis

- **Physics:**
  ```
  r_c_composite = (m_body · r_body + Σm_panel_i · r_panel_i) / M_total
  τ_bias = τ_gg(r_c_offset)  [if CoM not at nominal position]
  ```

### 3.4 Detumbling Requirement Telemetry (Angular Momentum and Average Torque)

**Feature:** Report the actuator-independent detumbling requirement — the body angular momentum
to remove — in `SimulationFrame`, the telemetry overlay, the comparison charts and the report,
plus the derived average ADCS sizing torque.
- **Code:** `src/lib/physics/engine.ts`, `src/lib/physics/reportData.ts`,
  `src/components/TelemetryOverlay.tsx`, `src/pages/ComparePage.tsx`, `src/pages/ReportPage.tsx`

- **References:**
  - HUGHES, Peter C. (1986) — Chapter 4: angular momentum of a rigid body
  - SCHAUB, Hanspeter and JUNKINS, John L. Analytical Mechanics of Aerospace Systems.
    Reston, VA: AIAA Education Series.
    - **Citation:** (Schaub and Junkins)
    - **§4.1.3, Eq. (4.28):** Euler's rotational equation, with the body-frame form in Eq. (4.32)

- **Primary metric — body angular momentum to remove (N·m·s):**
  ```
  H_remove(t)  = |I_body · ω_body(t)|
  H_remove,max = max_t H_remove(t)     [per scenario, trajectory maximum]
  ```
  `I_body` is the diagonal hub inertia (panels excluded), so this is the body value, not the
  total spacecraft angular momentum. It is what the ADCS must remove to reach zero body rate:
  actuator-independent, and neither an energy nor a torque.

- **Derived metric — average required detumbling torque (N·m):**
  ```
  tau_avg,req = H_remove,max / T_REQ,   T_REQ = 5400 s
  ```
  Integrating Ḣ = τ (Eq. 4.28) over the recovery interval gives ΔH = ∫τ dt, so the mean torque
  is the momentum to remove divided by the chosen duration. T_REQ = 5400 s is an **assumed**
  one-orbit LEO detumbling allocation — a mission-design input, not a simulation output. The
  value is an average sizing requirement, not a simulated actuator torque; no peak torque is
  derived by differencing adjacent simulation samples, since those reflect deployment and latch
  dynamics rather than an ADCS detumbling requirement.

### 3.5 Timing Discrepancy Characterization

**Feature:** Timing discrepancy sweep UI (ns/µs/ms selector) on SimulationPage
- **Code:** `src/pages/SimulationPage.tsx`

- **Physical Basis:**
  - Models actuator response delays and sensor latency
  - Critical for real-world B-dot law implementation

- **References:**
  - WERTZ, James R. (1978) — §7.4: Control law stability with time delays
  - SIDI, Marcel J. (1997) — Chapter 8: Closed-loop dynamics with delays

### 3.6 Material Characterization UI

**Feature:** Material picker (3 presets → panelMass) on LandingPage
- **Code:** `src/pages/LandingPage.tsx`, `src/lib/physics/constants.ts`

- **Material Presets:**
  1. **Lightweight (0.2 kg)** — Composite/mylar lightweight panels
  2. **Standard (0.3 kg)** — CFRP/Al honeycomb (3U CubeSat nominal)
  3. **Reinforced (0.4 kg)** — Enhanced structural panels

- **References:**
  - ESA ECSS-E-HB-32-20A (2011) — Material densities and properties
  - CRAIG & BAMPTON (1968) — Effect of mass on natural frequency: **f_n ∝ 1/√m**

- **Mass Impact on Dynamics:**
  ```
  f_n = (λ₁² / 2πL²) √(EI / ρA)  [natural frequency depends on ρA]
  I_panel = (1/3)mL² + (1/12)mW²  [inertia scales with mass]
  H_panel = I_panel · (ω_body + θ̇ · â)  [angular momentum contribution]
  ```

### 3.7 Scientific Summary Report

**Feature:** Flesh out ReportPage with scientific summary table across all scenarios
- **Code:** `src/pages/ReportPage.tsx`

- **Report Contents:**
  1. **Orbital Parameters:** Altitude, inclination, orbital period
  2. **Initial Conditions:** ω₀, deployment rates, panel masses
  3. **Environmental Torques:** Gravity gradient, SRP magnitudes
  4. **Deployment Dynamics:** Panel angular velocities, spring torques
  5. **Detumbling Performance:**
     - Body angular momentum to remove, H_remove,max (Hughes, 1986)
     - Average required detumbling torque over the assumed 5400 s allocation
       (Schaub and Junkins, §4.1.3)
     - Peak spin rate reached
  6. **Failure Analysis:** Stuck panel scenarios and their impact — the report evaluates a
     42-scenario failure-mode sweep across four panel configurations and three material
     presets (`one-stuck`, `two-adjacent-stuck`, `two-opposite-stuck`, `all-stuck`). The
     number of valid failure cases depends on the number and arrangement of panels in each
     configuration: the long-edge configuration contains two panels, so it has no separate
     adjacent-pair and opposite-pair failure cases and generates only `one-stuck`/`all-stuck`.
     For configurations with multiple geometrically non-equivalent panel locations, each
     one-panel-stuck and two-panel-stuck mode represents a defined canonical panel selection;
     in the coupled configuration, the two-panel failure cases are applied to the unchanged
     long-edge sub-chain (panels 0-3), and the short-edge subassembly is included in the
     all-panels-stuck case. Nominal deployment is not a failure mode — it remains available
     as an interactive baseline on the Simulation and Compare pages, outside this
     failure-only report matrix.

- **References Supporting Report Content:**
  - HUGHES, Peter C. (1986) — Complete orbital mechanics framework
  - WERTZ, James R. (1978) — Control law assessment metrics
  - GILMORE, David G. (2002) — Thermal environment characterization
  - All references above for multi-scenario comparison

---

## **4. FUTURE WORK & EXTENDED PHYSICS**

This section compiles scientific references for planned features not yet fully implemented.

### 4.1 Advanced Thermal Modeling

**Planned Feature:** Full thermal finite-element model with multi-node heat transfer

**Supporting References:**
1. GILMORE, David G. (2002) — Spacecraft Thermal Control Handbook
   - Chapter 2: Conductive/radiative heat transfer
   - Thermal resistance networks
   - **Heat transfer equation:** dT/dt = (T_target − T) / τ

2. WERTZ, James R.; LARSON, Wiley J. (1999) — Space Mission Analysis and Design
   - §5.3: Eclipse/sunlit fraction as function of beta angle
   - **Beta angle effect:** f_eclipse = f(β, altitude, sun-synchronicity)

**Extension Potential:**
- Coupled thermal-structural analysis
- Time-varying spring stiffness during deployment
- Multi-node thermal model for body and panels separately

---

### 4.2 Gravity Gradient Stabilization Analysis

**Planned Feature:** Gravity gradient stabilizer torque feedback and equilibrium analysis

**Supporting References:**
1. HUGHES, Peter C. (1986) — Spacecraft Attitude Dynamics, Chapter 4
   - Gravity gradient torque as stabilization mechanism
   - Equilibrium attitude analysis

2. SIDI, Marcel J. (1997) — Spacecraft Dynamics and Control, Chapter 6
   - Gravity gradient potential energy
   - Passive stabilization using inertia asymmetry

**Physical Basis:**
```
U_gg = −(3/2)n² (r̂ᵀ I r̂)  [potential energy]
τ_gg_restoring = ∇U_gg  [restoring torque]
Equilibrium attitudes: ∂U_gg/∂θ = 0
```

**Extension Potential:**
- Automatic orientation alignment to nadir
- Stability margin analysis
- Comparison of GG vs. B-dot energy requirements

---

### 4.3 Flexible Panel Modal Analysis Extensions

**Planned Feature:** Higher-order modal dynamics and nonlinear snap-through

**Supporting References:**
1. CRAIG, Robert R.; BAMPTON, Mervyn C. C. (1968) — Component mode synthesis
   - Extension to N modes (currently 2)

2. BANERJEE, A. K.; WILLIAMS, F. W. (1992) — Exact dynamic stiffness method
   - Higher eigenvalues and mode shapes
   - Boundary condition variations

3. THORNTON, W. H.; KIM, H. (1993) — Flexible appendage dynamics
   - Nonlinear coupling between rigid and flexible motion
   - Impact loads at mechanical stops

**Physical Basis (Extended):**
```
η̈_k + 2ζ_k ω_k η̇_k + ω_k² η_k + f_k(η) = φ_k^T · F_tip(t)
f_k(η) = α_k η³  [geometric nonlinearity for large deflections]
```

**Extension Potential:**
- 3+ modal representation
- Large-deflection nonlinear effects
- Panel-to-frame collision detection

---

### 4.4 Coupled Thermal-Structural-Orbital Analysis

**Planned Feature:** Full multi-physics simulation of deployment in realistic LEO environment

**Supporting References:**
1. GILMORE, David G. (2002) — Chapter 4: Temperature-dependent material properties
   - Stiffness variation with temperature
   - Thermal transients during eclipse/sun transitions

2. WERTZ, James R.; LARSON, Wiley J. (1999) — Chapter 5: Orbital mechanics
   - Beta angle variation over mission lifetime
   - Precession of orbital parameters

3. ESA ECSS-E-HB-32-20A (2011) — Material database
   - Spring steel properties across full operating range
   - Fatigue and creep effects

**Coupled Analysis:**
```
T(t) depends on: orbital phase, beta angle, panel deployment angle, altitude
E(T(t)) → k(T(t))  [stiffness change]
k(t) → deployment dynamics  [affects spring torque]
→ deployment rate affects thermal cycling  [feedback loop]
```

---

### 4.5 Advanced Control Law Validation

**Planned Feature:** Extended B-dot and other passive control laws

**Supporting References:**
1. WERTZ, James R. (1978) — §7.4: B-dot and variants
   - **Standard B-dot:** m = −K·dB/dt
   - **Augmented B-dot:** m = −K₁·dB/dt − K₂·B

2. SIDI, Marcel J. (1997) — Chapter 9: Advanced attitude control
   - Optimal gain tuning for B-dot
   - Energy minimization criteria

3. THORNTON, W. H.; KIM, H. (1993) — Control with flexible appendages
   - Spillover stabilization
   - Modal filtering for high-frequency modes

**Extension Potential:**
- Gyroscopic control integration
- Magnetic field scheduling based on orbital position
- Three-axis active magnetic control

---

## **COMPLETE REFERENCE LIST (DIN ISO 690 FORMAT)**

### Books

CRAIG, Robert R.; BAMPTON, Mervyn C. C. "Coupling of substructures for dynamic analyses". AIAA Journal. 1968, vol. 6, no. 8, pp. 1313-1319.

EUROPEAN SPACE AGENCY. Structural Materials Handbook. ECSS-E-HB-32-20A. 2011.

GILMORE, David G. Spacecraft Thermal Control Handbook. 2nd ed. Reston, VA: AIAA, 2002.

HUGHES, Peter C. Spacecraft Attitude Dynamics. New York: John Wiley & Sons, 1986.

SIDI, Marcel J. Spacecraft Dynamics and Control. Reston, VA: AIAA Education Series, 1997.

WERTZ, James R. Spacecraft Attitude Determination and Control. Dordrecht: Kluwer Academic Publishers, 1978.

WERTZ, James R.; LARSON, Wiley J. Space Mission Analysis and Design. 3rd ed. El Segundo, CA: Microcosm Press, 1999.

### Standards & Data

CODATA. Fundamental Physical Constants. NIST, 2018.

DORMAND, John R.; PRINCE, Peter J. "A family of embedded Runge-Kutta formulae". Journal of Computational and Applied Mathematics. 1980, vol. 6, no. 1, pp. 19-26.

INTERNATIONAL EARTH ROTATION SERVICE (IERS). IERS 2010 Conventions and WGS-84 Standard. 2010.

### Journal Articles

BANERJEE, A. K.; WILLIAMS, F. W. "Exact dynamic stiffness method". International Journal of Solids and Structures. 1992.

MALLIKARACHCHI, H.; PELLEGRINO, S. "Bistable composite panels". AIAA Journal. 2011.

SEFFEN, Keith A.; PELLEGRINO, Sergio. "Deployment of Eggbox Corrugated Panels". Proceedings of the Royal Society A. 1999.

THORNTON, W. H.; KIM, H. "Flexible appendage dynamics". AIAA Journal of Guidance, Control, and Dynamics. 1993, vol. 16, no. 1.

---

## **QUICK REFERENCE: FEATURE-TO-CITATION MAPPING**

| Feature | Primary Reference | Secondary References | Code Location |
|---------|------------------|----------------------|----------------|
| Rigid body dynamics | Hughes (1986) | Wertz (1978) | `engine.ts` |
| Gravity gradient | Hughes (1986) | Sidi (1997), Wertz & Larson (1999) | `orbitalTorques.ts` |
| SRP torque | Wertz (1978) | — | `orbitalTorques.ts` |
| B-dot detumbling | Wertz (1978) | Sidi (1997) | `detumbling.ts` |
| Detumbling requirement (H, tau_avg,req) | Schaub and Junkins (§4.1.3) | Hughes (1986) | `engine.ts`, `reportData.ts` |
| Modal dynamics | Craig & Bampton (1968) | Thornton & Kim (1993), Banerjee & Williams (1992) | `flexModel.ts` |
| Thermal stiffness | Gilmore (2002) | Wertz & Larson (1999), ESA (2011) | `thermalModel.ts` |
| Bistable hinges | Seffen & Pellegrino (1999) | Mallikarachchi & Pellegrino (2011) | `bistableHinge.test.ts` |
| Center of mass | Hughes (1986) | — | `engine.ts` |
| CoM visualization | Hughes (1986) | — | `CubeSatViewer.tsx` |
| Numerical integration | Dormand & Prince (1980) | — | `engine.ts`, `flexModel.ts` |
| Physical constants | IERS (2010), CODATA (2018) | — | `constants.ts` |

---

**Document Version:** 2.0 (Feature-Based Organization with DIN ISO 690 Citations)  
**Last Updated:** 2026-05-15  
**Citation Format:** DIN ISO 690 (Author-Year System)  
**Project:** deployable-dynamics — CubeSat Solar Panel Deployment & Detumbling Simulator
