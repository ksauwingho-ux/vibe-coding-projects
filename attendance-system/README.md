# 课堂考勤管理系统

基于学校已有 **WPS 365** 的学院课堂考勤管理应用。业务设计见 `docs/baseline/00—06`。

---

## ⚠ 先读这段

本仓库是在**没有 WPS 365 租户**的环境中开发的完整可运行实现：

- **业务逻辑是真的**：判定规则、请假、申诉、核对、统计、消息全部按设计文档实现，
  并用学校真实的 31,792 行考勤数据验证，判定结果与 v4 基线完全一致。
- **平台能力是模拟的**：身份、通讯录、多维表格、表单、轻审批、IM 全部走适配器，
  由本地实现替代。**P01—P14 一项都没有在学校真实租户验证过**，见 `docs/capability-matrix.md`。

迁移到 WPS 365 时**只需要替换 `server/src/adapters/` 下的实现**，
业务层（`domain/`、`ingestion/`、`api/`）不需要改动。

---

## 快速开始

```bash
cd attendance-system
npm install --prefix web        # 前端依赖（服务端零运行时依赖）

# 1. 初始化组织与名册
npm run seed -- --file data/第8周.xlsx

# 2. 接入考勤数据
npm run ingest -- --file data/第8周.xlsx

# 3. 构建前端并启动
npm run web:build
npm run server                  # http://localhost:8787
```

浏览器打开后选择一个身份进入（正式环境由 WPS 365 提供统一身份，不存在独立账号密码）。

开发模式下前后端分离运行：

```bash
npm run server                  # 后端 :8787
npm run web:dev                 # 前端 :5173，自动代理 /api
```

### 全部命令

| 命令 | 用途 |
|---|---|
| `npm run seed` | 初始化班级、名册、角色授权 |
| `npm run ingest` | 接入考勤数据（`--dry-run` 预览、`--resume <batch_id>` 续传） |
| `npm run server` | 启动服务与后台任务处理器 |
| `npm run web:dev` / `web:build` | 前端开发 / 构建 |
| `npm test` | 单元与集成测试（115 项） |
| `npm run acceptance` | 执行 67 条验收用例并回填结果 |
| `npm run volume -- --rows 600000` | 容量与查询性能实测 |
| `npm run report` | 由实际执行结果生成验收报告 |

环境变量：`PORT`、`DB_PATH`、`TENANT_ID`、`COLLEGE_ID`、`TERM_ID`、
`IM_WHITELIST`（消息白名单）、`REQUIRE_CONFIRMED_POLICY=1`（未确认口径禁止自动改判）。

---

## 架构

```
server/src/
├── adapters/          平台适配层 —— 迁移 WPS 365 时只改这里
│   ├── identity.js      Identity / Directory（身份与通讯录）
│   ├── table.js         Table（业务台账，对应多维表格）
│   ├── form.js          Form（表单受理与附件登记）
│   ├── approval.js      Approval（轻审批，审批过程的权威来源）
│   ├── message.js       Message（IM 发送，三态返回）
│   └── scheduler.js     Scheduler（持久任务与租约）
├── ingestion/         统一考勤接入层
│   ├── source.js        来源适配器契约
│   ├── sources/         excel-file.js（本期）、school-api.js（二期契约桩）
│   ├── normalize.js     字段标准化：列名别名、节次、日期、结果与方式值域
│   ├── registry.js      来源注册表
│   └── pipeline.js      与来源无关的管线：批次、去重、身份映射、异常隔离、续传
├── domain/            业务逻辑
│   ├── rules.js         判定规则引擎（确定性，不用模型推断）
│   ├── writer.js        受控写入服务 —— 最终判定的唯一产生者
│   ├── authz.js         授权（服务端唯一真相）
│   ├── policy.js        业务口径配置与确认状态
│   ├── attendance.js    查询与详情
│   ├── review.js        待核实核对与辅导员复核
│   ├── leave.js         请假、多人公假、撤销
│   ├── appeal.js        申诉两级流程、时限、公示与锁定
│   ├── stats.js         三级汇总与对账
│   └── notify.js        日报与消息台账
├── jobs/worker.js     任务处理器与定时调度
├── api/               HTTP 路由
└── db/schema.sql      业务台账结构
```

### 三条不可动摇的约束

**1. 考勤数据只经由统一接入层进入系统。**
Excel 是来源适配器之一，学校 API 是另一个。两者产出同一份标准化记录。
判定、审批、统计、推送**不出现**文件名、工作表、列下标等任何来源特有概念。
新增来源只需实现 `AttendanceSource` 接口并注册，下游一行不改。

