#!/usr/bin/env node
// 组织与名册初始化。
//
// ⚠ 重要边界：学院**没有提供权威学生名册**（docs/baseline/04 §8 的资源清单第一项）。
// 本脚本从考勤来源中出现过的「姓名＋班级」派生一份**占位名册**，用于把系统跑通。
//   · 派生学生的 student_no 是系统生成的占位学号，带 provisional=1 标记；
//   · source 记为 derived_from_attendance，随时可被真实名册覆盖；
//   · 占位学号**不是**真实学号，不得用于任何对外场景。
// 真实名册到位后，用 --roster <file> 导入并按姓名＋班级完成对齐，provisional 置 0。
//
// 角色（辅导员/副班长/学生干部）在真实环境由学院提供名单。
// 这里按班级生成可用于流程验证的角色授权，同样带 provisional 标记。

import {openDb} from '../server/src/db/index.js';
import {Table} from '../server/src/adapters/table.js';
import {createSource} from '../server/src/ingestion/registry.js';
import {normalizeText} from '../server/src/ingestion/normalize.js';
import {newId, nowUtc, sha256} from '../server/src/lib/util.js';
import {TENANT_ID, COLLEGE_ID} from '../server/src/config.js';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const filePath = getArg('file', 'data/第8周.xlsx');
const reset = args.includes('--reset');

async function main() {
  openDb();
  if (reset) clearOrg();

  console.log(`读取来源以派生组织结构：${filePath}`);
  const source = createSource('excel_file', {filePath});
  const descriptor = await source.describe();

  const classSet = new Set();
  const studentSet = new Map();   // "班级\u0001姓名" -> {name, className}
  let rows = 0;

  for await (const page of source.read({batchSize: 5000})) {
    for (const r of page) {
      const name = normalizeText(r.name_raw);
      const className = normalizeText(r.class_raw);
      if (!name || !className) continue;
      rows += 1;
      classSet.add(className);
      studentSet.set(`${className}\u0001${name}`, {name, className});
    }
  }
  console.log(`来源 ${rows} 行，班级 ${classSet.size} 个，姓名+班级组合 ${studentSet.size} 个`);

  const ts = nowUtc();
  const classIdByName = new Map();
  const classNames = [...classSet].sort();

  // ---- 班级
  for (const className of classNames) {
    const existing = Table.findOne('class_profile', {tenant_id: TENANT_ID, class_name: className});
    if (existing) { classIdByName.set(className, existing.class_id); continue; }
    const classId = `cls_${sha256(className).slice(0, 16)}`;
    Table.insert('class_profile', {
      class_id: classId, tenant_id: TENANT_ID, college_id: COLLEGE_ID,
      class_name: className, grade: gradeOf(className), counselor_user_id: null, active: 1,
    });
    classIdByName.set(className, classId);
  }
  console.log(`班级档案：${classIdByName.size}`);

  // ---- 辅导员：每 8 个班一名，负责班级即其授权范围
  const counselors = [];
  const perCounselor = 8;
  for (let i = 0; i < Math.ceil(classNames.length / perCounselor); i += 1) {
    const userId = `u_counselor_${String(i + 1).padStart(2, '0')}`;
    const name = `辅导员${i + 1}号`;
    upsertDirectoryUser(userId, name, '学生工作办公室', '辅导员');
    counselors.push({userId, classes: classNames.slice(i * perCounselor, (i + 1) * perCounselor)});
  }
  for (const c of counselors) {
    for (const className of c.classes) {
      Table.updateRecord('class_profile', classIdByName.get(className), {counselor_user_id: c.userId});
    }
    // 辅导员按 D15 拥有学院范围（可查看与兜底），常规待办按负责班级路由。
    grantRole(c.userId, 'counselor', 'college', COLLEGE_ID);
    for (const className of c.classes) grantRole(c.userId, 'counselor', 'class', classIdByName.get(className));
  }
  console.log(`辅导员：${counselors.length}`);

  // ---- 学生：占位名册
  const grouped = new Map();
  for (const {name, className} of studentSet.values()) {
    if (!grouped.has(className)) grouped.set(className, []);
    grouped.get(className).push(name);
  }

  let created = 0;
  let duplicateInClass = 0;
  for (const className of classNames) {
    const classId = classIdByName.get(className);
    const names = grouped.get(className) ?? [];
    names.sort();
    const seen = new Set();
    names.forEach((name, i) => {
      if (seen.has(name)) { duplicateInClass += 1; return; }
      seen.add(name);
      const existing = Table.findOne('student_profile', {tenant_id: TENANT_ID, name, current_class_id: classId});
      if (existing) return;
      const studentId = `stu_${sha256(`${className}|${name}`).slice(0, 16)}`;
      // 占位学号：D + 班级序号 + 班内序号。明确不是真实学号。
      const studentNo = `D${String(classNames.indexOf(className) + 1).padStart(3, '0')}${String(i + 1).padStart(3, '0')}`;
      Table.insert('student_profile', {
        student_id: studentId, tenant_id: TENANT_ID, college_id: COLLEGE_ID,
        student_no: studentNo, name, current_class_id: classId, active: 1,
        provisional: 1, source: 'derived_from_attendance', source_updated_at: ts,
      });
      Table.insert('student_class', {
        membership_id: newId('mem'), tenant_id: TENANT_ID, student_id: studentId,
        class_id: classId, valid_from: '2026-09-01', valid_to: null,
      });
      const userId = `u_${studentId}`;
      upsertDirectoryUser(userId, name, className, '学生');
      Table.insert('identity_link', {
        link_id: newId('lnk'), tenant_id: TENANT_ID, student_id: studentId,
        wps_user_id: userId, directory_object_id: userId, link_status: 'verified',
        verified_by: 'seed:derived', verified_at: ts, source: 'derived_from_attendance',
      });
      grantRole(userId, 'student', 'self', studentId);
      created += 1;
    });

    // 班内前两名作为副班长与学生干部，用于流程验证
    const roster = Table.all('student_profile', {
      where: {tenant_id: TENANT_ID, current_class_id: classId},
      order: [['student_no', 'ASC']], limit: 2,
    });
    if (roster[0]) grantRole(`u_${roster[0].student_id}`, 'monitor', 'class', classId);
    if (roster[1]) grantRole(`u_${roster[1].student_id}`, 'student_cadre', 'class', classId);
  }

  console.log(`学生档案新增：${created}（占位学号，provisional=1）`);
  if (duplicateInClass) console.log(`同班同名（已合并为同一人，真实名册到位后需人工区分）：${duplicateInClass}`);
  console.log(`来源摘要：${descriptor.source_digest.slice(0, 16)}…`);
  console.log('\n完成。提醒：占位名册仅用于打通流程，真实名册到位后必须覆盖。');
}

