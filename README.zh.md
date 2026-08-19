# dsh-admin-panel

[English](README.md) | [中文](README.zh.md)

管理面板——多租户 dsh 部署中的用户、会话和工作区管理 agent 工具。

[dsh-multi-tenant](https://github.com/JoeMartini/dsh-multi-tenant) 部署套件的一部分。**请先阅读[部署指南](https://github.com/JoeMartini/dsh-multi-tenant)**——本插件需配合 workspace-guard、oauth2-proxy 和 Keycloak 使用。

## 功能

在 **admin 实例**上注册 7 个 agent 工具，让 admin agent 在会话中管理用户和查看租户状态：

| 工具 | 说明 |
|---|---|
| `admin_user_list` | 列出所有 Keycloak 用户及其角色和状态 |
| `admin_user_create` | 创建用户 + 分配角色 + 设密码 + 创建 workspace 目录 |
| `admin_user_enable` | 启用或禁用用户 |
| `admin_user_password` | 重置用户密码 |
| `admin_user_role` | 分配或移除 realm 角色 |
| `admin_session_list` | 列出所有租户会话（只读） |
| `admin_workspace_list` | 列出所有工作区目录及会话数量 |

无 Web UI——管理通过 agent 会话完成。对 agent 说"列出所有用户"或"创建用户 alice 并分配 dsh-tenant-access 角色"，它会调用这些工具。

## 安装

```bash
dsh plugin --profile <name> add dsh-admin-panel
```

## 配置

Bundle 的 `cordis.patch.yml` 使用环境变量默认值自动插入插件。在 profile 的 `cordis.patch.yml` 中覆盖：

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

凭据存入 admin 实例的 `.credentials.yaml`：

```yaml
KEYCLOAK_ADMIN_USERNAME: admin
KEYCLOAK_ADMIN_PASSWORD: <password>
```

## 已知限制

- **仅 admin 实例。** 绝不可装在 tenant 实例上——它拥有 Keycloak Admin API 权限。
- **不支持会话内容检查。** `admin_session_list` 展示元数据（ID、工作区、大小、日期），不解码 jsonl.zstd 内容。计划中。
- **不支持会话干预。** 会话工具是只读的——暂无取消/分叉/删除能力。
- **单 Keycloak realm。** 插件只连接一个 realm；多 realm 支持暂缓。
