/**
 * A catalog built from what an npm registry actually holds.
 *
 * Every other catalog source in this market is a document somebody wrote:
 * the curated list, a catalog package, a file on the operator's machine. All
 * three have the same weakness in an intranet deployment — the catalog is a
 * second thing to keep in step with the registry, and it goes stale the
 * moment someone publishes a plugin without also editing it. The user then
 * sees a market that lists a plugin the registry no longer has, or does not
 * list one it just received.
 *
 * An intranet registry is already the authoritative list: it is where the
 * packages were uploaded. So this reads the registry itself. Two steps:
 *
 * 1. Ask the registry which packages it has. `/ -/v1/search` and `/-/all` are
 *    the npm-standard endpoints; a read-only snapshot that implements
 *    neither can still answer `/-/ping` with its selection, which is the
 *    convention our own offline bundle uses.
 * 2. Read each package's own manifest and keep the ones that are DSH
 *    plugins. This is the step that makes the result usable: an intranet
 *    registry carries the plugins' DEPENDENCIES too — pnpm itself, the
 *    @babel/* tree, every transitive library — and listing those as
 *    installable plugins would bury thirteen entries under several hundred.
 *
 * The discriminator is the `dsh` field in package.json, which every plugin
 * carries and no ordinary library does (verified against all thirteen
 * packages in the Windows offline bundle: the field is present on each, and
 * on none of their dependencies). `keywords` alone is not enough — several
 * plugins ship `keywords: []`, so a keyword rule would silently hide them.
 *
 * Nothing here caches. The registry is asked on every load for the same
 * reason the file source is re-read: a plugin uploaded this morning is
 * exactly the case this source exists to show, and a cached listing would
 * report it as absent.
 */

import { fetchBodyWhileProgressing } from './body-progress.ts'
import { logEvent } from './log.ts'
import { marketFetch } from './net.ts'
import type { Registry, RegistryPlugin } from './registry.ts'

/** Per-request budget for one registry document. Loopback is fast; a slow answer is a failure. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * How many packages to read at once.
 *
 * A snapshot answering from local disk has no cost to speak of, but a shared
 * intranet registry does, and this runs on every catalog load. Six keeps a
 * thirteen-plugin source under one round trip while staying polite to a
 * registry that other people are also installing from.
 */
const CONCURRENCY = 6

/**
 * A ceiling on how many candidates to read.
 *
 * An intranet mirror that carries the whole public registry would otherwise
 * turn one catalog load into thousands of requests. The limit is high enough
 * that no real plugin set reaches it and low enough that a misconfigured
 * `npmRegistry` pointing at a full mirror fails in seconds rather than
 * minutes.
 */
const MAX_CANDIDATES = 400

/** One package's manifest, as much of it as a catalog entry needs. */
interface Manifest {
  name?: unknown
  version?: unknown
  description?: unknown
  keywords?: unknown
  dsh?: unknown
  repository?: unknown
  homepage?: unknown
  author?: unknown
}

/** A packument: the per-package document a registry serves at `/<name>`. */
interface Packument {
  name?: unknown
  'dist-tags'?: unknown
  versions?: unknown
  time?: unknown
}

/** The registry as a base URL with no trailing slash. */
function baseOf(registry: string): string {
  return registry.replace(/\/+$/u, '')
}

/** `@scope/name` as a path segment a registry accepts, slashes included. */
function packagePath(name: string): string {
  return encodeURIComponent(name).replace(/%2F/giu, '%2f')
}

