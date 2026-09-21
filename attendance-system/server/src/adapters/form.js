// Form 适配器 —— 对应 04 §3 的 Form.acceptSubmission。
//
// 生产形态：WPS 表单负责采集，提交人身份由平台注入，应用只接收 submission。
// 关键约束（对应 P07）：
//   · 提交人身份来自可信登录态，不接受表单里手填的姓名/学号；
//   · 同一 submission_id 重复提交返回已有业务单号，不重复建单。

import {Table} from './table.js';
import {newId} from '../lib/util.js';
import {TENANT_ID} from '../config.js';

export const Form = {
  /**
   * 受理一次表单提交。
   * @param {object} p
   * @param {string} p.formKey        逻辑表单标识，如 leave_apply / appeal_submit
   * @param {string} p.submitterUserId 可信提交人（来自登录态，不是表单字段）
   * @param {string} [p.submissionId]  平台提交 ID；缺失时本地生成，仍保证幂等
   * @param {string} p.businessTable   业务单据所在逻辑表
   * @returns {{submission_id:string, existing:object|null}}
   */
  acceptSubmission({formKey, submitterUserId, submissionId, businessTable}) {
    if (!submitterUserId) throw new Error('FORM_UNTRUSTED_SUBMITTER');
    const id = submissionId || newId(`sub_${formKey}`);
    const existing = Table.findOne(businessTable, {tenant_id: TENANT_ID, submission_id: id});
    return {submission_id: id, existing};
  },

  /**
   * 受限附件登记。附件不得成为无鉴权公开链接：
   * 这里只返回内部 evidence_id，实际读取走 /api/evidence/:id 并做服务端鉴权。
   */
  registerEvidence({ownerStudentId, businessType, businessId, fileName, contentType, byteSize, storageRef, uploadedBy, sensitivity = 'restricted'}) {
    const evidenceId = newId('ev');
    Table.insert('evidence_file', {
      evidence_id: evidenceId,
      tenant_id: TENANT_ID,
      owner_student_id: ownerStudentId ?? null,
      business_type: businessType,
      business_id: businessId ?? null,
      file_name: fileName,
      content_type: contentType,
      byte_size: byteSize,
      storage_ref: storageRef,
      uploaded_by: uploadedBy,
      sensitivity,
      created_at: new Date().toISOString(),
    });
    return evidenceId;
  },
};
