/**
 * Tenant session and workspace inspector — reads the tenant DSH_HOME
 * file system to enumerate sessions and workspace directories.
 *
 * Sessions are stored as `session.jsonl.zstd` under
 * `<tenantHome>/sessions/<workspace-slug>/session-<uuid>/`.
 *
 * Workspaces are directories under `<workspaceRoot>/<username>/`.
 *
 * @module @deepseek-ai/dsh-admin-panel/inspector
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** One session summary row. */
export interface SessionSummary {
  sessionId: string
  workspaceSlug: string
  createdAt: string
  size: number
}

/** One workspace directory summary. */
export interface WorkspaceSummary {
  username: string
  path: string
  sessionCount: number
  totalSize: number
}

export interface InspectorConfig {
  readonly tenantHome: string
  readonly workspaceRoot: string
}

/**
 * Filesystem inspector for the tenant instance.
 * All methods are read-only and throw on errors (caller handles).
 */
export class TenantInspector {
  constructor(private readonly config: InspectorConfig) {}

  /** Whether the inspector has valid configuration. */
  get enabled(): boolean {
    return !!(this.config.tenantHome || this.config.workspaceRoot)
  }

  /** List all sessions across all workspace slugs in the tenant DSH_HOME. */
  async listSessions(): Promise<SessionSummary[]> {
    if (!this.config.tenantHome) return []
    const sessionsDir = join(this.config.tenantHome, 'sessions')
    const results: SessionSummary[] = []

    let slugs: string[]
    try {
      slugs = await readdir(sessionsDir)
    } catch {
      return [] // sessions dir doesn't exist yet
    }

    for (const slug of slugs) {
      const slugDir = join(sessionsDir, slug)
      let sessionDirs: string[]
      try {
        sessionDirs = await readdir(slugDir)
      } catch {
        continue
      }
      for (const sd of sessionDirs) {
        if (!sd.startsWith('session-')) continue
        const sessionPath = join(slugDir, sd)
        const file = join(sessionPath, 'session.jsonl.zstd')
        try {
          const fs = await import('node:fs/promises')
          const stat = await fs.stat(file)
          results.push({
            sessionId: sd.replace('session-', ''),
            workspaceSlug: slug,
            createdAt: stat.mtime.toISOString(),
            size: stat.size,
          })
        } catch {
          // session dir without jsonl.zstd — skip
        }
      }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** List all user workspace directories under the workspace root. */
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    if (!this.config.workspaceRoot) return []
    const results: WorkspaceSummary[] = []

    let entries: string[]
    try {
      entries = await readdir(this.config.workspaceRoot)
    } catch {
      return []
    }

    for (const entry of entries) {
      const dirPath = join(this.config.workspaceRoot, entry)
      try {
        const stat = await import('node:fs/promises').then(fs => fs.stat(dirPath))
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }
      // Count sessions for this user (if workspace slug matches)
      const slug = this.config.tenantHome
        ? dirPath.replace(/\//g, '--').replace(/^-/, '')
        : entry
      const results_count = await this.countSessionsForSlug(slug)
      results.push({
        username: entry,
        path: dirPath,
        sessionCount: results_count.sessions,
        totalSize: results_count.size,
      })
    }
    return results
  }

  /** Count sessions and total size for one workspace slug. */
  private async countSessionsForSlug(slug: string): Promise<{ sessions: number; size: number }> {
    if (!this.config.tenantHome) return { sessions: 0, size: 0 }
    const slugDir = join(this.config.tenantHome, 'sessions', slug)
    let sessionDirs: string[]
    try {
      sessionDirs = await readdir(slugDir)
    } catch {
      return { sessions: 0, size: 0 }
    }
    let sessions = 0
    let size = 0
    for (const sd of sessionDirs) {
      if (!sd.startsWith('session-')) continue
      const file = join(slugDir, sd, 'session.jsonl.zstd')
      try {
        const stat = await import('node:fs/promises').then(fs => fs.stat(file))
        sessions++
        size += stat.size
      } catch {
        // skip
      }
    }
    return { sessions, size }
  }

  /** Get the raw session file path for a session id. */
  async findSessionFile(sessionId: string): Promise<string | null> {
    if (!this.config.tenantHome) return null
    const sessionsDir = join(this.config.tenantHome, 'sessions')
    let slugs: string[]
    try {
      slugs = await readdir(sessionsDir)
    } catch {
      return null
    }
    for (const slug of slugs) {
      const file = join(sessionsDir, slug, `session-${sessionId}`, 'session.jsonl.zstd')
      try {
        await import('node:fs/promises').then(fs => fs.access(file))
        return file
      } catch {
        continue
      }
    }
    return null
  }
}
