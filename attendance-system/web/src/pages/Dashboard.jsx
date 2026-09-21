// 数据看板。读汇总台账，不拉明细到浏览器再筛。

import {api} from '../api.js';
import {Async, Metric, Notice, useAsync, formatDate, label} from '../ui.jsx';

export function Dashboard({me}) {
  const state = useAsync(() => api.dashboard(), []);
  const d = state.data;

  const totals = d?.daily.reduce((acc, x) => ({
    total: acc.total + x.total, abnormal: acc.abnormal + x.abnormal, pending: acc.pending + x.pending,
  }), {total: 0, abnormal: 0, pending: 0});
  const maxDaily = Math.max(1, ...(d?.daily.map((x) => x.total) ?? [1]));

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>数据看板</h1>
          <p>
            {me.manageable_classes.length} 个班级
            {d?.updated_at && <> · 汇总更新于 {formatDate(d.updated_at)}</>}
          </p>
        </div>
        <a className="secondary" style={{textDecoration: 'none', display: 'inline-flex', alignItems: 'center', padding: '10px 16px'}}
          href={api.exportUrl({scope_type: 'college', scope_id: me.college_id})}>导出明细 CSV</a>
      </div>

      <Async state={state}>
        {d && (
          <>
            {d.coverage.status !== 'complete' && (
              <Notice kind="warn">
                数据完整性尚未逐班逐日确认（已确认 {d.coverage.confirmed_complete} / {d.coverage.total_class_days}）。
                以下口径为「已导入考勤」，不代表全院完整到课情况。
              </Notice>
            )}

            <div className="metrics">
              <Metric label="已导入节次" value={totals.total.toLocaleString()} tone="neutral" note="单位：学生·节" />
              <Metric label="异常节次" value={totals.abnormal.toLocaleString()} tone="warning" note={d.definitions.abnormal} />
              <Metric label="待核实" value={totals.pending.toLocaleString()} note="单列，不计入异常" />
              <Metric label="需关注记录" value={(d.daily.reduce((a, x) => a + x.counts['旷课'], 0) + totals.pending).toLocaleString()}
                note="旷课＋待核实（v4 口径，独立命名）" />
              <Metric label="到课率" value="—" note="无权威课表与选课关系，不提供应到分母" />
            </div>

            <div className="grid cols-2">
              <div className="card">
                <h2>按日趋势</h2>
                <p className="sub">每日已导入节次与异常分布</p>
                <table style={{marginTop: 12}}>
                  <thead>
                    <tr><th>日期</th><th>已导入</th><th>异常</th><th>待核实</th><th style={{width: '35%'}}>分布</th></tr>
                  </thead>
                  <tbody>
                    {d.daily.map((x) => (
                      <tr key={x.att_date}>
                        <td data-label="日期" className="mono">{x.att_date}</td>
                        <td data-label="已导入" className="mono">{x.total.toLocaleString()}</td>
                        <td data-label="异常" className="mono" style={{color: 'var(--warn)'}}>{x.abnormal.toLocaleString()}</td>
                        <td data-label="待核实" className="mono">{x.pending.toLocaleString()}</td>
                        <td data-label="分布">
                          <div className="bar" title={`${x.total} 节`}>
                            <i className="warn" style={{width: `${(x.abnormal / maxDaily) * 100}%`}} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card">
                <h2>班级异常率排行</h2>
                <p className="sub">异常率 = {d.definitions.abnormal} ÷ 已导入节次</p>
                <table style={{marginTop: 12}}>
                  <thead>
                    <tr><th>班级</th><th>已导入</th><th>异常</th><th>待核实</th><th>异常率</th></tr>
                  </thead>
                  <tbody>
                    {d.classes.slice(0, 15).map((c) => (
                      <tr key={c.class_id}>
                        <td data-label="班级">{c.class_name}</td>
                        <td data-label="已导入" className="mono">{c.total.toLocaleString()}</td>
                        <td data-label="异常" className="mono">{c.abnormal.toLocaleString()}</td>
                        <td data-label="待核实" className="mono">{c.pending.toLocaleString()}</td>
                        <td data-label="异常率" className="mono" style={{color: c.abnormal_rate > 50 ? 'var(--danger)' : 'var(--warn)'}}>
                          {c.abnormal_rate ?? '—'}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.classes.length > 15 && <p className="hint">共 {d.classes.length} 个班级，此处显示异常率最高的 15 个。</p>}
              </div>
            </div>

            <div className="card" style={{marginTop: 18}}>
              <h2>统计口径说明</h2>
              <ul className="hint" style={{paddingLeft: 18}}>
                <li>统计单位：{d.definitions.unit}，不是人头数。</li>
                <li>异常节次：{d.definitions.abnormal}。</li>
                <li>待核实：{d.definitions.pending}</li>
                <li>需关注记录：{d.definitions.needs_attention}</li>
                <li>应到与到课率：{d.definitions.expected_periods}</li>
                <li>{d.coverage.note}</li>
              </ul>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
