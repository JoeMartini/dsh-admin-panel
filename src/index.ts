/**
 * Admin Panel — agent tools for multi-tenant dsh management.
 *
 * Registers tools that let the admin agent manage users (via Keycloak Admin
 * API), inspect tenant sessions, and perform privilege escalation on behalf
 * of tenants (unrestricted shell, file copy, ownership fix). Only mount on the
 * admin instance.
 *
 * @module @deepseek-ai/dsh-admin-panel
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { KeycloakClient } from './keycloak.ts'
import { TenantInspector } from './inspector.ts'

export const name = 'admin-panel'
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration. */
export interface Config {
  /** Keycloak base URL (e.g. https://auth.example.com:50443). */
  keycloakUrl: string
  /** Keycloak realm name (e.g. martini). */
  keycloakRealm: string
  /** Path to the tenant DSH_HOME (for session inspection). */
  tenantHome: string
  /** Path to the shared workspace root (e.g. /home/user/dsh-projects). */
  workspaceRoot: string
  /** Keycloak admin username (from credentials or env). */
  adminUsername: string
  /** Keycloak admin password (from credentials or env). */
  adminPassword: string
}

export const Config: z<Config> = z.object({
  keycloakUrl: z.string().required(),
  keycloakRealm: z.string().required(),
  tenantHome: z.string().required(),
  workspaceRoot: z.string().required(),
  adminUsername: z.string().required(),
  adminPassword: z.string().required(),
})

const SYSTEM_PROMPT = `## Admin Panel Tools

You have access to admin tools for multi-tenant management:

**User Management** (via Keycloak):
- \`admin_user_list\`: List all users with their roles and status
- \`admin_user_create\`: Create a user, assign roles, set password, and create workspace directory
- \`admin_user_enable\`: Enable or disable a user
- \`admin_user_password\`: Reset a user's password
- \`admin_user_role\`: Assign or remove a realm role from a user

**Session & Workspace Inspection** (read-only):
- \`admin_session_list\`: List all tenant sessions across workspaces
- \`admin_workspace_list\`: List all user workspace directories with session counts

**Privilege Operations** (admin acts on behalf of tenants):
- \`admin_privilege_exec\`: Run a shell command in a tenant's workspace directory (unrestricted — no sandbox). Use for installing packages, running builds, or any operation the tenant cannot do themselves.
- \`admin_privilege_copy\`: Copy a file or directory from any source path to any destination. Use to place files into a tenant's workspace from outside the sandbox.
- \`admin_privilege_chown\`: Change ownership of files in a tenant's workspace so the tenant can access them.

When a user asks to manage users or check tenant status, use these tools.
User workspace directories follow the pattern: <workspaceRoot>/<username>/.
New users automatically get a workspace directory created at this path.

**Privilege escalation guidelines:**
- Always resolve the tenant's workspace path via admin_workspace_list first.
- Execute privilege commands with the tenant's username as context.
- After privilege_exec or privilege_copy, verify the result landed in the tenant's workspace.
- Never use privilege tools to modify the admin instance itself.
`

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Reject usernames that could be path traversal or shell injection vectors. */
const SAFE_USERNAME = /^[a-zA-Z0-9_-]+$/

/** Assert a username is safe for filesystem path construction. */
function validateUsername(username: string): void {
  if (!SAFE_USERNAME.test(username)) {
    throw new Error(`Invalid username: "${username}" — only alphanumeric, hyphen, and underscore are allowed.`)
  }
}

/**
 * Resolve a tenant workspace path and verify it is under the workspace root.
 * Prevents path traversal (e.g. username = "../etc") and symlink escapes.
 */
async function resolveTenantPath(workspaceRoot: string, username: string, subPath?: string): Promise<string> {
  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const cwd = path.resolve(workspaceRoot, username, subPath ?? '')
  const realWorkspaceRoot = await fs.realpath(workspaceRoot).catch(() => workspaceRoot)
  const realCwd = await fs.realpath(cwd).catch(() => cwd)
  if (!realCwd.startsWith(realWorkspaceRoot + path.sep) && realCwd !== realWorkspaceRoot) {
    throw new Error(`Resolved path "${realCwd}" is outside workspace root "${realWorkspaceRoot}"`)
  }
  return cwd
}

/** Ensure a directory exists, creating it if necessary. */
async function ensureDir(dirPath: string): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.mkdir(dirPath, { recursive: true })
}

/** Truncate stdout/stderr to a reasonable size for tool output. */
const MAX_OUTPUT = 50_000
function truncate(s: string): string {
  return s.slice(0, MAX_OUTPUT)
}

