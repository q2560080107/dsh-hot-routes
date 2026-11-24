/** catalogVersion / sessionRouteVersion / stale 标记的持久化（JSON 文件）。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const EMPTY = {
  catalogVersion: 0,
  sessionRouteVersions: {},
  stale: false,
  lastError: null,
  lastFailedAt: null,
  lastSuccessAt: null,
  routesSnapshot: null,
}

export function loadState(file) {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      catalogVersion: Number.isSafeInteger(parsed.catalogVersion) && parsed.catalogVersion >= 0 ? parsed.catalogVersion : 0,
      sessionRouteVersions: parsed.sessionRouteVersions && typeof parsed.sessionRouteVersions === 'object'
        ? parsed.sessionRouteVersions
        : {},
      stale: parsed.stale === true,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      lastFailedAt: typeof parsed.lastFailedAt === 'number' ? parsed.lastFailedAt : null,
      lastSuccessAt: typeof parsed.lastSuccessAt === 'number' ? parsed.lastSuccessAt : null,
      routesSnapshot: parsed.routesSnapshot ?? null,
    }
  } catch {
    return { ...EMPTY, sessionRouteVersions: {} }
  }
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.tmp'
  writeFileSync(temp, JSON.stringify({
    catalogVersion: state.catalogVersion,
    sessionRouteVersions: state.sessionRouteVersions,
    stale: state.stale,
    lastError: state.lastError,
    lastFailedAt: state.lastFailedAt,
    lastSuccessAt: state.lastSuccessAt,
    routesSnapshot: state.routesSnapshot,
  }, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

export { EMPTY }
