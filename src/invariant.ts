/**
 * InvariantInstaller registration for @deepseek-ai/dsh-admin-panel.
 * @module @deepseek-ai/dsh-admin-panel/invariant
 */


export const name = 'admin-panel-invariant'

export function apply(): void {
  // No runtime invariant: admin-panel tools are thin wrappers over Keycloak
  // Admin API and filesystem reads; correctness is verified by e2e behavior,
  // not by an owned event/data relation in the harness.
}
