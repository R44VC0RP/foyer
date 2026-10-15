import type { Provider } from "./types"

// Small public-suffix subset. Good enough to group login.example.co.uk with
// example.co.uk without shipping the whole PSL.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp",
  "co.kr", "or.kr",
  "com.br", "com.mx", "com.ar", "com.co",
  "co.in", "net.in", "org.in",
  "com.cn", "com.hk", "com.tw", "com.sg", "com.my",
  "co.za", "co.il", "com.tr",
  "github.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "herokuapp.com", "firebaseapp.com", "web.app", "azurewebsites.net",
  "cloudfront.net", "appspot.com",
])

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "")
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost" || !host.includes(".")) return host
  const labels = host.split(".")
  const lastTwo = labels.slice(-2).join(".")
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".")
  return lastTwo
}

// Hosts that act as identity providers. A login flow that hops onto one of
// these stays attributed to the site that started it.
const IDP_HOSTS: Array<[RegExp, Provider]> = [
  [/^accounts\.google\.com$/, "google"],
  [/^appleid\.apple\.com$/, "apple"],
  [/^idmsa\.apple\.com$/, "apple"],
  [/^login\.microsoftonline\.com$/, "microsoft"],
  [/^login\.live\.com$/, "microsoft"],
  [/^login\.windows\.net$/, "microsoft"],
  [/(^|\.)b2clogin\.com$/, "microsoft"],
  [/^github\.com$/, "github"],
  [/^(www|m)\.facebook\.com$/, "facebook"],
  [/^(api\.)?(twitter|x)\.com$/, "x"],
  [/^(www\.)?linkedin\.com$/, "linkedin"],
  [/^gitlab\.com$/, "gitlab"],
  [/^slack\.com$/, "slack"],
  [/^discord\.com$/, "discord"],
  [/^(www\.)?amazon\.com$/, "amazon"],
  [/(^|\.)okta(preview|-emea)?\.com$/, "okta"],
  [/(^|\.)(auth0|onelogin|jumpcloud|pingone|duosecurity|workos)\.com$/, "sso"],
  [/(^|\.)awsapps\.com$/, "sso"],
  [/(^|\.)cloudflareaccess\.com$/, "sso"],
]

export function idpForHost(hostname: string): Provider | undefined {
  const host = hostname.toLowerCase()
  for (const [pattern, provider] of IDP_HOSTS) if (pattern.test(host)) return provider
  return undefined
}

/** IdP hosts whose own pages always count as part of someone else's flow. */
export function isDedicatedIdpHost(hostname: string): boolean {
  const provider = idpForHost(hostname)
  // github.com, facebook.com etc. are also normal sites; only treat them as an
  // IdP hop when a flow is already in progress (handled by the background).
  return provider !== undefined && !/^(github|www\.facebook|m\.facebook|twitter|x|api\.twitter|api\.x|www\.linkedin|linkedin|gitlab|slack|discord|www\.amazon|amazon)\.com$/.test(hostname)
}
