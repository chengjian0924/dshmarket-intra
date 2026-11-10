#!/usr/bin/env node
/**
 * Stage an intranet mirror of the plugin market, from a machine that still has
 * the public internet.
 *
 * Run this on the connected side, carry the directory across, publish it into
 * the internal registry — and the market's offline mode has everything it
 * needs: a catalog listing only what the intranet can actually install, and
 * the tarballs for exactly those packages.
 *
 * Three facts shape the output:
 *
 *  - GitHub-only plugins are DROPPED, not carried. A `github:` install on an
 *    air-gapped network cannot succeed, so listing one would be an entry whose
 *    only possible outcome is an error. If an operator wants one, they publish
 *    it to their own registry and add its `npm` name when they merge the
 *    catalog — which is the same work as mirroring any other package.
 *  - The two INFRASTRUCTURE packages ride along: `dshmarket` (the market
 *    itself, so it can update from the mirror) and `dsh-plugin-updates` (the
 *    daily release notes the changelog reads). Without the second one the
 *    changelog has nothing to say on that network, and it says nothing in a
 *    way that looks like the plugin published no notes.
 *  - Every tarball is version-pinned in the printed publish script, so what
 *    was reviewed on the connected side is what lands on the intranet.
 *
 * Not a package manager: `npm publish <tgz> --registry <internal>` is the
 * publish step, because every private registry supports it and none of them
 * agree on anything more elaborate.
 *
 * Usage:
 *   node scripts/offline-bundle.mjs --out ./offline-bundle --target http://npm.corp/
 *   node scripts/offline-bundle.mjs --out ./bundle --plugins dshmarket,@scope/plugin --target http://npm.corp/
 *   node scripts/offline-bundle.mjs --out ./bundle --catalog ./plugins.json --registry https://registry.npmmirror.com
 *   node scripts/offline-bundle.mjs --out ./bundle --replace dshmarket=./dshmarket-1.73.17.tgz
 *
 * `--replace <name>=<tgz>` stages a local build instead of the published one,
 * which is what a fork needs: the market being deployed is this checkout, not
 * whatever is on npm today.
 *
 * `--target` is where the tarballs are published FROM THE OTHER SIDE, and it
 * is written into the generated script; `--registry` is where they are
 * downloaded from, here. They are different machines, which is the whole
 * point of the exercise.
 */

