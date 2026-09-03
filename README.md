# dsh-log-viewer — Java 日志分析插件

[![npm version](https://img.shields.io/npm/v/dsh-log-viewer)](https://www.npmjs.com/package/dsh-log-viewer)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-%234A90D9)](https://github.com/topics/dsh-plugin)

选择本机 Java 服务文本日志，看异常统计，并可一键 AI 研判。  
适用于 Spring Boot / Logback / Log4j 常见文本格式，自动识别异常类名与堆栈（含 Caused by）。

## 安装

### 方式一：一键安装（推荐）

```powershell
dsh plugin --profile web add dsh-log-viewer
```

### 方式二：从 GitHub 安装

```powershell
dsh plugin --profile web add github:CodeDice1024/dsh-log-viewer
```

### 方式三：本地开发测试

```powershell
cd D:\deepseek\deepseek-harness
pnpm dsh web --patch ./scratch-plugin/dsh-log-viewer/cordis.yml --no-open
```

## 使用

1. 打开 http://127.0.0.1:3080 → 右下角 **「日志分析」**
2. 或直接访问 http://127.0.0.1:3080/log-viewer
3. 选择 `.log` 文件 → 查看仪表盘 → 点击 **「AI 分析异常」**
4. 在对话中也可直接说：`分析一下 test.log`

## 能力

| 能力 | 说明 |
|------|------|
| 📊 Web 仪表盘 | 紧凑选文件、日志级别分布、异常统计、时间线 |
| 🤖 AI 分析 | `/log-viewer/api/ai-analyze`，自动调用默认模型 |
| 🔧 AI 工具 | `analyze_log` / `search_log` / `get_exceptions` 三个对话工具 |

## 工具说明

| 工具名 | 功能 |
|--------|------|
| `analyze_log` | 分析日志文件，返回汇总统计报告 |
| `search_log` | 按关键字搜索日志条目 |
| `get_exceptions` | 提取异常和堆栈追踪信息 |

## 日志格式注意

支持 `Logger: 69 -`（冒号后有空格）、线程名带逗号、切面 `[File.java : n] [AUTO_WRITE]` 等线上常见写法。

## 开发

```powershell
git clone https://github.com/CodeDice1024/dsh-log-viewer.git
cd dsh-log-viewer
# 在 DSH 源码目录中测试
pnpm dsh web --patch ./cordis.yml
```
