// Message 适配器 —— 对应 04 §3 的 Message.send。
//
// 生产形态：WPS IM。本地形态把"已发送"的消息落到 notification 台账并写入本地信箱文件，
// 供验收核对；默认只发测试白名单（policy notify.whitelist_only）。
//
// 三态返回是刻意的：sent / failed / unknown。
// unknown 表示请求结果不明，必须核对后再决定是否补发 —— 不承诺严格一次送达。

import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Directory} from './identity.js';
import {nowUtc} from '../lib/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUTBOX_FILE = process.env.IM_OUTBOX || join(here, '../../../var/im-outbox.log');

/** 测试白名单。真实联调前只允许这些账号收到消息。 */
export const whitelist = new Set(
  (process.env.IM_WHITELIST || '').split(',').map((s) => s.trim()).filter(Boolean),
);

/** 故障注入，仅供验收用例驱动（AT 消息失败/结果未知）。 */
export const faultInjection = {failFor: new Set(), unknownFor: new Set()};

export const Message = {
  /**
   * @returns {{status:'sent'|'failed'|'unknown', message_id?:string, error?:string}}
   */
  send({receiverUserId, kind, title, body, link, dedupKey, whitelistOnly = true}) {
    const imId = Directory.imReceiver(receiverUserId);
    if (!imId) {
      // 映射异常：不用姓名搜到的第一人代发。
      return {status: 'failed', error: 'IM_RECEIVER_UNRESOLVED'};
    }
    if (whitelistOnly && whitelist.size > 0 && !whitelist.has(receiverUserId)) {
      return {status: 'skipped', error: 'NOT_IN_WHITELIST'};
    }
    if (faultInjection.failFor.has(receiverUserId)) {
      return {status: 'failed', error: 'IM_UPSTREAM_ERROR'};
    }
    if (faultInjection.unknownFor.has(receiverUserId)) {
      return {status: 'unknown', error: 'IM_TIMEOUT_RESULT_UNKNOWN'};
    }
    const messageId = `im_${dedupKey}`;
    try {
      mkdirSync(dirname(OUTBOX_FILE), {recursive: true});
      appendFileSync(OUTBOX_FILE, `${JSON.stringify({
        at: nowUtc(), to: receiverUserId, im: imId, kind, title, body, link, dedupKey,
      })}\n`, 'utf8');
    } catch (err) {
      return {status: 'unknown', error: `OUTBOX_WRITE_FAILED:${err.message}`};
    }
    return {status: 'sent', message_id: messageId};
  },

  /**
   * 查询消息结果。平台支持时用于核对 unknown；不支持则由管理员决定是否补发。
   * 本地实现始终支持，但业务层必须容忍 supported:false 的返回。
   */
  queryStatus(messageId) {
    return {supported: true, message_id: messageId, status: 'sent'};
  },
};
