# Desktop 1.0.2

Windows x64 Electron desktop release.

- Copy terminal selections with Ctrl+C or Ctrl+Shift+C; Ctrl+C without a selection still interrupts the remote process.
- Copy mouse selections through the desktop clipboard bridge, without copying search selections automatically.
- Keep the live terminal buffer visible while the model opens and closes.
- Include the current desktop workspace, appearance, editor close, and diagnostic improvements.
- Preserve the web SSH demonstration already present on main.

Validation:
- TypeScript and desktop production build passed.
- Clipboard and diagnostics: 11 tests passed.
- SSH workspace: 9 tests passed.
- Terminal tools browser regression suite passed with no page errors.
- Native Electron startup smoke: 18 checks passed.
- Packaged version is 1.0.2; renderer bundles and runtime entry files match the tested build.

Artifacts: RhineLab-Setup-1.0.2.exe, RhineLab-Portable-1.0.2.exe, SHA256SUMS.txt.
