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

## Autofill with your own password manager

Foyer can fill, save and sign in with **your** password manager. It never
keeps passwords itself.

- **Fill:** focus a login field and pick an account from Foyer's menu, use the
  toolbar popup, or press ⌥⇧F. Email-first logins fill the password step
  automatically, and one-time codes fill on the code screen.
- **Save:** after you sign in, Foyer offers to save a new login or update a
  changed password. On sign-up and change-password forms it suggests a strong
  password and saves or updates it once the form goes through.
- **Passkeys:** when a site asks for a passkey, Foyer can create one or sign in
  with one kept in your password manager. "Use another device" falls back to
  the browser.
- **Sign-in methods:** after "Continue with Google", Foyer offers to remember
  it, and next time the menu offers that button.

It works with 1Password (`op` CLI), Bitwarden (`bw` CLI), or anything else you
connect. Install the bridge once:

```sh
bun run bridge:install
```

Then reload Foyer and check **Dataset → Password managers**. To connect another
password manager, see [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Where data lives

Everything stays in Chrome's local extension storage on your machine. Nothing is
sent anywhere. Exports round dates to the month, and imported files are
re-checked before they're merged. Incognito windows are never recorded.

Credentials are separate from the dataset. They pass between your password
manager and the page only when you pick an account or agree to save, live in
memory only, and are never written to Foyer's storage or exports.

## Develop

```sh
bun run watch       # rebuild dist/ on change
bun run typecheck
```

The data model is in `src/shared/types.ts`. The filters that strip anything
personal are in `src/shared/privacy.ts`.
