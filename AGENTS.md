# AGENTS.md — KizamuBeam coding-agent guidance

These instructions apply to AI coding agents working in this repository. Read [CONTRIBUTING.md](CONTRIBUTING.md), the [developer guide](docs/development.md), and the relevant code before changing anything.

**Primary objective:** Make the smallest safe, testable change that solves the stated problem. Preserve user data, established behavior, machine safety, and the project's architecture.

## Project identity

- **KizamuBeam:** open-source laser design and control application for Windows, macOS, and Linux, licensed **GPL-3.0-or-later**.
- Main desktop stack: **Tauri 2**, **TypeScript**, **Vite**, and **Rust**.
- Main UI uses **native DOM APIs**, not React, Vue, Svelte, or another UI framework. This is an intentional design decision; do not introduce a framework without explicit maintainer approval.
- The repository also contains **KizamuBeam Virtual Machine** (`vm/`), a separate, independently usable Tauri app that emulates GRBL/FluidNC-style controllers. It is not just a testing screen of the main application.
- Work may be AI-assisted, but all changes must be understandable, auditable, and testable by human contributors.

## Repository map

| Area | Responsibility |
| --- | --- |
| `src/model.ts`, `src/geom.ts` | Project/document model, shapes, transforms and geometry |
| `src/editor.ts`, `src/editor/` | Editor state and tools; existing editor modules are composed into the editor at runtime |
| `src/ui.ts`, `src/*Panel.ts`, `src/dock.ts` | UI, panels, windows and user interaction |
| `src/nest.ts`, `src/editor/nest.ts` | Nesting algorithm and placement in documents |
| `src/generators/`, `src/model3d/`, `src/view3d/` | Parametric parts, imported 3D geometry and assembly preview |
| `src/gcode.ts`, `src/machine.ts`, `src/laser.ts` | Job generation, machine communication and control UI |
| `src/ruidaSettings.ts`, `src/ruidaDialog.ts`, `src-tauri/src/ruida.rs`, `src-tauri/core/src/ruida.rs` | Ruida (CO2) controllers: settings catalog and window, UDP/USB driver, protocol and RD job format |
| `src/importers.ts`, `src/lbrn.ts`, `src/pdfimport.ts` | File imports and compatibility |
| `src/locales/`, `src/i18n.ts` | Translations and UI strings |
| `src-tauri/`, `src-tauri/core/` | Main application native backend and Rust processing core |
| `vm/src/`, `vm/src-tauri/`, `vm/src-tauri/core/` | Separate Virtual Machine UI, native app and controller engine |
| `scripts/` | Focused regression and feature tests |
| `docs/` | Developer and user documentation |

Consult the current source and `package.json` rather than assuming this map or a command list is exhaustive.

## First steps for any task

1. Read the relevant implementation, existing tests, and any linked issue or PR.
2. Identify affected data formats, machine commands, UI behavior, and other modules.
3. For broad or risky changes, propose a short plan before editing. For a small bug, keep the scope narrow.
4. Implement the change with focused tests and documentation where needed.
5. Run relevant checks and report **actual** results, remaining risks, and anything you could not verify.

Do not claim a fix is verified merely because code was written or another AI model reviewed it.

## Architectural rules

- Follow existing TypeScript and Rust patterns. Prefer clear module boundaries and readable types over clever abstractions.
- Do not perform unsolicited framework migrations, broad rewrites, dependency upgrades, or cosmetic mass-refactoring.
- Existing editor code uses a non-standard runtime method-composition pattern. Understand it before editing. Avoid method-name collisions and do not redesign it in an unrelated PR.
- Keep geometry and machine-processing logic independently testable where practical; avoid adding DOM dependencies to algorithms.
- Avoid unchecked DOM assumptions and injecting untrusted data into `innerHTML`. Use text nodes or safe DOM construction for user-controlled content.
- Add dependencies only when justified; check licensing and whether existing utilities already solve the problem.
- Preserve existing public behavior, shortcuts, settings, file associations and cross-platform operation unless the task explicitly changes them.

## Data and backward compatibility

