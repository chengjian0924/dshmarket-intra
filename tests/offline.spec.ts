/**
 * Intranet mode: the switch, the fence in front of every outbound request,
 * and the catalog that comes from a file instead of a host.
 *
 * The three are one feature and are tested together because each is useless
 * alone: a catalog file nobody routes to is dead configuration, and a fence
 * with no local catalog leaves the market with nothing to list. Every
 * assertion below is about the OBSERVABLE consequence — which request is
 * made, which host is refused, what the reader is told — never about the
 * shape of the module's state.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OfflineHostError, offlineBlockedHost, offlineMode, offlineReachable, setOfflineMode,
} from '../src/offline.ts'
import {
  catalogSourcesFor, normalizeCatalogSource, routesFor, setConfiguredCatalog, setConfiguredNpmRegistry,
} from '../src/regions.ts'
import { forgetCatalog, loadRegistry } from '../src/registry.ts'

const undici = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
  EnvHttpProxyAgent: vi.fn(function (this: unknown, opts?: unknown) { return { opts } }),
  Agent: vi.fn(function (this: unknown) { return { direct: true } }),
}))

vi.mock('undici', () => ({
  fetch: undici.fetch,
  EnvHttpProxyAgent: undici.EnvHttpProxyAgent,
  Agent: undici.Agent,
}))

function reset(): void {
  setOfflineMode(false)
  setConfiguredNpmRegistry(null)
  setConfiguredCatalog(null)
  forgetCatalog()
  undici.fetch.mockClear()
}

afterEach(reset)

/** A catalog document shaped like the published one. */
const CATALOG = {
  updated: '2026-11-01',
  count: 1,
  categories: { tools: { en: 'Tools', zh: '工具' } },
  plugins: [{
    name: 'dsh-loop', owner: 'someone', url: 'https://github.com/someone/dsh-loop', category: 'tools',
    description: { en: 'a plugin' }, install: 'dsh-loop', added: '2026-01-01', npm: 'dsh-loop',
  }],
}

describe('the offline switch', () => {
  it('is off until something turns it on', () => {
    // Every existing deployment must keep behaving exactly as before; this is
    // the default a missing `offline:` key resolves to.
    expect(offlineMode()).toBe(false)
    expect(offlineReachable('https://github.com/x/y')).toBe(true)
  })

  it('refuses the public hosts the market itself knows', () => {
    setOfflineMode(true)
    for (const url of [
      'https://api.github.com/repos/a/b/releases/latest',
      'https://raw.githubusercontent.com/a/b/HEAD/README.md',
      'https://codeload.github.com/a/b/tar.gz/abc',
      'https://avatars.githubusercontent.com/u/1?size=96',
      'https://awesome-dsh-plugin.com/plugins.json',
      'https://registry.npmjs.org/left-pad/latest',
      'https://giscus.app/client.js',
    ]) {
      expect(offlineBlockedHost(url), url).not.toBeNull()
      expect(offlineReachable(url)).toBe(false)
    }
  })

  it('lets an intranet host through, which is the whole point', () => {
    // An allowlist would have to predict the operator's hostname. It cannot,
    // so the rule is the inverse: only hosts known to be public are refused.
    setOfflineMode(true)
    expect(offlineReachable('http://npm.intra.corp/repository/npm/dshmarket')).toBe(true)
    expect(offlineReachable('https://dsh.intra.corp:8443/market/plugins.json')).toBe(true)
    expect(offlineReachable('file:///opt/dsh/plugins.json')).toBe(true)
  })

  it('lets through the hosts the operator named, even when they look public', () => {
    // A network that mirrors npm at a name in the denylist is still the
    // operator's own network: their statement outranks our guess.
    setOfflineMode(true, ['registry.npmjs.org'])
    expect(offlineReachable('https://registry.npmjs.org/dshmarket/latest')).toBe(true)
    expect(offlineReachable('https://api.github.com/repos/a/b')).toBe(false)
  })
})

