#!/usr/bin/env node
/**
 * DingTalk Wiki MCP Server
 * 钉钉知识库 MCP 服务 - 支持读写操作
 * 
 * 基于钉钉 Wiki API v2.0
 * 文档: https://open.dingtalk.com/document/development/knowledge-base-overview
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const axios = require('axios');
const MiniSearch = require('minisearch');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');

// 钉钉 API 配置
const DINGTALK_API_BASE = 'https://oapi.dingtalk.com';
const DINGTALK_API_V2 = 'https://api.dingtalk.com';
const fs = require('fs');
const path = require('path');
const os = require('os');
const CACHE_DIR = path.join(os.homedir(), '.cache', 'dingtalk-wiki');
const UNIONID_CACHE_PATH = path.join(CACHE_DIR, 'unionid-cache.json');
const SEARCH_INDEX_PATH = path.join(CACHE_DIR, 'search-index.sqlite');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

let unionIdCache = {};
try {
  if (fs.existsSync(UNIONID_CACHE_PATH)) {
    unionIdCache = JSON.parse(fs.readFileSync(UNIONID_CACHE_PATH, 'utf8'));
  }
} catch (e) {
  console.error('[钉钉MCP] 读取 unionId 缓存失败:', e.message);
}

function saveUnionIdCache() {
  try {
    fs.writeFileSync(UNIONID_CACHE_PATH, JSON.stringify(unionIdCache, null, 2), 'utf8');
  } catch (e) {
    console.error('[钉钉MCP] 写入 unionId 缓存失败:', e.message);
  }
}

class WikiSearchIndex {
  constructor() {
    this.db = new Database(SEARCH_INDEX_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      workspaceId TEXT NOT NULL DEFAULT '',
      workspaceName TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT ''
    )`);
    this._insertStmt = this.db.prepare(`INSERT OR REPLACE INTO docs (id, title, content, workspaceId, workspaceName, url, type) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this._deleteStmt = this.db.prepare(`DELETE FROM docs WHERE id = ?`);
    this._getStmt = this.db.prepare(`SELECT * FROM docs WHERE id = ?`);

    this.index = new MiniSearch({
      fields: ['title', 'content'],
      storeFields: ['title', 'workspaceId', 'workspaceName', 'url', 'type'],
    });

    this._load();
  }

  _load() {
    try {
      const rows = this.db.prepare('SELECT id, title, content, workspaceId, workspaceName, url, type FROM docs').all();
      for (const row of rows) {
        this.index.add({
          id: row.id, title: row.title, content: row.content,
          workspaceId: row.workspaceId, workspaceName: row.workspaceName,
          url: row.url, type: row.type,
        });
      }
      console.error(`[钉钉MCP] 搜索索引已加载 (${rows.length} 篇文档)`);
    } catch (e) {
      console.error('[钉钉MCP] 加载搜索索引失败:', e.message);
    }
  }

  add(docKey, data) {
    this._insertStmt.run(docKey, data.title || '', data.content || '', data.workspaceId || '', data.workspaceName || '', data.url || '', data.type || '');
    try {
      this.index.add({ id: docKey, ...data });
    } catch (e) {
      console.error(`[钉钉MCP] 索引添加失败 [${docKey}]:`, e.message);
    }
  }

  remove(docKey) {
    this._deleteStmt.run(docKey);
    try { this.index.remove({ id: docKey }); } catch (e) { /* not in index */ }
  }

  update(docKey, data) {
    const existing = this._getStmt.get(docKey);
    const merged = {
      title: data.title ?? existing?.title ?? '',
      content: data.content ?? existing?.content ?? '',
      workspaceId: data.workspaceId ?? existing?.workspaceId ?? '',
      workspaceName: data.workspaceName ?? existing?.workspaceName ?? '',
      url: data.url ?? existing?.url ?? '',
      type: data.type ?? existing?.type ?? '',
    };
    this._insertStmt.run(docKey, merged.title, merged.content, merged.workspaceId, merged.workspaceName, merged.url, merged.type);
    try { this.index.remove({ id: docKey }); } catch (e) { /* ignore */ }
    try {
      this.index.add({ id: docKey, ...merged });
    } catch (e) {
      console.error(`[钉钉MCP] 索引更新失败 [${docKey}]:`, e.message);
    }
  }

  search(keyword, maxResults = 20) {
    const results = this.index.search(keyword, { prefix: true, fuzzy: 0.2 });
    const top = results.slice(0, maxResults);
    if (top.length === 0) return [];

    const ids = top.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM docs WHERE id IN (${placeholders})`).all(...ids);
    const rowMap = Object.fromEntries(rows.map(r => [r.id, r]));

    return top.map(r => ({
      id: r.id, score: r.score,
      title: rowMap[r.id]?.title || '',
      content: rowMap[r.id]?.content || '',
      workspaceId: rowMap[r.id]?.workspaceId || '',
      workspaceName: rowMap[r.id]?.workspaceName || '',
      url: rowMap[r.id]?.url || '',
      type: rowMap[r.id]?.type || '',
    }));
  }

  get size() {
    return this.db.prepare('SELECT COUNT(*) as c FROM docs').get().c;
  }

  clear() {
    this.db.exec('DELETE FROM docs');
    this.index = new MiniSearch({
      fields: ['title', 'content'],
      storeFields: ['title', 'workspaceId', 'workspaceName', 'url', 'type'],
    });
  }
}

async function reindexNotableBase(baseId) {
  try {
    const sheetsRes = await dingtalk.notableRequest('GET', `/v1.0/notable/bases/${baseId}/sheets`);
    const sheets = sheetsRes.value || [];
    const texts = [];
    for (const sheet of sheets) {
      try {
        const recordsRes = await dingtalk.notableRequest('POST', `/v1.0/notable/bases/${baseId}/sheets/${sheet.id}/records/list`, {
          data: { maxResults: 500 }
        });
        const records = recordsRes.records || [];
        for (const rec of records) {
          for (const val of Object.values(rec.fields || {})) {
            if (typeof val === 'string' || typeof val === 'number') {
              texts.push(String(val));
            }
          }
        }
      } catch (e) { /* skip sheet */ }
    }
    wikiIndex.update(baseId, { content: texts.join('\n') });
  } catch (e) {
    console.error(`[钉钉MCP] 重建 Notable 表索引失败 [${baseId}]:`, e.message);
  }
}

async function rebuildSearchIndex() {
  const wsResult = await dingtalk.wikiRequest('workspaces');
  const workspaces = wsResult.workspaces || [];

  wikiIndex.clear();
  let total = 0;

  for (const ws of workspaces) {
    const queue = [ws.rootNodeId];
    const visited = new Set();

    while (queue.length > 0) {
      const dentryId = queue.shift();
      if (!dentryId || visited.has(dentryId)) continue;
      visited.add(dentryId);

      try {
        const result = await dingtalk.docRequest('GET', `/v2.0/doc/spaces/${ws.workspaceId}/directories`, {
          extraParams: dentryId !== ws.rootNodeId ? { dentryId, maxResults: 500 } : { maxResults: 500 }
        });

        const children = result.children || [];
        for (const child of children) {
          const childId = child.dentryId || child.nodeId || child.id;
          const name = child.name || '';
          const isFolder = child.contentType === 'folder';

          if (!isFolder && childId) {
            let content = '';
            try {
              const blocks = await dingtalk.docRequest('GET', `/v1.0/doc/suites/documents/${childId}/blocks`);
              const blockData = blocks.result?.data || [];
              content = blockData.map(b => extractBlockText(b)).join('\n\n');
            } catch (e) { /* content unavailable via blocks */ }

            // Fallback: 存储 v1.0 下载 API（对上传的 .md 等文件有效）
            if (!content && child.spaceId) {
              try {
                const token = await dingtalk.getAccessToken();
                const dlRes = await axios({
                  method: 'POST',
                  url: `${DINGTALK_API_V2}/v1.0/storage/spaces/${child.spaceId}/dentries/${child.dentryId}/downloadInfos/query`,
                  headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
                  params: { unionId: await dingtalk.resolveOperatorId(null) },
                  data: {}
                });
                const data = dlRes.data;
                const downloadUrl = data.downloadInfo?.resourceUrl || data.resourceUrl || data.downloadUrl || data.url;
                const downloadHeaders = data.downloadInfo?.headers || data.headers || {};
                if (downloadUrl) {
                  const contentRes = await axios({ method: 'GET', url: downloadUrl, headers: downloadHeaders, responseType: 'text' });
                  content = contentRes.data;
                }
              } catch (e) { /* storage v1.0 unavailable */ }
            }

            if (!content) {
              try {
                const sheetsRes = await dingtalk.notableRequest('GET', `/v1.0/notable/bases/${childId}/sheets`);
                const sheets = sheetsRes.value || [];
                const texts = [];
                for (const sheet of sheets) {
                  try {
                    const recordsRes = await dingtalk.notableRequest('POST', `/v1.0/notable/bases/${childId}/sheets/${sheet.id}/records/list`, {
                      data: { maxResults: 500 }
                    });
                    const records = recordsRes.records || [];
                    for (const rec of records) {
                      for (const val of Object.values(rec.fields || {})) {
                        if (typeof val === 'string' || typeof val === 'number') {
                          texts.push(String(val));
                        }
                      }
                    }
                  } catch (e) { /* skip sheet */ }
                }
                content = texts.join('\n');
              } catch (e) { /* not a Notable table */ }
            }

            wikiIndex.add(childId, {
              title: name, content,
              workspaceId: ws.workspaceId,
              workspaceName: ws.name,
              url: child.url || '',
              type: child.contentType || 'DOC',
            });
            total++;
          }

          if (child.hasChildren && childId && !visited.has(childId)) {
            queue.push(childId);
          }
        }
      } catch (e) { /* skip errored nodes */ }
    }
  }

  console.error(`[钉钉MCP] 搜索索引重建完成 (${total} 篇文档)`);
  return total;
}

function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }

  dotenv.config({ path: filePath, override: false });
  return true;
}

function getElementsText(elements) {
  if (!elements || !Array.isArray(elements)) return '';
  return elements.map(el => {
    if (el.textRun?.content) return el.textRun.content;
    if (el.paragraphRun?.richText?.elements) return getElementsText(el.paragraphRun.richText.elements);
    return '';
  }).join('');
}

function extractBlockText(block) {
  const getText = () => {
    switch (block.blockType) {
      case 'paragraph':
        return getElementsText(block.paragraph?.richText?.elements);
      case 'heading': {
        const level = block.heading?.headingType || 1;
        const headingText = getElementsText(block.heading?.richText?.elements);
        return `${'#'.repeat(level)} ${headingText}`;
      }
      case 'table': {
        const table = block.table;
        if (!table?.cells) return '[空表格]';
        const cellTexts = table.cells.map(cell => {
          const cellBlocks = cell.blocks || [];
          return cellBlocks.map(cb => extractBlockText(cb)).join(' | ');
        });
        const colCount = table.columnsCount || (table.cells[0]?.blocks?.length || 1);
        const rows = [];
        let currentRow = [];
        cellTexts.forEach((t, i) => {
          currentRow.push(t);
          if (currentRow.length === colCount) {
            rows.push(currentRow.join(' | '));
            currentRow = [];
          }
        });
        if (currentRow.length) rows.push(currentRow.join(' | '));
        return rows.map(r => `| ${r} |`).join('\n');
      }
      case 'unorderedList':
        return `• ${getElementsText(block.unorderedList?.richText?.elements)}`;
      case 'orderedList':
        return `1. ${getElementsText(block.orderedList?.richText?.elements)}`;
      case 'blockquote':
        return `> ${getElementsText(block.blockquote?.richText?.elements)}`;
      case 'codeBlock':
        return '```\n' + getElementsText(block.codeBlock?.richText?.elements) + '\n```';
      case 'divider':
        return '---';
      case 'image':
        return `[图片: ${block.image?.caption || ''}]`;
      default:
        return `[${block.blockType}] ${getElementsText(block.paragraph?.richText?.elements)}`;
    }
  };
  return getText();
}

const DOTENV_CANDIDATES = [
  process.env.DINGTALK_WIKI_ENV_PATH,
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '.env')
].filter(Boolean);

for (const candidate of DOTENV_CANDIDATES) {
  if (loadEnvFile(candidate)) {
    console.error(`[钉钉MCP] 已加载环境变量文件: ${candidate}`);
    break;
  }
}

// 加载配置
let userConfig = {};
if (process.env.DINGTALK_WIKI_CONFIG) {
  try {
    userConfig = JSON.parse(process.env.DINGTALK_WIKI_CONFIG);
    console.error('[钉钉MCP] 已加载环境变量配置');
  } catch (error) {
    console.error('[钉钉MCP] 环境变量配置解析失败:', error.message);
  }
}

// 环境变量配置
const DINGTALK_APP_KEY = process.env.DINGTALK_APP_KEY;
const DINGTALK_APP_SECRET = process.env.DINGTALK_APP_SECRET;

if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) {
  console.error('错误: 请设置环境变量 DINGTALK_APP_KEY 和 DINGTALK_APP_SECRET');
  process.exit(1);
}

// 钉钉 API 客户端
class DingTalkClient {
  constructor() {
    this.accessToken = null;
    this.tokenExpireTime = 0;
    this.operatorId = null;
  }

  // 获取 Access Token
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpireTime) {
      return this.accessToken;
    }

    try {
      const response = await axios.get(`${DINGTALK_API_BASE}/gettoken`, {
        params: {
          appkey: DINGTALK_APP_KEY,
          appsecret: DINGTALK_APP_SECRET
        }
      });

      if (response.data.errcode !== 0) {
        throw new Error(`获取 Token 失败: ${response.data.errmsg}`);
      }

      this.accessToken = response.data.access_token;
      // Token 7200 秒过期，提前 5 分钟刷新
      this.tokenExpireTime = Date.now() + (response.data.expires_in - 300) * 1000;
      return this.accessToken;
    } catch (error) {
      throw new Error(`获取 Access Token 失败: ${error.message}`);
    }
  }

  // 设置操作者 ID (unionid)
  setOperatorId(unionid) {
    this.operatorId = unionid;
    console.error(`[钉钉MCP] 操作者已设置: ${unionid}`);
    return true;
  }

  // 获取默认用户的 unionId — 优先级：内存 > 系统缓存 > API
  async getCurrentUserUnionId() {
    if (this.operatorId) {
      return this.operatorId;
    }

    const defaultUser = userConfig.defaultUser;
    const users = userConfig.users;
    if (!defaultUser || !users || !users[defaultUser]) {
      return null;
    }

    const user = users[defaultUser];
    if (!user.userId) {
      return null;
    }

    // 查系统缓存
    if (unionIdCache[user.userId]) {
      this.operatorId = unionIdCache[user.userId];
      return this.operatorId;
    }

    // 调 API
    try {
      const token = await this.getAccessToken();
      const response = await axios({
        method: 'POST',
        url: `${DINGTALK_API_BASE}/topapi/v2/user/get`,
        params: { access_token: token },
        data: { userid: user.userId }
      });
      if (response.data.errcode === 0 && response.data.result && response.data.result.unionid) {
        const unionid = response.data.result.unionid;
        this.operatorId = unionid;
        unionIdCache[user.userId] = unionid;
        saveUnionIdCache();
        return unionid;
      }
    } catch (error) {
      console.error('[钉钉MCP] 获取 unionId 失败:', error.message);
    }
    return null;
  }

  // Wiki API v2.0 请求
  async wikiRequest(endpoint, params = {}) {
    const token = await this.getAccessToken();

    if (!this.operatorId) {
      await this.getCurrentUserUnionId();
    }

    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        queryParams.append(key, value);
      }
    }

    // 添加 operatorId
    if (this.operatorId) {
      queryParams.append('operatorId', this.operatorId);
    }

    const url = `${DINGTALK_API_V2}/v2.0/wiki/${endpoint}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;

    try {
      const response = await axios({
        method: 'GET',
        url,
        headers: {
          'x-acs-dingtalk-access-token': token
        }
      });
      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`${error.response.data?.message || error.message} (code: ${error.response.data?.code})`);
      }
      throw error;
    }
  }

  async resolveOperatorId(overrideOperatorId = null) {
    if (overrideOperatorId) {
      this.setOperatorId(overrideOperatorId);
      return this.operatorId;
    }

    if (!this.operatorId) {
      await this.getCurrentUserUnionId();
    }

    if (!this.operatorId) {
      throw new Error('未设置 operator_id，请传入 operator_id 或在配置文件中设置默认用户');
    }

    return this.operatorId;
  }

  async docRequest(method, pathName, { operatorId = null, data = null, extraParams = {} } = {}) {
    const token = await this.getAccessToken();
    const resolvedOperatorId = await this.resolveOperatorId(operatorId);
    const url = `${DINGTALK_API_V2}${pathName}`;

    try {
      const requestConfig = {
        method,
        url,
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json'
        },
        params: {
          operatorId: resolvedOperatorId,
          ...extraParams
        },
        data
      };
      if (pathName.includes('blocks')) {
        console.error(`[DEBUG] docRequest: ${method} ${url} operatorId=${resolvedOperatorId} extraParams=${JSON.stringify(extraParams)}`);
      }
      const response = await axios(requestConfig);
      return response.data;
    } catch (error) {
      if (error.response) {
        const fullErr = JSON.stringify(error.response.data);
        console.error(`[DEBUG] docRequest error (${pathName}): status=${error.response.status} data=${fullErr}`);
        throw new Error(`${error.response.data?.message || error.message} (code: ${error.response.data?.code})`);
      }
      throw error;
    }
  }

  async notableRequest(method, pathName, { operatorId = null, params = {}, data = null } = {}) {
    const token = await this.getAccessToken();
    const resolvedOperatorId = await this.resolveOperatorId(operatorId);
    const url = `${DINGTALK_API_V2}${pathName}`;

    try {
      const response = await axios({
        method,
        url,
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json'
        },
        params: {
          ...params,
          operatorId: resolvedOperatorId
        },
        data
      });
      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`${error.response.data?.message || error.message} (code: ${error.response.data?.code})`);
      }
      throw error;
    }
  }

  // OAPI 请求
  async oapiRequest(apiName, data = null) {
    const token = await this.getAccessToken();
    const url = `${DINGTALK_API_BASE}/topapi/${apiName}`;
    
    const config = {
      method: data ? 'POST' : 'GET',
      url,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (data) {
      config.data = data;
      config.params = { access_token: token };
    } else {
      config.params = { access_token: token };
    }

    try {
      const response = await axios(config);
      if (response.data.errcode !== 0) {
        throw new Error(`${response.data.errmsg || '未知错误'} (错误码: ${response.data.errcode})`);
      }
      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`钉钉 API 错误: ${error.response.data?.errmsg || error.message}`);
      }
      throw error;
    }
  }
}

