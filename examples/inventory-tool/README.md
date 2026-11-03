# Inventory Tool

A dependency-free inventory manager built with plain HTML, CSS, and JavaScript.
It has no build step and does not require any installed packages.

## Features

- Track item name, SKU, quantity, and minimum stock.
- Create, edit, and delete inventory items.
- Search by partial name or SKU and sort by any inventory field in either direction.
- Persist inventory in browser `localStorage`.
- Highlight low-stock items where quantity is less than or equal to minimum stock.
- Export the complete inventory as `inventory.json`.

## Run Locally

The application uses native JavaScript modules, so serve the repository over
HTTP instead of opening `index.html` directly.

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8000/> in a modern browser.

## Test

The pure inventory logic has focused tests using Node's built-in test runner.
No package installation is needed.

```powershell
node --test
```
