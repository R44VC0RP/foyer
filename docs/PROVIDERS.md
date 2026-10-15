# Bring your own password manager

Foyer doesn't keep passwords. It finds login forms, learns how each site signs
you in, and asks *your* password manager for what it needs: accounts to offer,
the password or one-time code to fill, a passkey signature, or a place to save a
new login. It talks to password managers through a small local program, the
**bridge**, using the protocol below.

```
web page ─ content script ─ background ══ native messaging ══ foyer-bridge
                │                                              ├─ 1Password (op CLI)
   menu & dialogs (extension pages,                            ├─ Bitwarden (bw CLI)
   the site can't read or click them)                          ├─ your command  ← this doc
                                                               └─ demo vault (JSON)
```

## Install the bridge

```sh
bun run bridge:install     # builds foyer-bridge and registers it with your browsers
```

Then reload Foyer. The dashboard's **Password managers** section shows each
provider and whether it's ready.

Configuration lives in `~/.config/foyer/bridge.json`. Without one, the bridge
turns on 1Password if `op` is installed and Bitwarden if `bw` is installed.

```json
{
  "providers": [
    { "type": "1password", "account": "my.1password.com" },
    { "type": "bitwarden", "sessionFile": "~/.config/foyer/bw-session" },
    { "type": "command", "id": "mine", "name": "My manager", "command": ["/usr/local/bin/my-manager-foyer"] },
    { "type": "demo", "file": "~/.config/foyer/demo-vault.json" }
  ]
}
```

## Write a provider in any language

A `command` provider is any executable. For each request the bridge starts it,
writes one JSON request to stdin, and reads one JSON response from stdout. Exit
non-zero on failure. Every response echoes the request `id`.

Capabilities you don't support can simply return an error; declare what you
support in `hello` (if you declare none, the bridge assumes `list` and `fill`).

### hello

```json
{ "id": "1", "type": "hello", "protocol": 1, "client": "foyer-bridge" }
```
```json
{ "id": "1", "type": "hello", "protocol": 1, "bridge": "my-manager 1.0",
  "providers": [{ "id": "mine", "name": "My manager", "status": "ready",
                  "capabilities": ["list", "fill", "save", "passkeys", "sso"] }] }
```

### list: what can sign in here?

```json
{ "id": "2", "type": "list", "domain": "github.com", "origin": "https://github.com" }
```
```json
{ "id": "2", "type": "list", "accounts": [
  { "provider": "mine", "ref": "item-123", "kind": "password", "title": "GitHub",
    "username": "octocat", "hasPassword": true, "hasTotp": true, "urls": ["https://github.com"] },
  { "provider": "mine", "ref": "item-456", "kind": "passkey", "title": "GitHub passkey",
    "username": "octocat", "rpId": "github.com", "credentialId": "base64url…",
    "hasPassword": false, "hasTotp": false, "urls": ["https://github.com"] },
  { "provider": "mine", "ref": "item-789", "kind": "sso", "title": "Figma", "sso": "google",
    "hasPassword": false, "hasTotp": false, "urls": ["https://figma.com"] }
] }
```

Return metadata only, never secrets. Include `urls` on every account: the bridge
drops any account whose URLs don't match `domain`, and refuses later requests
for refs it didn't see in a matching list.

### fill: the user picked an account

```json
{ "id": "3", "type": "fill", "provider": "mine", "ref": "item-123",
  "domain": "github.com", "origin": "https://github.com", "want": ["username", "password", "totp"] }
```
```json
{ "id": "3", "type": "fill", "username": "octocat", "password": "…", "totp": "123456" }
```

### check and save: offering to save a login

After a successful sign-in Foyer asks whether what was typed is new, changed or
already saved. Answer without revealing anything:

```json
{ "id": "4", "type": "check", "domain": "github.com", "origin": "https://github.com",
  "username": "octocat", "password": "…" }
```
```json
{ "id": "4", "type": "check", "status": "update", "matches": [{ "provider": "mine", "ref": "item-123" }] }
```

`status` is `new` (no saved login with that username), `update` (saved, but the
password differs; `matches` lists those items) or `same` (`matches` lists the
equal items). Compare usernames trimmed and case-insensitively.

If the user says yes, Foyer saves. `ref` is present when updating an existing
item's password. `entry.kind` is `password` or `sso` (a remembered "Sign in with
Google" for a site):

