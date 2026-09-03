---
name: log-analysis
description: K8s Spring Boot (Logback) 日志分析最佳实践指南
---

# K8s Spring Boot 日志分析指南

## 何时使用
当用户提供 K8s 导出的日志文件（通常为 `.log` 或 `.txt` 格式），需要进行以下分析时使用：
- 问题排查：定位 ERROR/WARN 日志和异常堆栈
- 健康评估：查看日志级别分布、错误频率趋势
- 性能分析：识别高频线程和慢操作

## 日志格式说明

本插件专为 Spring Boot / Logback 默认格式设计：

```
2024-01-15 10:23:45.678 [http-nio-8080-exec-1] INFO  c.e.s.UserService:42 - User logged in
```

字段说明：
- `2024-01-15 10:23:45.678` — 时间戳（精确到毫秒）
- `[http-nio-8080-exec-1]` — 线程名称
- `INFO` — 日志级别（TRACE/DEBUG/INFO/WARN/ERROR/FATAL）
- `c.e.s.UserService:42` — Logger 类名:行号
- `User logged in` — 消息内容

## K8s 线程类型速查

| 线程前缀 | 含义 | 关注场景 |
|----------|------|----------|
| `http-nio-*` | Tomcat HTTP 请求处理 | 用户请求的入口，大部分业务日志在这里 |
| `xxl-job-*` | XXL-JOB 定时任务 | 定时任务执行日志，关注超时和异常 |
| `pool-N-thread-N` | 通用线程池 | 异步任务、并行处理 |
| `wr-org-*` | Worker 线程 | 工作线程池任务 |
| `scheduling-*` | Spring @Scheduled | 定时任务（非 XXL-JOB） |
| `main` | 应用启动主线程 | 启动阶段日志 |

## 分析步骤

1. **先全局扫描**：使用 `analyze_log` 获取汇总报告，了解整体健康状态
2. **关注 ERROR**：查看错误数量和 Top 异常列表
3. **定位根因**：使用 `get_exceptions` 按异常类分组，查看堆栈追踪
4. **关键字搜索**：使用 `search_log` 搜索特定用户ID、请求ID、业务关键字
5. **时间线分析**：查看 errorTimeline 判断是否有错误集中爆发

## 常见 Spring Boot 异常解读

| 异常类 | 可能原因 | 排查方向 |
|--------|----------|----------|
| `NullPointerException` | 空指针 | 检查参数校验和防御性编程 |
| `DataAccessException` | 数据库访问失败 | 检查连接池、SQL 语法、事务超时 |
| `HttpClientErrorException` | HTTP 4xx 响应 | 检查外部 API 调用参数 |
| `HttpServerErrorException` | HTTP 5xx 响应 | 上游服务不可用 |
| `RedisConnectionException` | Redis 连接失败 | 检查 Redis 集群状态和网络 |
| `KafkaException` | Kafka 消费/生产失败 | 检查 Broker 状态和 Topic 配置 |
| `OptimisticLockingFailureException` | 乐观锁冲突 | 高并发下的数据竞争 |
| `MethodArgumentNotValidException` | 参数校验失败 | 检查 @Valid 注解和前端传参 |

## 注意事项

- 大文件（>100MB）建议先用 `tail` 或 `grep` 截取相关时段再分析
- K8s 多 Pod 日志混合时，线程名可能带有 Pod 标识前缀
- 堆栈追踪是多行内容，解析器会自动关联到前一条日志条目
- 如果日志格式不是标准 Logback，解析结果可能不完整
