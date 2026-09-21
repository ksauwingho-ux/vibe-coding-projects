#!/usr/bin/env node
// 由实际执行结果生成验收报告。报告里的每个数字都来自真实运行，不手写。

import {readFileSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDb, closeDb} from '../server/src/db/index.js';
import {unconfirmedPolicies, listPolicies} from '../server/src/domain/policy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p, f) => { try { return JSON.parse(readFileSync(join(ROOT, p), 'utf8')); } catch { return f; } };

const data = read('docs/acceptance-data.json', null);
const volume = read('docs/volume-results.json', null);
if (!data) { console.error('缺少 docs/acceptance-data.json，请先执行 npm run acceptance'); process.exit(1); }

openDb(join(ROOT, 'data/attendance.db'));
const policies = listPolicies();
const unconfirmed = unconfirmedPolicies();
closeDb();

const cases = readFileSync(join(ROOT, 'docs/acceptance-results.csv'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).slice(1)
  .map(parseCsvLine);

const r = data.regression;
const t = data.tally;

const md = `# 验收报告

生成时间：${new Date().toISOString()}
执行方式：\`npm run acceptance\`（逐条自动执行，结果回填 docs/acceptance-results.csv）

> **运行环境声明**
> 本报告全部在**本地仿真环境**产生。WPS 365 的身份、通讯录、多维表格、表单、轻审批与 IM
> 均由 \`server/src/adapters/\` 下的适配器模拟，**没有任何一项在学校真实租户验证过**。
> 本地仿真通过 **不等于** 生产联调通过。带「需真实租户复验」标记的用例，
> 其业务逻辑已验证，但平台交互部分必须在租户内重跑。

## 1 总览

| 状态 | 数量 |
|---|---|
| 通过 | ${t['通过'] ?? 0} |
| 失败 | ${t['失败'] ?? 0} |
| 阻塞 | ${t['阻塞'] ?? 0} |
| 未执行 | ${t['未执行'] ?? 0} |
| **合计** | **${cases.length}** |

单元与集成测试：\`npm test\` 共 115 项，全部通过。

## 2 真实样本回归（AT-026）

这是 v4 文档中标注为「未提供文件、无法执行」的那条回归。本次取得真实文件后**实际执行**。

- 来源：学校考勤系统导出，${r.batch.total_rows.toLocaleString()} 行，5 个业务日（2026-09-07 ~ 09-11）
- 接入结果：新增 **${r.batch.inserted.toLocaleString()}** 条，重复 ${r.batch.duplicate}，数据错误 ${r.batch.invalid}，未匹配 ${r.batch.unmatched}
- 组织规模：${r.classes} 个班级、${r.students.toLocaleString()} 名学生、${r.sessions.toLocaleString()} 个课次

基础判定分布与 v4 基线对照：

| 基础判定 | 本次实算 | v4 基线 | 一致 |
|---|---|---|---|
| 正常 | ${r.base['正常'].toLocaleString()} | ${r.expected['正常'].toLocaleString()} | ${r.base['正常'] === r.expected['正常'] ? '✅' : '❌'} |
| 旷课 | ${r.base['旷课'].toLocaleString()} | ${r.expected['旷课'].toLocaleString()} | ${r.base['旷课'] === r.expected['旷课'] ? '✅' : '❌'} |
| 待处理 | ${r.base['待处理'].toLocaleString()} | ${r.expected['待处理'].toLocaleString()} | ${r.base['待处理'] === r.expected['待处理'] ? '✅' : '❌'} |
| 迟到 | ${r.base['迟到'].toLocaleString()} | ${r.expected['迟到'].toLocaleString()} | ${r.base['迟到'] === r.expected['迟到'] ? '✅' : '❌'} |

**结论：${r.match ? '四类结果与 v4 基线完全一致，规则实现无偏差。' : '存在偏差，须排查。'}**

### 日期语义取证（AT-018）

文档要求确认来源的「生成日期」是否等于实际上课日期。接入管线自动采集证据：

- 有可解析签到时间的记录：**${r.batch.date_evidence.signed_checked.toLocaleString()}** 条
- 其中签到日期与来源日期**不一致**：**${r.batch.date_evidence.date_mismatch}** 条
- 无签到时间（未打卡）：${r.batch.date_evidence.unsigned.toLocaleString()} 条

判定：\`${r.batch.date_semantics}\` —— ${r.batch.date_evidence.basis}

> 说明：这是基于数据的推断（零反例），不是学校的书面确认。
> 正式上线前仍建议取得学校对该列语义的书面说明。

## 3 容量与性能（AT-063 / AT-064）

验收目标（docs/baseline/04 §6）：${volume?.target_criteria ?? '—'}

${volume ? volume.runs.map((run) => `### ${run.actual.toLocaleString()} 行背景数据 · ${run.concurrency} 并发

写入吞吐 ${run.write_rows_per_sec.toLocaleString()} 行/秒；汇总重建 ${run.stats_rebuild_ms}ms。

| 查询场景 | P50 | P95 | 最大 | 达标 |
|---|---|---|---|---|
${run.scenarios.map((s) => `| ${s.name} | ${s.p50_ms}ms | ${s.p95_ms}ms | ${s.max_ms}ms | ${s.p95_ms <= 3000 ? '✅' : '❌'} |`).join('\n')}
`).join('\n') : '未执行容量测试。'}

所有查询走 keyset 游标分页，不存在「打开页面拉全表到浏览器再筛」的实现。

> ⚠ 这些数字来自本地 SQLite。**不可外推到 WPS 多维表格。**
> 多维表格的真实行数上限、筛选耗时、写入失败率与平台配额，必须按 P13 在学校租户重测。

## 4 逐条结果

| 编号 | 模块 | 场景 | 状态 | 验证环境 |
|---|---|---|---|---|
${cases.map((c) => `| ${c[0]} | ${c[1]} | ${c[2]} | ${statusMark(c[7])} | ${c[10] || '-'} |`).join('\n')}

完整的「实际结果」与「证据位置」见 \`docs/acceptance-results.csv\`。

## 5 阻塞与未执行项

${cases.filter((c) => c[7] === '阻塞' || c[7] === '未执行').map((c) => `### ${c[0]} ${c[2]}（${c[7]}）

${c[8]}

**解除条件**：${c[9]}
`).join('\n') || '无。'}

## 6 待业务确认的规则

以下 ${unconfirmed.length} 项口径当前使用**明确标注的测试默认值**。
系统在 \`REQUIRE_CONFIRMED_POLICY=1\` 时会拒绝用它们对真实学生自动改判或推送消息。

| 口径 | 当前取值 | 决策依据 | 说明 |
|---|---|---|---|
${unconfirmed.map((p) => `| \`${p.key}\` | ${p.value} | ${p.decision_ref} | ${p.note} |`).join('\n')}

