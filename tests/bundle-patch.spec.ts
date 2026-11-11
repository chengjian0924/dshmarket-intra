/**
 * The bundle patch this package ships, as a deployment receives it.
 *
 * `offline` is read from exactly one place — the plugin's own config — and
 * nothing infers it from the network. A profile only gets that config if a
 * patch writes it, so the entry this package inserts has to carry it: the
 * client's "add plugin" dialog installs the package and writes no
 * configuration, and on a network without the public catalog an unconfigured
 * market answers every request with `fetch failed`.
 *
 * That makes the patch file a contract, and this is the test that keeps it
 * from being edited away as "deployment-specific" — it is, which is why it
 * belongs in the package and not in the deployment.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

interface PatchRow {
  insert?: { id?: string, name?: string, config?: Record<string, unknown> }[]
}

const readPatch = (): PatchRow[] => load(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')) as PatchRow[]

describe('shipped bundle patch', () => {
  it('inserts the market under the id its configuration is addressed by', () => {
    const rows = readPatch()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.insert).toHaveLength(1)
    expect(rows[0]?.insert?.[0]?.id).toBe('dsh-market')
    expect(rows[0]?.insert?.[0]?.name).toBe('dshmarket')
  })

  it('carries offline: true, so an install with no configuration is still on the intranet', () => {
    const config = readPatch()[0]?.insert?.[0]?.config
    expect(config).toEqual({ offline: true })
  })

  it('names no registry, leaving the default loopback port to the plugin', () => {
    // A pinned address here would be wrong for every deployment that moves the
    // mirror; the profile's own patch layer is where that belongs.
    expect(readPatch()[0]?.insert?.[0]?.config).not.toHaveProperty('npmRegistry')
  })
})
