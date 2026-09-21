# 平台能力矩阵（capability_matrix）

对应 `docs/baseline/04 §1` 的 P01—P14。

**状态说明**：本仓库在**没有 WPS 365 租户**的环境中开发。下表中"本地仿真"列说明我们用什么实现替代；
"真实租户验证"列一律为 **待验证**——没有任何一条在学校现网取得过证据。
Comate 或实施方接手后，按"最小验证动作"逐条实测并回填证据，再把状态改为已验证。

| 编号 | 验证对象 | 本地仿真实现 | 业务是否被阻塞 | 真实租户验证 | 接管时必须实测并回填 |
|---|---|---|---|---|---|
| P01 | 当前登录身份 | `adapters/identity.js` 的 `app_session` 表模拟已认证结果 | 否 | **待验证** | 用户 ID 类型（openid/unionid/IM ID 是否同一空间）、令牌用途与 scope |
| P02 | 通讯录与学号 | `directory_user` 表 + `identity_link` 映射 | 否 | **待验证** | 通讯录是否含学号/班级扩展字段、缺失清单、可读范围 |
| P03 | 多维表格结构 | SQLite `schema.sql` | 否 | **待验证** | workspace/table/field 的真实 ID，样例表公式与关联配置 |
| P04 | 查询与分页 | `Table.query` keyset 游标 | 否 | **待验证** | 分页参数形态、单页上限、可用筛选算子、是否支持排序 |
| P05 | 写入和并发 | `Table.createBatch` 逐条结果 + `updateRecord` 条件更新 | 否 | **待验证** | **批量上限**（当前 `TABLE_BATCH_LIMIT=500` 是占位值）、是否有条件更新/幂等写 |
| P06 | 行与附件权限 | 服务端 `domain/authz.js` 全量校验，不依赖平台行权限 | 否 | **待验证** | 平台原生行权限粒度；若不足则维持"学生只经应用服务读本人数据" |
| P07 | 表单身份 | `adapters/form.js`，提交人只取登录态 | 否 | **待验证** | 表单是否注入可信身份、能否防改填、附件引用形态 |
| P08 | 轻审批路由 | `adapters/approval.js` 单级实例 + 业务服务编排 | 否 | **待验证** | 动态选人、排除本人、无人时兜底是否原生支持 |
| P09 | 审批状态回传 | `approval_outbox` 事件提示 + `fetchState` 权威回查 | 否 | **待验证** | 有无回调及验真方式；有无版本/顺序字段 |
| P10 | 转办和撤销 | `changeRoute` 返回 `old_task_invalidated` | 否 | **待验证** | 平台能否让旧任务失效、能否撤销已通过实例 |
| P11 | IM 消息 | `adapters/message.js` 写本地信箱 + 白名单 | 否 | **待验证** | 接收人 ID 空间、授权、频率限额、幂等键与回执查询 |
| P12 | 调度运行 | `event_job` 持久任务 + `jobs/worker.js` 租约 | 否 | **待验证** | 运行环境、持久化、重试、监控归属、时区 |
| P13 | 容量与性能 | 本地已按 31,792 行真实数据实测（见验收报告） | 否 | **待验证** | 多维表格真实行数上限、筛选耗时、写入失败率、平台配额 |
| P14 | 备份和恢复 | SQLite 文件级备份 | 否 | **待验证** | 导出/恢复流程、附件可用性、业务 ID 与关联校验 |

## 逻辑适配器与替换点

迁移到 WPS 365 时**只需替换 `server/src/adapters/` 下的实现**，业务层（`domain/`、`api/`、`ingestion/`）不改。

| 适配器 | 文件 | 替换要点 |
|---|---|---|
| Identity / Directory | `adapters/identity.js` | 换成 WPS 登录态解析与通讯录读取 |
| Table | `adapters/table.js` | 换成多维表格 API；`aggregate()` 逃生口必须改为汇总表或分页扫描 |
| Form | `adapters/form.js` | 换成 WPS 表单提交受理与附件引用 |
| Approval | `adapters/approval.js` | 换成轻审批；按 P08—P10 结果决定采用 04 §4 的优先级 A/B/C |
| Message | `adapters/message.js` | 换成 IM 发送与回执查询 |
| Scheduler | `adapters/scheduler.js` | 单副本可保留；多副本须换成支持原子租约的任务支撑 |

## 刻意保留的能力边界

本地实现故意**不**向业务层暴露以下本地才有的能力，以免迁移时塌方：

- 不暴露跨表事务（`Table.transaction` 只在接入层内部降低写放大，业务正确性靠幂等键与版本校验）。
- 不暴露 offset 分页。
- 不暴露自由 SQL 聚合（`aggregate()` 仅 `domain/stats.js` 一处调用，便于整体替换）。
- 不暴露"写完立刻可读"的强一致假设，写入后需要读回的地方一律显式回读校验。
