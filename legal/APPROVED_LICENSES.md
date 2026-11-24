# Talqava approved licence list

Use this list to decide quickly about any open-source component before it goes into Talqava: a library, an AI agent framework, an MCP server, a UI library, a database, a model, a dataset, a font or an image. It is part of our [open-source policy](OPEN_SOURCE_POLICY.md).

- 🟢 **Safe.** Use it. Keep its copyright notice and licence text (`npm run licenses` does this for code).
- 🟡 **Review.** Do not ship it until a maintainer has read the actual terms, decided, and recorded the decision and the reason in `scripts/licenses.mjs`.
- 🔴 **Avoid.** Do not put it in Talqava. Find another component or write our own.

*A working guide, not legal advice. Have a lawyer review it before a paid release.*

## First: check what you are really taking

"The project says MIT" does not mean every part of it is MIT. Before you decide, check:

1. **The licence file itself**, not only the label on GitHub or npm.
2. **Everything inside:** licence files in subfolders, licence headers in files, vendored code, fonts, images and data.
3. **Compiled binaries** (`.node`, `.wasm`, `.dylib`, `.dll`). They often bundle other libraries; look for the licences shipped beside them or a bill of materials (such as `sbom.cdx.json`).
4. **What it pulls in.** Every dependency it brings counts as well.
5. **Names, logos and trademarks.** A licence for the code is not permission to use the project's name or logo.

`npm run licenses` does steps 1 to 4 for code we ship, and stops a release when something needs a decision. It has already caught two: a drawing library bundling MPL and unlicensed code, and GPL fonts inside the PDF reader. Neither was needed, so neither ships.

## Code: libraries, frameworks, MCP servers, databases, UI

| | Licence | Notes |
| --- | --- | --- |
| 🟢 | MIT, MIT-0, ISC, 0BSD | Keep the notice. |
| 🟢 | BSD-2-Clause, BSD-3-Clause | Keep the notice. BSD-3: do not use the authors' names to promote Talqava. |
| 🟢 | Apache-2.0 | Keep the notice **and any NOTICE file**; say if we changed their files. Includes a patent licence. |
| 🟢 | Zlib, BlueOak-1.0.0, Unlicense, CC0-1.0, Unicode-3.0 | Permissive. |
| 🟡 | MPL-2.0 | Copyleft for the MPL files themselves: we must publish our changes to those files. Usable as separate, unmodified files. |
| 🟡 | LGPL-2.1, LGPL-3.0 | Allowed only as a separate, replaceable library; bundling it into our code is a problem. |
| 🟡 | EPL-2.0, CDDL, Artistic-2.0, Python-2.0, OpenSSL, FTL (FreeType) | Each has its own conditions, such as credits in documentation or published changes. |
| 🟡 | Dual-licensed ("free for open source, paid for commercial use") | Check which licence applies to how we use it. |
| 🟡 | Any licence not on this list, or a custom one | Read it; decide; record. |
| 🔴 | GPL-2.0, GPL-3.0 | Would require releasing everything combined with it under the GPL. |
| 🔴 | AGPL-3.0 | The same, and also for software used over a network. |
| 🔴 | SSPL, BUSL, Elastic License, Commons Clause, "source available" | Restrict commercial or service use. |
| 🔴 | Non-commercial or no-derivatives terms (such as CC-BY-NC, CC-BY-ND) | We are commercial. |
| 🔴 | No licence at all, or "all rights reserved" | No permission to use it. |
| 🔴 | "Good, not evil" (JSON licence) and similar moral clauses | Not open source, and unclear. |

**MCP servers and agent frameworks** follow the code rules above when we ship or bundle them. A connector a person adds to their own copy of Talqava runs on its own, under its own terms, and is not distributed by us; if we list or recommend one in the app, check its licence and terms anyway.

## AI models

Talqava does not ship model weights today: people choose a model provider, or run a model on their own computer. If we ever bundle, download for the user, or recommend a specific model, check its licence first.

| | Licence | Notes |
| --- | --- | --- |
| 🟢 | Apache-2.0, MIT | As for code. |
| 🟡 | Llama, Gemma and other model-specific licences or use policies | Often allow commercial use, with conditions: user limits, naming ("Built with …"), banned uses. Read each one. |
| 🟡 | OpenRAIL and other RAIL licences | Commercial use allowed, with use restrictions that pass on to our users. |
| 🔴 | Research-only or non-commercial models | Not for Talqava. |

**Hosted models** (Anthropic, OpenRouter and others) are used under each provider's own terms, which the person using Talqava accepts with their own account.

## Data and content

| | Licence | Notes |
| --- | --- | --- |
| 🟢 | CC0, public domain, our own content | |
| 🟡 | CC-BY | Allowed with credit in the notices. |
| 🟡 | CC-BY-SA | The share-alike terms apply to what we make from it. |
| 🔴 | CC-BY-NC, research-only data, scraped data with unclear rights | |

## Fonts, icons and images

| | Licence | Notes |
| --- | --- | --- |
| 🟢 | SIL Open Font License 1.1 | Keep the licence with the font; do not sell the font on its own. |
| 🟢 | Our own work (the Talqava logo, the brand video) | |
| 🟡 | CC-BY icons or images | Credit required. |
| 🔴 | Fonts or images with no licence, or "personal use only" | |

## Names, logos and trademarks

- Use other projects' and companies' names only to say plainly what Talqava works with ("works with Claude", "connect GitHub").
- Never use their logos, or wording that suggests they make, sponsor or endorse Talqava, unless they have said we may.
- A licence for a project's code never includes its trademark.

## Our own code around open-source parts

Permissive licences (🟢) do not require the rest of a product to be open source. Talqava itself is MIT, so anyone may build on it; if we ever add parts under other terms (a paid edition, a hosted service), they may include 🟢 components as long as we keep their notices. Copyleft components (🔴, and 🟡 MPL/LGPL) are what would put that choice at risk, which is why they are avoided or reviewed.

## Decisions made so far

| Component | Decision | Why |
| --- | --- | --- |
| `@napi-rs/canvas` (optional extra of the PDF reader) | 🔴 Not shipped | Bundles MPL, FreeType and unlicensed code; not needed to read PDF text. Installs use `--omit=optional`. |
| Liberation fonts inside `pdfjs-dist` | 🔴 Not shipped | GPL v2 with a font exception; not needed to read PDF text. Removed by `scripts/prune-shipped.mjs` after every install. |
| WebAssembly decoders inside `pdfjs-dist` (JBIG2, OpenJPEG, qcms, QuickJS) | 🟢 Approved | Each ships its licence beside it: BSD, Apache-2.0 and MIT. Carried into the notices. |
| `standardwebhooks` (inside the Anthropic SDK) | 🟢 Approved | Declares MIT but ships no licence file; the notice is recorded with the copyright holder it names. |
| Tiptap and ProseMirror (the page editor) | 🟢 Approved | MIT; notices in `public/vendor/editor.LICENSES.txt`. |
| Inter and Space Grotesk fonts | 🟢 Approved | SIL Open Font License; licences in `public/fonts`. |
