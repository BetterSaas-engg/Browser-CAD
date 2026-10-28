# Bundled fonts

Two fonts ship with the app so that text geometry never depends on a network
request. Both are **SIL Open Font License 1.1**, which permits bundling and
redistribution. The full licence text sits next to each font.

| File | Font | Weight | Licence | Copyright |
|---|---|---|---|---|
| `NotoSans-Regular.ttf` | Noto Sans | Regular (400) | OFL-1.1 (`NotoSans-OFL.txt`) | 2022 The Noto Project Authors |
| `Sniglet-ExtraBold.ttf` | Sniglet | ExtraBold (800) | OFL-1.1 (`Sniglet-OFL.txt`) | 2008 Haley Fiege; 2012 Brenda Gallo; 2013 Pablo Impallari |

## Where these came from

Downloaded from `fonts.gstatic.com` via the Google Fonts CSS API, asked for the
static TrueType build rather than the variable one:

```
Noto Sans  2026-10-28
  https://fonts.gstatic.com/s/notosans/v42/o-0mIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjcz6L1SoM-jCpoiyD9A99d41X6zQ.ttf
Sniglet    2026-10-28
  https://fonts.gstatic.com/s/sniglet/v19/cIf9MaFLtkE3UjaJ_ImHRGEsnIJkWL4.ttf
```

The licence texts are the upstream `OFL.txt` from `google/fonts/ofl/notosans`
and `google/fonts/ofl/sniglet`.

**Static, not variable, on purpose.** Several Google Fonts families now ship
only as variable fonts. opentype.js — which replicad uses to turn glyphs into
outlines — reads a variable font's default instance only, so a variable file
would come out Regular no matter what weight was asked for. Both files here are
already-instanced statics.

## Why not Nunito any more

The rounded face used to be Nunito Bold. It was replaced because **44 of the 76
characters the Text shape promises had self-intersecting outlines**, which
OpenCascade cannot turn into a valid face. The result built, measured the right
volume, and rendered with faces missing. See D50.

Overlapping strokes are normal in font design — the renderer resolves them with
the nonzero winding rule — so this is a property of our pipeline, not a defect
in Nunito. It does mean every bundled font has to be checked.

Screened across the full promised character set, these were clean: Noto Sans,
Sniglet, M PLUS Rounded 1c, Varela Round, Dosis, Rubik. These were not:
Nunito (44 characters), Quicksand (41), Mulish (43), Nunito Sans (43),
Asap (17), Comfortaa (10), Fredoka (10), Baloo 2 (9), Baloo Bhaijaan 2 (9),
Signika (9).

Sniglet ExtraBold was chosen from the clean list: rounded, genuinely heavy
(800, which prints well), and 51 kB against M PLUS Rounded's 3.5 MB.

## Verified on every test run

`src/shapes/fonts.test.ts` checks, for both fonts:

- TrueType with no `fvar` table, so not variable.
- `usWeightClass` is the weight the label claims.
- Every character the Text shape promises — letters, digits, space and
  `+ - × ÷ = . , ! ? # & @ ( )` — maps to a real glyph.
- **No glyph in that set has a self-intersecting outline.** This is the check
  that would have caught the Nunito bug before it reached a browser.
