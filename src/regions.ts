/**
 * Download regions: which route the market's own network requests take.
 *
 * Almost every external request the market makes lands on npm's registry or
 * on GitHub — the plugin catalog, update checks, package downloads, author
 * avatars, README screenshots. From mainland China several of those can be
 * slow, which is why this is ONE setting rather than a
 * row of them: "npm mirror", "GitHub proxy" and "image proxy" are three
 * spellings of a single question the user is actually being asked, which is
 * where they are.
 *
 * The routing table is the single source of truth. Every consumer asks it
 * rather than reaching for a hardcoded host, so adding a region is a table
 * entry instead of a search across six modules.
 *
 * Each route has an environment escape hatch, following `DSHM_REGISTRY_URL`
 * (src/registry.ts). The China route has service-specific public-proxy
 * fallbacks; those come and go, and a user whose routes have died needs a way
 * out that is not "wait for the next release".
 *
 * Two things here are the intranet deployment rather than the internet one:
 * an operator-named registry (`setConfiguredNpmRegistry`) and an
 * operator-named catalog (`setConfiguredCatalog`). Both exist because the
 * region table's own answers are, by construction, public hosts — and a
 * network that has none of them cannot be served by a table it cannot edit.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { offlineMode, offlineReachable } from './offline.ts'

/** A region the market can download from. */
export type Region = 'global' | 'china'

/** Every region a user may pick. */
export const REGIONS: readonly Region[] = ['global', 'china']

/** Narrow an untrusted value to a Region, or null. */
export function asRegion(value: unknown): Region | null {
  return value === 'global' || value === 'china' ? value : null
}

/**
 * The npm registry the market and pnpm read, no trailing slash.
 *
 * Exported because callers need to tell "this region uses the default" from
 * "this region names a mirror" — the difference between leaving a spawned
 * pnpm's registry alone and setting it.
 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'
/**
 * The registry an intranet deployment serves plugins from, no trailing slash.
 *
 * This is the address the offline bundle's own registry listens on
 * (`Start-offline-registry.cmd` in the Windows bundle, `serve.mjs` in the
 * bundle's root). It is a DEFAULT, not a policy: it
 * only applies in intranet mode and only when nothing else named a registry,
 * and it is loopback, so a wrong guess costs one refused connection on this
 * machine rather than a request leaving the network.
 *
 * Without it, `offline: true` alone would leave the market pointed at
 * registry.npmjs.org — blocked by the fence, so the market would boot with no
 * catalog and no way to install anything, while the machine running it hosts
 * a registry one configuration line away. The failure would be correct and
 * useless; naming the conventional address makes the switch alone enough for
 * the deployment this mode exists for.
 */
export const OFFLINE_DEFAULT_REGISTRY = 'http://127.0.0.1:4873'
/**
 * Default npm registry for the China download region, no trailing slash.
 *
 * Exported so failure classifiers can recognize this host in pnpm's output
 * (#926) without duplicating the URL.
 */
export const CHINA_NPM_REGISTRY = 'https://mirrors.cloud.tencent.com/npm'
const NPM_CHINA = CHINA_NPM_REGISTRY
/**
 * Second China npm mirror, used only as a catalog fallback (#1051), no
 * trailing slash.
 *
 * The catalog list named the Tencent mirror and the origin and nothing else,
 * so a network that blocks or outranks one of them lost both: a corporate
 * egress proxy refusing that host (measured: HTTP 522/525) left GitHub Pages
 * as the only way to the catalog, and on the China line that host is the one
 * that has to be reachable. The catalog package is published to npm proper,
 * and this mirror carries it, so naming it costs one request only when the
 * first mirror has already failed.
 */
const CHINA_NPM_FALLBACK = 'https://registry.npmmirror.com'

/**
 * First public prefix used for unauthenticated GitHub reads, no trailing slash.
 * Authenticated API calls and canonical codeload tarballs never use it.
 *
 * What this proxy accepts is a list of GitHub SERVICES, not a hostname test.
 * The previous note here said it "refuses anything that is not a github.com
 * hostname", which #460 by @Homplex measured as wrong in both directions —
 * re-measured 2026-09-01:
 *
 *   https://raw.githubusercontent.com/…   200   ← not a github.com hostname
 *   https://github.com/owner/repo         403   ← is one
 *   https://example.com/                  403
 *
 * So a plain repository page is refused while raw content is served. Do not
 * reason about this proxy from the hostname; check the specific service, and
 * re-measure rather than infer, because the policy is the operator's and can
 * change under us. That fragility is the substance of #460's actual request
 * (a mirror list and a visible setting), which is tracked separately.
 */
