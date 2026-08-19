/**
 * Keycloak Admin API client — thin fetch wrapper with token caching.
 *
 * Credentials are read from the dsh credentials system:
 *   KEYCLOAK_ADMIN_USERNAME / KEYCLOAK_ADMIN_PASSWORD
 * or from environment variables of the same name.
 *
 * @module @deepseek-ai/dsh-admin-panel/keycloak
 */

/** One Keycloak user record (subset of the Admin API response). */
export interface KcUser {
  id: string
  username: string
  email: string | null
  enabled: boolean
  firstName: string | null
  lastName: string | null
  createdTimestamp: number
}

/** One realm role. */
export interface KcRole {
  id: string
  name: string
  description: string | null
}

export interface KeycloakConfig {
  readonly url: string
  readonly realm: string
  readonly adminUsername: string
  readonly adminPassword: string
}

interface TokenCache {
  token: string
  expiresAt: number
}

/**
 * Keycloak Admin API client with automatic token refresh.
 * Holds no state beyond the cached token; each method is a standalone HTTP call.
 */
export class KeycloakClient {
  private tokenCache: TokenCache | null = null

  constructor(private readonly config: KeycloakConfig) {}

  /** Whether the client has valid configuration. */
  get enabled(): boolean {
    return !!(this.config.url && this.config.adminUsername && this.config.adminPassword)
  }

  /** Obtain or refresh the admin access token. */
  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token
    }
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: this.config.adminUsername,
      password: this.config.adminPassword,
    })
    const resp = await fetch(
      `${this.config.url}/realms/master/protocol/openid-connect/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    )
    if (!resp.ok) {
      throw new Error(`Keycloak auth failed: ${resp.status} ${await resp.text()}`)
    }
    const data = await resp.json() as { access_token: string; expires_in: number }
    this.tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 30) * 1000 }
    return data.access_token
  }

  /** Issue an authenticated Admin API request. */
  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken()
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const resp = await fetch(
      `${this.config.url}/admin/realms/${this.config.realm}${path}`,
      init,
    )
    if (resp.status === 204) return undefined as T
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Keycloak API ${method} ${path} failed: ${resp.status} ${text}`)
    }
    return resp.json() as T
  }

  // ── User operations ──

  /** List all users in the realm. */
  async listUsers(): Promise<KcUser[]> {
    return this.api<KcUser[]>('GET', '/users?max=100')
  }

  /** Create a new user. Returns the user id. */
  async createUser(input: {
    username: string
    email?: string
    firstName?: string
    lastName?: string
    enabled?: boolean
    password?: string
    temporaryPassword?: boolean
  }): Promise<string> {
    const user: Record<string, unknown> = {
      username: input.username,
      enabled: input.enabled ?? true,
    }
    if (input.email) user.email = input.email
    if (input.firstName) user.firstName = input.firstName
    if (input.lastName) user.lastName = input.lastName

    // Create returns 201 with Location header, no body
    const token = await this.getToken()
    const resp = await fetch(
      `${this.config.url}/admin/realms/${this.config.realm}/users`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
      },
    )
    if (!resp.ok) {
      throw new Error(`Keycloak create user failed: ${resp.status} ${await resp.text()}`)
    }
    const location = resp.headers.get('Location')
    const userId = location?.split('/').pop()
    if (!userId) throw new Error('Keycloak create user: no Location header')

    // Set password if provided
    if (input.password) {
      await this.api('PUT', `/users/${userId}/reset-password`, {
        type: 'password',
        value: input.password,
        temporary: input.temporaryPassword ?? true,
      })
    }
    return userId
  }

  /** Enable or disable a user. */
  async setUserEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.api('PUT', `/users/${userId}`, { enabled })
  }

  /** Reset a user's password. */
  async resetPassword(userId: string, password: string, temporary = true): Promise<void> {
    await this.api('PUT', `/users/${userId}/reset-password`, {
      type: 'password',
      value: password,
      temporary,
    })
  }

  // ── Role operations ──

  /** List all realm roles. */
  async listRealmRoles(): Promise<KcRole[]> {
    return this.api<KcRole[]>('GET', '/roles')
  }

  /** Get realm roles assigned to a user. */
  async getUserRealmRoles(userId: string): Promise<KcRole[]> {
    return this.api<KcRole[]>('GET', `/users/${userId}/role-mappings/realm`)
  }

  /** Assign a realm role to a user by role name. */
  async assignRealmRole(userId: string, roleName: string): Promise<void> {
    const roles = await this.listRealmRoles()
    const role = roles.find(r => r.name === roleName)
    if (!role) throw new Error(`Realm role not found: ${roleName}`)
    await this.api('POST', `/users/${userId}/role-mappings/realm`, [role])
  }

  /** Remove a realm role from a user by role name. */
  async removeRealmRole(userId: string, roleName: string): Promise<void> {
    const roles = await this.listRealmRoles()
    const role = roles.find(r => r.name === roleName)
    if (!role) throw new Error(`Realm role not found: ${roleName}`)
    const token = await this.getToken()
    const resp = await fetch(
      `${this.config.url}/admin/realms/${this.config.realm}/users/${userId}/role-mappings/realm`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([role]),
      },
    )
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`Keycloak remove role failed: ${resp.status} ${await resp.text()}`)
    }
  }
}
