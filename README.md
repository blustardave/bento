# Bento

A minimal, fast CSV viewer and editor for Windows, with light and dark modes.

## Install

Open the [Releases](../../releases) page, download the newest **Bento_x.x.x_x64-setup.exe**, and run it. It installs for your user only, so you don't need admin rights. After that you can double-click any `.csv` file, or right-click it and choose **Open with → Bento**.

Every push to `main` builds a fresh installer automatically (see `.github/workflows/build.yml`).

## What it does

- Opens CSV/TSV files of a million rows or more and scrolls them smoothly. Only the visible cells are drawn.
- Works out the delimiter, encoding (UTF-8, UTF-8 BOM, UTF-16, Windows-1252) and line endings, and keeps them when you save. You can change any of them from the status bar.
- Edits like a spreadsheet: type, F2/Enter, Tab/Enter to move, Ctrl+arrows, Shift to extend, Ctrl+D fill down.
- Copy and paste work with Excel and Google Sheets, and formulas keep their relative references when you paste them inside Bento.
- Unlimited-feeling undo/redo (the last 300 steps).
- Insert, delete and hide rows and columns, resize columns (double-click a border to auto-fit), and freeze the header row.
- Sort (numbers sort as numbers, blanks go last) and filter each column by value.
- Find and replace, with match-case, whole-cell and regex options.
- Formulas: `+ - * / ^ & %`, comparisons, `A1`, `$A$1`, `A1:B9`, `A:A`, plus `SUM AVERAGE MIN MAX COUNT COUNTA PRODUCT ROUND ABS IF IFERROR AND OR NOT CONCAT LEN UPPER LOWER TRIM`.
- The status bar shows Sum, Avg and Count for the selection.
- Tabs, recent files, drag-and-drop, and a single window (opening another file adds a tab).

CSV can't store formulas, so when you save Bento asks whether to write the calculated values or keep the formulas as text.

## Develop

```
npm install
npm run dev          # UI only, in a browser at http://localhost:1420
npm run tauri dev    # the real desktop app (needs Rust)
npm test             # parser / formula / undo tests
```

Built with [Tauri 2](https://tauri.app) and plain TypeScript, with a canvas-drawn grid.
