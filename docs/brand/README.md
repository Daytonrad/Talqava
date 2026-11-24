# Talqava brand guide

Talqava is the operating system for a business run with AI agents: the layer between people and any AI model or agent that gives the work an org chart, rules, memory and a receipt. The brand should feel like a well-run operations desk: calm and exact, with one green signal for what needs doing.

## The logo

The mark is a **T made of two parts**: a white bar, the layer Talqava adds on top, and a green block under it, the cursor of work in progress. It sits on a black rounded tile, so it reads the same on any background.

| File (in [logos/](logos)) | Use it for |
| --- | --- |
| `talqava-mark.svg` | App icon, favicon, avatars, anywhere square. Works on any background. |
| `talqava-lockup-dark.svg` | The main logo on dark grounds (dark grounds): website header, decks, the app's sign-in screen. |
| `talqava-lockup-light.svg` | The main logo on light grounds: documents, invoices, light slides. |
| `talqava-wordmark-dark.svg` / `-light.svg` | Wordmark with its cursor, where the mark already appears nearby (the app's top-left corner). |

**Wordmark.** TALQAVA in capitals, drawn as single-weight strokes the same thickness as the mark's bar (one eighth of its height). Corners on A and Q are rounded to 12 of 56 units; everything else is square. Written in running text the name is **Talqava**, capital T only.

**Clear space.** Keep space-8 (32px) clear around a 64px tile; scale it with the logo (half the tile's side).

**Smallest size.** Tile 16px on screen, 6mm in print. The lockup no smaller than 24px tall.

**Do not** recolour the bar or the cursor, put the mark without its tile on a mid-grey, stretch or rotate it, add shadows or glows, or set the name in another font in its place.

## Colour

Light is the default look of the product, and every colour has a light and a dark value. The exact values, with what each is for, are in [tokens.json](tokens.json); the app uses them as named colours in `public/theme.css`.

- **signal-green** is the brand. Use it for the one action on a screen (Assign task, Connect), the logo's cursor, and live states. If two things on a screen are green, one of them is wrong.
- **ground, panel, raised, line** build the surfaces, one step at a time; separate things with line, not with shadows.
- **ink, ink-soft, ink-muted** are the three strengths of text. Costs, times and helper text are ink-muted.
- **green-text** is green used as words or thin lines; on light grounds it becomes a darker green so it stays readable.
- **warning** and **critical** mean states only (waiting, failed, over budget), never decoration.

Primary button: signal-green fill, on-green text, radius-md. Secondary button: panel fill, line border, ink text.

## Type

- **Space Grotesk** (display) for website and deck headlines only.
- **Inter** (sans) for everything people read in the app.
- **JetBrains Mono** (mono) for uppercase labels and for numbers that line up: costs, counts, receipts. It carries the product's terminal heritage.

All three are free under the SIL Open Font License. The app bundles Inter and Space Grotesk (in `public/fonts`, with their licences); JetBrains Mono falls back to the system's monospace font.

## Voice

Plain, businesslike and specific, written for an owner who is not technical.

- Agents are named by their job: Head of Marketing, Bookkeeper. Never cute names.
- Say what happened and what it cost: "The Head of Finance finished the cash forecast. $0.08."
- Buttons say exactly what they do: "Assign to the team", "Connect OpenRouter".
- Say "agents", "tasks", "team", "organization". Avoid technical words: say "add credit", not "provision billing".

## Iconography and characters

Interface icons are simple line icons, 1.5px strokes, rounded ends, drawn in ink-soft and turning ink on hover. Agents keep their keycap character portraits: they are part of the brand, and each department has its own colour family.

## Examples

- App header: the wordmark at 15px cap height, top left, cursor blinking once a second.
- Website hero: display-xl headline in ink on ground, one signal-green button, the lockup top left.
- Receipt: label style for headings, data style for every number, ink-muted for times.

## Using the brand

The Talqava name and logo belong to GR Investments LLC. The MIT licence covers Talqava's code, not its name or logo: you may use the logo to refer to Talqava, but not in a way that suggests your own product or version is the official Talqava, or is made or endorsed by us. See the [Terms of Use](../../legal/TERMS.md).
