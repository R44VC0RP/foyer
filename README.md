# Foyer

A Chrome extension that learns how each site logs you in — password, email-first,
passkey, "Continue with Google", magic link, one-time code — and builds a shareable
dataset of those login recipes. It never stores anything personal.

The goal: a password manager (or anything else) can look up `github.com` and know
the login takes an identifier, then a password, then maybe a passkey, and which
selectors to use, because someone already walked through it.

## What it records

For every site (keyed by registrable domain, e.g. `github.com`):

- **offers**: methods the login screens advertise (`password`, `identifier-first`,
  `passkey`, `passkey-autofill`, `magic-link`, `otp`, `sso:google`, `sso:apple`, …)
- **surfaces**: login screens seen: field roles, selectors, provider buttons
- **flows**: logins you actually did, as ordered steps of actions
  (`fill:email → submit → fill:password → submit → fill:otp → submit`), with the
  primary method, any second factor, and whether it completed

How it sees things:

| Signal | Source |
| --- | --- |
| Fields and buttons | DOM structure and attributes (`type`, `autocomplete`, `name`, …) |
| Which field you used | That an `input` event fired on it, never its value |
| Passkeys | Hooks `navigator.credentials.get/create` in the page (shape only) |
| Google One Tap | FedCM `identity.providers[].configURL` host |
| IdP hops | Top-level navigations and OAuth popups |

## What it never records

- Field values, page text, titles, or anything you typed
- Query strings or fragments; path segments outside an auth vocabulary become `*`
- Emails, long numbers, hashes or UUIDs in any attribute
- Tenant subdomains on shared IdPs (`acme.okta.com` → `*.okta.com`)
- WebAuthn challenges, credential IDs, user handles or responses
- Incognito windows (the extension is disabled there)

Exports round every date to the month. Imports are re-validated and re-sanitised,
so a hand-edited file can't smuggle extra fields in.

## Develop

```sh
bun install
bun run build       # -> dist/
bun run watch       # rebuild on change
bun run typecheck
```

Load it: `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.

Then log in to things as usual. The toolbar popup shows what Foyer knows about the
current site; **Dataset** opens the full view with export, import (merge) and delete.

## Layout

```
src/
  passkey-hook.ts   MAIN-world WebAuthn/FedCM hook
  content.ts        finds login screens, watches interactions
  detect.ts         field/button classification and selectors
  background.ts     stitches events into flows across tabs/popups
  popup.ts          per-site view
  dashboard.ts      dataset view, import/export
  shared/
    types.ts        the data model (start here)
    privacy.ts      sanitisers every string passes through
    dataset.ts      flow classification, merge, export, import validation
    domains.ts      registrable domains and known IdP hosts
    store.ts        chrome.storage wrappers
static/             manifest, HTML, CSS
```

## Dataset format

```jsonc
{
  "format": "foyer.dataset",
  "version": 1,
  "exportedAt": "2026-10",
  "sites": {
    "bank.test": {
      "domain": "bank.test",
      "hosts": ["bank.test"],
      "offers": { "password": { "seen": 1, "lastSeen": "2026-10" }, "otp": { … } },
      "surfaces": [ … ],
      "flows": [{
        "method": "password",
        "mfa": "otp",
        "outcome": "completed",
        "steps": [
          { "host": "bank.test", "path": "/account/login", "kind": "login",
            "fields": [{ "role": "username", "selector": "#user", "type": "text" },
                       { "role": "password", "selector": "input[name=\"pw\"]", "type": "password" }],
            "actions": [{ "kind": "fill", "role": "username", "selector": "#user" }, …] },
          { "host": "bank.test", "path": "/verify", "kind": "mfa", … }
        ],
        "seen": 1, "firstSeen": "2026-10", "lastSeen": "2026-10"
      }]
    }
  }
}
```

Flows are deduped by a hash of their shape, so merging datasets from many people
adds up `seen` counts instead of duplicating entries.

## Known limits

- Login detection is heuristic. Unusual forms may be missed or misread.
- Selectors come from page attributes and can break when a site redeploys.
- The domain grouping uses a small public-suffix list, not the full PSL.
- Importing the same file twice double-counts `seen`.
- Login forms inside shadow DOM aren't seen yet.
- A page can forge the passkey events Foyer listens for. Their fields are
  validated (enums, rpId must match the host) so nothing personal gets in, but a
  hostile site can add a fake passkey step to its own recipe.
- Unknown hosts reached mid-SSO (an employer's IdP) are stored as `*`.
