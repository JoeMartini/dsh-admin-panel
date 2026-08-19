# dsh-admin-panel

[English](README.md) | [中文](README.zh.md)

Admin panel — agent tools for user, session, and workspace management in multi-tenant dsh deployments.

Part of the [dsh-multi-tenant](https://github.com/JoeMartini/dsh-multi-tenant) deployment suite. **Read the [deployment guide](https://github.com/JoeMartini/dsh-multi-tenant) first** — this plugin is only useful alongside workspace-guard, oauth2-proxy, and Keycloak.

## What it does

Registers 7 agent tools on the **admin instance only**, enabling the admin agent to manage users and inspect tenant state during a conversation:

| Tool | Description |
|---|---|
| `admin_user_list` | List all Keycloak users with roles and status |
| `admin_user_create` | Create user + assign roles + set password + create workspace dir |
| `admin_user_enable` | Enable or disable a user |
| `admin_user_password` | Reset a user's password |
| `admin_user_role` | Assign or remove a realm role |
| `admin_session_list` | List all tenant sessions (read-only) |
| `admin_workspace_list` | List all workspace directories with session counts |

No web UI — management happens through the agent conversation. Ask the agent "list all users" or "create a user named alice with dsh-tenant-access role" and it uses these tools.

## Install

```bash
dsh plugin --profile <name> add dsh-admin-panel
```

## Configure

The bundle's `cordis.patch.yml` inserts the plugin with environment-variable defaults. Override in your profile's `cordis.patch.yml`:

```yaml
- id: admin-panel
  config:
    keycloakUrl: https://auth.example.com:8443
    keycloakRealm: myrealm
    tenantHome: /home/dsh/.dsh-tenant
    workspaceRoot: /home/dsh/dsh-projects
    adminUsername: admin
    adminPassword: <keycloak-admin-password>
```

Store credentials in the admin instance's `.credentials.yaml`:

```yaml
KEYCLOAK_ADMIN_USERNAME: admin
KEYCLOAK_ADMIN_PASSWORD: <password>
```

## Known Limitations

- **Admin instance only.** Never mount on the tenant instance — it grants Keycloak admin API access.
- **No session content inspection.** `admin_session_list` shows metadata (id, workspace, size, date) but does not decode the jsonl.zstd content. Future work.
- **No session intervention.** Tools are read-only for sessions — no cancel/fork/delete capability yet.
- **Single Keycloak realm.** The plugin talks to one realm; multi-realm support is deferred.