**2. 最终判定只由 `domain/writer.js` 写入。**
同一记录串行处理、校验 `business_revision`、`applied_event_id` 幂等、
公示锁定后拒绝自动改判（转辅导员复核）。
表格公式、人工编辑、审批自动化都不能各写一个"最终结果"。

**3. 权限只在服务端判定。**
前端筛选不是访问控制。每次读取与写入都重新校验角色范围与有效期，
不信任前端传入的身份、scope 或 student_id。

---

## 判定规则

### 基础判定（原始结果 × 原始方式）

| 原始结果 | 原始方式 | 基础结果 |
|---|---|---|
| 正常 | 刷脸 / istudy / 二维码 | 正常 |
| 正常 | 刷卡 | **旷课**（决策 D06，业务政策，可配置） |
| 正常 | 空值或未知方式 | 待处理 |
| 迟到 / 早退 / 旷课 | 任意 | 同原始结果 |
| 其他未识别结果 | 任意 | 待处理 |

### 最终判定顺序

```
1. 有效人工结论存在      → 采用人工结论（与请假冲突则转辅导员复核）
2. 基础结果是旷课且有有效请假 → 请假
3. 否则                  → 基础结果
```

请假**只覆盖基础旷课**，不消除迟到、早退、待处理（决策 D09）。

六类最终结果：正常 / 旷课 / 迟到 / 早退 / 请假 / 待处理（界面显示"待核实"）。

### 统计口径

- 单位是 **学生·节**，不是人头。
- 异常节次 = 旷课＋迟到＋早退。**待核实单列，不计入异常。**
- "旷课＋待核实"另名为 **需关注记录**，绝不与异常率混用。
- 没有权威课表与选课关系，因此**不提供应到分母与到课率**，相关字段返回 `null`。
- 覆盖状态须由辅导员逐班逐日确认，不能由"导入成功"推断。

---

## 业务口径的确认状态

`docs/baseline/01` 决策表中待业务确认的口径，全部存在 `policy_setting` 表，
带 `confirmed` 标记，可在「数据与运行 → 规则配置」页查看与修改。

当前 **15 项** 为测试默认值（D06 刷卡口径、D08 早退申诉、D09 请假覆盖范围、
D16 公示起算、D17 异常口径等）。设置 `REQUIRE_CONFIRMED_POLICY=1` 后，
系统会拒绝用未确认口径对真实学生自动改判或推送消息。

**试点前必须由业务负责人逐项确认并在系统内标记。**

---

## 验收

```bash
npm test          # 115 项，全部通过
npm run acceptance # 67 条验收用例：66 通过 / 1 阻塞
npm run report     # 生成 docs/acceptance-report.md
```

关键结果：

- **真实样本回归**：31,792 行真实数据，基础判定四类结果与 v4 基线完全一致
  （正常 15,442 / 旷课 14,185 / 待处理 2,001 / 迟到 164）。
- **日期语义取证**：26,771 条有签到时间的记录，签到日期与来源日期零反例。
- **容量与性能**：60 万行与 100 万行背景数据、30 并发，7 个真实查询场景
  P95 最差 14.5ms（目标 ≤3s）。
- **阻塞项**：AT-065 分区备份恢复，依赖多维表格导出通道。

详见 `docs/acceptance-report.md` 与 `docs/acceptance-results.csv`。

---

## 数据与隐私

- 真实学生数据（`data/*.xlsx`）与本地台账（`data/*.db`）已加入 `.gitignore`，**不进仓库**。
- 病假证据等受限附件不返回公开链接，读取走 `/api/evidence/:id` 服务端鉴权；
  默认只有本人与对应辅导员可见。
- 审计日志不记录凭证与完整病历内容。
- 消息默认只发测试白名单（`IM_WHITELIST`），接入真实 IM 前不对真实学生发送。

---

## 接手须知

1. **先读** `docs/capability-matrix.md`，按 P01—P14 在学校租户逐项实测并回填证据。
   适配器里的方法名是本设计的逻辑命名，**不是 WPS 官方 API**，不要照抄。
2. `TABLE_BATCH_LIMIT=500` 是占位值，真实批量上限必须实测后回填。
3. 权威学生名册到位后覆盖派生名册（当前学号是 `provisional=1` 的占位值）。
4. 学校考勤 API 的接入清单见 `server/src/ingestion/sources/school-api.js`
   的 `PENDING_REQUIREMENTS`；接口到位后把 `registry.js` 里的 `enabled` 改为 `true` 即可，
   管线与下游不需要改动。
5. 多副本部署前先把 `Scheduler` 的租约换成真实的分布式实现。