const GITHUB_PROXY_CHINA = 'https://gh-proxy.com'
const GITHUB_PROXY_CHINA_FALLBACK = 'https://ghfast.top'

/** GitHub transports that fail independently on filtered networks. */
export type GithubService = 'git' | 'raw' | 'avatar'

/** A prefix proxy, or null for the canonical GitHub address. */
export type GithubRoute = string | null

/** Ordered candidates per GitHub service. */
export type GithubRoutes = Record<GithubService, GithubRoute[]>

/**
 * The catalog's stable public address.
 *
 * A custom domain rather than the repository path, deliberately: it survives
 * the repo being renamed or moved, and Pages puts a CDN in front of it.
 */
const CATALOG_OFFICIAL = 'https://awesome-dsh-plugin.com/plugins.json'

/**
 * One place the catalog can be read from.
 *
 * Two kinds because the two routes are genuinely different transports, not
 * two URLs. The npm route reads a published package — which is what lets the
 * catalog ride the same mirror as everything else, and gives it a version
 * number that can be rolled back when a bad build ships.
 */
export type CatalogSource =
  | { kind: 'url'; url: string }
  | { kind: 'npm'; registry: string; pkg: string }
  /**
   * A catalog file on this machine — the air-gapped answer.
   *
   * An intranet that serves no HTTP at all still has a file share, and a
   * deployment that would rather not run a web server for one JSON document
   * can drop `plugins.json` next to the profile and name it here. Read on
   * every load, like the networked sources: a stale allowance is worse than
   * a missing one, because it silently withdraws plugins the operator
   * published this morning.
   */
  | { kind: 'file'; path: string }
  /**
   * The registry itself, read as a listing.
   *
   * An intranet registry is already the authoritative list of what its
   * network can install: publishing a plugin there IS the act of making it
   * available. Reading a separate document alongside it means the document
   * has to be kept in step by hand, and it goes stale exactly when someone
   * publishes without remembering to. See `src/catalog-registry.ts`.
   *
   * `names` is the operator's own statement of which packages are plugins,
   * and it turns the `dsh`-field filter off: a source that was told what it
   * holds should not second-guess the answer.
   */
  | { kind: 'registry'; registry: string; names: string[] | null }

/** Where one region sends each kind of request. `null` means "go direct". */
export interface RegionRoutes {
  /** npm registry base, no trailing slash. */
  npmRegistry: string
  /** Prefix proxy for github.com-family URLs, or null to go direct. */
  githubProxy: string | null
  /** Ordered routes per service; every list ends in a direct escape path. */
  githubRoutes: GithubRoutes
  /**
   * Where to look for the catalog, in order. Later entries are fallbacks.
   *
   * The catalog is the FIRST request the market makes, so a mirror that has
   * gone down must mean a slow market rather than an empty one — every
   * region ends its list at an address that has always worked.
   */
  catalog: CatalogSource[]
}

/**
 * The npm package carrying `plugins.json`.
 *
 * A package rather than a file URL, because the catalog's own host is the
 * problem being solved: it is served from GitHub Pages, and the public
 * GitHub proxies refuse hostnames that are not github.com's own. Published
 * to npm, it reaches mainland China through the same mirror as every plugin
 * — no extra service to depend on, and nothing new that can go down.
 *
 * Its own package rather than a file added to `awesome-dsh-plugin`: npm
 * force-includes README files whatever the `files` field says, and that
 * package's two generated READMEs come to ~1MB. Attaching the catalog to it
 * would have spent on the wire exactly what this exists to save (measured:
 * 772KB attached, 413KB standing alone — the latter matching the gzipped
 * origin almost exactly).
 */
const CATALOG_PACKAGE = 'dsh-plugin-catalog'

