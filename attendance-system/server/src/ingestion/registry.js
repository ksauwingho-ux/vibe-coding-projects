// 来源注册表。新增考勤来源的唯一登记处。

import {createExcelSource, SOURCE_TYPE as EXCEL} from './sources/excel-file.js';
import {createSchoolApiSource, SOURCE_TYPE as SCHOOL_API, PENDING_REQUIREMENTS} from './sources/school-api.js';

export const SOURCES = {
  [EXCEL]: {
    type: EXCEL,
    label: '学校考勤 Excel 导出',
    enabled: true,
    create: createExcelSource,
    note: '本期默认权威来源。',
  },
  [SCHOOL_API]: {
    type: SCHOOL_API,
    label: '学校考勤 API',
    enabled: false,
    create: createSchoolApiSource,
    note: '二期接入项。接口文档与授权到位后置为 enabled，管线与下游无需改动。',
    pending: PENDING_REQUIREMENTS,
  },
};

export function createSource(sourceType, options) {
  const entry = SOURCES[sourceType];
  if (!entry) throw new Error(`未知考勤来源: ${sourceType}`);
  if (!entry.enabled) {
    const err = new Error(`SOURCE_DISABLED: ${entry.label} 尚未启用。${entry.note}`);
    err.code = 'SOURCE_DISABLED';
    err.pending = entry.pending ?? [];
    throw err;
  }
  return entry.create(options);
}

export function listSources() {
  return Object.values(SOURCES).map(({type, label, enabled, note, pending}) => ({
    type, label, enabled, note, pending: pending ?? [],
  }));
}
