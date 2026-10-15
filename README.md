<p align="center"><img src="static/icons/icon-128.png" width="96" alt="Foyer icon"></p>

# Foyer

A Chrome extension that learns how each site logs you in (password, email first,
passkey, "Continue with Google", magic link, one-time code) and builds a dataset
of those login recipes you can export and share.

It never stores anything personal: no values you type, page text, query strings
or account names. Only the shape of the login: which fields, which buttons, and
in what order.

## Install

You need [Bun](https://bun.sh) and Chrome 120 or newer.

1. Clone and build:

   ```sh
   git clone https://github.com/R44VC0RP/foyer.git
   cd foyer
   bun install
   bun run build
   ```

2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `foyer/dist` folder.
4. Pin Foyer from the puzzle-piece menu so the icon stays in the toolbar.

To update later: `git pull && bun run build`, then click reload on Foyer in
`chrome://extensions`.

## Use

- Log in to sites as usual. Foyer watches quietly in the background.
- Click the toolbar icon to see what it learned about the current site, or to pause it.
- Click **Dataset** for everything: export to a `.foyer.json` file, import
  someone else's file (it merges), or delete sites.

## Where data lives

Everything stays in Chrome's local extension storage on your machine. Nothing is
sent anywhere. Exports round dates to the month, and imported files are
re-checked before they're merged. Incognito windows are never recorded.

## Develop

```sh
bun run watch       # rebuild dist/ on change
bun run typecheck
```

The data model is in `src/shared/types.ts`. The filters that strip anything
personal are in `src/shared/privacy.ts`.
