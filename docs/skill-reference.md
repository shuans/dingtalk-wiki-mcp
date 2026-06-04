# DingTalk Wiki MCP Server 参考文档

钉钉知识库 MCP Server，支持通过 MCP 协议读写钉钉 Wiki / Docs 内容。

## 功能特性

### 知识库管理
- `list_wiki_workspaces` - 列出知识库工作空间列表
- `get_wiki_workspace` - 获取知识库详情
- `list_wiki_nodes` - 列出知识库节点（文档 / 目录）
- `get_wiki_node` - 获取节点详情
- `create_wiki_doc` - 创建文档（支持 `DOC` / `WORKBOOK` / `MIND` / `FOLDER`）
- `search_wiki` - 搜索知识库内容
- `list_notable_sheets` - 获取 `.able` / AI 表格中的所有数据表
- `list_notable_records` - 获取指定数据表中的 records

### 组织架构
- `list_departments` - 列出部门列表
- `get_department_users` - 获取部门成员
- `get_user_info` - 获取用户详情（包含 `unionid`）

### 配置管理
- `set_operator` - 设置操作者 `unionid`
- `show_config` - 显示当前配置信息

---

## 环境变量

```bash
cp .env.example .env
```

填写：

```env
DINGTALK_APP_KEY=your-app-key
DINGTALK_APP_SECRET=your-app-secret
```

可选：

```env
DINGTALK_WIKI_CONFIG_PATH=/absolute/path/to/config.json
```

如果不设置 `DINGTALK_WIKI_CONFIG_PATH`，程序默认读取当前目录下的 `config.json`。

---

## 配置文件

先复制示例配置：

```bash
cp config.example.json config.json
```

然后填入你自己的：
- 默认用户
- userId / unionId
- 常用 workspace 信息

---

## 配置文件格式

```json
{
  "defaultUser": "your-default-user",
  "users": {
    "your-default-user": {
      "name": "Your Name",
      "userId": "your-user-id"
    }
  },
  "workspaces": {
    "Your Workspace": {
      "id": "your_workspace_id",
      "url": "https://alidocs.dingtalk.com/i/spaces/your-space-id/overview",
      "type": "TEAM"
    }
  },
}
```

---

## API 端点

- Wiki API v2.0: `https://api.dingtalk.com/v2.0/wiki`
- 创建文档: `POST /v1.0/doc/workspaces/{workspaceId}/docs`

---

## 注意事项

1. `operator_id` 使用 DingTalk `unionId`
2. 不传 `operator_id` 时，默认使用配置文件中的默认用户
3. 只能访问当前账号有权限的知识库
4. `config.json` 不建议提交到 Git 仓库

---

## 相关链接

- [钉钉开放平台 - 知识库概述](https://open.dingtalk.com/document/development/knowledge-base-overview)
- [Create Team Space Document](https://open.dingtalk.com/document/development/create-team-space-document)