- Treat existing user projects, imports/exports, machine profiles, preferences, template and pack formats, and the library as durable user data.
- Do not silently remove, rename, or reinterpret serialized fields. If a change is required, add compatible reading and, where appropriate, an explicit migration with regression tests.
- Avoid modifying `src/storageMigration.ts` without first understanding the legacy settings migration.
- Keep the main app and the Virtual Machine's configuration and versioning separate. Main releases use tags such as `v2.5.0`; VM releases use `vm-v…`. Do not update versions or publish releases unless requested.
- Never commit credentials, machine network secrets, signing keys, personal projects, or private images.

## Machine and laser safety — high priority

This software controls physical motion and laser output. Treat changes to G-code, stream buffering, firmware identification, homing, jogging, coordinate transforms, units, soft/hard limits, laser enable/disable, spindle power, and emergency controls as safety-sensitive.

- Preserve controller-specific behavior; do not assume GRBL, FluidNC, grblHAL, Marlin and Smoothieware use identical commands or semantics.
- Do not introduce automatic homing, laser activation, motion, or test firing without an explicit user action and suitable checks.
- Do not bypass bounds checking, interlocks, alarming, stop handling, or confirmation dialogs to make a test pass.
- An `Unlock`/`$X` command is not a safe substitute for correct homing or limit-switch configuration.
- Prefer pure unit tests, G-code fixtures and Virtual Machine integration tests before physical-machine tests.
- Do not connect to or drive real hardware from an autonomous agent workflow unless the user has explicitly authorized that particular test and safety setup. Never treat simulated success as hardware certification.
- If the reported fault involves a head running into the machine or a laser failing to switch off, prioritize safe failure behavior and request controller/firmware details rather than guessing at a fix.

## Localization

Source-code UI messages are normally written in **German** through `t('…')` or `tn(…)`, even though these instructions are in English. The source text is the translation key; translations live in `src/locales/`.

- Keep placeholders and context suffixes intact.
- Update/check translations for new UI messages; do not replace the project's i18n conventions with an unrelated library.
- Run `npm run i18n:check`. See `docs/development.md` for the optional `--write` workflow; inspect generated changes before committing.

## Builds and tests

Run `npm ci` before local development if dependencies are not installed. Relevant commands from the root:

```bash
npm run build           # TypeScript validation and Vite build
npm run i18n:check      # Localization checks
npm run test:gcode      # G-code and laser job behavior
npm run test:nest       # Nesting
npm run test:generators
npm run test:3d
npm run test:joints
npm run test:history
npm run test:lbrn
npm run test:core       # Fixtures and Rust core tests
npm run test:vm         # VM regression and Rust controller tests
npm run tauri dev       # Main desktop dev mode
npm run vm              # Separate VM dev mode
```

There are additional focused `test:*` scripts in `package.json`; identify and run those relevant to the change. For Rust-specific work, use the corresponding workspace or package under `src-tauri/` or `vm/src-tauri/` as appropriate.

- Add regression tests for bug fixes. For geometry/nesting issues, include concrete dimensions and rotations; for machine issues, cover firmware variants and failure cases.
- Do not delete or relax tests simply to obtain a passing build.
- Do not report tests as passing if they were not executed. If OS/hardware restrictions prevent testing, state exactly what remains unverified.
- Release workflows are not a substitute for checking PR changes; do not assume all tests are run automatically on every PR.

## Virtual Machine specifics

- `vm/` is a **separately distributed** product, even though it shares this repository and root dependencies.
- Its controller core (`vm/src-tauri/core/`) should remain useful without its graphical interface; do not couple protocol behavior to a particular UI.
- Preserve protocol response behavior and network defaults unless the task requires otherwise. Avoid unintentionally exposing controller endpoints on external interfaces.
- Keep emulator behavior distinct from physical hardware guarantees, and cover changes with `npm run test:vm` or focused Rust tests.

## Pull requests and communication

- Make focused changes; avoid unrelated formatting or cleanup.
- Summarize the user-visible effect, compatibility implications and any safety impact.
- Include which commands were run and their results, plus any manual checks and limitations.
- Disclose substantial AI assistance honestly. Do not present automated AI review as independent human review.
- If requirements are ambiguous and the difference affects hardware safety, file compatibility or data loss, ask before making the risky choice.

When in doubt, prioritize **safe machine behavior**, **preserving existing user work**, and **small reviewable patches** over speed or feature count.
