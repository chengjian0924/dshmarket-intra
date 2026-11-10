/**
 * Intranet mode: the market on a network that serves its own packages and
 * reaches nothing else.
 *
 * The market was built for the public internet. Every interesting thing it
 * does is a request to somebody else's host: the catalog from
 * awesome-dsh-plugin.com, README images and commit lookups from GitHub, the
 * changelog from the npm origin, comments from giscus, and — behind all of
 * it — pnpm fetching every plugin from a registry. A bank or a factory floor
 * deployment has an internal npm registry and a file share, and none of
 * those hosts.
 *
 * Left alone on such a network, the market does not fail: it hangs. Each
 * public request runs out a 15-second header budget, twice per catalog
 * source, and the page a user sees is a spinner followed by a message about
 * a host they have never heard of. That is the failure this module removes —
 * it turns "unreachable" into "not available on this network", immediately,
 * with the reason.
 *
 * The switch is opt-in (`offline: true` in the profile) because the answer
 * to "is this host reachable" is the operator's to give, not something to
 * infer: a laptop behind a corporate forward proxy has no internet either
 * and works fine, while an air-gapped network would rather be told.
 *
 * What it does NOT do is disable installation. An intranet deployment
 * installs plugins all day — from its own registry, which is the one host
 * `npmRegistry` already names. So this is a denylist of the public hosts the
 * market itself knows how to talk to, not an allowlist of everything else:
 * a registry, a catalog server, or a WebDAV box on the intranet has a
 * hostname nobody here could have predicted.
 */

/**
 * Hosts (and every subdomain of them) that belong to the public internet.
 *
 * Only hosts this market actually requests, each one named for a reason:
 *
 * - GitHub: `raw` (README images, installed-plugin package.json reads),
 *   `api` (release manifests), `codeload` (git archives), `avatars`, and the
 *   `githubusercontent.com` CDN the raw and camo images come from.
 * - npm's two public registries, which are what the region table falls back
 *   to when no `npmRegistry:` is configured.
 * - The catalog's two homes, the community proxies the China region uses,
 *   jsDelivr (the index source the host's own Discover page is told about),
 *   and giscus — the comment iframe.
 *
 * gitlab.com and bitbucket.org are here for the same reason as GitHub: a
 * `gitlab:` spec in a catalog is a plugin that cannot be installed on this
 * network, and finding that out in one second beats finding it out in
 * fifteen minutes.
 */
const PUBLIC_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'gist.github.com',
  'githubusercontent.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'avatars.githubusercontent.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  'registry.npmmirror.com',
  'cdn.npmmirror.com',
  'mirrors.cloud.tencent.com',
  'awesome-dsh-plugin.com',
  'dshmarket.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'giscus.app',
  'gh-proxy.com',
  'ghfast.top',
  'gitlab.com',
  'bitbucket.org',
]

/** Hosts the operator named themselves; always reachable in this mode. */
let named: string[] = []

let enabled = false

/**
 * The error a blocked request throws.
 *
 * A distinct class rather than an `Error` with a marker: callers that
 * classify failures (the catalog's per-source report, pnpm failure
 * classification, the update checker's per-plugin result) can tell "this
 * network does not have that host" from "that host is broken", and say the
 * first thing instead of offering a retry that cannot work.
 */
export class OfflineHostError extends Error {
  readonly host: string
  constructor(host: string, url: string) {
    super(`offline mode: ${host} is not reachable on this network (${url}) · 内网离线模式：无法访问 ${host}`)
    this.name = 'OfflineHostError'
    this.host = host
  }
}

/** The hostname a URL names, lowercased, or null when it is not a URL. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  } catch {
    return null
  }
}

/**
 * Turn the offline switch on or off, and name the hosts it must let through.
 *
 * `hosts` are the ones the composition points at — the npm registry and the
 * catalog — because a deployment that mirrors npm INSIDE its own network is
 * entitled to serve it from `npm.internal.example.com`, and a deployment
 * that mirrors it at a name that happens to be in the denylist above is
 * still the operator's own choice. Named hosts win over the denylist.
 */
export function setOfflineMode(value: unknown, hosts: readonly string[] = []): void {
  enabled = value === true
  named = hosts
    .map(host => host.trim().toLowerCase())
    .filter(host => host !== '')
}

/** Whether this process is running in intranet mode. */
export function offlineMode(): boolean {
  return enabled
}

/**
 * Whether a request to `url` may leave this process.
 *
 * True when offline mode is off, when the URL is not an http(s) address at
 * all (a `file:` catalog, an internal handle), or when its host is one of the
 * named ones. False only for the public hosts above.
 */
export function offlineReachable(url: string): boolean {
  if (!enabled) return true
  const host = hostOf(url)
  if (host === null) return true
  if (named.some(name => host === name || host.endsWith(`.${name}`))) return true
  return !PUBLIC_HOSTS.some(public_ => host === public_ || host.endsWith(`.${public_}`))
}

/**
 * The host a request is blocked for, or null when it is allowed.
 *
 * Exposed beside {@link offlineReachable} so a caller can put the host in its
 * own message — "github.com is not reachable" reads as a network fact, which
 * is what it is.
 */
export function offlineBlockedHost(url: string): string | null {
  return offlineReachable(url) ? null : hostOf(url)
}

/**
 * Refuse a request that cannot leave this network, before it is attempted.
 *
 * @throws {OfflineHostError} when offline mode is on and the host is public.
 */
export function assertOfflineReachable(url: string): void {
  const host = offlineBlockedHost(url)
  if (host !== null) throw new OfflineHostError(host, url)
}
