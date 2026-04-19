import { useState } from 'react';
import { Sparkles, Tag, ListChecks, Zap, Trash2, Edit3, Check, X } from 'lucide-react';
import { CategoryBadge, PriorityBadge, StatusBadge } from '../common/Badge';
import SubtaskList from './SubtaskList';
import Button from '../common/Button';
import LoadingSpinner from '../common/LoadingSpinner';
import { useTasks } from '../../contexts/TasksContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useAI } from '../../hooks/useAI';
import { CATEGORIES } from '../../constants/categories';
import { PRIORITIES, STATUSES } from '../../constants/priorities';
import { format, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';

export default function TaskDetail({ task, onClose }) {
  const { updateTask, deleteTask } = useTasks();
  const { settings } = useSettings();
  const ai = useAI();

  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [priorityResult, setPriorityResult] = useState(null);
  const [categoryResult, setCategoryResult] = useState(null);
  const [breakdownResult, setBreakdownResult] = useState(null);

  const hasKey = !!settings.apiKey;

  const startEdit = (field, val) => {
    setEditing(field);
    setEditVal(val);
  };

  const saveEdit = () => {
    if (!editing) return;
    updateTask(task.id, { [editing]: editVal });
    setEditing(null);
  };

  const cancelEdit = () => setEditing(null);

  const handleDelete = () => {
    if (window.confirm('确定删除这个任务吗？')) {
      deleteTask(task.id);
      onClose();
    }
  };

  const handleSuggestPriority = async () => {
    const result = await ai.suggestPriority(task);
    if (result) setPriorityResult(result);
  };

  const handleSuggestCategory = async () => {
    const result = await ai.suggestCategory(task);
    if (result) setCategoryResult(result);
  };

  const handleBreakdown = async () => {
    const result = await ai.breakdownTask(task);
    if (result) setBreakdownResult(result);
  };

  const applyPriority = () => {
    updateTask(task.id, { priority: priorityResult.priority });
    setPriorityResult(null);
  };

  const applyCategory = () => {
    updateTask(task.id, { category: categoryResult.category });
    setCategoryResult(null);
  };

  const applyBreakdown = () => {
    const newSubs = breakdownResult.subtasks.map((s) => ({
      id: crypto.randomUUID(),
      title: s.title,
      done: false,
    }));
    updateTask(task.id, { subtasks: [...(task.subtasks || []), ...newSubs] });
    setBreakdownResult(null);
  };

  const Field = ({ label, children }) => (
    <div>
      <dt className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="p-6 pb-4">
        {editing === 'title' ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={editVal}
              onChange={(e) => setEditVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
              className="flex-1 text-lg font-semibold border-b-2 border-indigo-400 focus:outline-none"
            />
            <button onClick={saveEdit} className="text-green-500"><Check size={18} /></button>
            <button onClick={cancelEdit} className="text-gray-400"><X size={18} /></button>
          </div>
        ) : (
          <div className="flex items-start gap-2 group">
            <h3 className="text-lg font-semibold text-gray-800 flex-1 leading-snug">{task.title}</h3>
            <button
              onClick={() => startEdit('title', task.title)}
              className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-gray-600 transition-opacity"
            >
              <Edit3 size={15} />
            </button>
          </div>
        )}

        {/* Status selector */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              onClick={() => updateTask(task.id, { status: s.value })}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                task.status === s.value
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pb-6 space-y-5 overflow-y-auto">
        {/* Description */}
        {editing === 'description' ? (
          <div>
            <textarea
              autoFocus
              value={editVal}
              onChange={(e) => setEditVal(e.target.value)}
              rows={3}
              className="w-full text-sm border border-indigo-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
            />
            <div className="flex gap-2 mt-1">
              <button onClick={saveEdit} className="text-xs text-green-600 font-medium">保存</button>
              <button onClick={cancelEdit} className="text-xs text-gray-400">取消</button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => startEdit('description', task.description || '')}
            className="text-sm text-gray-500 min-h-8 cursor-text hover:text-gray-700 transition-colors"
          >
            {task.description || <span className="text-gray-300 italic">点击添加描述…</span>}
          </div>
        )}

        {/* Metadata grid */}
        <dl className="grid grid-cols-2 gap-4">
          <Field label="分类">
            <div className="flex items-center gap-1">
              <CategoryBadge category={task.category} />
              <select
                value={task.category}
                onChange={(e) => updateTask(task.id, { category: e.target.value })}
                className="ml-1 text-xs text-gray-400 border-0 focus:outline-none bg-transparent cursor-pointer"
              >
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </Field>

          <Field label="优先级">
            <div className="flex items-center gap-1">
              <PriorityBadge priority={task.priority} />
              <select
                value={task.priority}
                onChange={(e) => updateTask(task.id, { priority: e.target.value })}
                className="ml-1 text-xs text-gray-400 border-0 focus:outline-none bg-transparent cursor-pointer"
              >
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </Field>

          <Field label="截止日期">
            <input
              type="date"
              value={task.dueDate || ''}
              onChange={(e) => updateTask(task.id, { dueDate: e.target.value })}
              className="text-sm text-gray-700 border-0 focus:outline-none focus:ring-1 focus:ring-indigo-300 rounded px-1 -ml-1"
            />
          </Field>

          <Field label="创建时间">
            <span className="text-sm text-gray-500">
              {format(parseISO(task.createdAt), 'M月d日 HH:mm', { locale: zhCN })}
            </span>
          </Field>
        </dl>

        {/* Subtasks */}
        <div>
          <h4 className="text-sm font-medium text-gray-600 mb-2">子任务</h4>
          <SubtaskList
            subtasks={task.subtasks || []}
            onChange={(subtasks) => updateTask(task.id, { subtasks })}
          />
        </div>

        {/* AI Features */}
        {hasKey && (
          <div className="border border-violet-100 rounded-xl p-4 bg-violet-50/50">
            <h4 className="text-sm font-semibold text-violet-700 mb-3 flex items-center gap-1.5">
              <Sparkles size={14} />
              AI 智能助手
            </h4>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ai"
                size="sm"
                onClick={handleSuggestPriority}
                disabled={ai.loading.priority}
              >
                {ai.loading.priority ? <LoadingSpinner size={14} /> : <Zap size={14} />}
                优先级建议
              </Button>
              <Button
                variant="ai"
                size="sm"
                onClick={handleSuggestCategory}
                disabled={ai.loading.category}
              >
                {ai.loading.category ? <LoadingSpinner size={14} /> : <Tag size={14} />}
                自动分类
              </Button>
              <Button
                variant="ai"
                size="sm"
                onClick={handleBreakdown}
                disabled={ai.loading.breakdown}
              >
                {ai.loading.breakdown ? <LoadingSpinner size={14} /> : <ListChecks size={14} />}
                拆解任务
              </Button>
            </div>

            {/* AI Results */}
            {priorityResult && (
              <AIResultCard
                title={`建议优先级：${priorityResult.priority === 'high' ? '高' : priorityResult.priority === 'medium' ? '中' : '低'}`}
                reason={priorityResult.reason}
                onAccept={applyPriority}
                onDismiss={() => setPriorityResult(null)}
              />
            )}
            {categoryResult && (
              <AIResultCard
                title={`建议分类：${CATEGORIES.find(c => c.value === categoryResult.category)?.label || categoryResult.category}`}
                reason={categoryResult.reason}
                onAccept={applyCategory}
                onDismiss={() => setCategoryResult(null)}
              />
            )}
            {breakdownResult && (
              <div className="mt-3 p-3 bg-white rounded-lg border border-violet-200">
                <p className="text-xs font-medium text-violet-700 mb-2">AI 建议子任务：</p>
                <ul className="space-y-1">
                  {breakdownResult.subtasks.map((s, i) => (
                    <li key={i} className="text-sm text-gray-700 flex items-center gap-2">
                      <span className="w-4 h-4 rounded-full bg-violet-100 text-violet-600 text-xs flex items-center justify-center shrink-0">{i + 1}</span>
                      {s.title}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2 mt-3">
                  <Button size="sm" variant="ai" onClick={applyBreakdown}>添加全部子任务</Button>
                  <Button size="sm" variant="ghost" onClick={() => setBreakdownResult(null)}>忽略</Button>
                </div>
              </div>
            )}

            {(ai.errors.priority || ai.errors.category || ai.errors.breakdown) && (
              <p className="mt-2 text-xs text-red-500">
                AI 调用失败：{ai.errors.priority || ai.errors.category || ai.errors.breakdown}
              </p>
            )}
          </div>
        )}

        {!hasKey && (
          <p className="text-xs text-gray-400 text-center py-2">
            在设置中添加 API Key 以启用 AI 功能
          </p>
        )}

        {/* Footer actions */}
        <div className="flex justify-end pt-2 border-t border-gray-100">
          <Button variant="danger" size="sm" onClick={handleDelete}>
            <Trash2 size={14} />
            删除任务
          </Button>
        </div>
      </div>
    </div>
  );
}

function AIResultCard({ title, reason, onAccept, onDismiss }) {
  return (
    <div className="mt-3 p-3 bg-white rounded-lg border border-violet-200">
      <p className="text-sm font-medium text-violet-700">{title}</p>
      <p className="text-xs text-gray-500 mt-1">{reason}</p>
      <div className="flex gap-2 mt-2">
        <Button size="sm" variant="ai" onClick={onAccept}>采用建议</Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>忽略</Button>
      </div>
    </div>
  );
}
