import { useState } from 'react';
import { CATEGORIES } from '../../constants/categories';
import { PRIORITIES } from '../../constants/priorities';
import Button from '../common/Button';
import LoadingSpinner from '../common/LoadingSpinner';
import { Sparkles } from 'lucide-react';

export default function TaskForm({ initialData = {}, onSubmit, onCancel, onAICategory }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    category: 'other',
    priority: 'medium',
    dueDate: '',
    ...initialData,
  });
  const [categorizing, setCategorizing] = useState(false);

  const set = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleAICategory = async () => {
    if (!onAICategory || !form.title.trim()) return;
    setCategorizing(true);
    try {
      const result = await onAICategory(form);
      if (result?.category) set('category', result.category);
    } finally {
      setCategorizing(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSubmit(form);
  };

  return (
    <form onSubmit={handleSubmit} className="p-6 space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">任务标题 *</label>
        <input
          type="text"
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="输入任务标题…"
          autoFocus
          required
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">描述</label>
        <textarea
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="添加描述（可选）…"
          rows={3}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-gray-700">分类</label>
            {onAICategory && (
              <button
                type="button"
                onClick={handleAICategory}
                disabled={categorizing || !form.title.trim()}
                className="flex items-center gap-1 text-xs text-violet-600 hover:text-violet-700 disabled:opacity-40"
              >
                {categorizing ? <LoadingSpinner size={12} /> : <Sparkles size={12} />}
                AI 分类
              </button>
            )}
          </div>
          <select
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.icon} {c.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">优先级</label>
          <select
            value={form.priority}
            onChange={(e) => set('priority', e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">截止日期</label>
        <input
          type="date"
          value={form.dueDate}
          onChange={(e) => set('dueDate', e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-gray-50">
        <Button type="button" variant="secondary" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={!form.title.trim()}>
          {initialData.id ? '保存' : '创建'}
        </Button>
      </div>
    </form>
  );
}