async function readJson(url: string, what: string): Promise<unknown> {
  // The body reader is shared with the catalog fetch: it separates "slow"
  // from "stuck" by watching for bytes, which a fixed budget cannot do.
  const bytes = await fetchBodyWhileProgressing(marketFetch, url, what)
  const text = new TextDecoder().decode(bytes)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} is not JSON`)
  }
}

/**
 * Package names a registry says it has, in the order the endpoints name them.
 *
 * Three spellings because the endpoint that answers depends on what the
 * registry is. A full registry answers search; a Verdaccio answers `/-/all`;
 * the read-only snapshot this deployment ships answers `/-/ping` with its
 * selection. Trying all three in one pass is cheaper than a configuration
 * switch the operator would have to get right.
 */
async function discoverNames(registry: string): Promise<{ names: string[]; answered: string[] }> {
  const base = baseOf(registry)
  const names: string[] = []
  const seen = new Set<string>()
  const answered: string[] = []
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return
    const name = value.trim()
    if (name === '' || seen.has(name)) return
    seen.add(name)
    names.push(name)
  }

  const attempts: { path: string; pick: (body: unknown) => void }[] = [
    {
      // npm's own search API. `text=` empty asks for everything the registry
      // will admit to, which is what a private registry returns in full.
      path: '/-/v1/search?text=&size=250',
      pick: body => {
        const objects = (body as { objects?: unknown }).objects
        if (!Array.isArray(objects)) return
        for (const entry of objects) {
          add((entry as { package?: { name?: unknown } }).package?.name)
        }
      },
    },
    {
      // The pre-search spelling. Still what Verdaccio and Nexus answer, and
      // it is a plain name → document map, so the keys are the packages.
      path: '/-/all',
      pick: body => {
        const record = body as Record<string, unknown>
        for (const key of Object.keys(record)) {
          if (key.startsWith('_')) continue
          add(key)
        }
      },
    },
    {
      // A read-only snapshot's own selection list. `selection.plugins` is a
      // name → version map; the bare `plugins` array is the other spelling
      // an operator might have used.
      path: '/-/ping',
      pick: body => {
        const record = body as Record<string, unknown>
        const selection = record.selection as Record<string, unknown> | undefined
        const plugins = selection?.plugins ?? record.plugins
        if (Array.isArray(plugins)) {
          for (const entry of plugins) add(typeof entry === 'string' ? entry : (entry as { name?: unknown }).name)
          return
        }
        if (plugins !== null && typeof plugins === 'object') {
          for (const key of Object.keys(plugins as Record<string, unknown>)) add(key)
        }
      },
    },
  ]

  for (const attempt of attempts) {
    try {
      const body = await readJson(`${base}${attempt.path}`, `the registry index at ${base}${attempt.path}`)
      attempt.pick(body)
      answered.push(attempt.path)
      // Search paginates; `/-/all` and the snapshot's selection do not. Only
      // search can leave names behind, so only search is followed.
      if (attempt.path.startsWith('/-/v1/search')) {
        for (let from = 250; from < MAX_CANDIDATES; from += 250) {
          const page = await readJson(
            `${base}/-/v1/search?text=&size=250&from=${String(from)}`,
            `the registry search page at ${base}`,
          )
          const before = names.length
          attempt.pick(page)
          if (names.length === before) break
          if (names.length >= MAX_CANDIDATES) break
        }
      }
    } catch (error) {
      // An endpoint a registry does not implement is expected, not an error:
      // it simply answers 404 and the next spelling is tried.
      logEvent('info', 'registry', `catalog: ${base}${attempt.path} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { names: names.slice(0, MAX_CANDIDATES), answered }
}