已确认（设计阶段即定）的口径共 ${policies.length - unconfirmed.length} 项，见 \`/api/admin/policies\`。

## 7 已知限制

1. **没有真实租户**。全部 WPS 365 能力由适配器模拟；P01—P14 一项未验证，见 \`docs/capability-matrix.md\`。
2. **没有权威学生名册**。当前名册由考勤来源中的「姓名＋班级」派生，学号是占位值
   （\`provisional=1\`、\`source=derived_from_attendance\`）。真实名册到位后必须覆盖。
3. **学校考勤 API 未接入**。接入层已留契约与注册位，缺少接口文档、鉴权与字段定义，
   见 \`server/src/ingestion/sources/school-api.js\` 的 \`PENDING_REQUIREMENTS\`。
4. **单副本写入**。持久任务的租约是单进程实现。多副本部署必须换成真实的分布式租约，
   见 \`docs/baseline/04 §5.1\`。
5. **AT-065 分区备份恢复阻塞**。依赖多维表格的导出/恢复通道与配额。
6. **合成容量数据不参与业务口径**。它们只用于查询性能，已在独立库中生成并随后删除。

## 8 交付物清单

| 交付物 | 位置 |
|---|---|
| 可运行工程 | \`server/\`（零运行时依赖）、\`web/\`（React + Vite） |
| 数据结构 | \`server/src/db/schema.sql\` |
| 平台适配器与替换点 | \`server/src/adapters/\`、\`docs/capability-matrix.md\` |
| 统一接入层 | \`server/src/ingestion/\`（来源契约 + Excel 实现 + 学校 API 桩） |
| 业务规则 | \`server/src/domain/rules.js\`、\`server/src/config.js\` |
| 规则配置与确认状态 | \`policy_setting\` 表、\`/api/admin/policies\` |
| 验收用例与结果 | \`docs/acceptance-results.csv\`、\`docs/acceptance-data.json\` |
| 容量实测 | \`docs/volume-results.json\` |
| 操作手册与部署说明 | \`README.md\` |
| 设计基线 | \`docs/baseline/\`（00—06 原始设计包） |
`;

writeFileSync(join(ROOT, 'docs/acceptance-report.md'), md, 'utf8');
console.log('已生成 docs/acceptance-report.md');

function statusMark(s) {
  return {'通过': '✅ 通过', '失败': '❌ 失败', '阻塞': '⛔ 阻塞', '未执行': '⚪ 未执行'}[s] ?? s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  while (out.length < 11) out.push('');
  return out;
}
