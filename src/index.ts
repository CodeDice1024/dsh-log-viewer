/**
 * dsh-log-viewer - 插件入口
 *
 * 注册三个 AI 工具：analyze_log、search_log、get_exceptions
 * 注入日志分析领域知识（SKILL.md）
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  parseLog,
  analyzeLog,
  searchLog,
  getExceptions,
  formatSummary,
  formatSearchResults,
  formatExceptions,
  type LogEntry,
} from './parser.js'

// ============================================================
// 插件元数据
// ============================================================

/** 插件名称（诊断日志中标识） */
export const name = 'dsh-log-viewer'

/** 声明依赖：需要 tools 服务就绪后才能注册工具 */
export const inject = ['tools']

// ============================================================
// 日志文件缓存
// ============================================================

/**
 * 简单的文件级缓存，避免同一会话内重复解析大文件。
 * key = 文件路径，value = { entries, mtime }
 */
interface CacheEntry {
  entries: LogEntry[]
  /** 缓存时间戳，超过 60 秒失效 */
  cachedAt: number
}

const fileCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000 // 60 秒

/**
 * 读取并解析日志文件（带缓存）
 */
function loadLogEntries(filePath: string): LogEntry[] {
  const absPath = resolve(filePath)
  const now = Date.now()
  const cached = fileCache.get(absPath)

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.entries
  }

  const raw = readFileSync(absPath, 'utf-8')
  const entries = parseLog(raw)

  fileCache.set(absPath, { entries, cachedAt: now })
  return entries
}

// ============================================================
// 插件主体
// ============================================================

