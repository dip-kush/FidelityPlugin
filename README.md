# Fidelity Position Copier

A local-only Chrome extension for extracting visible Fidelity positions into daily JSON snapshots.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `fidelity-position-copier`.
5. Open your Fidelity positions page and click the extension icon.

## What it does

- Reads visible position rows from the active Fidelity tab.
- Separates obvious stock rows from option rows where possible.
- Saves one snapshot per day in `chrome.storage.local`.
- Copies the latest snapshot as JSON.
- Exports JSON or CSV.

The extension does not send data to any server. Exports and clipboard copies are user-triggered.

## Next parser pass

The current parser is intentionally heuristic because Fidelity page markup varies. For a reliable public release,
capture a sanitized HTML snapshot of your positions page and update `content.js` with page-specific selectors.

When sanitizing, remove account numbers, names, balances, and exact quantities if you prefer, but keep the table
structure, class names, labels, and a few representative stock and option rows.