function gradeOf(className) {
  const m = /^(\d{2})/.exec(className);
  return m ? `20${m[1]}` : null;
}

function upsertDirectoryUser(userId, displayName, department, title) {
  if (Table.get('directory_user', userId)) return;
  Table.insert('directory_user', {
    wps_user_id: userId, tenant_id: TENANT_ID, display_name: displayName,
    department, title, im_user_id: `im_${userId}`, active: 1, source: 'derived_from_attendance',
  });
}

function grantRole(userId, role, scopeType, scopeId) {
  const existing = Table.findOne('role_assignment', {
    tenant_id: TENANT_ID, wps_user_id: userId, role, scope_type: scopeType, scope_id: scopeId,
  });
  if (existing) return;
  Table.insert('role_assignment', {
    assignment_id: newId('role'), tenant_id: TENANT_ID, wps_user_id: userId,
    role, scope_type: scopeType, scope_id: scopeId,
    valid_from: '2026-09-01', valid_to: null, enabled: 1, assigned_by: 'seed:derived',
  });
}

function clearOrg() {
  for (const t of ['role_assignment', 'identity_link', 'student_class', 'student_profile',
    'directory_user', 'class_alias', 'class_profile']) {
    Table.aggregate(`DELETE FROM ${t}`);
  }
  console.log('已清空组织与名册表');
}

main().catch((err) => { console.error(err); process.exit(1); });