describe('what an intranet can install', () => {
  it('installs a registry package and refuses a GitHub one', async () => {
    // The refusal is the whole point of the rule: on that network the GitHub
    // install cannot succeed, and the only useful thing the market can do is
    // say so in one second rather than let pnpm prove it in fifteen minutes.
    const { offlineInstallRefusal } = await import('../src/routes.ts')
    setOfflineMode(true)
    expect(offlineInstallRefusal('dsh-loop')).toBeNull()
    expect(offlineInstallRefusal('@scope/plugin')).toBeNull()
    const refusal = offlineInstallRefusal('github:someone/dsh-loop')
    expect(refusal).not.toBeNull()
    // Both languages, because this string lands in the install dialog for a
    // user who may read either, and it names the fix rather than the failure.
    expect(refusal).toContain('离线模式')
    expect(refusal).toContain('npm')
    expect(offlineInstallRefusal('https://github.com/o/r/releases/download/v1/p.tgz')).not.toBeNull()
    expect(offlineInstallRefusal('https://codeload.github.com/o/r/tar.gz/abc')).not.toBeNull()
  })

  it('installs from an intranet tarball URL or a staged file', async () => {
    // Republishing into the internal registry is the recommended route, but a
    // tarball the intranet serves — or a path the operator staged on the
    // machine — is still a source that works here.
    const { offlineInstallRefusal } = await import('../src/routes.ts')
    setOfflineMode(true)
    expect(offlineInstallRefusal('http://npm.intra.corp/dsh-loop/-/dsh-loop-1.0.0.tgz')).toBeNull()
    expect(offlineInstallRefusal('file:///opt/dsh/tarballs/dsh-loop-1.0.0.tgz')).toBeNull()
  })

  it('changes nothing when the switch is off', async () => {
    const { offlineInstallRefusal } = await import('../src/routes.ts')
    expect(offlineInstallRefusal('github:someone/dsh-loop')).toBeNull()
  })
})

