import { getDomain } from "tldts"
import type { Provider } from "./types"

/**
 * Registrable domain from the full Public Suffix List, private section included,
 * so alice.github.io and bob.github.io (or two blogspot blogs) are different
 * sites. That matters for autofill: credentials are offered per registrable domain.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "")
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost" || !host.includes(".")) return host
  return getDomain(host, { allowPrivateDomains: true }) ?? host
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
