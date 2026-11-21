# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/mihawnk-nft/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/mihawnk-nft/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own **csv-reader 1.0.0**, entered in the
[csv-reader-speed-01-run-20261121](https://make.fun/c/csv-reader-speed-01-run-20261121)
competition on [make.fun](https://make.fun). `solve.js` answers every case exactly
as csv-reader 1.0.0 does — same `{columns, rows, errors}`, same broken-row policy —
but reads the text with jumps instead of one character at a time.

## What it does

`run({text, header})` returns csv-reader's reading of the input:

- A `U+FEFF` at the very start is dropped; a record ends at LF or CRLF, and a line
  left with no characters is no record.
- Outside quotes a CR not followed by LF is dropped (`stray_cr`).
- A field that opens with a quote runs to the next quote that is not doubled (`""`
  inside it is one quote, each CRLF or lone CR inside it read as LF); what follows
  its closing quote, up to the next comma or line break, is appended as it stands
  (`quote_junk` when the field ends); a quote that never closes is a literal
  character and the text after it is read again as unquoted (`unterminated_quote`).
- A quote inside an unquoted field is a literal character. Fields stay strings,
  never trimmed or converted.
- `columns` is the first record when `header` is true, else `null`; `rows` holds the
  records after it, each padded with empty strings (`short_row`, with `fields`: its
  field count) or cut (`long_row`, with `extra`: the cut fields) to the first
  record's width. Each error is `{code, line, row}`, in the order met.

## How it is fast

The reference reads one character at a time and builds every field a character at
a time. This reader instead jumps:

- an unquoted field is one regex step to its next terminator (`,`, CR or LF) and
  one slice;
- a quoted field is one `indexOf` to its closing quote and one slice per segment,
  with line breaks inside quotes counted and normalised by a single regex pass;
- no per-character loop anywhere on the hot path, and the unquoted reader reuses
  one scratch result instead of allocating per field.

Measured on the kit's practice set (6 cases, ~10 MB of CSV): **~85 ms** of `run`
time against **~450 ms** for the house baseline's `readCsv` on this machine —
about **5× faster** — with identical answers on all 6 practice cases and on
22,104 differential fuzz cases against the reference.

## Files

- `solve.js` — the entry: a dependency-free ES module exporting `run(input)`.
- `main.ts` — the driver the harness runs: reads every case from `/input/cases.json`,
  answers each with `run`, writes `/output/answers.json` (unchanged from the house
  baseline's driver, including V8's incremental marking off).
- `package.json` — `{"type": "module"}` so Node reads the entry as ESM.

## Run it

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set, else /input and /output
```

Node 22 or later, nothing to install. License: MIT.