/**
 * Register admin management tools on the tool registry.
 */
export function apply(ctx: Context, config: Config): void {
  const kc = new KeycloakClient({
    url: config.keycloakUrl,
    realm: config.keycloakRealm,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
  })

  const inspector = new TenantInspector({
    tenantHome: config.tenantHome,
    workspaceRoot: config.workspaceRoot,
  })

  ctx.systemPrompt.section({ name: 'admin:panel', order: 200, text: SYSTEM_PROMPT })

  // ── admin_user_list ──
  ctx.tools.register(defineTool({
    name: 'admin_user_list',
    description:
      'List all users in the Keycloak realm with their assigned realm roles and enabled status. '
      + 'Returns username, email, enabled flag, and role names for each user.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          users: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                username: { type: 'string', required: true },
                email: { type: 'string' },
                enabled: { type: 'boolean', required: true },
                roles: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.users.length > 0
          ? `Found ${value.users.length} users:\n` + value.users.map(u =>
              `  • ${u.username} (${u.email ?? 'no email'}) — ${u.enabled ? 'enabled' : 'disabled'} — roles: ${u.roles.join(', ') || 'none'}`,
            ).join('\n')
          : 'No users found.',
      }],
    },
    async execute() {
      const users = await kc.listUsers()
      const enriched = await Promise.all(
        users.map(async u => {
          const roles = await kc.getUserRealmRoles(u.id)
          return {
            id: u.id,
            username: u.username,
            email: u.email ?? '',
            enabled: u.enabled,
            roles: roles.map(r => r.name),
          }
        }),
      )
      return { users: enriched }
    },
  }))

  // ── admin_user_create ──
  ctx.tools.register(defineTool({
    name: 'admin_user_create',
    description:
      'Create a new user in Keycloak, assign realm roles, set an initial password, '
      + 'and create the workspace directory. The workspace directory is created at '
      + '<workspaceRoot>/<username>/. At least one role should be assigned (e.g. dsh-tenant-access).',
    parameters: {
      username: { type: 'string', required: true, description: 'Login username (unique in realm).' },
      email: { type: 'string', description: 'User email address.' },
      firstName: { type: 'string', description: 'User first name.' },
      lastName: { type: 'string', description: 'User last name.' },
      password: { type: 'string', required: true, description: 'Initial password (user must change on first login).' },
      roles: {
        type: 'array',
        description: 'Realm roles to assign (e.g. ["dsh-tenant-access"]).',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userId: { type: 'string', required: true },
          username: { type: 'string', required: true },
          workspacePath: { type: 'string', required: true },
          rolesAssigned: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `User "${value.username}" created (id=${value.userId}). Workspace: ${value.workspacePath}. Roles: ${value.rolesAssigned.join(', ') || 'none'}.`,
      }],
    },
    async execute(args) {
      validateUsername(args.username)
      const createInput: { username: string; password: string; enabled: boolean; temporaryPassword: boolean; email?: string; firstName?: string; lastName?: string } = {
        username: args.username,
        password: args.password,
        enabled: true,
        temporaryPassword: true,
      }
      if (args.email) createInput.email = args.email
      if (args.firstName) createInput.firstName = args.firstName
      if (args.lastName) createInput.lastName = args.lastName
      const userId = await kc.createUser(createInput)
      // Assign roles
      const rolesAssigned: string[] = []
      for (const role of args.roles ?? []) {
        try {
          await kc.assignRealmRole(userId, role)
          rolesAssigned.push(role)
        } catch {
          // role not found — skip
        }
      }
      // Create workspace directory
      const path = await import('node:path')
      const workspacePath = path.join(config.workspaceRoot, args.username)
      await ensureDir(workspacePath)
      return { userId, username: args.username, workspacePath, rolesAssigned }
    },
  }))

  // ── admin_user_enable ──
  ctx.tools.register(defineTool({
    name: 'admin_user_enable',
    description:
      'Enable or disable a user by username. A disabled user cannot log in.',
    parameters: {
      username: { type: 'string', required: true, description: 'Username to enable or disable.' },
      enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `User "${value.username}" is now ${value.enabled ? 'enabled' : 'disabled'}.`,
      }],
    },
    async execute(args) {
      const users = await kc.listUsers()
      const user = users.find(u => u.username === args.username)
      if (!user) throw new Error(`User not found: ${args.username}`)
      await kc.setUserEnabled(user.id, args.enabled)
      return { username: args.username, enabled: args.enabled }
    },
  }))

  // ── admin_user_password ──
  ctx.tools.register(defineTool({
    name: 'admin_user_password',
    description:
      'Reset a user password. The new password is temporary — the user must change it on next login.',
    parameters: {
      username: { type: 'string', required: true, description: 'Username to reset password for.' },
      password: { type: 'string', required: true, description: 'New temporary password.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'string', required: true },
          reset: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Password reset for "${value.username}". User must change it on next login.`,
      }],
    },
    async execute(args) {
      const users = await kc.listUsers()
      const user = users.find(u => u.username === args.username)
      if (!user) throw new Error(`User not found: ${args.username}`)
      await kc.resetPassword(user.id, args.password, true)
      return { username: args.username, reset: true }
    },
  }))

  // ── admin_user_role ──
  ctx.tools.register(defineTool({
    name: 'admin_user_role',
    description:
      'Assign or remove a realm role for a user. Use action "assign" to add, "remove" to remove.',
    parameters: {
      username: { type: 'string', required: true, description: 'Username to modify.' },
      role: { type: 'string', required: true, description: 'Realm role name (e.g. dsh-tenant-access).' },
      action: {
        type: 'string',
        required: true,
        enum: ['assign', 'remove'],
        description: '"assign" to add the role, "remove" to remove it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'string', required: true },
          role: { type: 'string', required: true },
          action: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Role "${value.role}" ${value.action === 'assign' ? 'assigned to' : 'removed from'} "${value.username}".`,
      }],
    },
    async execute(args) {
      const users = await kc.listUsers()
      const user = users.find(u => u.username === args.username)
      if (!user) throw new Error(`User not found: ${args.username}`)
      if (args.action === 'assign') {
        await kc.assignRealmRole(user.id, args.role)
      } else {
        await kc.removeRealmRole(user.id, args.role)
      }
      return { username: args.username, role: args.role, action: args.action }
    },
  }))

  // ── admin_session_list ──
  ctx.tools.register(defineTool({
    name: 'admin_session_list',
    description:
      'List all tenant sessions across all workspaces. Returns session id, workspace slug, '
      + 'creation timestamp, and file size. Read-only — does not modify sessions.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum sessions to return (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                workspaceSlug: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                sizeKb: { type: 'integer', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.sessions.length > 0
          ? `${value.total} sessions total (showing ${value.sessions.length}):\n` + value.sessions.map(s =>
              `  • ${s.sessionId.slice(0, 8)}…  ${s.workspaceSlug}  ${s.createdAt}  ${s.sizeKb}KB`,
            ).join('\n')
          : 'No sessions found.',
      }],
    },
    async execute(args) {
      const limit = args.limit ?? 50
      const sessions = await inspector.listSessions()
      const trimmed = sessions.slice(0, limit)
      return {
        sessions: trimmed.map(s => ({
          ...s,
          sizeKb: Math.round(s.size / 1024),
        })),
        total: sessions.length,
      }
    },
  }))

  // ── admin_workspace_list ──
  ctx.tools.register(defineTool({
    name: 'admin_workspace_list',
    description:
      'List all user workspace directories under the shared workspace root. '
      + 'Returns username, path, session count, and total size for each workspace.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaces: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                username: { type: 'string', required: true },
                path: { type: 'string', required: true },
                sessionCount: { type: 'integer', required: true },
                totalSizeKb: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.workspaces.length > 0
          ? `${value.workspaces.length} workspaces:\n` + value.workspaces.map(w =>
              `  • ${w.username}  (${w.sessionCount} sessions, ${w.totalSizeKb}KB)  ${w.path}`,
            ).join('\n')
          : 'No workspaces found.',
      }],
    },
    async execute() {
      const workspaces = await inspector.listWorkspaces()
      return {
        workspaces: workspaces.map(w => ({
          username: w.username,
          path: w.path,
          sessionCount: w.sessionCount,
          totalSizeKb: Math.round(w.totalSize / 1024),
        })),
      }
    },
  }))

  // ── admin_privilege_exec ──
  ctx.tools.register(defineTool({
    name: 'admin_privilege_exec',
    description:
      'Run a shell command in a tenant\'s workspace directory with admin privileges (no sandbox). '
      + 'Use for installing packages, running builds, or any operation the tenant cannot do themselves. '
      + 'The command runs via `bash -c <command>` with cwd set to <workspaceRoot>/<username>/. '
      + 'The workspace directory is created if it does not exist.',
    parameters: {
      username: { type: 'string', required: true, description: 'Tenant username whose workspace to act in.' },
      command: { type: 'string', required: true, description: 'Shell command to execute.' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds (default 60000, max 300000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Command finished (exit ${value.exitCode}) in ${value.cwd} (${value.durationMs}ms):\nstdout:\n${value.stdout}\nstderr:\n${value.stderr}`,
      }],
    },
    async execute(args) {
      validateUsername(args.username)
      const cwd = await resolveTenantPath(config.workspaceRoot, args.username)
      await ensureDir(cwd)
      const { execFile } = await import('node:child_process')
      const timeout = Math.min(args.timeout ?? 60000, 300000)
      const start = Date.now()
      return new Promise((resolve) => {
        execFile('bash', ['-c', args.command], { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          const durationMs = Date.now() - start
          resolve({
            username: args.username,
            cwd,
            exitCode: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
            stdout: truncate(stdout ?? ''),
            stderr: truncate(stderr ?? ''),
            durationMs,
          })
        })
      })
    },
  }))

  // ── admin_privilege_copy ──
  ctx.tools.register(defineTool({
    name: 'admin_privilege_copy',
    description:
      'Copy a file or directory from any source path to any destination. Use to place files '
      + 'into a tenant\'s workspace from outside the sandbox. Runs `cp -v [-r] <source> <destination>`.',
    parameters: {
      source: { type: 'string', required: true, description: 'Source file or directory path.' },
      destination: { type: 'string', required: true, description: 'Destination path.' },
      recursive: { type: 'boolean', description: 'Copy directories recursively (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          destination: { type: 'string', required: true },
          copied: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.copied
          ? `Copied ${value.source} → ${value.destination}.\n${value.detail}`
          : `Copy failed: ${value.source} → ${value.destination}. ${value.detail}`,
      }],
    },
    async execute(args) {
      const { execFile } = await import('node:child_process')
      const recursive = args.recursive ?? true
      const cpArgs = ['-v']
      if (recursive) cpArgs.push('-r')
      cpArgs.push(args.source, args.destination)
      return new Promise((resolve) => {
        execFile('cp', cpArgs, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            resolve({
              source: args.source,
              destination: args.destination,
              copied: false,
              detail: truncate((err.message || '') + (stderr ? `\n${stderr}` : '')),
            })
          } else {
            resolve({
              source: args.source,
              destination: args.destination,
              copied: true,
              detail: truncate((stdout ?? '').trim() || 'OK'),
            })
          }
        })
      })
    },
  }))

  // ── admin_privilege_chown ──
  ctx.tools.register(defineTool({
    name: 'admin_privilege_chown',
    description:
      'Change ownership of files in a tenant\'s workspace so the tenant can access them. '
      + 'Runs `sudo chown -R <owner> <path>`. If path is omitted, defaults to <workspaceRoot>/<username>/. '
      + 'The target path must resolve under the workspace root.',
    parameters: {
      username: { type: 'string', required: true, description: 'Tenant username (owner to set).' },
      path: { type: 'string', description: 'Path to chown (defaults to <workspaceRoot>/<username>).' },
      group: { type: 'string', description: 'Group to set (e.g. <username> or a shared group).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          username: { type: 'string', required: true },
          path: { type: 'string', required: true },
          chowned: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.chowned
          ? `Chowned ${value.path} to ${value.username}.\n${value.detail}`
          : `Chown failed for ${value.path}: ${value.detail}`,
      }],
    },
    async execute(args) {
      validateUsername(args.username)
      // Resolve default path or validate custom path is under workspace root
      const path = await import('node:path')
      const fs = await import('node:fs/promises')
      const targetPath = args.path ?? path.join(config.workspaceRoot, args.username)
      // Canonicalize and verify containment
      const realWorkspaceRoot = await fs.realpath(config.workspaceRoot).catch(() => config.workspaceRoot)
      const realTarget = await fs.realpath(targetPath).catch(() => targetPath)
      if (!realTarget.startsWith(realWorkspaceRoot + path.sep) && realTarget !== realWorkspaceRoot) {
        throw new Error(`Target path "${realTarget}" is outside workspace root "${realWorkspaceRoot}"`)
      }
      const owner = args.group ? `${args.username}:${args.group}` : args.username
      const { execFile } = await import('node:child_process')
      return new Promise((resolve) => {
        execFile('sudo', ['chown', '-R', owner, targetPath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            resolve({
              username: args.username,
              path: targetPath,
              chowned: false,
              detail: truncate((err.message || '') + (stderr ? `\n${stderr}` : '')),
            })
          } else {
            resolve({
              username: args.username,
              path: targetPath,
              chowned: true,
              detail: truncate((stdout ?? '').trim() || 'OK'),
            })
          }
        })
      })
    },
  }))
}
