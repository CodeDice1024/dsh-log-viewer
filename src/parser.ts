/**
 * dsh-log-viewer - 日志解析器
 *
 * 专为 K8s 导出的 Spring Boot (Logback) 日志设计。
 * 支持：自动格式检测、多行堆栈追踪、K8s 线程类型识别、Spring 异常模式匹配。
 */

// ============================================================
// 类型定义
// ============================================================

/** 日志级别枚举 */
export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'UNKNOWN'

/** K8s 线程类型 */
export type K8sThreadType =
  | 'xxl-job'           // XXL-JOB 定时任务线程
  | 'pool-thread'       // 通用线程池 (pool-N-thread-N)
  | 'worker-thread'     // 工作线程 (wr-org-N)
  | 'http-nio'          // Tomcat HTTP NIO 线程
  | 'main'              // 主线程
  | 'scheduler'         // Spring @Scheduled 线程
  | 'async'             // Spring @Async 线程
  | 'unknown'           // 未识别

/** 单条解析后的日志条目 */
export interface LogEntry {
  /** 原始时间戳字符串 */
  timestamp: string
  /** 解析后的 Date 对象（解析失败时为 null） */
  date: Date | null
  /** 线程名称 */
  thread: string
  /** K8s 线程类型分类 */
  threadType: K8sThreadType
  /** 日志级别 */
  level: LogLevel
  /** Logger 类名（如 com.example.service.UserService） */
  logger: string
  /** 行号（如果日志中包含） */
  line: string
  /** 日志消息（首行） */
  message: string
  /** 完整内容（包含堆栈追踪） */
  fullMessage: string
  /** 是否为异常/堆栈追踪条目 */
  isException: boolean
  /** 异常类名（如果检测到） */
  exceptionClass: string | null
  /** 异常消息（如果检测到） */
  exceptionMessage: string | null
}

/** 日志分析汇总结果 */
export interface LogSummary {
  /** 总条目数 */
  totalEntries: number
  /** 时间范围 */
  timeRange: {
    start: string | null
    end: string | null
    durationMs: number | null
  }
  /** 各级别计数 */
  levelCounts: Record<string, number>
  /** 线程类型分布 */
  threadTypeCounts: Record<string, number>
  /** Top N 异常类 */
  topExceptions: Array<{ className: string; count: number; sampleMessage: string }>
  /** Top N Logger */
  topLoggers: Array<{ logger: string; count: number }>
  /** 错误频率时间线（按分钟分桶） */
  errorTimeline: Array<{ minute: string; count: number }>
  /** ERROR 级别日志条目列表 */
  errorEntries: LogEntry[]
}

// ============================================================
// 正则表达式常量
// ============================================================

/**
 * 常见 Java 服务文本日志（Logback / Log4j）：
 * 2024-01-15 10:23:45.678 [http-nio-8080-exec-1] INFO  c.e.s.UserService - User logged in
 * 2024-01-15 10:23:45,678 [http-nio-8080-exec-1] ERROR c.e.s.UserService - java.lang.NullPointerException: x
 * 也兼容：级别在线程前、Logger 带行号
 */
const TS = String.raw`(?<timestamp>\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)`
const LEVEL = String.raw`(?<level>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)`
const THREAD = String.raw`\[(?<thread>[^\]]+)\]`
/** 行号允许 `:69` / `: 69`；后面还可跟 `[File.java : 12] [AUTO_WRITE]` 这类切面标记 */
const LOGGER = String.raw`(?<logger>\S+?)(?::\s*(?<line>\d+))?(?:\s+\[[^\]]+\])*`
const MSG = String.raw`(?<message>.*)`

/** pattern A: 时间 [线程] 级别 Logger - 消息（Logback 默认） */
const PATTERN_THREAD_THEN_LEVEL = new RegExp(
  `^${TS}\\s+${THREAD}\\s+${LEVEL}\\s+${LOGGER}\\s*-\\s*${MSG}$`
)

/** pattern B: 时间 级别 [线程] Logger - 消息（部分 Log4j / 自定义） */
const PATTERN_LEVEL_THEN_THREAD = new RegExp(
  `^${TS}\\s+${LEVEL}\\s+${THREAD}\\s+${LOGGER}\\s*-\\s*${MSG}$`
)

const LINE_PATTERNS = [PATTERN_THREAD_THEN_LEVEL, PATTERN_LEVEL_THEN_THREAD]

/** Caused by 行 */
const CAUSED_BY_PATTERN = /^Caused by:\s+(?<className>[\w.$]+)(?::\s*(?<message>.*))?$/

