---
description: Describe when these instructions should be loaded
# applyTo: 'Describe when these instructions should be loaded' # when provided, instructions will automatically be added to the request context when the pattern matches an attached file
---
please write tests first we are doing test driven development 
never hardcode any physics
always use reputable libraries for physics calculations and constants 
never use any python loops
parallalize the test runs and run them extensively during development 
always use a linter and formatter to maintain code quality and consistency
Always read .lovable\plan.md before writing any code and refer to it often during development to ensure alignment with the project goals and requirements.
Please use docker compose to deploy and develop the application, never assume or execute any other commands on the local host machine.
If you create a feature, create new branch and once all tests pass, merge this branch to main and delete the feature branch
Always make sure to run the tests before pushing any code to the repository, and ensure that all tests pass successfully. If any tests fail, fix the issues before pushing the code. This will help maintain the integrity of the codebase and ensure that new features do not introduce bugs or regressions.
Always write clear and concise commit messages that describe the changes made in each commit. This will help other developers understand the purpose of each commit and make it easier to review and maintain the codebase.
Never declare a raw numeric value for any physical or mathematical constant. All constants (gravitational parameters, planetary radii, speed of light, solar pressure, orbital mechanics inputs, etc.) must be imported from `src/lib/physics/constants.ts`, which sources values from IERS 2010, WGS-84, and CODATA 2018. If a constant is missing from that file, ADD it there with a JSDoc citation before using it anywhere else. Never inline it at the call site.
Never implement cross products, dot products, normalizations, quaternion multiplications, Euler conversions, or rotations manually. Always use THREE.Vector3 and THREE.Quaternion from the `three` package, which is already installed. Use THREE.MathUtils for clamping, degree/radianconversions, and interpolation.
Never write raw Math.PI fractions (Math.PI/2, Math.PI/4, etc.) as geometry or configuration values. Always use MathUtils.degToRad(deg) so the intent is human-readable and traceable.
Never reimplement a formula that already exists in THREE.js or a cited library. If a new physics formula is added (e.g. a new torque model, a new integrator), it must include a JSDoc comment citing the exact reference (author, year, book/paper title, section or equation number) so it is traceable to peer-reviewed literature.
Before installing any new npm package for math or physics, check whether
THREE.js or the existing stack already covers the need. If a new package is genuinely required, document the reason in a comment at the import site. Never install gl-matrix, mathjs, or odex without explicit discussion — previous attempts caused ESM/Vite runtime failures (see physics-refactor-plan.md).