/** The GitHub repository an entry points at, from the spellings npm allows. */
function repositoryOf(manifest: Manifest): { owner: string; repo: string } | null {
  const raw = manifest.repository
  const value = typeof raw === 'string' ? raw : (raw as { url?: unknown } | undefined)?.url
  if (typeof value !== 'string') return null
  const cleaned = value
    .replace(/^git\+/u, '')
    .replace(/\.git$/u, '')
    .replace(/^github:/u, 'https://github.com/')
  const match = /github\.com[/:]([^/]+)\/([^/#?]+)/iu.exec(cleaned)
  if (match === null) return null
  return { owner: match[1]!, repo: match[2]! }
}

/** The last path segment of a package name, which is what a plugin is called. */
function leafOf(name: string): string {
  const slash = name.lastIndexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}

/** The scope of a package name, without the `@`, or null. */
function scopeOf(name: string): string | null {
  return name.startsWith('@') && name.includes('/') ? name.slice(1, name.indexOf('/')) : null
}

/**
 * The `author` field in either of its two spellings, as a bare name.
 *
 * Last resort before `local`: an unscoped plugin with no `repository` still
 * usually names who wrote it, and an entry attributed to its author reads as
 * a real listing rather than an anonymous one.
 */
function authorOf(manifest: Manifest): string | null {
  const raw = manifest.author
  const value = typeof raw === 'string' ? raw : (raw as { name?: unknown } | undefined)?.name
  if (typeof value !== 'string') return null
  // `Name <mail@host> (url)` — the name is the part before the first bracket.
  const name = value.split(/[<(]/u)[0]?.trim() ?? ''
  return name === '' ? null : name
}

/**
 * Whether a manifest describes something a user can install as a plugin.
 *
 * The `dsh` field is the discriminator, and it is a deliberate one: this
 * source lists packages, and the same registry holds every dependency of
 * every one of them. A keyword test would both miss plugins that publish no
 * keywords and admit libraries that happen to be tagged `dsh`.
 */
function isPlugin(manifest: Manifest): boolean {
  return manifest.dsh !== undefined && manifest.dsh !== null
}

/** A date from a packument's `time` map, in the catalog's YYYY-MM-DD form. */
function dayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value)
  return match === null ? null : `${match[1]!}-${match[2]!}-${match[3]!}`
}

/**
 * Category ids for one plugin, from its own keywords.
 *
 * Coarse on purpose. A registry does not carry a curated category, and
 * inventing a fine-grained taxonomy from keyword soup would put the same
 * plugin in three places. Every id returned here is present in the
 * `categories` map this module emits, so the UI never renders a raw id.
 */
const CATEGORY_RULES: readonly { id: string; words: readonly string[] }[] = [
  { id: 'ui', words: ['ui', 'client', 'sidebar', 'board', 'panel', 'theme', 'interface', 'frontend'] },
  { id: 'model', words: ['model', 'llm', 'vision', 'ocr', 'context', 'memory', 'embedding', 'compress'] },
  { id: 'tools', words: ['tool', 'skill', 'agent', 'mcp', 'shell', 'browser', 'office', 'spreadsheet'] },
]

const CATEGORY_LABELS: Record<string, Record<string, string>> = {
  ui: { en: 'Interface', zh: '界面' },
  model: { en: 'Model & context', zh: '模型与上下文' },
  tools: { en: 'Tools & skills', zh: '工具与技能' },
  other: { en: 'Other', zh: '其他' },
}

function categoriesOf(manifest: Manifest): string[] {
  const keywords = Array.isArray(manifest.keywords)
    ? manifest.keywords.filter((word): word is string => typeof word === 'string').map(word => word.toLowerCase())
    : []
  const ids = CATEGORY_RULES
    .filter(rule => rule.words.some(word => keywords.some(keyword => keyword.includes(word))))
    .map(rule => rule.id)
  return ids.length === 0 ? ['other'] : ids
}

/**
 * One catalog entry from one package.
 *
 * `url` is the field that needs explaining: the catalog model requires a
 * source URL, and this source has no repository to point at when a package
 * was uploaded as a tarball. The synthesized `github.com` address is a
 * stable identifier rather than a promise — offline mode does not offer it
 * as a link — and every install path uses `npm` and the configured registry,
 * never this field.
 */
function entryFrom(name: string, manifest: Manifest, version: string | null, added: string | null): RegistryPlugin {
  const repo = repositoryOf(manifest)
  const scope = scopeOf(name)
  const leaf = leafOf(name)
  const owner = repo?.owner ?? scope ?? authorOf(manifest) ?? 'local'
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : ''
  return {
    name: leaf,
    owner,
    url: `https://github.com/${owner}/${repo?.repo ?? leaf}`,
    category: categoriesOf(manifest),
    description: description === '' ? {} : { en: description, zh: description },
    npm: name,
    install: name,
    added: added ?? new Date().toISOString().slice(0, 10),
    version,
    // Not a zero: the registry carries no download statistics this market
    // can trust, and sorting must not read "unknown" as "unpopular".
    downloads: null,
    stars: null,
  }
}

/** The latest version's manifest, and the date it was published. */
function latestOf(packument: Packument): { manifest: Manifest; version: string | null; added: string | null } | null {
  const tags = packument['dist-tags'] as Record<string, unknown> | undefined
  const latestTag = typeof tags?.latest === 'string' ? tags.latest : null
  const versions = packument.versions as Record<string, Manifest> | undefined
  if (versions === undefined || versions === null) return null
  const version = latestTag !== null && versions[latestTag] !== undefined
    ? latestTag
    : (Object.keys(versions).at(-1) ?? null)
  if (version === null) return null
  const manifest = versions[version]
  if (manifest === undefined) return null
  const time = packument.time as Record<string, unknown> | undefined
  return { manifest, version, added: dayOf(time?.[version]) ?? dayOf(time?.created) }
}

/** One package read, with the reason it was skipped when it was not a plugin. */
type ReadResult = { entry: RegistryPlugin } | { skipped: string }

async function readPackage(base: string, name: string, filterPlugins: boolean): Promise<ReadResult> {
  const url = `${base}/${packagePath(name)}`
  const body = await readJson(url, `the manifest of ${name} at ${url}`)
  const latest = latestOf(body as Packument)
  if (latest === null) return { skipped: 'no published version' }
  if (filterPlugins && !isPlugin(latest.manifest)) return { skipped: 'not a DSH plugin (no `dsh` field)' }
  return { entry: entryFrom(name, latest.manifest, latest.version, latest.added) }
}

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await task(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * The catalog, read out of a registry.
 *
 * `names` short-circuits discovery: an operator who states the plugin list
 * gets exactly that list, in that order, and nothing is filtered out — the
 * statement is theirs. Without it, the registry is asked and the `dsh` field
 * decides.
 *
 * @throws when the registry cannot be asked, when it names no packages, or
 * when none of the packages it names is a plugin — three different
 * situations with three different things for the operator to fix, so the
 * message says which one happened.
 */
export async function catalogFromRegistry(registry: string, names?: readonly string[] | null): Promise<Registry> {
  const base = baseOf(registry)
  const explicit = names !== undefined && names !== null && names.length > 0
  let candidates: string[]
  let answered: string[] = []
  if (explicit) {
    candidates = [...names]
  } else {
    const discovered = await discoverNames(registry)
    candidates = discovered.names
    answered = discovered.answered
    if (candidates.length === 0) {
      throw new Error(
        `the registry at ${base} answered none of /-/v1/search, /-/all or /-/ping — it is not an npm registry, or it is empty`,
      )
    }
  }

  const results = await mapLimited(candidates, CONCURRENCY, async name => {
    try {
      // An explicit list is the operator's statement of which packages are
      // plugins, so the `dsh` test is off for it: the whole reason to name
      // the list is that the marker cannot be trusted on this registry.
      return await readPackage(base, name, !explicit)
    } catch (error) {
      // One unreadable package must not cost the whole listing: a registry
      // that holds a half-uploaded tarball still has the other twelve.
      return { skipped: `${name}: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  const plugins: RegistryPlugin[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if ('entry' in result) {
      // Two packages can share a leaf name (`@a/ui`, `@b/ui`). The catalog is
      // keyed by display name in several places, so the second one keeps its
      // scope rather than silently replacing the first.
      if (seen.has(result.entry.name)) result.entry.name = `${String(result.entry.owner)}/${result.entry.name}`
      seen.add(result.entry.name)
      plugins.push(result.entry)
    } else {
      skipped.push(result.skipped)
    }
  }

  if (plugins.length === 0) {
    const detail = explicit
      ? `none of the ${String(candidates.length)} names configured could be read as a plugin`
      : `it holds ${String(candidates.length)} packages and none of them carries the \`dsh\` field that marks a plugin`
    throw new Error(`the registry at ${base} lists no installable plugins — ${detail}`)
  }

  logEvent('info', 'registry', `catalog: ${String(plugins.length)} plugins from ${base}${answered.length > 0 ? ` (index: ${answered.join(', ')})` : ''}, ${String(skipped.length)} packages skipped`)
  if (skipped.length > 0) {
    // One line, truncated: the shape of the list matters more than each
    // library's name, and this fires on every load.
    logEvent('info', 'registry', `catalog: skipped ${skipped.slice(0, 6).join('; ')}${skipped.length > 6 ? ` … and ${String(skipped.length - 6)} more` : ''}`)
  }

  // Only the categories actually used are declared, so the filter bar shows
  // the taxonomy this registry has rather than the public catalog's.
  const used = new Set(plugins.flatMap(plugin => pluginCategoriesOf(plugin)))
  const categories: Record<string, Record<string, string>> = {}
  for (const id of [...used].sort()) categories[id] = CATEGORY_LABELS[id] ?? { en: id, zh: id }

  return {
    updated: new Date().toISOString().slice(0, 10),
    count: plugins.length,
    categories,
    plugins,
  }
}

/** Category ids already normalized by `entryFrom`, kept local to avoid a cycle. */
function pluginCategoriesOf(plugin: RegistryPlugin): string[] {
  return Array.isArray(plugin.category) ? plugin.category : [plugin.category]
}