const ROUTES: Record<Region, RegionRoutes> = {
  global: {
    npmRegistry: DEFAULT_NPM_REGISTRY,
    githubProxy: null,
    githubRoutes: { git: [null], raw: [null], avatar: [null] },
    catalog: [{ kind: 'url', url: CATALOG_OFFICIAL }],
  },
  china: {
    npmRegistry: NPM_CHINA,
    githubProxy: GITHUB_PROXY_CHINA,
    // Filtering is service-shaped, not GitHub-shaped. Raw content commonly
    // needs help while git advertisements and avatars remain reachable, so
    // putting one global order on all three only trades one outage for
    // needless proxy traffic on the paths that still work.
    githubRoutes: {
      raw: [GITHUB_PROXY_CHINA, GITHUB_PROXY_CHINA_FALLBACK, null],
      git: [null, GITHUB_PROXY_CHINA, GITHUB_PROXY_CHINA_FALLBACK],
      avatar: [null, GITHUB_PROXY_CHINA, GITHUB_PROXY_CHINA_FALLBACK],
    },
    // The package, then the origin. There is deliberately no
    // raw.githubusercontent step between them: `plugins.json` is a build
    // artifact that the site publishes to Pages and never commits, so that
    // path is a guaranteed 404 and would only spend two attempts proving it.
    catalog: [
      { kind: 'npm', registry: NPM_CHINA, pkg: CATALOG_PACKAGE },
      { kind: 'url', url: CATALOG_OFFICIAL },
    ],
  },
}

/**
 * Every catalog source worth trying for a region: its own list, plus the
 * catalog's published package on that region's own registry when the list
 * does not already name it.
 *
 * The catalog hangs off a SECOND, independently blockable host (#891), and
 * the probe that picks a region measures only the npm registry. A network
 * where npm answers fast and GitHub Pages is blocked therefore measures
 * `global` — whose one source is that very host — and since the region is
 * decided once and persisted, nothing ever reconsiders: "catalog fetch
 * failed" forever, on a machine whose registry is serving the catalog as a
 * package all along.
 *
 * Appending the package closes that blind spot without asking the probe to
 * learn about the second host, without revisiting the decision, and without
 * sending anyone to another region's mirror: it rides the registry the probe
 * already proved reachable. Last, not first — for everyone the official
 * domain serves, this stays a source that is never contacted.
 */
export function catalogSourcesFor(region: Region): CatalogSource[] {
  const routes = routesFor(region)
  const sources = [...routes.catalog]
  // Intranet mode: no source list may grow a fallback that is a public host.
  // Every addition below is one — a filed public origin, npm's own registry,
  // a second China mirror — and each would be attempted before it could
  // report the only fact worth reporting, which is that the operator's own
  // catalog did not answer. A `file:` source is kept: it is the one kind that
  // cannot be unreachable.
  if (offlineMode()) {
    return sources.filter(source => source.kind !== 'url' || offlineReachable(source.url))
  }
  const served = sources.some(source => source.kind === 'npm'
    && source.registry === routes.npmRegistry && source.pkg === CATALOG_PACKAGE)
  if (!served) sources.push({ kind: 'npm', registry: routes.npmRegistry, pkg: CATALOG_PACKAGE })
  // A second China mirror, before the origin (#1051). The list named one
  // mirror, so a corporate proxy or a 522/525 window on it left the origin —
  // the host the China line exists to avoid — as the only way to the catalog.
  // Only while the region's own registry is the default one: a run pointed at
  // a registry the operator chose must not fall back to a public mirror that
  // is not on their network.
  if (region === 'china' && routes.npmRegistry === CHINA_NPM_REGISTRY
    && !sources.some(source => source.kind === 'npm' && source.registry === CHINA_NPM_FALLBACK)) {
    const fallback: CatalogSource = { kind: 'npm', registry: CHINA_NPM_FALLBACK, pkg: CATALOG_PACKAGE }
    const origin = sources.findIndex(source => source.kind === 'url')
    if (origin < 0) sources.push(fallback)
    else sources.splice(origin, 0, fallback)
  }
  return sources
}

/** Read an environment override, treating blank as unset. */
function override(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]
  return raw !== undefined && raw.trim() !== '' ? raw.trim().replace(/\/+$/, '') : null
}

/**
 * Normalize an npm registry the operator named, or reject it.
 *
 * Everything else in this module is built by appending to this base —
 * `/pkg/latest`, `/pkg/-/pkg-1.0.0.tgz`, the catalog package — so a value that
 * is not a plain base URL produces addresses that cannot be formed at all.
 * Credentials, a query or a fragment are refused for the same reason the
 * GitHub proxy refuses them: the result is persisted and shown back, and a
 * token has no business in either.
 *
 * HTTP is allowed on purpose. An internal registry on a trusted network is
 * routinely plain HTTP (`http://127.0.0.1:4873` is Verdaccio's default), and
 * demanding TLS here would rule out the one deployment this setting exists
 * for while protecting nothing on a network that already trusted the hop.
 */