```json
{ "id": "5", "type": "save", "provider": "mine", "domain": "github.com", "origin": "https://github.com",
  "entry": { "kind": "password", "title": "github.com", "url": "https://github.com",
             "username": "octocat", "password": "…" } }
{ "id": "6", "type": "save", "provider": "mine", "domain": "figma.com", "origin": "https://figma.com",
  "entry": { "kind": "sso", "title": "figma.com", "url": "https://figma.com", "sso": "google" } }
```
```json
{ "id": "5", "type": "save", "provider": "mine", "ref": "item-999", "created": true }
```

### Passkeys

The bridge does the WebAuthn cryptography (ES256 / P-256, `none` attestation),
so a command provider only stores and returns key material. Built-in providers
handle this internally; a command provider implements two storage calls:

```json
{ "id": "7", "type": "store-passkey", "record": {
    "rpId": "github.com", "credentialId": "base64url…", "userHandle": "base64url…",
    "userName": "octocat", "displayName": "The Octocat",
    "privateKey": "base64url PKCS#8", "createdAt": "2026-10-15T20:00:00Z" } }
{ "id": "7", "type": "store-passkey", "ref": "item-456" }

{ "id": "8", "type": "load-passkey", "ref": "item-456" }
{ "id": "8", "type": "load-passkey", "record": { …same fields… } }
```

and returns passkeys from `list` with `kind: "passkey"`, `rpId` and
`credentialId`. Passkeys are matched by `rpId` rather than `urls`. Add
`"userVerified": true` to the `store-passkey`/`load-passkey` replies if your
manager verified the user (biometrics, PIN, unlocked vault); the bridge then sets
the UV flag. It defaults to `false`.

Foyer passkeys use ES256 (P-256), `none` attestation, a sign count of 0, and are
marked backup-eligible like other synced passkeys. Sites that only accept other
algorithms get the browser's own passkey flow instead.

What the extension sends the bridge for passkeys (you only need this if you
replace the bridge itself): `passkey-create` and `passkey-get` with the rpId,
the page origin, and the SHA-256 of `clientDataJSON`. Foyer builds
`clientDataJSON` in the extension from the browser's record of the page's
origin, never from page input.

## Or: plug in as a browser extension

A password manager that already ships a browser extension can skip the bridge.
The user allowlists its extension id in **Dataset → Password managers**, and
Foyer sends it the same requests with `chrome.runtime.sendMessage`. Each request
carries `foyer: 1`; answer with the same response shapes as above:

```js
chrome.runtime.onMessageExternal.addListener((req, sender, reply) => {
  if (sender.id !== "gpjhllicgakephbnmkoibbigebmdhfoi" || req.foyer !== 1) return
  handle(req).then(reply)   // hello, list, fill, check, save, passkey-create, passkey-get
  return true
})
```

Extension providers are namespaced (`ext:<your id>:<provider>`), and anything
you return is re-shaped before Foyer uses it. Passkey requests reach you as
`passkey-create`/`passkey-get` (you do the WebAuthn signing), since there's no
bridge to do it.

The allowlist works both ways: allowlisted extensions can also ask Foyer what it
has learned about a page's login.

```js
chrome.runtime.sendMessage("gpjhllicgakephbnmkoibbigebmdhfoi", { type: "foyer.recipe", url: location.href })
// → { type: "foyer.recipe", recipe: { offers, surfaces, flows, … } | null }
```

## Safety rules every side follows

- Lists carry metadata only. Secrets appear only in `fill`, `check`, `save` and
  passkey storage calls, only for an account or login the user chose. Foyer and
  the bridge never write them to disk; your password manager stores them. (The
  demo provider is the exception: it is a plain JSON file, for testing only.)
- Secrets never go in command-line arguments; the 1Password and Bitwarden
  adapters pass them on stdin.
- The domain comes from the browser's record of the frame URL. Providers return
  only accounts whose saved URLs match it, and refuse fills for anything else.
- Credentials are only offered on https pages (and local development hosts),
  and only into frames on the same site as the page around them.
- Passkey sign-in and creation, and every save, need a click in a Foyer dialog.
  The dialog is an extension page in an iframe: the site can't read it, click it
  for you, or hide it and still have the click count.
- The bridge only accepts connections from the Foyer extension id
  (`allowed_origins` in its native messaging manifest).
