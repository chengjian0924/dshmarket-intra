/**
 * Reading the catalog out of the registry itself.
 *
 * What is being tested is the answer to one question an intranet operator
 * asks: "the plugins are in our registry — why does the market not show
 * them?" Three separate things have to be true for the right answer:
 *
 * - the packages have to be found (three discovery endpoints, because which
 *   one answers depends on what is serving),
 * - the dependencies have to be excluded (an intranet snapshot carries pnpm
 *   and its whole tree), and
 * - what the market shows has to be the packages' own declarations — version,
 *   description, repository — rather than a second document to maintain.
 *
 * The registry here is a real HTTP server on loopback rather than a mocked
 * fetch: the discovery step is a sequence of requests whose ORDER is part of
 * the behaviour, and a mock would test the mock.
 */

import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { catalogFromRegistry } from '../src/catalog-registry.ts'
import { setOfflineMode } from '../src/offline.ts'
import { routesFor, setConfiguredCatalog, setConfiguredNpmRegistry, setConfiguredPlugins } from '../src/regions.ts'
import { forgetCatalog, loadRegistry } from '../src/registry.ts'

/** A plugin, a scoped plugin without a repository, and an ordinary library. */
const PACKS: Record<string, unknown> = {
  'dsh-context': {
    name: 'dsh-context',
    'dist-tags': { latest: '0.81.0' },
    time: { '0.81.0': '2026-02-03T08:00:00.000Z' },
    versions: {
      '0.81.0': {
        name: 'dsh-context',
        version: '0.81.0',
        description: 'Token accounting and context compression',
        keywords: ['deepseek-harness', 'dsh', 'context'],
        dsh: { client: { platform: 'web' } },
        repository: { type: 'git', url: 'git+https://github.com/T-Auto/dsh-context.git' },
        dist: { tarball: '/tarballs/dsh-context-0.81.0.tgz' },
      },
    },
  },
  '@liustack/modlens': {
    name: '@liustack/modlens',
    'dist-tags': { latest: '3.27.2' },
    versions: {
      '3.27.2': {
        name: '@liustack/modlens',
        version: '3.27.2',
        description: 'Vision model access',
        keywords: ['vision', 'ocr'],
        dsh: { client: { platform: 'web' } },
        dist: { tarball: '/tarballs/modlens-3.27.2.tgz' },
      },
    },
  },
  // Not a plugin. An intranet snapshot carries the whole dependency tree, and
  // the point of the `dsh` filter is that none of it reaches the listing.
  pnpm: {
    name: 'pnpm',
    'dist-tags': { latest: '11.28.5' },
    versions: { '11.28.5': { name: 'pnpm', version: '11.28.5', description: 'a package manager', dist: { tarball: '/tarballs/pnpm.tgz' } } },
  },
  '@babel/core': {
    name: '@babel/core',
    'dist-tags': { latest: '7.28.0' },
    versions: { '7.28.0': { name: '@babel/core', version: '7.28.0', dist: { tarball: '/tarballs/babel.tgz' } } },
  },
}

interface StubOptions {
  /** Which discovery endpoints this registry answers. */
  search?: boolean
  all?: boolean
  pingSelection?: boolean
}