export function normalizeNpmRegistry(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '' || raw.includes('\\')) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (parsed.username !== '' || parsed.password !== '') return null
    if (parsed.search !== '' || parsed.hash !== '') return null
    const path = parsed.pathname.replace(/\/+$/u, '')
    return `${parsed.origin}${path}`
  } catch {
    return null
  }
}

/**
 * The registry the composition named, or null for the region's own table.
 *
 * Module state for the same reason `activeRegion` is: every consumer asks
 * `routesFor`, several frames deep, and threading one more parameter through
 * the catalog, the update checker and every pnpm spawn would buy nothing.
 */
let configuredRegistry: string | null = null

/**
 * Point every route at an operator-named npm registry, or clear it.
 *
 * This is the composition's `npmRegistry:` option, and it exists because an
 * internal network has no use for the public table: the global entry is npm
 * itself and the China entry is a public mirror, so neither is reachable and
 * neither can be edited from where the operator sits. `DSHM_NPM_MIRROR` still
 * wins over this, being the escape hatch someone reaches for when the profile
 * file is the thing they cannot edit right now.
 *
 * An unparseable value is dropped rather than thrown: a typo must not stop the
 * market from booting, and the region table is exactly the sane fallback.
 */
export function setConfiguredNpmRegistry(value: unknown): void {
  configuredRegistry = normalizeNpmRegistry(value)
}

/**
 * The catalog the composition named, or null for the region's own list.
 *
 * Beside `configuredRegistry` and for the same reason: every reader asks
 * `routesFor`, and a deployment that has no use for the public catalog has to
 * be able to say so once.
 */
let configuredCatalog: CatalogSource | null = null

/**
 * The plugin names the composition named, or null to ask the registry.
 *
 * Only consulted when a catalog is being read out of a registry: everywhere
 * else the catalog document already states what it holds.
 */
let configuredPlugins: string[] | null = null

/**
 * Name the packages that ARE plugins, for a registry read as a catalog.
 *
 * The registry cannot tell a plugin from a library — both are packages. The
 * `dsh` field does that job for every plugin published today, and this
 * option exists for the deployment whose plugins predate it, or whose
 * packaging pipeline strips it. Stating the list also states the ORDER, and
 * an empty list is treated as "no statement" rather than "no plugins",
 * because an empty option is much more likely to be an unfinished edit than
 * a request for an empty market.
 */
export function setConfiguredPlugins(value: unknown): void {
  if (!Array.isArray(value)) {
    configuredPlugins = null
    return
  }
  const names = value
    .filter((name): name is string => typeof name === 'string')
    .map(name => name.trim())
    .filter(name => name !== '')
  configuredPlugins = names.length === 0 ? null : names
}

/**
 * Read a catalog location the operator named: an http(s) URL, or a file path.
 *
 * One option rather than two, because the two are the same decision — "the
 * catalog is here" — and an operator who has to choose between `catalogUrl:`
 * and `catalogFile:` is being asked which transport their own network has,
 * which they know and the schema should not require them to spell.
 *
 * A file path is resolved against the process's working directory, and is
 * normalized rather than checked: the file may legitimately appear after
 * boot (an ops job drops it), and refusing the whole mount over a typo in a
 * path would take the market down instead of reporting one failed source.
 */
export function normalizeCatalogSource(value: unknown): CatalogSource | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '' || raw.includes('\0')) return null
  if (/^https?:\/\//iu.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (parsed.username !== '' || parsed.password !== '') return null
      if (parsed.search !== '' || parsed.hash !== '') return null
      return { kind: 'url', url: parsed.toString() }
    } catch {
      return null
    }
  }
  // Anything else is a path. `file://` is accepted because that is how the
  // same location is written everywhere else an operator meets a URL, and
  // being refused for the spelling would be a puzzle rather than a message.
  if (/^file:\/\//iu.test(raw)) {
    try {
      return { kind: 'file', path: fileURLToPath(raw) }
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) return null
  return { kind: 'file', path: resolve(raw) }
}

/**
 * Point the catalog at the operator's own location, or clear it.
 *
 * Takes either spelling — the raw value from the composition, or a source
 * that was already normalized (the mount validates once, so that a bad value
 * can be reported instead of silently disappearing).
 */
export function setConfiguredCatalog(value: CatalogSource | string | null): void {
  configuredCatalog = typeof value === 'string' ? normalizeCatalogSource(value) : value
}

