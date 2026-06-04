# DingTalk Wiki MCP Server

钉钉知识库 MCP Server，支持通过 MCP 协议读写钉钉 Wiki / Docs 内容。

### 知识库管理
- `list_wiki_workspaces` - 列出知识库工作空间列表
- `get_wiki_workspace` - 获取知识库详情
- `list_wiki_nodes` - 列出知识库节点（文档 / 目录）
- `get_wiki_node` - 获取节点详情
- `get_wiki_doc_content` - 读取文档正文内容（Block 结构）
- `create_wiki_doc` - 创建文档（支持 `DOC` / `WORKBOOK` / `MIND` / `FOLDER`）
- `update_wiki_doc_content` - 覆写文档内容（Markdown，⚠️ 全量覆盖）
- `rename_wiki_doc` - 重命名文档
- `delete_wiki_doc` - 删除文档节点
- `search_wiki` - 搜索知识库内容
- `list_notable_sheets` - 获取 `.able` / AI 表格中的所有数据表
- `list_notable_records` - 获取指定数据表中的 records
- `create_notable_record` - 创建记录（单条或多条）
- `update_notable_record` - 更新记录
- `delete_notable_record` - 删除记录
- `create_notable_sheet` - 创建数据表
- `delete_notable_sheet` - 删除数据表

### 组织架构
- `list_departments` - 列出部门列表
- `get_department_users` - 获取部门成员
- `get_user_info` - 获取用户详情（包含 `unionid`）

## 使用示例

### 查看所有工具

```bash
mcporter list dingtalk-wiki
```

### 知识库管理

```bash
# 列出知识库工作空间
mcporter call dingtalk-wiki.list_wiki_workspaces

# 获取知识库详情
mcporter call dingtalk-wiki.get_wiki_workspace workspace_id="your_workspace_id"

# 列出知识库节点（根目录）
mcporter call dingtalk-wiki.list_wiki_nodes workspace_id="your_workspace_id"

# 列出指定目录下的节点
mcporter call dingtalk-wiki.list_wiki_nodes workspace_id="your_workspace_id" parent_node_id="folder_node_id"

# 创建文档（默认 DOC）
mcporter call dingtalk-wiki.create_wiki_doc \
  workspace_id="your_workspace_id" \
  name="新文档标题"

# 创建表格
mcporter call dingtalk-wiki.create_wiki_doc \
  workspace_id="your_workspace_id" \
  name="数据统计" \
  doc_type="WORKBOOK"

# 创建脑图
mcporter call dingtalk-wiki.create_wiki_doc \
  workspace_id="your_workspace_id" \
  name="思维导图" \
  doc_type="MIND"

# 创建文件夹
mcporter call dingtalk-wiki.create_wiki_doc \
  workspace_id="your_workspace_id" \
  name="项目文档" \
  doc_type="FOLDER"

# 在指定目录下创建文档
mcporter call dingtalk-wiki.create_wiki_doc \
  workspace_id="your_workspace_id" \
  name="周报" \
  parent_node_id="folder_node_id"

# 获取节点详情
mcporter call dingtalk-wiki.get_wiki_node node_id="your_node_id"

# 读取文档正文内容
mcporter call dingtalk-wiki.get_wiki_doc_content doc_key="your_doc_key"

# 更新文档内容（Markdown，⚠️ 全量覆盖）
mcporter call dingtalk-wiki.update_wiki_doc_content \
  doc_key="your_doc_key" \
  content="# 新标题\n\n新正文"

# 重命名文档
mcporter call dingtalk-wiki.rename_wiki_doc \
  workspace_id="your_workspace_id" \
  node_id="your_node_id" \
  name="新文档名称"

# 删除文档
mcporter call dingtalk-wiki.delete_wiki_doc \
  workspace_id="your_workspace_id" \
  node_id="your_node_id"

# 搜索知识库
mcporter call dingtalk-wiki.search_wiki keyword="项目规划"

# 在指定知识库内搜索
mcporter call dingtalk-wiki.search_wiki keyword="项目规划" workspace_id="your_workspace_id"

# 自定义返回条数
mcporter call dingtalk-wiki.search_wiki keyword="项目规划" max_results=5

# 分页搜索
mcporter call dingtalk-wiki.search_wiki keyword="项目规划" next_token="your_next_token"
```

### AI 表格（Notable）

```bash
# 获取 AI 表格的所有数据表（base_id 通常就是 nodeId）
mcporter call dingtalk-wiki.list_notable_sheets base_id="your_base_id"

# 获取数据表中的记录
mcporter call dingtalk-wiki.list_notable_records \
  base_id="your_base_id" \
  sheet_id="your_sheet_id"

# 指定返回条数（默认 20）
mcporter call dingtalk-wiki.list_notable_records \
  base_id="your_base_id" \
  sheet_id="your_sheet_id" \
  max_results=100

# 分页获取
mcporter call dingtalk-wiki.list_notable_records \
  base_id="your_base_id" \
  sheet_id="your_sheet_id" \
  next_token="your_next_token"

# 创建记录（单条或多条）
mcporter call dingtalk-wiki.create_notable_record \
  base_id="your_base_id" \
  sheet_id="your_sheet_id" \
  records='[{"fields":{"姓名":"张三","年龄":25}}]'

# 更新记录
mcporter call dingtalk-wiki.update_notable_record \
  base_id="your_base_id" \
  sheet_id="your_sheet_id" \
  records='[{"id":"record_id","fields":{"姓名":"李四","年龄":26}}]'

# 删除记录
mcporter call dingtalk-wiki.delete_notable_record \
  base_id="your_base_id" \
  sheet_id="your_sheet_id" \
  record_ids='["record_id1","record_id2"]'

# 创建数据表
mcporter call dingtalk-wiki.create_notable_sheet \
  base_id="your_base_id" \
  name="新数据表"

# 创建带字段的数据表
mcporter call dingtalk-wiki.create_notable_sheet \
  base_id="your_base_id" \
  name="员工表" \
  fields='[{"name":"姓名","type":"Text"},{"name":"年龄","type":"Number"}]'

# 删除数据表
mcporter call dingtalk-wiki.delete_notable_sheet \
  base_id="your_base_id" \
  sheet_id="your_sheet_id"
```

### 组织架构

```bash
# 列出根部门
mcporter call dingtalk-wiki.list_departments

# 列出指定部门下的子部门
mcporter call dingtalk-wiki.list_departments dept_id=123456

# 获取部门成员（默认每页 50 条）
mcporter call dingtalk-wiki.get_department_users dept_id=123456

# 分页获取部门成员
mcporter call dingtalk-wiki.get_department_users dept_id=123456 cursor=0 size=100

# 获取用户详情
mcporter call dingtalk-wiki.get_user_info userid="your_user_id"
```
