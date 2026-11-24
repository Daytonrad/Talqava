# Talqava open-source policy

Talqava is MIT-licensed and is built to be used commercially, by us and by others. It includes open-source components written by other people. Each comes with its own licence, and we respect every one of them: we know what we ship, we only ship what we may, and we keep every notice we are asked to keep.

This policy says how. It applies to everything in this repository and everything that ships with Talqava: the app, the Mac app, the installer and the Docker image.

*This is our working policy, not legal advice. Before a paid or commercial release, have it reviewed by a lawyer.*

## 1. Know what we ship

- Every third-party component that ships is listed, with its licence and its full notice, in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The file is generated from what actually ships, never written by hand.
- **What ships:** the app's runtime dependencies (every level deep), the packages bundled into the page editor (`public/vendor/editor.js`), and bundled assets (fonts, images, video).
- **What does not ship:** development tools (TypeScript, the test runner, the bundler, electron-builder) and optional extras. Talqava is installed with `--omit=dev --omit=optional` wherever it ships, and `scripts/prune-shipped.mjs` removes, after every install, files that dependencies bring but we may not ship (each with its reason).
- **Not only the label:** the check reads each package's licence text, and looks inside it for other licence files and compiled binaries, since a package marked MIT can contain parts under other licences.
- Electron adds its own licence and Chromium's to the Mac app (`LICENSE.electron.txt` and `LICENSES.chromium.html`).

## 2. Which licences we accept

The quick 🟢 safe / 🟡 review / 🔴 avoid list, covering code, AI models, data, fonts, images and trademarks, is the [approved licence list](APPROVED_LICENSES.md). In short:

| | Licences | What to do |
| --- | --- | --- |
| **Allowed** | MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0, Zlib; SIL Open Font License 1.1 for fonts | Use it. Keep its notice. For Apache-2.0, also keep any NOTICE file. |
| **Needs review** | MPL-2.0, LGPL, EPL-2.0, CC-BY, Artistic-2.0, Python-2.0, and anything not listed here | Do not add it until a maintainer has reviewed it and recorded the approval and the reason in `scripts/licenses.mjs`. |
| **Not allowed** | GPL, AGPL, SSPL, BUSL, Elastic, Commons Clause, any "non-commercial" or "no derivatives" licence, and code with no licence at all | Never ship it. Find another component, or write our own. |

For a choice of licences ("MIT OR Apache-2.0"), one allowed option is enough. For a combination ("MIT AND Unicode-3.0"), every part must be allowed.

## 3. Before adding a dependency

1. **Do we need it?** Prefer the Node and browser built-ins. Every dependency is code we answer for.
2. **Check its licence**, and the licences of everything it brings with it. Native packages often bundle other libraries inside a binary; look for a bill of materials such as `sbom.cdx.json`.
3. **Prefer components that are maintained, widely used, and minimal.**
4. **Run `npm run licenses`.** It fails on any licence the policy does not allow, or on a component that ships no licence text.
5. **Say in the pull request** what the dependency is, why it is needed, and its licence.

## 4. Keeping notices

- MIT, ISC, BSD and similar licences ask that their copyright and licence text travel with the code. `npm run licenses` writes them into THIRD_PARTY_NOTICES.md, and into `public/vendor/editor.LICENSES.txt` for the bundled editor, whose minified file names that list in its first line.
- A component that declares a licence but ships no text is checked by hand against its repository and recorded in `scripts/licenses.mjs`, with the copyright holder and the source.
- Bundled fonts keep their licence files next to them (`public/fonts`).

## 5. Our own code and contributions

- **We never copy code, designs or wording from other projects** unless their licence allows it and the pull request says so. We study other products for ideas only.
- Contributions are accepted under the MIT licence, as [CONTRIBUTING.md](../CONTRIBUTING.md) says.
- Code from an AI assistant is reviewed like any other. If it reproduces recognisable code from another project, that code's licence applies and this policy decides.
- Images, icons, video and fonts need a licence too. Our brand video and logo are our own work.

## 6. Keep checking

- Run `npm run licenses` after every dependency change and before every release. Commit the regenerated notices.
- `npm run licenses -- --check` fails when the notices are out of date; it belongs in the automated checks on every pull request ([#13](https://github.com/Talqava/Talqava/issues/13)).
- Review this policy once a year, and before Talqava is sold or offered as a paid service.

## Where things are

| What | Where |
| --- | --- |
| The 🟢 / 🟡 / 🔴 list, and decisions made | [APPROVED_LICENSES.md](APPROVED_LICENSES.md) |
| The check, and recorded approvals | `scripts/licenses.mjs` |
| Files removed after install, and why | `scripts/prune-shipped.mjs` |
| Every shipped component and its notice | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |
| Notices for the page editor | `public/vendor/editor.LICENSES.txt` |
| Packages in the page editor | `editor/bundled-packages.json` |
| Font licences | `public/fonts/OFL-*.txt` |