/**
 * Normalize a user-maintained prefix, or reject it.
 *
 * Public mirrors receive the complete destination URL in their path. Only
 * HTTPS prefixes without embedded credentials or query fragments are safe to
 * persist and show again in the settings UI.
 */
export function normalizeGithubProxy(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw === '' || raw.includes('\\')) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null
    if (parsed.search !== '' || parsed.hash !== '') return null
    const path = parsed.pathname.replace(/\/+$/u, '')
    return `${parsed.origin}${path}`
  } catch {
    return null
  }
}

let customGithubProxy: string | null = null
const preferredGithubRoutes = new Map<GithubService, GithubRoute>()

/** Apply (or clear) the persisted UI escape route. */
export function setCustomGithubProxy(proxy: string | null): void {
  const next = proxy === null ? null : normalizeGithubProxy(proxy)
  if (next === customGithubProxy) return
  customGithubProxy = next
  resetGithubRoutePreferences()
}

/** Whether the operator-owned environment variable disables UI changes. */
export function githubProxyManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return override(env, 'DSHM_GITHUB_PROXY') !== null
}

/** Remember one verified route without changing other GitHub services. */
export function rememberGithubRoute(service: GithubService, route: GithubRoute): void {
  preferredGithubRoutes.set(service, route)
}

/** Forget learned winners after the configured candidates change. */
export function resetGithubRoutePreferences(): void {
  preferredGithubRoutes.clear()
}

/**
 * Put a user's own prefix in front, and keep the region's other routes (#850).
 *
 * Heading rather than replacing, because a public proxy dying is the whole
 * reason the setting exists — the reporter's was one of these mirrors, and it
 * took the rest of the chain with it: `gh-proxy.com` stopped serving on
 * 2026-10-13, and every GitHub-sourced update then failed on a timeout rather
 * than trying the next candidate. Replacing the list buys one attempt per
 * mirror outage; heading it buys one, and then the chain that was already
 * measured to work.
 *
 * The proxy is also dropped from the tail if it is already there, so a user
 * who accepted the value the settings UI pre-suggests gets exactly the
 * region's own table back rather than the same prefix twice.
 *
 * The direct escape is never dropped: `githubRoutes` promises every list ends
 * in one, and dropping it would turn a dead mirror into an outage instead of
 * a slow request.
 */
function withCustomProxy(proxy: string, base: GithubRoute[]): GithubRoute[] {
  return [proxy, ...base.filter(route => route !== proxy)]
}

/**
 * The routes for a region, with environment overrides applied.
 *
 * Overrides win over the table because they are the user's statement about
 * their own network, and they are the way out when a public proxy dies.
 *
 * `DSHM_REGISTRY_URL` keeps its existing meaning — the catalog URL — and
 * when set it REPLACES the source list rather than heading it: someone
 * pointing the market at their own catalog does not want it quietly
 * reverting to ours.
 */
export function routesFor(region: Region, env: NodeJS.ProcessEnv = process.env): RegionRoutes {
  const base = ROUTES[region]
  const npmMirror = override(env, 'DSHM_NPM_MIRROR')
  const githubProxy = override(env, 'DSHM_GITHUB_PROXY') ?? customGithubProxy
  const catalog = override(env, 'DSHM_REGISTRY_URL')
  const offline = offlineMode()
  // In intranet mode an unnamed registry is the address the offline bundle
  // listens on, not npm's: the public one is blocked by the fence, so falling
  // back to it guarantees a market with nothing in it. Everything that names
  // a registry still wins (env, then the composition).
  const registry = npmMirror ?? configuredRegistry ?? (offline ? OFFLINE_DEFAULT_REGISTRY : base.npmRegistry)
  const githubRoutes: GithubRoutes = githubProxy === null
    ? {
        git: [...base.githubRoutes.git],
        raw: [...base.githubRoutes.raw],
        avatar: [...base.githubRoutes.avatar],
      }
    : {
        git: withCustomProxy(githubProxy, base.githubRoutes.git),
        raw: withCustomProxy(githubProxy, base.githubRoutes.raw),
        avatar: withCustomProxy(githubProxy, base.githubRoutes.avatar),
      }
  return {
    npmRegistry: registry,
    // No GitHub route survives intranet mode. It is not a preference: every
    // candidate in every list is a public host, so an empty list is the
    // honest answer, and it is also the one that keeps a caller from
    // reporting "all routes failed" for a network where no route exists.
    githubProxy: offline ? null : githubProxy ?? base.githubProxy,
    githubRoutes: offline ? { git: [], raw: [], avatar: [] } : githubRoutes,
    // A named catalog REPLACES the list rather than joining it. Someone
    // pointing the market at their own catalog does not want it quietly
    // reverting to ours when theirs is briefly unreachable — that is how a
    // fixture-backed test ends up asserting against the live registry.
    catalog: catalog !== null
      ? [{ kind: 'url', url: catalog }]
      // The operator's own location, for exactly the same reason and with the
      // same finality: it is the only source, because falling back to the
      // public catalog is the timeout offline mode exists to remove.
      : configuredCatalog !== null
        ? [configuredCatalog]
        // Intranet mode with no catalog stated: the registry IS the listing.
        // This is the answer that needs no second document to maintain —
        // whatever has been published is what the market shows, version and
        // description included, because they are read from the packages
        // themselves rather than from a file describing them.
        : offline
          ? [{ kind: 'registry', registry, names: configuredPlugins }]
          // Rebuilt against the resolved registry, so an npm override moves
          // the catalog to the same mirror it moved everything else to.
          : catalogForRegistry(base.catalog, registry, npmMirror === null && configuredRegistry !== null),
  }
}