import { copyFileSync as cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DEFAULT_SOURCE_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_ORIGIN = 'https://awesome-dsh-plugin.com/plugins.json'
/** Packages the market itself needs on the far side, beyond the plugins. */
const INFRASTRUCTURE = ['dshmarket', 'dsh-plugin-updates']

function parseArgs(argv) {
  const options = {
    out: './offline-bundle',
    registry: DEFAULT_SOURCE_REGISTRY,
    target: null,
    catalog: DEFAULT_ORIGIN,
    plugins: null,
    replace: {},
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--out') options.out = next()
    else if (arg === '--registry') options.registry = next()
    else if (arg === '--target') options.target = next()
    else if (arg === '--catalog') options.catalog = next()
    else if (arg === '--plugins') options.plugins = next().split(',').map(name => name.trim()).filter(Boolean)
    else if (arg === '--replace') {
      const pair = next()
      const separator = pair.indexOf('=')
      if (separator <= 0) throw new Error('--replace wants <package-name>=<path-to-tgz>')
      options.replace[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim()
    }
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''))
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/** The catalog, from whatever this side can read it from. */
async function readCatalog(location) {
  if (!/^https?:\/\//iu.test(location)) {
    // A local file is how an operator curates the list before mirroring it.
    try {
      return JSON.parse(readFileSync(resolve(location), 'utf8'))
    } catch (error) {
      throw new Error(`cannot read catalog ${location}: ${error.message}`)
    }
  }
  const response = await fetch(location, { redirect: 'follow' })
  if (!response.ok) throw new Error(`catalog ${location} answered HTTP ${response.status}`)
  return await response.json()
}

/** `dist-tags.latest` and its tarball address, straight from the registry. */
async function resolvePackage(registry, name) {
  const url = `${registry.replace(/\/+$/, '')}/${encodeURIComponent(name).replace(/^%40/, '@')}/latest`
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${name}: registry answered HTTP ${response.status}`)
  const body = await response.json()
  const version = body.version
  const tarball = body.dist?.tarball
  if (typeof version !== 'string' || typeof tarball !== 'string') {
    throw new Error(`${name}: registry metadata carries no version or tarball`)
  }
  return { name, version, tarball }
}

/** Download one tarball to `directory`, returning the file name written. */
async function download(pkg, directory) {
  const file = `${pkg.name.replace(/[@/]/gu, '-').replace(/^-/u, '')}-${pkg.version}.tgz`
  const target = join(directory, file)
  if (existsSync(target)) return file
  const response = await fetch(pkg.tarball, { redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`${pkg.name}: tarball answered HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
  return file
}

/** Publish scripts, because the far side is offline and cannot run this one. */
function publishScripts(files, registry) {
  const target = registry.replace(/\/+$/, '')
  const lines = files.map(file => `npm publish "${file}" --registry ${target}`)
  const sh = ['#!/bin/sh', '# Generated by scripts/offline-bundle.mjs. Run inside tarballs/.',
    `# Publishes into ${target}; each package is pinned to the version staged here.`,
    'set -e', ...lines, ''].join('\n')
  const cmd = ['@echo off', 'REM Generated by scripts/offline-bundle.mjs. Run inside tarballs\\',
    `REM Publishes into ${target}.`, ...lines.map(line => line.replace(/"/gu, '')), ''].join('\r\n')
  return { sh, cmd }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const out = resolve(options.out)
  const tarballDirectory = join(out, 'tarballs')
  mkdirSync(tarballDirectory, { recursive: true })

  const catalog = await readCatalog(options.catalog)
  const entries = Array.isArray(catalog.plugins) ? catalog.plugins : []
  if (entries.length === 0) throw new Error('the catalog carries no plugins')

  // Only entries the intranet can install: a registry package. Everything
  // else is a GitHub install, which offline mode refuses by design.
  let kept = entries.filter(entry => typeof entry.npm === 'string' && entry.npm.trim() !== '')
  const dropped = entries.length - kept.length
  if (options.plugins !== null) {
    const wanted = new Set(options.plugins)
    const before = kept.length
    kept = kept.filter(entry => wanted.has(entry.npm))
    for (const name of wanted) {
      if (!kept.some(entry => entry.npm === name) && !INFRASTRUCTURE.includes(name)) {
        console.warn(`warn: ${name} is not an npm-installable entry in this catalog`)
      }
    }
    console.log(`selected ${kept.length} of ${before} npm-installable entries`)
  }

  const names = [...new Set([...INFRASTRUCTURE, ...kept.map(entry => entry.npm)])]
  const files = []
  const missing = []
  // Sequential on purpose: this runs on an operator's laptop once, and a
  // burst of parallel requests to the public registry is how a mirror job
  // gets rate-limited halfway through.
  for (const name of names) {
    // A local build wins over the registry: this deployment ships a fork of
    // the market, and staging the upstream tarball under the same name would
    // silently replace it with code nobody reviewed.
    const local = options.replace[name]
    if (local !== undefined) {
      const file = basename(local)
      cpSync(resolve(local), join(tarballDirectory, file))
      files.push(file)
      console.log(`  ${name} -> tarballs/${file} (local build)`)
      continue
    }
    try {
      const pkg = await resolvePackage(options.registry, name)
      if (pkg === null) {
        missing.push(name)
        console.warn(`warn: ${name} is not published on ${options.registry}`)
        continue
      }
      const file = await download(pkg, tarballDirectory)
      files.push(file)
      console.log(`  ${pkg.name}@${pkg.version} -> tarballs/${file}`)
    } catch (error) {
      missing.push(name)
      console.warn(`warn: ${name}: ${error.message}`)
    }
  }

  // The catalog is rewritten to the entries actually staged, so the intranet
  // lists only what it can install. A version the staging side could not
  // fetch is removed rather than advertised.
  const staged = new Set(missing)
  const catalogOut = {
    ...catalog,
    updated: new Date().toISOString().slice(0, 10),
    count: kept.filter(entry => !staged.has(entry.npm)).length,
    plugins: kept.filter(entry => !staged.has(entry.npm)),
  }
  writeFileSync(join(out, 'plugins.json'), `${JSON.stringify(catalogOut, null, 2)}\n`)

  // The publish side is the intranet registry the operator names. Falling
  // back to the download registry would generate a script that tries to
  // publish INTO npmjs from a machine that cannot reach it — the one mistake
  // this file exists to make impossible.
  const targetRegistry = options.target === null ? null : options.target.replace(/\/+$/, '')
  if (targetRegistry === null) {
    console.warn('warn: no --target given, so publish.sh was not written; re-run with --target http://your-registry/')
  }
  const { sh, cmd } = publishScripts(files, targetRegistry ?? '<your-registry>')
  if (targetRegistry !== null) {
    writeFileSync(join(tarballDirectory, 'publish.sh'), sh, { mode: 0o755 })
    writeFileSync(join(tarballDirectory, 'publish.cmd'), cmd)
  }
  writeFileSync(join(out, 'README.txt'), [
    'dsh-market offline bundle',
    '',
    `staged ${String(files.length)} tarballs for ${String(catalogOut.count)} catalog entries`,
    dropped > 0 ? `${String(dropped)} GitHub-only entries were dropped: offline mode refuses them.` : '',
    '',
    'On the intranet:',
    targetRegistry === null
      ? '  1. publish the tarballs by hand: npm publish <tgz> --registry http://your-registry/'
      : '  1. publish the tarballs:  cd tarballs && sh publish.sh   (or publish.cmd on Windows)',
    '  2. (only for a hand-maintained catalog) copy plugins.json somewhere the host can read',
    '     Without it the market lists whatever the registry holds, which needs no upkeep:',
    '     a plugin published to the registry IS listed. Drop this step and the `catalog:`',
    '     line below unless you need a fixed order or a curated subset.',
    '  3. configure the plugin in the profile composition:',
    '',
    '     - id: dsh-market',
    '       name: dshmarket',
    '       config:',
    '         offline: true',
    `         npmRegistry: ${targetRegistry ?? 'http://npm.corp'}/`,
    `         # catalog: ${join('/opt/dsh/market', 'plugins.json')}`,
    `         # plugins: [dsh-context, "@your-scope/plugin"]   # explicit list, no filtering`,
    '',
    '  4. restart dsh',
    '',
  ].filter(line => line !== undefined).join('\n'))

  console.log('')
  console.log(`staged ${String(files.length)} tarballs and ${String(catalogOut.count)} catalog entries in ${out}`)
  if (dropped > 0) console.log(`dropped ${String(dropped)} GitHub-only entries (offline mode cannot install them)`)
  if (missing.length > 0) console.log(`missing from the source registry: ${missing.join(', ')}`)
  console.log('next: publish tarballs/, copy plugins.json, set offline:true — see README.txt')
}

main().catch((error) => {
  console.error(`offline-bundle: ${error.message}`)
  process.exit(1)
})
