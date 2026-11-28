# Bento

A minimal, fast spreadsheet and CSV editor for Windows and macOS, with light and dark modes.

## Install

Open the [Releases](../../releases) page and download the newest build:

- **Windows:** **Bento_x.x.x_x64-setup.exe**. It installs for your user only, so you don't need admin rights. After that you can double-click any `.csv` file, or right-click it and choose **Open with → Bento**.
- **Mac:** **Bento_x.x.x_universal.dmg** (Apple Silicon and Intel). It isn't notarised yet, so the first time, open **System Settings → Privacy & Security** and click **Open Anyway**.

Bento checks for updates and offers to restart into a new version ("Update ready" in the title bar).

Every push to `main` builds both installers (see `.github/workflows/build.yml`). The release stays a draft until both platforms have built, then goes live.

## Files

- **`.bento`** is Bento's own format: it can hold several sheets (tabs along the bottom) and keeps the data plus formatting, formulas, column widths, the frozen header and filters. It's gzip-compressed JSON, often smaller than the CSV it came from. Saved `.bento` files save themselves as you work (AutoSave, which you can turn off in Preferences).
- **CSV/TSV** files open as normal (a heading row is spotted and frozen, so sorting and filtering leave it alone). **Ctrl+S** saves the CSV back in place with the separator, encoding and line endings it came with; if the sheet has things a CSV can't hold (formatting, charts, extra sheets…), Bento asks first and offers to save a `.bento` copy instead. **Export as CSV…** (Ctrl+E) writes a CSV copy, letting you pick the separator, encoding and line endings. AutoSave never overwrites a CSV.

## What it does

- Formatting: bold, italic, underline, strikethrough; text and fill colours (a palette with light and dark versions of each colour, plus custom colours); horizontal and vertical alignment; overflow/wrap/clip; font size; number formats (currency £/$/€, percent, decimal places, thousands separators, four date styles, plain text).

- Opens CSV/TSV files of a million rows or more and scrolls them smoothly. Only the visible cells are drawn.
- Works out the delimiter, encoding (UTF-8, UTF-8 BOM, UTF-16, Windows-1252) and line endings, and keeps them when you save. You can change any of them from the status bar.
- Edits like a spreadsheet: type, F2/Enter, Tab/Enter to move, Ctrl+arrows, Shift to extend, Ctrl+D fill down.
- Copy and paste work with Excel and Google Sheets, and formulas keep their relative references when you paste them inside Bento.
- Undo/redo (the last 300 steps), including column widths, hiding and named ranges.
- Insert, delete and hide rows and columns, and resize columns (double-click a border to auto-fit).
- Freeze any number of rows and columns by dragging the bars in the top-left corner (or the freeze lines).
- Fill handle: drag the dot on a selection to continue numbers, dates, weekdays, months and "Item 1"-style text, or to copy; Ctrl switches between the two. Double-click it to fill down alongside the neighbouring column.
- Sort the whole sheet or just a selected range (numbers and dates sort as such, blanks go last) and filter each column by value.
- Find and replace, with match-case, whole-cell, regex and "in formulas" options.
- Formulas: `+ - * / ^ & %`, comparisons, `A1`, `$A$1`, `A1:B9`, `A:A`, other sheets (`Sheet2!A1`), named ranges, and several hundred functions — maths, statistics, lookup (`XLOOKUP`, `INDEX`/`MATCH`…), text, dates, finance, dynamic arrays that spill (`FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`…) and `LET`/`LAMBDA`. Browse them from the Σ button.
- Charts, pictures, shapes and text boxes over the grid; checkboxes, dropdowns and pictures in cells.
- The status bar shows Sum, Avg and Count for the selection.
- Tabs, recent files, drag-and-drop, and a single window (opening another file adds a tab).

CSV can't store formulas, so when you export Bento asks whether to write the calculated values or keep the formulas as text. Text that only looks like a formula (`=== Totals ===`) is written back exactly as it was.

## Develop

```
npm install
npm run dev          # UI only, in a browser at http://localhost:1420
npm run tauri dev    # the real desktop app (needs Rust)
npm test             # all tests in tests/ (parser, formulas, engine, undo, security…)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust side (file access rules)
```

Built with [Tauri 2](https://tauri.app) and plain TypeScript, with a canvas-drawn grid.

### Security

Files are untrusted input. Everything read from a `.bento` is checked before it reaches the page (`src/sanitize.ts`), the page runs under a strict Content Security Policy, and the Rust side only reads or writes files the user picked in a dialog, dropped, opened from Finder/Explorer or the recent list, plus Bento's own recovery folder (`src-tauri/src/access.rs`).
