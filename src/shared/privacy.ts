// Everything that leaves a page goes through these helpers. The rule is simple:
// when a string could plausibly identify a person or an account, drop it.

// A path segment survives only if every one of its `-`, `_` or `.` separated
// words is auth vocabulary. Anything else (slugs, tenants, tokens) becomes `*`.
const AUTH_WORDS = new Set(
  (
    "login logon log in out signin sign on signon signup up register registration auth authn authenticate " +
    "authentication authorize authorization oauth oauth2 saml saml2 sso oidc openid connect account accounts " +
    "session sessions password passwords passwd pwd identifier identity id challenge challenges verify " +
    "verification mfa 2fa two factor otp totp passkey passkeys webauthn fido fido2 consent lookup flow flows " +
    "recover recovery reset forgot magic link callback redirect continue select selection chooser choose " +
    "accountchooser servicelogin u i api app web gsi ui s user users me new start begin step email phone code " +
    "secure security common organizations consumers interaction default oauth2callback v2.0"
  ).split(" "),
)

function isAuthSegment(seg: string): boolean {
  if (AUTH_WORDS.has(seg)) return true
  const words = seg.split(/[-_.]/).filter(Boolean)
  return words.length > 0 && words.every((w) => AUTH_WORDS.has(w) || /^v\d{1,2}$/.test(w))
}

/** Plausibly-personal or generated strings: emails, long numbers, hashes, UUIDs. */
function looksPersonalOrGenerated(value: string): boolean {
  return (
    value.includes("@") ||
    /\d{4,}/.test(value) ||
    /[0-9a-f]{10,}/i.test(value) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ||
    /^:r[0-9a-z]+:$/i.test(value) || // React useId
    /^(ember|ext-gen|mui-|radix-|headlessui-)/i.test(value) // generated ids
  )
}

/** Returns an attribute value safe to keep, or undefined. */
export function safeToken(value: string | null | undefined, max = 64): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  if (/\s/.test(trimmed)) return undefined
  if (looksPersonalOrGenerated(trimmed)) return undefined
  return trimmed
}

const SELECTOR_ATTRS = new Set(["data-testid", "data-test", "data-qa", "name", "autocomplete", "aria-label", "type"])
const SELECTOR_PART = /^(?:#((?:[A-Za-z0-9_-]|\\.)+)|([a-z][a-z0-9-]*)(?:\[([a-z-]+)="([^"\\]*)"\]|:nth-of-type\((\d{1,3})\))?)$/

/**
 * True only for selectors in the exact grammar `selectorFor` produces, with
 * every embedded value passing `safeToken`. Used to vet imported files.
 */
export function isSafeSelector(selector: string): boolean {
  if (selector.length > 300) return false
  return selector.split(" > ").every((part) => {
    const m = SELECTOR_PART.exec(part)
    if (!m) return false
    const [, id, , attr, value] = m
    if (id !== undefined) return safeToken(id.replace(/\\(.)/g, "$1")) !== undefined
    if (attr !== undefined) return SELECTOR_ATTRS.has(attr) && safeToken(value, 48) !== undefined
    return true
  })
}

/**
 * Path template that keeps auth vocabulary and drops everything else, so a
 * profile slug, tenant name or token in the path never reaches the dataset.
 */
export function templatePath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean)
  const kept = parts.map((raw) => {
    let seg = raw
    try {
      seg = decodeURIComponent(raw)
    } catch {}
    seg = seg.toLowerCase()
    if (seg.length > 40 || looksPersonalOrGenerated(seg)) return "*"
    if (/^[a-z]{2}-[a-z]{2}$/.test(seg)) return seg // locale like en-us
    if (/^v\d{1,2}$/.test(seg)) return seg
    return isAuthSegment(seg) ? seg : "*"
  })
  return "/" + kept.join("/")
}

// Shared multi-tenant hosts where the subdomain is an organisation name.
const TENANT_PARENTS = [
  "okta.com",
  "oktapreview.com",
  "okta-emea.com",
  "auth0.com",
  "onelogin.com",
  "slack.com",
  "atlassian.net",
  "zendesk.com",
  "my.salesforce.com",
  "b2clogin.com",
  "awsapps.com",
  "cloudflareaccess.com",
  "jumpcloud.com",
  "duosecurity.com",
  "pingone.com",
  "workos.com",
  "clerk.accounts.dev",
  // Hosting platforms where the subdomain is often a username or project name.
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "firebaseapp.com",
  "web.app",
  "azurewebsites.net",
  "appspot.com",
  "fly.dev",
  "onrender.com",
  "replit.app",
]

const HOSTNAME = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/

/** True for strings shaped like a hostname (or a masked `*.parent`). */
export function isHostname(value: string): boolean {
  return value.length <= 253 && HOSTNAME.test(value)
}

/** Hostname with tenant subdomains on shared IdPs replaced by `*`. */
export function safeHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (!isHostname(host)) return "*"
  for (const parent of TENANT_PARENTS) {
    if (host.endsWith("." + parent)) {
      const sub = host.slice(0, -parent.length - 1)
      // Keep well-known fixed subdomains (e.g. app.slack.com), mask the rest.
      if (/^(www|app|login|auth|accounts|api|sso)$/.test(sub)) return host
      return "*." + parent
    }
  }
  return host
}