describe('the fence in front of every outbound request', () => {
  it('refuses before a socket is opened, and says which host', async () => {
    const { marketFetch } = await import('../src/net.ts')
    setOfflineMode(true)
    const error = await marketFetch('https://api.github.com/repos/a/b').then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(OfflineHostError)
    expect((error as OfflineHostError).host).toBe('api.github.com')
    // Message carries both the fact and the address: this string is what the
    // catalog banner and the exported log will show.
    expect((error as Error).message).toContain('offline mode')
    expect((error as Error).message).toContain('api.github.com')
    // Nothing was dispatched. That is the difference between "unreachable in
    // fifteen seconds" and "not available on this network".
    expect(undici.fetch).not.toHaveBeenCalled()
  })

  it('dispatches normally once the switch is off again', async () => {
    const { marketFetch } = await import('../src/net.ts')
    setOfflineMode(true)
    await expect(marketFetch('https://api.github.com/repos/a/b')).rejects.toBeInstanceOf(OfflineHostError)
    reset()
    const response = await marketFetch('https://api.github.com/repos/a/b')
    expect(response.status).toBe(200)
    expect(undici.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('catalog routing in intranet mode', () => {
  it('names one source and no public fallback', () => {
    // The region table's global list is the public origin; appending the npm
    // package and the China mirrors (#891/#1051) would hand the operator a
    // list of hosts that can only time out.
    setConfiguredCatalog('/opt/dsh/plugins.json')
    setOfflineMode(true)
    expect(routesFor('global').catalog).toEqual([{ kind: 'file', path: resolve('/opt/dsh/plugins.json') }])
    expect(catalogSourcesFor('global')).toEqual([{ kind: 'file', path: resolve('/opt/dsh/plugins.json') }])
  })

  it('drops a public catalog URL that an environment override named', () => {
    // `DSHM_REGISTRY_URL` pointing at the public origin is a stale escape
    // hatch on a network that cannot reach it.
    setOfflineMode(true)
    const sources = catalogSourcesFor('global')
    expect(sources.every(source => source.kind !== 'url')).toBe(true)
  })

  it('keeps an intranet catalog URL', () => {
    setConfiguredCatalog('http://dsh.intra.corp/market/plugins.json')
    setOfflineMode(true)
    expect(catalogSourcesFor('global')).toEqual([
      { kind: 'url', url: 'http://dsh.intra.corp/market/plugins.json' },
    ])
  })
})

describe('normalizeCatalogSource', () => {
  it('reads an http(s) URL as a URL', () => {
    expect(normalizeCatalogSource(' http://dsh.intra.corp/plugins.json '))
      .toEqual({ kind: 'url', url: 'http://dsh.intra.corp/plugins.json' })
  })

  it('reads everything else as a path on this machine', () => {
    // Absolute either way, but not spelled the same: a bare path is resolved
    // against the working directory (`D:\opt\...` on Windows), while a file
    // URL is decoded into a rooted path with no drive (`\opt\...`). Both open
    // the same file, so the expectation is computed rather than pinned to the
    // slash the test runner happens to use.
    expect(normalizeCatalogSource('/opt/dsh/plugins.json')).toEqual({ kind: 'file', path: resolve('/opt/dsh/plugins.json') })
    expect(normalizeCatalogSource('./plugins.json')).toEqual({ kind: 'file', path: join(process.cwd(), 'plugins.json') })
    expect(normalizeCatalogSource('file:///opt/dsh/plugins.json'))
      .toEqual({ kind: 'file', path: fileURLToPath('file:///opt/dsh/plugins.json') })
  })

  it('refuses what it cannot use, so boot reports a bad value instead of failing later', () => {
    expect(normalizeCatalogSource('')).toBeNull()
    expect(normalizeCatalogSource(undefined)).toBeNull()
    expect(normalizeCatalogSource('ftp://dsh.intra.corp/plugins.json')).toBeNull()
    expect(normalizeCatalogSource('https://user:token@dsh.intra.corp/plugins.json')).toBeNull()
    expect(normalizeCatalogSource('https://dsh.intra.corp/plugins.json?token=1')).toBeNull()
  })
})

describe('a catalog read from a file', () => {
  /** A directory that survives the test process: cleanup is the OS's job. */
  function stagingDirectory(): string {
    return mkdtempSync(join(tmpdir(), 'dshm-offline-'))
  }

  it('loads the operator\'s listing without a single request', async () => {
    const directory = stagingDirectory()
    const path = join(directory, 'plugins.json')
    writeFileSync(path, JSON.stringify(CATALOG))
    setConfiguredCatalog(path)
    setOfflineMode(true)
    const registry = await loadRegistry()
    expect(registry.plugins.map(plugin => plugin.npm)).toEqual(['dsh-loop'])
    expect(undici.fetch).not.toHaveBeenCalled()
  })

  it('re-reads it, so an ops sync is visible without a restart', async () => {
    const directory = stagingDirectory()
    const path = join(directory, 'plugins.json')
    writeFileSync(path, JSON.stringify(CATALOG))
    setConfiguredCatalog(path)
    setOfflineMode(true)
    await loadRegistry()
    writeFileSync(path, JSON.stringify({
      ...CATALOG,
      plugins: [...CATALOG.plugins, { ...CATALOG.plugins[0]!, name: 'dsh-new', npm: 'dsh-new' }],
    }))
    const registry = await loadRegistry()
    expect(registry.plugins.map(plugin => plugin.npm)).toEqual(['dsh-loop', 'dsh-new'])
  })

  it('names the path it could not read', async () => {
    // The one thing an operator needs from this failure is which file, since
    // the file is the whole configuration.
    const path = join(stagingDirectory(), 'missing.json')
    setConfiguredCatalog(path)
    setOfflineMode(true)
    await expect(loadRegistry()).rejects.toThrow(new RegExp(`cannot read the catalog file ${path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`))
  })

  it('refuses a document that is not a catalog', async () => {
    const directory = stagingDirectory()
    const path = join(directory, 'plugins.json')
    writeFileSync(path, '{"plugins":[]}')
    setConfiguredCatalog(path)
    setOfflineMode(true)
    await expect(loadRegistry()).rejects.toThrow(/empty/u)
  })
})
