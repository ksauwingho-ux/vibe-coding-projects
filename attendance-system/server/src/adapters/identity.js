// Identity / Directory 适配器 —— 对应 04 §3 的 Identity.resolveCurrentUser、Directory.listUsers。
//
// 生产形态：由 WPS 365 提供已认证身份，应用只接收可信用户 ID。
// 本地形态：用一张会话表模拟"已认证"的结果，登录入口在 api/auth.js。
// 无论哪种形态，业务层拿到的都是 {tenant_id, wps_user_id, ...}，
// 绝不接受前端传入的身份、学号或角色 —— 那些一律在服务端查。

import {Table} from './table.js';
import {newId, nowUtc, addHours} from '../lib/util.js';
import {TENANT_ID, RUNTIME} from '../config.js';

export const Identity = {
  /** 签发会话。真实环境由 WPS 登录态换取，这里模拟该结果。 */
  issueSession(wpsUserId) {
    const token = newId('sess');
    Table.insert('app_session', {
      session_token: token,
      tenant_id: TENANT_ID,
      wps_user_id: wpsUserId,
      issued_at: nowUtc(),
      expires_at: addHours(nowUtc(), RUNTIME.sessionHours),
    });
    return token;
  },

  /**
   * 解析当前登录身份。失效或未知一律拒绝，不做任何兜底放行。
   * 返回 null 表示未认证，由调用方转成 UNAUTHENTICATED。
   */
  resolveCurrentUser(token) {
    if (!token) return null;
    const session = Table.get('app_session', token);
    if (!session) return null;
    if (session.expires_at <= nowUtc()) {
      Table.remove('app_session', token);
      return null;
    }
    return {tenant_id: session.tenant_id, wps_user_id: session.wps_user_id};
  },

  revoke(token) {
    if (token) Table.remove('app_session', token);
  },
};

export const Directory = {
  /**
   * 列出租户内用户。不以显示名作为主键 —— 显示名只用于界面。
   * 真实环境读 WPS 通讯录；本地读已建立的身份映射。
   */
  listUsers({cursor = null, limit = 50} = {}) {
    return Table.query('identity_link', {
      where: {tenant_id: TENANT_ID},
      order: [['link_id', 'ASC']],
      cursor,
      limit,
    });
  },

  /** 由租户用户 ID 找到其学生身份。未映射返回 null，绝不猜学号。 */
  resolveStudent(wpsUserId) {
    const link = Table.findOne('identity_link', {tenant_id: TENANT_ID, wps_user_id: wpsUserId});
    if (!link || link.link_status !== 'verified' || !link.student_id) {
      return {student_id: null, mapping_status: link?.link_status ?? 'unresolved'};
    }
    const student = Table.get('student_profile', link.student_id);
    if (!student || !student.active) return {student_id: null, mapping_status: 'disabled'};
    return {student_id: student.student_id, mapping_status: 'verified', student};
  },

  displayName(wpsUserId) {
    return Table.get('directory_user', wpsUserId)?.display_name ?? wpsUserId;
  },

  /** IM 接收人 ID。缺失时返回 null，由消息服务登记映射异常，不用姓名搜索代发。 */
  imReceiver(wpsUserId) {
    return Table.get('directory_user', wpsUserId)?.im_user_id ?? null;
  },
};