/** A registry that answers the way a real one does, over real HTTP. */
async function registry(options: StubOptions = {}): Promise<{ url: string; close: () => Promise<void>; requests: string[] }> {
  const requests: string[] = []
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname).replace(/^\//u, '')
    requests.push(url.pathname + url.search)
    const reply = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const names = Object.keys(PACKS)
    if (path === '-/v1/search' && options.search !== false) {
      const text = (url.searchParams.get('text') ?? '').toLowerCase()
      const matched = names
        .filter(name => text === '' || name.toLowerCase().includes(text))
        .map(name => ({ package: { name, version: (PACKS[name] as { 'dist-tags': { latest: string } })['dist-tags'].latest } }))
      return reply(200, { objects: matched, total: matched.length })
    }
    if (path === '-/all' && options.all !== false) {
      const all: Record<string, unknown> = {}
      for (const name of names) all[name] = PACKS[name]
      return reply(200, all)
    }
    if (path === '-/ping') {
      // The read-only snapshot's convention: the selection IS the plugin list.
      return reply(200, options.pingSelection === false
        ? {}
        : { service: 'stub', selection: { plugins: { 'dsh-context': '0.81.0', '@liustack/modlens': '3.27.2', pnpm: '11.28.5' } } })
    }
    const pack = PACKS[path]
    if (pack !== undefined) return reply(200, pack)
    return reply(404, { error: 'not found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

function reset(): void {
  setOfflineMode(false)
  setConfiguredNpmRegistry(null)
  setConfiguredCatalog(null)
  setConfiguredPlugins(null)
  forgetCatalog()
}

afterEach(reset)

describe('a catalog read out of a registry', () => {
  it('lists the plugins the registry holds, and only the plugins', async () => {
    const source = await registry()
    try {
      const catalog = await catalogFromRegistry(source.url)
      expect(catalog.plugins.map(plugin => plugin.npm)).toEqual(['dsh-context', '@liustack/modlens'])
      // The dependency tree is what an unfiltered listing would have shown.
      expect(catalog.plugins.some(plugin => plugin.npm === 'pnpm' || plugin.npm === '@babel/core')).toBe(false)
      expect(catalog.count).toBe(2)
    } finally {
      await source.close()
    }
  })

  it('takes each entry from the package itself', async () => {
    const source = await registry()
    try {
      const catalog = await catalogFromRegistry(source.url)
      const context = catalog.plugins[0]!
      expect(context.name).toBe('dsh-context')
      // Repository first: a plugin that declares where it lives is described
      // by what it declares, not by a guess from its name.
      expect(context.owner).toBe('T-Auto')
      expect(context.url).toBe('https://github.com/T-Auto/dsh-context')
      expect(context.version).toBe('0.81.0')
      expect(context.added).toBe('2026-02-03')
      expect(context.description.en).toContain('context compression')
      expect(context.category).toContain('model')
      // Installing is a registry name, so the install path never touches a
      // GitHub host this network does not have.
      expect(context.npm).toBe('dsh-context')
      expect(context.install).toBe('dsh-context')

      // No repository declared: the scope names the owner, which is right for
      // every scoped plugin in the offline bundle.
      const modlens = catalog.plugins[1]!
      expect(modlens.owner).toBe('liustack')
      expect(modlens.url).toBe('https://github.com/liustack/modlens')
    } finally {
      await source.close()
    }
  })

  it('declares only the categories its own listing uses', async () => {
    const source = await registry()
    try {
      const catalog = await catalogFromRegistry(source.url)
      expect(Object.keys(catalog.categories).sort()).toEqual(['model'])
      expect(catalog.categories.model?.zh).toBe('模型与上下文')
    } finally {
      await source.close()
    }
  })

  it('falls back to the selection a read-only snapshot publishes', async () => {
    // A snapshot that implements neither search nor /-/all — the offline
    // bundle's own server before it learned them — still names its plugins
    // on /-/ping.
    const source = await registry({ search: false, all: false })
    try {
      const catalog = await catalogFromRegistry(source.url)
      expect(catalog.plugins.map(plugin => plugin.npm)).toEqual(['dsh-context', '@liustack/modlens'])
    } finally {
      await source.close()
    }
  })

  it('lists what the operator named, without second-guessing it', async () => {
    const source = await registry()
    try {
      // `pnpm` is in the list because the operator said so: a source that was
      // told what it holds must not filter the answer.
      const catalog = await catalogFromRegistry(source.url, ['pnpm'])
      expect(catalog.plugins.map(plugin => plugin.npm)).toEqual(['pnpm'])
    } finally {
      await source.close()
    }
  })

  it('says which of the three failures happened', async () => {
    const empty = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
    })
    await new Promise<void>(resolve => empty.listen(0, '127.0.0.1', resolve))
    const address = empty.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    try {
      // Nothing answered discovery: the message has to say that, because the
      // fix (this is not a registry) is not the same as "no plugins in it".
      await expect(catalogFromRegistry(`http://127.0.0.1:${String(address.port)}`)).rejects.toThrow(
        /answered none of/u,
      )
    } finally {
      await new Promise<void>(resolve => { empty.close(() => { resolve() }) })
    }
  })

  it('reads through `loadRegistry` like any other source', async () => {
    const source = await registry()
    setOfflineMode(true)
    setConfiguredNpmRegistry(source.url)
    try {
      const catalog = await loadRegistry('global')
      expect(catalog.plugins.map(plugin => plugin.name)).toEqual(['dsh-context', 'modlens'])
    } finally {
      await source.close()
    }
  })
})

describe('intranet mode points the catalog at the registry', () => {
  it('uses the offline bundle address when nothing named a registry', () => {
    setOfflineMode(true)
    const routes = routesFor('global', {})
    expect(routes.npmRegistry).toBe('http://127.0.0.1:4873')
    expect(routes.catalog).toEqual([{ kind: 'registry', registry: 'http://127.0.0.1:4873', names: null }])
  })

  it('follows a registry the composition named', () => {
    setOfflineMode(true)
    setConfiguredNpmRegistry('http://npm.intra.corp:8081')
    expect(routesFor('global', {}).catalog).toEqual([
      { kind: 'registry', registry: 'http://npm.intra.corp:8081', names: null },
    ])
  })

  it('carries a named plugin list into the source', () => {
    setOfflineMode(true)
    setConfiguredPlugins(['dsh-context', '  ', 'dsh-ops'])
    expect(routesFor('global', {}).catalog).toEqual([
      { kind: 'registry', registry: 'http://127.0.0.1:4873', names: ['dsh-context', 'dsh-ops'] },
    ])
  })

  it('keeps the public catalog list when offline mode is off', () => {
    expect(routesFor('global', {}).catalog[0]?.kind).toBe('url')
  })

  it('lets an explicit catalog win over the registry listing', () => {
    setOfflineMode(true)
    setConfiguredCatalog('/opt/dsh/plugins.json')
    // Absolute the way this platform spells it — the assertion is about which
    // source wins, not about which slash the runner uses.
    expect(routesFor('global', {}).catalog).toEqual([{ kind: 'file', path: resolve('/opt/dsh/plugins.json') }])
  })
})
