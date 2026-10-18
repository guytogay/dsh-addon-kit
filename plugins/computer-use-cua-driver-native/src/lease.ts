import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** One claim on a target, written by the agent that holds it. */
export interface LeaseRecord {
  key: string
  owner: string
  pid: number
  at: number
}

export interface LeaseDecision {
  ok: boolean
  holder?: LeaseRecord
  reason: string
}

/**
 * Decide whether a claim may proceed, given whatever claim is already on disk.
 * Two agents on one machine drive the same windows, clipboard and foreground; a silent second
 * writer corrupts the other agent's coordinates. So the second writer is refused and told who
 * holds the target, and an expired claim is taken over instead of deadlocking.
 * @param current - the claim already on disk, if any.
 * @param owner - identity of the requester (session label + pid).
 * @param now - current epoch milliseconds.
 * @param ttlMs - how long a claim stays valid without renewal; default 30 s.
 * @returns the decision plus the current holder when refusing.
 */
export function leaseDecision(current: LeaseRecord | undefined, owner: string, now: number, ttlMs = 30_000): LeaseDecision {
  if (current === undefined) return { ok: true, reason: 'no holder' }
  if (current.owner === owner) return { ok: true, holder: current, reason: 'reentrant by the same owner' }
  if (now - current.at > ttlMs) return { ok: true, holder: current, reason: `holder ${current.owner} expired ${Math.round((now - current.at) / 1000)} s ago` }
  return { ok: false, holder: current, reason: `held by ${current.owner} (pid ${current.pid}) for ${Math.round((now - current.at) / 1000)} s` }
}

const SAFE = /[^A-Za-z0-9._-]/g

/** Claim a target for one owner; the claim lives in a file so it works across processes. */
export async function acquireLease(
  key: string,
  owner: string,
  options: { dir?: string; ttlMs?: number; now?: () => number } = {},
): Promise<LeaseDecision> {
  const dir = options.dir ?? join(homedir(), '.dsh', 'computer-use', 'leases')
  const ttlMs = options.ttlMs ?? 30_000
  const now = (options.now ?? (() => Date.now()))()
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${key.replace(SAFE, '_')}.json`)
  const record: LeaseRecord = { key, owner, pid: process.pid, at: now }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      try { await handle.writeFile(JSON.stringify(record)) } finally { await handle.close() }
      return { ok: true, reason: 'claimed' }
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      let current: LeaseRecord | undefined
      try { current = JSON.parse(await readFile(path, 'utf8')) as LeaseRecord } catch { current = undefined }
      const decision = leaseDecision(current, owner, now, ttlMs)
      if (!decision.ok) return decision
      if (current !== undefined && now - current.at > ttlMs) {
        await unlink(path).catch(() => undefined)
        continue
      }
      return decision
    }
  }
  return { ok: false, reason: 'lost the claim race; retry' }
}

/** Release a claim, but only when this owner holds it. */
export async function releaseLease(key: string, owner: string, dir?: string): Promise<boolean> {
  const base = dir ?? join(homedir(), '.dsh', 'computer-use', 'leases')
  const path = join(base, `${key.replace(SAFE, '_')}.json`)
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as LeaseRecord
    if (current.owner !== owner) return false
    await unlink(path)
    return true
  } catch { return false }
}