/**
 * The catalog list for a registry.
 *
 * `preferPackage` puts the registry's own copy of the catalog in FRONT, and it
 * is only true for a registry the composition named. The difference is what
 * the two mechanisms mean: `DSHM_NPM_MIRROR` is the escape hatch someone
 * reaches for when a public host is slow or down, on a machine that still has
 * the origin — for them the origin stays first, as it always has (#891). A
 * registry in the composition says something stronger, that THIS network
 * serves packages and the public hosts are not on it, so a first request to
 * `awesome-dsh-plugin.com` can only time out before the source that answers.
 * Same routing either way; only the order of the first request changes.
 *
 * The table is left alone when the registry is the default one: the public
 * list was written for exactly that case.
 */
function catalogForRegistry(base: CatalogSource[], registry: string, preferPackage: boolean): CatalogSource[] {
  const mapped = base.map(source => (source.kind === 'npm' ? { ...source, registry } : source))
  if (registry === DEFAULT_NPM_REGISTRY) return mapped
  if (mapped.some(source => source.kind === 'npm' && source.registry === registry)) return mapped
  return preferPackage ? [{ kind: 'npm', registry, pkg: CATALOG_PACKAGE }, ...mapped] : mapped
}

/** Ordered candidates with this process's last verified winner first. */
export function githubRoutesFor(
  service: GithubService,
  region: Region = activeRegion(),
  env: NodeJS.ProcessEnv = process.env,
): GithubRoute[] {
  const routes = routesFor(region, env).githubRoutes[service]
  if (!preferredGithubRoutes.has(service)) return routes
  const preferred = preferredGithubRoutes.get(service)!
  const index = routes.findIndex(route => route === preferred)
  if (index <= 0) return routes
  return [routes[index]!, ...routes.slice(0, index), ...routes.slice(index + 1)]
}

/**
 * The region this process is running under.
 *
 * One piece of module state rather than a parameter threaded through the
 * catalog, the theme manager, update checks and every pnpm spawn: the region
 * is a property of the running market, not of any single question asked of
 * it, and the call graphs that need it are several frames deep.
 *
 * Consumers that must react to a CHANGE (dropping a cache gathered from the
 * other registry) keep their own setter beside this one; this holds the
 * answer for everyone who only needs to read it.
 */
let active: Region = 'global'

/** The region in force. */
export function activeRegion(): Region {
  return active
}

/** Set the region in force. Callers are responsible for their own caches. */
export function setActiveRegion(region: Region): void {
  active = region
}

/**
 * Wrap a github.com-family URL in a prefix proxy.
 *
 * The proxy takes the full absolute URL as its path (`{proxy}/{url}`) rather
 * than a rewritten hostname, so the same joining rule works for every
 * GitHub service a caller has explicitly allowed through public routes.
 *
 * @param proxy - the prefix, or null to go direct.
 * @param url - an absolute https URL on a github.com-family host.
 * @returns the proxied URL, or `url` unchanged when there is no proxy.
 */
export function throughProxy(proxy: string | null, url: string): string {
  return proxy === null ? url : `${proxy}/${url}`
}
