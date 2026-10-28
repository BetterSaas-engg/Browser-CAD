# Bundled fonts

Two fonts ship with the app so that text geometry never depends on a network
request. Both are **SIL Open Font License 1.1**, which permits bundling and
redistribution. The full licence text sits next to each font.

| File | Font | Weight | Licence | Copyright |
|---|---|---|---|---|
| `NotoSans-Regular.ttf` | Noto Sans | Regular (400) | OFL-1.1 (`NotoSans-OFL.txt`) | 2022 The Noto Project Authors |
| `Nunito-Bold.ttf` | Nunito | Bold (700) | OFL-1.1 (`Nunito-OFL.txt`) | 2014 The Nunito Project Authors |

## Where these came from

Downloaded on 2026-10-28 from `fonts.gstatic.com`, via the Google Fonts CSS API
asked for the static TrueType build rather than the variable one:

```
https://fonts.gstatic.com/s/notosans/v42/o-0mIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjcz6L1SoM-jCpoiyD9A99d41X6zQ.ttf
https://fonts.gstatic.com/s/nunito/v32/XRXI3I6Li01BKofiOc5wtlZ2di8HDFwmRTM9iI7f.ttf
```

The licence texts are the upstream `OFL.txt` from
`google/fonts/ofl/notosans` and `google/fonts/ofl/nunito`.

**Static, not variable, on purpose.** The canonical `google/fonts` repository now
ships these as variable fonts (`Nunito[wght].ttf`). opentype.js — which replicad
uses to turn glyphs into outlines — reads a variable font's default instance
only, so `Nunito[wght].ttf` would come out Regular no matter what weight was
asked for. These two files are already-instanced statics: Noto Sans at 400 and
Nunito at 700.

## Verified on arrival

- TrueType magic bytes `00010000`, no `fvar` table (so not variable).
- `usWeightClass` 400 and 700 respectively.
- Every character the Text shape promises — letters, digits, space and
  `+ - × ÷ = . , ! ? # & @ ( )` — maps to a real glyph in both.

`src/shapes/fonts.test.ts` re-checks the last two points on every test run, so a
font swap cannot quietly drop a character.