/** 顶层异常行 / 消息中的异常类 */
const TOP_EXCEPTION_PATTERN = /^([\w.$]+(?:Exception|Error))(?::\s*(.*))?$/
/** 消息/行内异常：避免匹配到 "nested exception is xxx" 里的碎片 */
const INLINE_EXCEPTION_PATTERN = /(?:^|[\s;:])((?:[a-z][a-z0-9_]*\.)+[A-Z][\w$]*(?:Exception|Error)|[A-Z][\w$]*(?:Exception|Error))(?::\s*([^\n]*))?/

/** K8s 线程类型识别正则 */
const K8S_THREAD_PATTERNS: Array<{ pattern: RegExp; type: K8sThreadType }> = [
  { pattern: /^xxl-job/i, type: 'xxl-job' },
  { pattern: /^pool-\d+-thread-\d+$/, type: 'pool-thread' },
  { pattern: /^wr-org-\d+/, type: 'worker-thread' },
  { pattern: /^http-nio/i, type: 'http-nio' },
  { pattern: /^main$/, type: 'main' },
  { pattern: /^scheduling-\d+/i, type: 'scheduler' },
  { pattern: /^@Async|task-\d+/i, type: 'async' },
]

/** Spring / Hibernate 常见异常类名模式 */
const SPRING_EXCEPTION_PATTERNS = [
  /org\.springframework\.\w+Exception/,
  /org\.hibernate\.\w+Exception/,
  /java\.sql\.\w+Exception/,
  /jakarta\.\w+Exception/,
  /com\.fasterxml\.jackson\.\w+Exception/,
  /io\.lettuce\.\w+Exception/,
  /org\.apache\.kafka\.\w+Exception/,
  /redis\.clients\.jedis\.exceptions\.\w+Exception/,
]

// ============================================================
// 解析函数
// ============================================================

/**
 * 检测线程的 K8s 类型
 */
export function classifyThread(thread: string): K8sThreadType {
  for (const { pattern, type } of K8S_THREAD_PATTERNS) {
    if (pattern.test(thread)) return type
  }
  return 'unknown'
}

/**
 * 尝试从一行文本中提取异常类名与消息
 */
function detectException(line: string): { className: string; message: string | null } | null {
  const causedMatch = CAUSED_BY_PATTERN.exec(line.trim())
  if (causedMatch?.groups?.className) {
    return {
      className: causedMatch.groups.className,
      message: causedMatch.groups.message ?? null,
    }
  }

  const trimmed = line.trim()
  const nested = /(?:^|[\s;])(?:nested\s+)?exception\s+is\s+([\w.$]+(?:Exception|Error))(?::\s*(.*))?/i.exec(trimmed)
  if (nested) {
    return { className: nested[1], message: nested[2] ?? null }
  }

  const topMatch = TOP_EXCEPTION_PATTERN.exec(trimmed)
  if (topMatch) {
    return { className: topMatch[1], message: topMatch[2] ?? null }
  }

  const inline = INLINE_EXCEPTION_PATTERN.exec(trimmed)
  if (inline) {
    return { className: inline[1], message: inline[2] ?? null }
  }

  return null
}

/**
 * 解析时间戳字符串为 Date（兼容 `.` / `,` 毫秒分隔）
 */