const dingtalk = new DingTalkClient();
const wikiIndex = new WikiSearchIndex();

// MCP Server 定义
const server = new Server(
  {
    name: 'dingtalk-wiki',
    version: '1.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// 工具定义
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_wiki_workspaces',
        description: '列出用户有权限的知识库工作空间列表',
        inputSchema: {
          type: 'object',
          properties: {
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用之前设置的）'
            }
          }
        }
      },
      {
        name: 'get_wiki_workspace',
        description: '获取知识库工作空间详情',
        inputSchema: {
          type: 'object',
          properties: {
            workspace_id: {
              type: 'string',
              description: '知识库工作空间 ID'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['workspace_id']
        }
      },
      {
        name: 'list_wiki_nodes',
        description: '列出知识库中的节点（文档和目录）',
        inputSchema: {
          type: 'object',
          properties: {
            workspace_id: {
              type: 'string',
              description: '知识库工作空间 ID'
            },
            parent_node_id: {
              type: 'string',
              description: '父节点 ID（不传则列出根目录节点）'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['workspace_id']
        }
      },
      {
        name: 'create_wiki_doc',
        description: '在知识库中创建新文档（需要 Document.WorkspaceDocument.Write 权限）',
        inputSchema: {
          type: 'object',
          properties: {
            workspace_id: {
              type: 'string',
              description: '知识库工作空间 ID'
            },
            name: {
              type: 'string',
              description: '文档名称'
            },
            doc_type: {
              type: 'string',
              description: '文档类型，可选: DOC / WORKBOOK / MIND / FOLDER（默认 DOC）'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            },
            parent_node_id: {
              type: 'string',
              description: '父节点 ID（可选，不传则创建在根目录）'
            },
            content: {
              type: 'string',
              description: '文档内容（可选）'
            }
          },
          required: ['workspace_id', 'name']
        }
      },
      {
        name: 'get_wiki_node',
        description: '获取知识库节点详情',
        inputSchema: {
          type: 'object',
          properties: {
            node_id: {
              type: 'string',
              description: '节点 ID'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['node_id']
        }
      },
      {
        name: 'search_wiki',
        description: '按名称搜索知识库中的文档和文件夹（遍历目录树，无需索引即可使用）',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '搜索关键词'
            },
            workspace_id: {
              type: 'string',
              description: '指定知识库 ID（可选，不传则搜索所有知识库）'
            },
            max_results: {
              type: 'number',
              description: '返回条数上限（默认 20，最大 50）'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['keyword']
        }
      },
      {
        name: 'refresh_search_index',
        description: '全量重建搜索索引（遍历所有知识库读取文档内容，建立全文索引后 search_wiki_content 方可使用）',
        inputSchema: {
          type: 'object',
          properties: {
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          }
        }
      },
      {
        name: 'search_wiki_content',
        description: '全文搜索知识库文档内容（需先运行 refresh_search_index 建立索引）',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '搜索关键词'
            },
            workspace_id: {
              type: 'string',
              description: '指定知识库 ID（可选，不传则搜索所有知识库）'
            },
            max_results: {
              type: 'number',
              description: '返回条数上限（默认 20，最大 50）'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['keyword']
        }
      },
      {
        name: 'list_departments',
        description: '列出钉钉组织架构中的部门列表',
        inputSchema: {
          type: 'object',
          properties: {
            dept_id: {
              type: 'number',
              description: '父部门 ID（默认 1 即根部门，可按需指定）',
              default: 1
            },
            fetch_child: {
              type: 'boolean',
              description: '是否递归获取子部门',
              default: true
            }
          }
        }
      },
      {
        name: 'get_department_users',
        description: '获取部门成员列表',
        inputSchema: {
          type: 'object',
          properties: {
            dept_id: {
              type: 'number',
              description: '部门 ID'
            },
            cursor: {
              type: 'number',
              description: '分页游标',
              default: 0
            },
            size: {
              type: 'number',
              description: '每页数量',
              default: 50
            }
          },
          required: ['dept_id']
        }
      },
      {
        name: 'get_user_info',
        description: '获取用户详细信息',
        inputSchema: {
          type: 'object',
          properties: {
            userid: {
              type: 'string',
              description: '用户 ID'
            }
          },
          required: ['userid']
        }
      },
      {
        name: 'get_wiki_doc_content',
        description: '读取文档内容。对 .adoc 在线文档使用 blocks API；对上传的 .md 等文件使用存储下载 API（需 Storage.DownloadInfo.Read 权限）。',
        inputSchema: {
          type: 'object',
          properties: {
            doc_key: {
              type: 'string',
              description: '文档标识。支持 nodeId（dentryUuid）、docKey，或文档 URL。'
            },
            workspace_id: {
              type: 'string',
              description: '知识库 ID（可选）。自动通过 wiki/nodes API 解析。'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['doc_key']
        }
      },
      {
        name: 'update_wiki_doc_content',
        description: '覆写 .adoc 在线文档正文内容（⚠️ 全量覆盖，不可撤销）。对上传的 .md 等文件不支持修改。',
        inputSchema: {
          type: 'object',
          properties: {
            doc_key: {
              type: 'string',
              description: '文档标识。支持 nodeId（dentryUuid）、docKey，或文档 URL。仅 .adoc 在线文档支持写入。'
            },
            content: {
              type: 'string',
              description: '要写入的 Markdown 内容'
            },
            workspace_id: {
              type: 'string',
              description: '知识库 ID（可选）。当 doc_key 来自 create_wiki_doc 返回的 nodeId 时，提供此参数可自动查找正确的 dentryUuid'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['doc_key', 'content']
        }
      },
      {
        name: 'rename_wiki_doc',
        description: '重命名文档',
        inputSchema: {
          type: 'object',
          properties: {
            workspace_id: {
              type: 'string',
              description: '知识库工作空间 ID'
            },
            node_id: {
              type: 'string',
              description: '节点 ID（重命名的目标文档）'
            },
            name: {
              type: 'string',
              description: '新的文档名称'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['workspace_id', 'node_id', 'name']
        }
      },
      {
        name: 'delete_wiki_doc',
        description: '删除文档节点',
        inputSchema: {
          type: 'object',
          properties: {
            workspace_id: {
              type: 'string',
              description: '知识库工作空间 ID'
            },
            node_id: {
              type: 'string',
              description: '节点 ID（要删除的目标文档）'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['workspace_id', 'node_id']
        }
      },
      {
        name: 'create_notable_record',
        description: '在 AI 表格数据表中创建一条或多条记录',
        inputSchema: {
          type: 'object',
          properties: {
            base_id: {
              type: 'string',
              description: 'Notable baseId'
            },
            sheet_id: {
              type: 'string',
              description: '数据表 ID 或名称，可通过 list_notable_sheets 获取'
            },
            records: {
              type: 'array',
              description: '要创建的记录数组。每条记录为 { fields: { 字段名: 值 } }',
              items: {
                type: 'object',
                properties: {
                  fields: {
                    type: 'object',
                    description: '字段名到字段值的映射'
                  }
                },
                required: ['fields']
              }
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['base_id', 'sheet_id', 'records']
        }
      },
      {
        name: 'update_notable_record',
        description: '更新 AI 表格数据表中的多条记录',
        inputSchema: {
          type: 'object',
          properties: {
            base_id: {
              type: 'string',
              description: 'Notable baseId'
            },
            sheet_id: {
              type: 'string',
              description: '数据表 ID 或名称'
            },
            records: {
              type: 'array',
              description: '要更新的记录数组。每条记录格式为 { id: "recordId", fields: { 字段名: 值 } }',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: '记录 ID'
                  },
                  fields: {
                    type: 'object',
                    description: '要更新的字段'
                  }
                },
                required: ['id', 'fields']
              }
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['base_id', 'sheet_id', 'records']
        }
      },
      {
        name: 'delete_notable_record',
        description: '删除 AI 表格数据表中的多条记录',
        inputSchema: {
          type: 'object',
          properties: {
            base_id: {
              type: 'string',
              description: 'Notable baseId'
            },
            sheet_id: {
              type: 'string',
              description: '数据表 ID 或名称'
            },
            record_ids: {
              type: 'array',
              description: '要删除的记录 ID 列表',
              items: {
                type: 'string'
              }
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['base_id', 'sheet_id', 'record_ids']
        }
      },
      {
        name: 'create_notable_sheet',
        description: '在 AI 表格中创建一个新的数据表',
        inputSchema: {
          type: 'object',
          properties: {
            base_id: {
              type: 'string',
              description: 'Notable baseId'
            },
            name: {
              type: 'string',
              description: '数据表名称'
            },
            fields: {
              type: 'array',
              description: '数据表字段配置（可选），格式: [{ name: "字段名", type: "字段类型", property: {} }]',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '字段名' },
                  type: { type: 'string', description: '字段类型，如 Text, Number, Select 等' }
                },
                required: ['name', 'type']
              }
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['base_id', 'name']
        }
      },
      {
        name: 'delete_notable_sheet',
        description: '删除 AI 表格中的一个数据表',
        inputSchema: {
          type: 'object',
          properties: {
            base_id: {
              type: 'string',
              description: 'Notable baseId'
            },
            sheet_id: {
              type: 'string',
              description: '数据表 ID 或名称'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['base_id', 'sheet_id']
        }
      },
      {
        name: 'list_notable_sheets',
        description: '读取 AI 表格 / Notable 的所有数据表。对于 .able 节点，直接使用 nodeId 作为 base_id。',
        inputSchema: {
          type: 'object',
          properties: {
            base_id: {
              type: 'string',
              description: 'Notable baseId。对 .able 节点来说，通常就是 nodeId。'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['base_id']
        }
      },
      {
        name: 'list_notable_records',
        description: '读取 AI 表格 / Notable 某个数据表中的记录。',
        inputSchema: {
          type: 'object',
          properties: {
            base_id: {
              type: 'string',
              description: 'Notable baseId。对 .able 节点来说，通常就是 nodeId。'
            },
            sheet_id: {
              type: 'string',
              description: '数据表 ID，可先通过 list_notable_sheets 获取。'
            },
            max_results: {
              type: 'number',
              description: '返回记录数，默认 20',
              default: 20
            },
            next_token: {
              type: 'string',
              description: '分页 token，可选'
            },
            operator_id: {
              type: 'string',
              description: '操作者 unionid（不传则使用默认用户）'
            }
          },
          required: ['base_id', 'sheet_id']
        }
      }
    ]
  };
});

async function resolveDocKey(docKey, operatorId, dingtalkInstance) {
  const rawInput = docKey;

  // 从 URL 中提取 ID
  const urlMatch = String(docKey).match(/\/i\/nodes\/([^\/\?#]+)/);
  docKey = urlMatch ? urlMatch[1] : docKey;
  console.error(`[DEBUG] resolveDocKey: rawInput=${rawInput}, extracted=${docKey}`);

  try {
    const nodeInfo = await dingtalkInstance.docRequest('GET', `/v2.0/wiki/nodes/${docKey}`, { operatorId });
    const node = nodeInfo.node || nodeInfo;
    console.error(`[DEBUG] resolveDocKey: wiki/nodes response keys=${Object.keys(node).join(',')}`);

    // 缓存 workspaceId，供后续 fallback 使用
    if (node.workspaceId) {
      dingtalkInstance._resolvedWorkspaceId = node.workspaceId;
    }

    // wiki/nodes 的 nodeId = dentryUuid，直接可用
    // 但 node.document.docKey 可能是不同的值，优先使用
    if (node.document?.docKey) {
      console.error(`[DEBUG] resolveDocKey: found document.docKey=${node.document.docKey}`);
      return node.document.docKey;
    }
    // 部分响应直接把 docKey 放在顶层
    if (node.docKey) {
      console.error(`[DEBUG] resolveDocKey: found top-level docKey=${node.docKey}`);
      return node.docKey;
    }
    console.error(`[DEBUG] resolveDocKey: no docKey in response, returning raw docKey=${docKey}`);
  } catch (e) {
    console.error(`[DEBUG] resolveDocKey: wiki/nodes failed: ${e.message}`);
  }

  return docKey;
}

// 工具调用处理
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'list_wiki_workspaces': {
        if (args.operator_id) {
          dingtalk.setOperatorId(args.operator_id);
        }
        const result = await dingtalk.wikiRequest('workspaces');
        const workspaces = result.workspaces || [];
        
        let output = `📚 知识库工作空间列表 (${workspaces.length}个)\n\n`;
        workspaces.forEach((ws, index) => {
          output += `${index + 1}. ${ws.name}\n`;
          output += `   ID: ${ws.workspaceId}\n`;
          output += `   类型: ${ws.type}\n`;
          output += `   描述: ${ws.description || '无'}\n`;
          output += `   链接: ${ws.url}\n\n`;
        });
        
        return {
          content: [{
            type: 'text',
            text: output
          }]
        };
      }

      case 'get_wiki_workspace': {
        const { workspace_id, operator_id } = args;
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }
        const result = await dingtalk.wikiRequest('workspaces');
        const workspaces = result.workspaces || [];
        const workspace = workspaces.find(ws => ws.workspaceId === workspace_id);
        
        if (!workspace) {
          return {
            content: [{
              type: 'text',
              text: `⚠️ 未找到知识库: ${workspace_id}`
            }],
            isError: true
          };
        }
        
        return {
          content: [{
            type: 'text',
            text: `📚 知识库详情\n\n${JSON.stringify(workspace, null, 2)}`
          }]
        };
      }

      case 'list_wiki_nodes': {
        const { workspace_id, parent_node_id, operator_id } = args;
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }
        
        const params = { workspaceId: workspace_id };
        if (parent_node_id) {
          params.parentNodeId = parent_node_id;
        } else {
          // 如果没有传入 parent_node_id，先获取 workspace 详情得到 rootNodeId
          const workspacesResult = await dingtalk.wikiRequest('workspaces');
          const workspace = workspacesResult.workspaces?.find(ws => ws.workspaceId === workspace_id);
          if (workspace && workspace.rootNodeId) {
            params.parentNodeId = workspace.rootNodeId;
          }
        }
        
        const result = await dingtalk.wikiRequest('nodes', params);
        const nodes = result.nodes || [];
        
        let output = `📄 知识库节点列表 (${nodes.length}个)\n\n`;
        nodes.forEach((node, index) => {
          const icon = node.type === 'FOLDER' ? '📁' : '📄';
          output += `${index + 1}. ${icon} ${node.name}\n`;
          output += `   ID: ${node.nodeId}\n`;
          output += `   类型: ${node.type}\n`;
          output += `   有子节点: ${node.hasChildren ? '是' : '否'}\n`;
          output += `   链接: ${node.url}\n\n`;
        });
        
        return {
          content: [{
            type: 'text',
            text: output
          }]
        };
      }

      case 'create_wiki_doc': {
        const { workspace_id, parent_node_id, name, doc_type = 'DOC', operator_id } = args;
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }

        try {
          const opId = await dingtalk.getCurrentUserUnionId();
          if (!opId) {
            throw new Error('未设置 operator_id，请传入 operator_id 或在配置文件中设置默认用户');
          }

          // 获取 access token
          const token = await dingtalk.getAccessToken();
          
          // 构建请求体 - 使用正确的 Document API v1.0
          const requestBody = {
            name: name,
            docType: doc_type,
            operatorId: opId
          };
          
          if (parent_node_id) {
            requestBody.parentNodeId = parent_node_id;
          }
          
          // 使用正确的 API 端点: POST /v1.0/doc/workspaces/{workspaceId}/docs
          const response = await axios({
            method: 'POST',
            url: `${DINGTALK_API_V2}/v1.0/doc/workspaces/${workspace_id}/docs`,
            headers: {
              'x-acs-dingtalk-access-token': token,
              'Content-Type': 'application/json'
            },
            data: requestBody
          });
          
          const doc = response.data;
          const nodeId = doc.nodeId || doc.id;
          const typeLabels = {
            DOC: '文档',
            WORKBOOK: '表格',
            MIND: '脑图',
            FOLDER: '文件夹'
          };
          const typeIcons = {
            DOC: '📄',
            WORKBOOK: '📊',
            MIND: '🧠',
            FOLDER: '📁'
          };
          const typeLabel = typeLabels[doc_type] || '文档';
          const typeIcon = typeIcons[doc_type] || '📄';
          const lines = [
            `✅ ${typeLabel}创建成功！`,
            '',
            `${typeIcon} ${name}`,
            `🗂️ 类型: ${doc_type}`,
            `🆔 Node ID: ${nodeId}`,
          ];

          if (doc.docKey) {
            lines.push(`🔑 DocKey（用于内容读写）: ${doc.docKey}`);
          }
          if (doc.dentryUuid) {
            lines.push(`📄 dentryUuid（用于内容读写）: ${doc.dentryUuid}`);
          }
          if (doc.url) {
            lines.push(`🔗 链接: ${doc.url}`);
          }
          if (doc.workspaceId) {
            lines.push(`📂 Workspace ID: ${doc.workspaceId}`);
          }

          setImmediate(() => {
            wikiIndex.add(nodeId || doc.docKey, {
              title: name,
              content: args.content || '',
              workspaceId: workspace_id || doc.workspaceId,
              workspaceName: '',
              url: doc.url || '',
              type: doc_type,
            });
            const contentId = doc.docKey || doc.dentryUuid || nodeId;
            if (args.content && contentId) {
              dingtalk.docRequest('POST', `/v1.0/doc/suites/documents/${contentId}/overwriteContent`, {
                operatorId: opId,
                data: { content: args.content, contentType: 'markdown' }
              }).catch(() => {});
            }
          });

          return {
            content: [{
              type: 'text',
              text: lines.join('\n')
            }]
          };
        } catch (error) {
          if (error.response?.data?.code === 'InvalidAuthentication') {
            return {
              content: [{
                type: 'text',
                text: `⚠️ Access Token 已过期或无效\n\n请稍后重试，或检查 AppKey/AppSecret 配置。`
              }],
              isError: true
            };
          }
          if (error.response?.data?.code === 'invalidRequest.workspaceNode.nameConflict') {
            return {
              content: [{
                type: 'text',
                text: `⚠️ 文档名称冲突\n\n知识库中已存在同名文档，请使用其他名称。`
              }],
              isError: true
            };
          }
          if (error.response?.data?.code?.includes('forbidden.accessDenied')) {
            return {
              content: [{
                type: 'text',
                text: `⚠️ 权限不足\n\n错误信息: ${error.response.data.message || error.message}\n\n需要申请的权限: Document.WorkspaceDocument.Write - 创建文档权限`
              }],
              isError: true
            };
          }
          throw error;
        }
      }

      case 'get_wiki_node': {
        const { node_id, operator_id } = args;
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }
        const result = await dingtalk.docRequest('GET', `/v2.0/wiki/nodes/${node_id}`, {
          operatorId: operator_id || null
        });
        const node = result.node || result;
        let output = `📄 节点详情\n\n`;
        output += `名称: ${node.name || '-'}\n`;
        output += `ID: ${node.id || node.nodeId || '-'}\n`;
        output += `类型: ${node.type || '-'}\n`;
        output += `知识库 ID: ${node.workspaceId || '-'}\n`;
        output += `父节点: ${node.parentNodeId || '-'}\n`;
        output += `创建时间: ${node.createdTime || '-'}\n`;
        output += `修改时间: ${node.modifiedTime || '-'}\n`;
        output += `URL: ${node.url || '-'}\n`;
        if (node.document) {
          output += `文档信息: ${JSON.stringify(node.document)}\n`;
        }
        return {
          content: [{ type: 'text', text: output }]
        };
      }

      case 'search_wiki': {
        const { keyword, workspace_id, max_results = 20, operator_id } = args;
        if (!keyword) {
          return {
            content: [{ type: 'text', text: '⚠️ 请提供搜索关键词 keyword' }],
            isError: true
          };
        }

        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }

        const MAX_RESULTS = Math.min(max_results, 50);
        const wsResult = await dingtalk.wikiRequest('workspaces');
        let workspaces = wsResult.workspaces || [];
        if (workspace_id) {
          workspaces = workspaces.filter(ws => ws.workspaceId === workspace_id);
        }

        if (workspaces.length === 0) {
          return {
            content: [{ type: 'text', text: '⚠️ 未找到可搜索的知识库' }],
            isError: true
          };
        }

        const matchedNodes = [];
        for (const ws of workspaces) {
          if (matchedNodes.length >= MAX_RESULTS) break;
          const queue = [ws.rootNodeId];
          const visited = new Set();
          while (queue.length > 0 && matchedNodes.length < MAX_RESULTS) {
            const dentryId = queue.shift();
            if (!dentryId || visited.has(dentryId)) continue;
            visited.add(dentryId);
            try {
              const result = await dingtalk.docRequest('GET', `/v2.0/doc/spaces/${ws.workspaceId}/directories`, {
                extraParams: dentryId !== ws.rootNodeId ? { dentryId, maxResults: 500 } : { maxResults: 500 }
              });
              const children = result.children || [];
              for (const child of children) {
                const name = child.name || '';
                if (name.includes(keyword)) {
                  matchedNodes.push({ name, nodeId: child.dentryUuid || child.dentryId || child.nodeId || child.id, workspaceId: ws.workspaceId, workspaceName: ws.name, type: child.contentType === 'folder' ? '文件夹' : '文档', url: child.url || '' });
                }
                const childId = child.dentryId || child.nodeId || child.id;
                if (child.hasChildren && childId && !visited.has(childId)) queue.push(childId);
              }
            } catch (e) { /* skip */ }
          }
        }

        let output = `🔍 搜索 "${keyword}" (${matchedNodes.length}条，按名称匹配)\n\n`;
        matchedNodes.slice(0, MAX_RESULTS).forEach((item, i) => {
          const icon = item.type === '文件夹' ? '📁' : '📄';
          output += `${i + 1}. ${icon} ${item.name}\n   知识库: ${item.workspaceName} (${item.workspaceId})\n`;
          if (item.url) output += `   链接: ${item.url}\n`;
          output += '\n';
        });
        if (matchedNodes.length === 0) {
          output += '没有找到匹配的文档或文件夹。\n';
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'search_wiki_content': {
        const { keyword, workspace_id, max_results = 20, operator_id } = args;
        if (!keyword) {
          return {
            content: [{ type: 'text', text: '⚠️ 请提供搜索关键词 keyword' }],
            isError: true
          };
        }

        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }

        if (wikiIndex.size === 0) {
          return {
            content: [{
              type: 'text',
              text: '🔍 全文搜索索引为空，请先运行 refresh_search_index 工具遍历知识库建立索引。'
            }]
          };
        }

        const MAX_RESULTS = Math.min(max_results, 50);
        let results = wikiIndex.search(keyword, MAX_RESULTS);
        if (workspace_id) {
          results = results.filter(r => r.workspaceId === workspace_id);
        }

        let output = `🔍 全文搜索 "${keyword}" (${results.length}条)\n\n`;
        results.slice(0, MAX_RESULTS).forEach((item, i) => {
          const icon = item.type === 'FOLDER' || item.type === 'folder' ? '📁' : '📄';
          output += `${i + 1}. ${icon} ${item.title}\n`;
          output += `   知识库: ${item.workspaceName} (${item.workspaceId})\n`;
          output += `   Node ID: ${item.id}\n`;
          output += `   匹配度: ${(item.score * 100).toFixed(0)}%\n`;
          if (item.url) output += `   链接: ${item.url}\n`;
          if (item.content) {
            const preview = item.content.slice(0, 120).replace(/\n+/g, ' ');
            output += `   内容预览: ${preview}${item.content.length > 120 ? '...' : ''}\n`;
          }
          output += '\n';
        });

        if (results.length === 0) {
          output += '没有找到匹配的文档。\n';
        }

        return { content: [{ type: 'text', text: output }] };
      }

      case 'list_departments': {
        const result = await dingtalk.oapiRequest('v2/department/listsub', {
          dept_id: args.dept_id || 1,
          fetch_child: args.fetch_child !== false
        });
        
        return {
          content: [{
            type: 'text',
            text: `✅ 部门列表 (${result.result?.length || 0}个)\n\n${JSON.stringify(result.result || [], null, 2)}`
          }]
        };
      }

      case 'get_department_users': {
        const { dept_id, cursor = 0, size = 50 } = args;
        const result = await dingtalk.oapiRequest('v2/user/list', {
          dept_id,
          cursor,
          size
        });
        
        return {
          content: [{
            type: 'text',
            text: `✅ 部门成员列表\n\n${JSON.stringify(result.result || {}, null, 2)}`
          }]
        };
      }

      case 'get_user_info': {
        const { userid } = args;
        const result = await dingtalk.oapiRequest('v2/user/get', {
          userid
        });

        const userInfo = result.result || {};
        let output = `✅ 用户信息\n\n${JSON.stringify(userInfo, null, 2)}\n\n`;
        if (userInfo.unionid && userInfo.userid) {
          output += `💡 提示: 将以下 userId 写入 config.json 的 defaultUser，程序会自动获取并缓存 unionId:\n   "${userInfo.userid}"`;
        }

        return {
          content: [{
            type: 'text',
            text: output
          }]
        };
      }

      case 'get_wiki_doc_content': {
        const { doc_key: docKey, workspace_id: workspaceId, operator_id } = args;
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }
        dingtalk._resolvedWorkspaceId = null;

        let realDocKey = await resolveDocKey(docKey, operator_id || null, dingtalk);
        console.error(`[DEBUG] get_wiki_doc_content: input=${docKey}, resolved=${realDocKey}`);

        const effectiveWsId = workspaceId || dingtalk._resolvedWorkspaceId;

        // 尝试 blocks API 读取 .adoc 在线文档内容
        try {
          const result = await dingtalk.docRequest('GET', `/v1.0/doc/suites/documents/${realDocKey}/blocks`, { operatorId: operator_id || null });
          const blocks = result.result?.data || [];
          let output = '';
          blocks.forEach((block) => {
            const text = extractBlockText(block);
            output += text + '\n\n';
          });
          if (!blocks.length) {
            output = '（文档为空或无可读内容）';
          }
          return {
            content: [{
              type: 'text',
              text: output.trim()
            }]
          };
        } catch (blocksErr) {
          const isDocKeyIllegal = blocksErr.message.includes('doc key is illegal');

          // Fallback: 尝试存储 v1.0 下载 API（对上传的 .md 等文件有效）
          if (isDocKeyIllegal && effectiveWsId) {
            try {
              const token = await dingtalk.getAccessToken();
              const opId = await dingtalk.resolveOperatorId(operator_id || null);

              // BFS 遍历查找 dentry
              const queue = [''];
              const visited = new Set();
              let foundDentry = null;
              let foundSpaceId = null;
              while (queue.length > 0 && !foundDentry) {
                const parentId = queue.shift();
                if (visited.has(parentId)) continue;
                visited.add(parentId);
                try {
                  const dirParams = { operatorId: opId, maxResults: 500 };
                  if (parentId) dirParams.dentryId = parentId;
                  const dirRes = await axios({
                    method: 'GET',
                    url: `${DINGTALK_API_V2}/v2.0/doc/spaces/${effectiveWsId}/directories`,
                    headers: { 'x-acs-dingtalk-access-token': token },
                    params: dirParams
                  });
                  const children = dirRes.data?.children || [];
                  for (const child of children) {
                    if (child.dentryUuid === realDocKey || child.dentryId === realDocKey || child.id === realDocKey) {
                      foundDentry = child;
                      foundSpaceId = child.spaceId;
                      break;
                    }
                    if (child.hasChildren && child.dentryId && !visited.has(child.dentryId)) {
                      queue.push(child.dentryId);
                    }
                  }
                } catch (e) { /* skip */ }
              }

              if (foundDentry && foundSpaceId) {
                const dlRes = await axios({
                  method: 'POST',
                  url: `${DINGTALK_API_V2}/v1.0/storage/spaces/${foundSpaceId}/dentries/${foundDentry.dentryId}/downloadInfos/query`,
                  headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
                  params: { unionId: opId },
                  data: {}
                });
                const data = dlRes.data;
                const downloadUrl = data.downloadInfo?.resourceUrl || data.resourceUrl || data.downloadUrl || data.url;
                const downloadHeaders = data.downloadInfo?.headers || data.headers || {};
                if (downloadUrl) {
                  const contentRes = await axios({ method: 'GET', url: downloadUrl, headers: downloadHeaders, responseType: 'text' });
                  return {
                    content: [{ type: 'text', text: contentRes.data }]
                  };
                }
              }
            } catch (fallbackErr) {
              console.error(`[钉钉MCP] 存储 v1.0 fallback 失败: ${fallbackErr.message}`);
            }
          }

          let hint = '';
          if (isDocKeyIllegal) {
            hint = `\n\n原因: 此文档不是 .adoc 在线文档，blocks API 无法读取。`;
            if (effectiveWsId) {
              hint += `\n已尝试存储 v1.0 下载 API 但仍失败（需开通 Storage.DownloadInfo.Read 权限）。`;
            } else {
              hint += `\n请提供 workspace_id 以尝试存储 v1.0 下载 API。`;
            }
          }
          return {
            content: [{
              type: 'text',
              text: `❌ 读取文档内容失败\n错误: ${blocksErr.message}${hint}\n\n调试信息:\n- 输入 doc_key: ${docKey}\n- 解析后 realDocKey: ${realDocKey}\n- workspaceId: ${effectiveWsId || '未提供'}\n- operator_id: ${operator_id || '未提供（将自动解析）'}`
            }],
            isError: true
          };
        }
      }

      case 'update_wiki_doc_content': {
        const { doc_key: docKey, content, workspace_id: workspaceId, operator_id } = args;
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }

        let realDocKey = await resolveDocKey(docKey, operator_id || null, dingtalk);

        // 尝试 overwriteContent API 写入 .adoc 在线文档内容
        try {
          await dingtalk.docRequest('POST', `/v1.0/doc/suites/documents/${realDocKey}/overwriteContent`, {
            operatorId: operator_id || null,
            data: { content, contentType: 'markdown' }
          });
        } catch (e) {
          const isDocKeyIllegal = e.message.includes('doc key is illegal');
          let hint = '';
          if (isDocKeyIllegal) {
            hint = `\n\n原因: 此文档不是 .adoc 在线文档（可能是上传的 .md 文件），不支持修改。overwriteContent 仅对 .adoc 在线文档有效。`;
          }
          return {
            content: [{ type: 'text', text: `❌ 写入文档内容失败\n${e.message}${hint}` }],
            isError: true
          };
        }
        setImmediate(() => { wikiIndex.update(docKey, { content }); });
        return {
          content: [{ type: 'text', text: '✅ 文档内容已更新' }]
        };
      }

      case 'rename_wiki_doc': {
        const { workspace_id, node_id, name, operator_id } = args;
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }
        await dingtalk.docRequest('PATCH', `/v1.0/doc/workspaces/${workspace_id}/docs/${node_id}`, {
          operatorId: operator_id || null,
          data: { name }
        });
        setImmediate(() => { wikiIndex.update(node_id, { title: name }); });
        return {
          content: [{ type: 'text', text: `✅ 文档已重命名为: ${name}` }]
        };
      }

      case 'delete_wiki_doc': {
        const { workspace_id, node_id, operator_id } = args;
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }
        await dingtalk.docRequest('DELETE', `/v1.0/doc/workspaces/${workspace_id}/docs/${node_id}`, {
          operatorId: operator_id || null
        });
        setImmediate(() => { wikiIndex.remove(node_id); });
        return {
          content: [{
            type: 'text',
            text: `✅ 文档已删除 (nodeId: ${node_id})`
          }]
        };
      }

      case 'list_notable_sheets': {
        const { base_id, operator_id } = args;
        const result = await dingtalk.notableRequest('GET', `/v1.0/notable/bases/${base_id}/sheets`, {
          operatorId: operator_id || null
        });
        const sheets = result.value || [];
        let output = `📊 数据表列表 (${sheets.length}个)\n\n`;
        sheets.forEach((sheet, index) => {
          output += `${index + 1}. ${sheet.name}\n`;
          output += `   ID: ${sheet.id}\n\n`;
        });
        if (!sheets.length) {
          output += '（没有返回任何数据表）';
        }
        output += `💡 说明: 对 .able 节点，通常直接使用 nodeId 作为 base_id。`;

        return {
          content: [{
            type: 'text',
            text: output
          }]
        };
      }

      case 'list_notable_records': {
        const { base_id, sheet_id, max_results = 20, next_token, operator_id } = args;
        const payload = {
          maxResults: max_results
        };
        if (next_token) {
          payload.nextToken = next_token;
        }
        const result = await dingtalk.notableRequest('POST', `/v1.0/notable/bases/${base_id}/sheets/${sheet_id}/records/list`, {
          operatorId: operator_id || null,
          data: payload
        });
        const records = result.records || [];
        let output = `📋 数据表记录 (${records.length}条)\n\n`;
        output += `${JSON.stringify(records, null, 2)}\n\n`;
        output += `hasMore: ${result.hasMore ? 'true' : 'false'}\n`;
        output += `nextToken: ${result.nextToken || ''}`;

        return {
          content: [{
            type: 'text',
            text: output
          }]
        };
      }

      case 'create_notable_record': {
        const { base_id, sheet_id, records, operator_id } = args;
        const result = await dingtalk.notableRequest('POST', `/v1.0/notable/bases/${base_id}/sheets/${sheet_id}/records`, {
          operatorId: operator_id || null,
          data: { records }
        });
        setImmediate(() => reindexNotableBase(base_id));
        return {
          content: [{
            type: 'text',
            text: `✅ 已创建 ${records.length} 条记录\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      }

      case 'update_notable_record': {
        const { base_id, sheet_id, records, operator_id } = args;
        const result = await dingtalk.notableRequest('PUT', `/v1.0/notable/bases/${base_id}/sheets/${sheet_id}/records`, {
          operatorId: operator_id || null,
          data: { records }
        });
        setImmediate(() => reindexNotableBase(base_id));
        return {
          content: [{
            type: 'text',
            text: `✅ 已更新 ${records.length} 条记录\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      }

      case 'delete_notable_record': {
        const { base_id, sheet_id, record_ids, operator_id } = args;
        const result = await dingtalk.notableRequest('DELETE', `/v1.0/notable/bases/${base_id}/sheets/${sheet_id}/records`, {
          operatorId: operator_id || null,
          data: { recordIds: record_ids }
        });
        setImmediate(() => reindexNotableBase(base_id));
        return {
          content: [{
            type: 'text',
            text: `✅ 已删除 ${record_ids.length} 条记录`
          }]
        };
      }

      case 'create_notable_sheet': {
        const { base_id, name, fields, operator_id } = args;
        const data = { name };
        if (fields) {
          data.fields = fields;
        }
        const result = await dingtalk.notableRequest('POST', `/v1.0/notable/bases/${base_id}/sheets`, {
          operatorId: operator_id || null,
          data
        });
        return {
          content: [{
            type: 'text',
            text: `✅ 数据表已创建\n\n${JSON.stringify(result, null, 2)}`
          }]
        };
      }

      case 'delete_notable_sheet': {
        const { base_id, sheet_id, operator_id } = args;
        await dingtalk.notableRequest('DELETE', `/v1.0/notable/bases/${base_id}/sheets/${sheet_id}`, {
          operatorId: operator_id || null
        });
        return {
          content: [{
            type: 'text',
            text: `✅ 数据表已删除 (sheetId: ${sheet_id})`
          }]
        };
      }

      case 'refresh_search_index': {
        const { operator_id } = args || {};
        if (operator_id) {
          dingtalk.setOperatorId(operator_id);
        }
        rebuildSearchIndex().catch(e => console.error('[钉钉MCP] 索引重建失败:', e.message));
        return {
          content: [{
            type: 'text',
            text: '🔄 搜索索引全量重建已启动（后台运行），完成后搜索将支持全文检索。\n\n这可能需要一些时间，取决于知识库中文档的数量和内容长度。'
          }]
        };
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ 错误: ${error.message}`
      }],
      isError: true
    };
  }
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('钉钉 Wiki MCP Server 已启动 v2.0');
  console.error(`Config via DINGTALK_WIKI_CONFIG env var`);
}

main().catch(console.error);