export function apply(ctx: Context) {
  ctx.logger.info('dsh-log-viewer 已加载 — Java 日志分析（Web + AI 工具）就绪')

  // ----------------------------------------------------------
  // 工具 1: analyze_log — 日志分析摘要
  // ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'analyze_log',
    description:
      '分析 Java 服务文本日志文件并返回汇总统计报告。包括：总条目数、时间范围、日志级别分布、线程类型分布、Top 异常列表、Top Logger、错误频率时间线。' +
      '适用于 Spring Boot / Logback / Log4j 常见文本格式，自动识别异常类名与堆栈（含 Caused by）。',

    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: '日志文件的绝对路径或相对路径，如 /tmp/app.log 或 ./logs/spring.log',
      },
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          report: { type: 'string', description: 'Markdown 格式的分析报告' },
          totalEntries: { type: 'number', description: '总日志条目数' },
          errorCount: { type: 'number', description: 'ERROR 级别条目数' },
          exceptionCount: { type: 'number', description: '异常条目数' },
          topExceptions: {
            type: 'array',
            description: 'Top 异常列表',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.report as string,
      }],
    },

    async execute(args, exec) {
      const entries = loadLogEntries(args.file_path)
      const summary = analyzeLog(entries)
      const report = formatSummary(summary)

      return {
        report,
        totalEntries: summary.totalEntries,
        errorCount: summary.errorEntries.length,
        exceptionCount: summary.topExceptions.reduce((sum, e) => sum + e.count, 0),
        topExceptions: summary.topExceptions.slice(0, 5),
      }
    },
  }))

  // ----------------------------------------------------------
  // 工具 2: search_log — 日志关键字搜索
  // ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'search_log',
    description:
      '在日志文件中搜索包含指定关键字的条目。支持按日志级别过滤。' +
      '搜索范围包括日志消息和堆栈追踪全文（大小写不敏感）。最多返回 50 条结果。',

    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: '日志文件路径',
      },
      keyword: {
        type: 'string',
        required: true,
        description: '搜索关键字（大小写不敏感），如 "OutOfMemoryError" 或 "用户登录失败"',
      },
      level: {
        type: 'string',
        description: '按日志级别过滤',
        enum: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'],
      },
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          report: { type: 'string', description: 'Markdown 格式的搜索结果' },
          matchCount: { type: 'number', description: '匹配条目数' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.report as string,
      }],
    },

    async execute(args, exec) {
      const entries = loadLogEntries(args.file_path)
      const results = searchLog(entries, args.keyword, {
        level: args.level as any,
        maxResults: 50,
      })
      const report = formatSearchResults(results, args.keyword)

      return { report, matchCount: results.length }
    },
  }))

  // ----------------------------------------------------------
  // 工具 3: get_exceptions — 异常/堆栈追踪提取
  // ----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'get_exceptions',
    description:
      '从日志文件中提取所有异常和堆栈追踪信息，按异常类名分组。' +
      '自动识别 Spring、Hibernate、JDBC、Jackson 等框架的异常模式。' +
      '可指定异常类名进行过滤。每组最多返回 10 条样例。',

    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: '日志文件路径',
      },
      class_name: {
        type: 'string',
        description: '按异常类名过滤（模糊匹配），如 "NullPointerException" 或 "HibernateException"',
      },
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          report: { type: 'string', description: 'Markdown 格式的异常提取报告' },
          exceptionTypeCount: { type: 'number', description: '异常种类数' },
          totalExceptionEntries: { type: 'number', description: '异常条目总数' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.report as string,
      }],
    },

    async execute(args, exec) {
      const entries = loadLogEntries(args.file_path)
      const groups = getExceptions(entries, {
        className: args.class_name,
        maxResults: 10,
      })
      const report = formatExceptions(groups)
      const totalExceptionEntries = groups.reduce((sum, g) => sum + g.entries.length, 0)

      return {
        report,
        exceptionTypeCount: groups.length,
        totalExceptionEntries,
      }
    },
  }))

  // ----------------------------------------------------------
  // 注册 SKILL.md 领域知识
  // ----------------------------------------------------------
  const skills = ctx.get('skills')
  if (skills) {
    try {
      const skillPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../skills/log-analysis.md'
      )
      skills.register({
        name: 'log-analysis',
        description: 'K8s Spring Boot 日志分析最佳实践指南',
        content: readFileSync(skillPath, 'utf8'),
        source: 'runtime',
        provider: 'dsh-log-viewer',
      })
      ctx.logger.info('log-analysis 技能已注册')
    } catch (e) {
      ctx.logger.warn('SKILL.md 加载失败（不影响工具使用）:', e)
    }
  }

  // ----------------------------------------------------------
  // 注册 Web UI：等 webServer 就绪后再挂路由（不能用同步 ctx.get，会拿不到）
  // ----------------------------------------------------------
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const htmlPath = resolve(pluginDir, '../ui/index.html')

  const buttonStyle = `
#dsh-log-viewer-btn {
  position: fixed; bottom: 24px; right: 24px; z-index: 99999;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 18px;
  background: linear-gradient(135deg, #58a6ff 0%, #3b82f6 100%);
  color: #fff; border: none; border-radius: 28px;
  font-size: 14px; font-weight: 600; cursor: pointer;
  box-shadow: 0 4px 16px rgba(59,130,246,0.4);
  text-decoration: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
#dsh-log-viewer-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(59,130,246,0.5);
}`

  const buttonHtml = `<a id="dsh-log-viewer-btn" href="/log-viewer" target="_blank" rel="noopener" title="打开日志分析仪表盘">日志分析</a>`

  async function readRequestBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8')
  }

  function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(text)
  }

  /** 无模型时的兜底：按异常统计给一份可读结论 */
  function ruleBasedAiReport(payload: {
    fileName?: string
    totalEntries?: number
    errorCount?: number
    topExceptions?: Array<{ className: string; count: number; sampleMessage?: string }>
    samples?: string[]
  }): string {
    const tops = payload.topExceptions ?? []
    const lines: string[] = []
    lines.push('## 异常快速研判（规则引擎，未调用大模型）')
    lines.push('')
    lines.push(`- 文件：${payload.fileName ?? '未知'}`)
    lines.push(`- 日志条目：${payload.totalEntries ?? 0}，ERROR 约 ${payload.errorCount ?? 0}`)
    lines.push(`- 异常种类：${tops.length}`)
    lines.push('')
    if (tops.length === 0) {
      lines.push('未提取到明确异常类名。建议先在仪表盘按 ERROR 过滤，或检查是否多为 WARN。')
      return lines.join('\n')
    }
    lines.push('### 主要异常')
    for (const t of tops.slice(0, 8)) {
      lines.push(`- **${t.className}** × ${t.count}${t.sampleMessage ? ` — ${t.sampleMessage.slice(0, 120)}` : ''}`)
    }
    lines.push('')
    lines.push('### 建议排查方向')
    const joined = tops.map(t => t.className).join(' ')
    if (/SQLGrammar|InvalidDataAccess|JDBC|SQLException/i.test(joined)) {
      lines.push('1. 优先查数据库：SQL 语法、表结构变更、只读库延迟、连接池耗尽。')
      lines.push('2. 对照近期 DDL / 迁移脚本与实体映射是否一致。')
    }
    if (/NullPointer|IllegalState|IllegalArgument/i.test(joined)) {
      lines.push('1. 空指针/状态异常：核对入参与缓存是否未初始化。')
      lines.push('2. 在对应 Service 打点，确认空值来源（上游接口 / 配置 / 组织数据）。')
    }
    if (/ConnectException|Timeout|Rabbit|Redis|Kafka/i.test(joined)) {
      lines.push('1. 中间件连通性：网络策略、凭证、集群节点是否存活。')
    }
    if (/BusinessException/i.test(joined)) {
      lines.push('1. 业务校验失败：按 sample 里的业务语义核对主数据是否缺失。')
    }
    lines.push('3. 在 DSH 对话里也可说：`用 get_exceptions 分析该日志文件`，让 Agent 继续深挖。')
    return lines.join('\n')
  }

  async function runLlmExceptionAnalysis(
    webCtx: Context,
    payload: {
      fileName?: string
      totalEntries?: number
      errorCount?: number
      topExceptions?: Array<{ className: string; count: number; sampleMessage?: string }>
      samples?: string[]
    },
  ): Promise<{ report: string; source: 'llm' | 'rules' }> {
    const llm = webCtx.get('llm')
    if (!llm) {
      return { report: ruleBasedAiReport(payload), source: 'rules' }
    }

    const providers = llm.listProviders()
    if (providers.length === 0) {
      return { report: ruleBasedAiReport(payload) + '\n\n> 提示：当前未配置可用模型，已使用规则研判。请在 DSH Settings → Models 填入 API Key。', source: 'rules' }
    }

    // 只用当前会话选中的模型，没有则回退到规则研判
    const preferred = webCtx.get('agentDefaultModel')?.currentSelection()
    let provider = preferred?.provider
    let model = preferred?.model
    if (!provider || !providers.some(p => p.id === provider)) {
      return { report: ruleBasedAiReport(payload) + '\n\n> 当前会话未设置模型，已使用规则研判。请在对话中先选择模型。', source: 'rules' }
    }
    if (!model) {
      const models = await llm.listModels(provider)
      model = models[0]?.id
    }
    if (!model) {
      return { report: ruleBasedAiReport(payload) + `\n\n> 提示：提供商 ${provider} 没有可用模型。`, source: 'rules' }
    }

    const digest = {
      fileName: payload.fileName,
      totalEntries: payload.totalEntries,
      errorCount: payload.errorCount,
      topExceptions: (payload.topExceptions ?? []).slice(0, 10),
      stackSamples: (payload.samples ?? []).slice(0, 6).map(s => s.slice(0, 800)),
    }

    const prompt =
      '你是资深 Java / Spring Boot 排障专家。根据下面的日志异常摘要，用中文给出简洁可执行的分析报告。\n' +
      '要求：\n' +
      '1. 先给「结论」：最可能的根因（1-3 条）\n' +
      '2. 再给「证据」：对应异常类与业务含义\n' +
      '3. 最后给「下一步动作」：可操作的排查/修复步骤（含建议看哪些配置、表、接口）\n' +
      '不要编造日志里没有的类名。\n\n' +
      '```json\n' + JSON.stringify(digest, null, 2) + '\n```'

    const message = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-log-viewer' },
    })

    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider,
        model,
        system: 'You analyze Java service logs. Reply in concise Chinese markdown.',
        messages: [message],
        maxTokens: 2048,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? 'llm finish with error')
        }
      }
    } catch (err) {
      webCtx.logger.warn('dsh-log-viewer AI analyze failed, fallback to rules:', err)
      return {
        report: ruleBasedAiReport(payload) + `\n\n> 大模型调用失败（${provider}/${model}）：${err instanceof Error ? err.message : String(err)}`,
        source: 'rules',
      }
    }

    if (!text.trim()) {
      return { report: ruleBasedAiReport(payload) + '\n\n> 模型返回为空，已回退规则研判。', source: 'rules' }
    }
    return { report: text.trim(), source: 'llm' }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/log-viewer',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const pathname = url.pathname.replace(/\/$/, '') || '/log-viewer'

        // POST /log-viewer/api/ai-analyze
        if (pathname === '/log-viewer/api/ai-analyze' && req.method === 'POST') {
          try {
            const raw = await readRequestBody(req)
            const payload = JSON.parse(raw || '{}') as {
              fileName?: string
              totalEntries?: number
              errorCount?: number
              topExceptions?: Array<{ className: string; count: number; sampleMessage?: string }>
              samples?: string[]
            }
            const result = await runLlmExceptionAnalysis(webCtx, payload)
            jsonResponse(res, 200, result)
          } catch (err) {
            jsonResponse(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            })
          }
          return
        }

        // 默认：仪表盘页面
        if (req.method === 'GET' || req.method === 'HEAD') {
          try {
            const html = readFileSync(htmlPath, 'utf-8')
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            if (req.method === 'HEAD') res.end()
            else res.end(html)
          } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Failed to load log viewer dashboard')
          }
          return
        }

        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Method Not Allowed')
      },
    }), 'dsh-log-viewer: /log-viewer')

    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text: buttonStyle })
      table.push({ kind: 'html', placement: 'body', html: buttonHtml })
    })

    webCtx.effect(() => webCtx.webServer.tapIndex((html: string) => {
      if (html.includes('id="dsh-log-viewer-btn"')) return html
      if (html.includes('</body>')) {
        return html.replace('</body>', `<style>${buttonStyle}</style>${buttonHtml}\n</body>`)
      }
      return `${html}<style>${buttonStyle}</style>${buttonHtml}`
    }), 'dsh-log-viewer: tapIndex button')

    webCtx.logger.info('dsh-log-viewer Web UI ready: /log-viewer + /log-viewer/api/ai-analyze')
  })
}