function parseTimestamp(ts: string): Date | null {
  try {
    const normalized = ts.replace(' ', 'T').replace(',', '.')
    const d = new Date(normalized)
    return isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/** 尝试用多种格式匹配日志首行 */
function matchLogLine(line: string): RegExpExecArray | null {
  for (const pattern of LINE_PATTERNS) {
    const match = pattern.exec(line)
    if (match?.groups) return match
  }
  return null
}

/** 把首行消息里的异常信息写进 entry */
function applyExceptionFromText(entry: LogEntry, text: string): void {
  const detected = detectException(text)
  if (!detected) return
  entry.isException = true
  if (!entry.exceptionClass) {
    entry.exceptionClass = detected.className
    entry.exceptionMessage = detected.message
  }
}

/**
 * 解析日志文本为结构化条目数组
 *
 * @param rawLog - 原始日志文本（可包含多行堆栈追踪）
 * @returns 解析后的日志条目数组
 */
export function parseLog(rawLog: string): LogEntry[] {
  const lines = rawLog.split(/\r?\n/)
  const entries: LogEntry[] = []
  let current: LogEntry | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 尝试匹配日志首行（多种 Java 文本格式）
    const match = matchLogLine(line)

    if (match?.groups) {
      if (current) entries.push(current)

      const { timestamp, thread, level, logger, line: lineNo, message } = match.groups

      current = {
        timestamp,
        date: parseTimestamp(timestamp),
        thread,
        threadType: classifyThread(thread),
        level: level as LogLevel,
        logger,
        line: lineNo ?? '',
        message,
        fullMessage: line,
        isException: false,
        exceptionClass: null,
        exceptionMessage: null,
      }

      // 消息首行里就带异常类名（很常见）
      applyExceptionFromText(current, message)
      continue
    }

    // 非首行 → 属于当前条目的堆栈追踪
    if (current) {
      current.fullMessage += '\n' + line

      if (/^\s+at\s+/.test(line) || /^\s*\.\.\.\s+\d+\s+more/.test(line)) {
        current.isException = true
      }

      applyExceptionFromText(current, line)
    }
  }

  if (current) entries.push(current)

  return entries
}

/**
 * 分析日志并返回汇总统计
 */
export function analyzeLog(entries: LogEntry[]): LogSummary {
  const levelCounts: Record<string, number> = {}
  const threadTypeCounts: Record<string, number> = {}
  const exceptionMap = new Map<string, { count: number; sampleMessage: string }>()
  const loggerMap = new Map<string, number>()
  const errorTimelineMap = new Map<string, number>()
  const errorEntries: LogEntry[] = []

  let startDate: Date | null = null
  let endDate: Date | null = null

  for (const entry of entries) {
    // 级别计数
    levelCounts[entry.level] = (levelCounts[entry.level] ?? 0) + 1

    // 线程类型计数
    threadTypeCounts[entry.threadType] = (threadTypeCounts[entry.threadType] ?? 0) + 1

    // Logger 计数
    loggerMap.set(entry.logger, (loggerMap.get(entry.logger) ?? 0) + 1)

    // 异常计数
    if (entry.exceptionClass) {
      const existing = exceptionMap.get(entry.exceptionClass)
      if (existing) {
        existing.count++
      } else {
        exceptionMap.set(entry.exceptionClass, {
          count: 1,
          sampleMessage: entry.exceptionMessage ?? entry.message,
        })
      }
    }

    // ERROR 级别特殊处理
    if (entry.level === 'ERROR' || entry.level === 'FATAL') {
      errorEntries.push(entry)

      // 按分钟分桶
      if (entry.date) {
        const minute = entry.date.toISOString().slice(0, 16) // YYYY-MM-DDTHH:mm
        errorTimelineMap.set(minute, (errorTimelineMap.get(minute) ?? 0) + 1)
      }
    }

    // 时间范围
    if (entry.date) {
      if (!startDate || entry.date < startDate) startDate = entry.date
      if (!endDate || entry.date > endDate) endDate = entry.date
    }
  }

  // Top N 异常（按 count 降序）
  const topExceptions = Array.from(exceptionMap.entries())
    .map(([className, { count, sampleMessage }]) => ({ className, count, sampleMessage }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  // Top N Logger
  const topLoggers = Array.from(loggerMap.entries())
    .map(([logger, count]) => ({ logger, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  // 错误频率时间线（按时间排序）
  const errorTimeline = Array.from(errorTimelineMap.entries())
    .map(([minute, count]) => ({ minute, count }))
    .sort((a, b) => a.minute.localeCompare(b.minute))

  // 时间范围
  const durationMs = startDate && endDate ? endDate.getTime() - startDate.getTime() : null

  return {
    totalEntries: entries.length,
    timeRange: {
      start: startDate?.toISOString() ?? null,
      end: endDate?.toISOString() ?? null,
      durationMs,
    },
    levelCounts,
    threadTypeCounts,
    topExceptions,
    topLoggers,
    errorTimeline,
    errorEntries,
  }
}

/**
 * 在日志条目中搜索关键字
 *
 * @param entries - 日志条目数组
 * @param keyword - 搜索关键字（大小写不敏感）
 * @param options - 搜索选项
 * @returns 匹配的日志条目数组
 */
export function searchLog(
  entries: LogEntry[],
  keyword: string,
  options?: { level?: LogLevel; maxResults?: number }
): LogEntry[] {
  const lowerKeyword = keyword.toLowerCase()
  const maxResults = options?.maxResults ?? 50

  return entries.filter(entry => {
    // 级别过滤
    if (options?.level && entry.level !== options.level) return false

    // 全文搜索（包括堆栈追踪）
    return entry.fullMessage.toLowerCase().includes(lowerKeyword)
  }).slice(0, maxResults)
}

/**
 * 提取所有异常/堆栈追踪条目
 *
 * @param entries - 日志条目数组
 * @param options - 选项
 * @returns 异常条目数组（按异常类名分组）
 */
export function getExceptions(
  entries: LogEntry[],
  options?: { className?: string; maxResults?: number }
): Array<{ className: string; entries: LogEntry[] }> {
  const maxResults = options?.maxResults ?? 10

  // 过滤出异常条目
  let exceptionEntries = entries.filter(e => e.isException && e.exceptionClass)

  // 按类名过滤
  if (options?.className) {
    const lowerClass = options.className.toLowerCase()
    exceptionEntries = exceptionEntries.filter(
      e => e.exceptionClass!.toLowerCase().includes(lowerClass)
    )
  }

  // 按异常类名分组
  const grouped = new Map<string, LogEntry[]>()
  for (const entry of exceptionEntries) {
    const key = entry.exceptionClass!
    const group = grouped.get(key) ?? []
    group.push(entry)
    grouped.set(key, group)
  }

  // 返回分组结果（限制每组条目数）
  return Array.from(grouped.entries())
    .map(([className, entries]) => ({ className, entries: entries.slice(0, maxResults) }))
    .sort((a, b) => b.entries.length - a.entries.length)
}

/**
 * 格式化日志汇总为人类可读的文本报告
 */
export function formatSummary(summary: LogSummary): string {
  const lines: string[] = []

  lines.push(`## 日志分析摘要`)
  lines.push(`- **总条目数**：${summary.totalEntries}`)

  if (summary.timeRange.start && summary.timeRange.end) {
    lines.push(`- **时间范围**：${summary.timeRange.start} → ${summary.timeRange.end}`)
    if (summary.timeRange.durationMs !== null) {
      const mins = Math.round(summary.timeRange.durationMs / 60000)
      lines.push(`- **跨度**：${mins} 分钟`)
    }
  }

  lines.push('')
  lines.push('### 日志级别分布')
  for (const [level, count] of Object.entries(summary.levelCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / summary.totalEntries) * 100).toFixed(1)
    lines.push(`- ${level}: ${count} (${pct}%)`)
  }

  lines.push('')
  lines.push('### 线程类型分布')
  for (const [type, count] of Object.entries(summary.threadTypeCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${type}: ${count}`)
  }

  if (summary.topExceptions.length > 0) {
    lines.push('')
    lines.push('### Top 异常')
    for (const exc of summary.topExceptions.slice(0, 10)) {
      lines.push(`- **${exc.className}** (${exc.count} 次): ${exc.sampleMessage}`)
    }
  }

  if (summary.topLoggers.length > 0) {
    lines.push('')
    lines.push('### Top Logger')
    for (const lg of summary.topLoggers.slice(0, 10)) {
      lines.push(`- ${lg.logger}: ${lg.count}`)
    }
  }

  return lines.join('\n')
}

/**
 * 格式化搜索结果为人可读文本
 */
export function formatSearchResults(results: LogEntry[], keyword: string): string {
  if (results.length === 0) return `未找到包含 "${keyword}" 的日志条目。`

  const lines: string[] = []
  lines.push(`## 搜索结果：找到 ${results.length} 条包含 "${keyword}" 的日志`)
  lines.push('')

  for (let i = 0; i < results.length; i++) {
    const e = results[i]
    lines.push(`### [${i + 1}] ${e.timestamp} [${e.level}] ${e.thread}`)
    lines.push(`- Logger: ${e.logger}`)
    lines.push(`- 消息: ${e.message}`)
    if (e.isException) {
      lines.push(`- 异常: ${e.exceptionClass}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 格式化异常提取结果
 */
export function formatExceptions(groups: Array<{ className: string; entries: LogEntry[] }>): string {
  if (groups.length === 0) return '未找到匹配的异常条目。'

  const lines: string[] = []
  const totalEntries = groups.reduce((sum, g) => sum + g.entries.length, 0)
  lines.push(`## 异常提取结果：${groups.length} 种异常，共 ${totalEntries} 条`)
  lines.push('')

  for (const group of groups) {
    lines.push(`### ${group.className} (${group.entries.length} 次)`)
    for (let i = 0; i < Math.min(group.entries.length, 3); i++) {
      const e = group.entries[i]
      lines.push(`- **${e.timestamp}** [${e.thread}]: ${e.message}`)
      // 截取堆栈前 5 行
      const stackLines = e.fullMessage.split('\n').slice(1, 6)
      if (stackLines.length > 0) {
        lines.push('  ```')
        for (const sl of stackLines) lines.push('  ' + sl.trimEnd())
        lines.push('  ```')
      }
    }
    if (group.entries.length > 3) {
      lines.push(`- ... 还有 ${group.entries.length - 3} 条`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
