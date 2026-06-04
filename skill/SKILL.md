# DingTalk Wiki MCP Server

钉钉知识库 MCP Server，支持通过 MCP 协议读写钉钉 Wiki / Docs 内容。

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

## 使用示例

### 查看所有工具

```bash
mcporter list dingtalk-wiki
```

### 查看当前配置

```bash
mcporter call dingtalk-wiki.show_config
```

### 列出知识库

```bash
mcporter call dingtalk-wiki.list_wiki_workspaces
```

### 获取某个知识库节点

```bash
mcporter call dingtalk-wiki.list_wiki_nodes workspace_id="your_workspace_id"
```

### 创建文档

```bash
mcporter call dingtalk-wiki.create_wiki_doc \
  workspace_id="your_workspace_id" \
  name="新文档标题"
```

### 搜索知识库

```bash
mcporter call dingtalk-wiki.search_wiki keyword="项目规划"
```
