import { useState } from 'react';
import { Plus, Trash2, Check } from 'lucide-react';

export default function SubtaskList({ subtasks = [], onChange }) {
  const [newTitle, setNewTitle] = useState('');

  const toggle = (id) => {
    onChange(subtasks.map((s) => (s.id === id ? { ...s, done: !s.done } : s)));
  };

  const remove = (id) => {
    onChange(subtasks.filter((s) => s.id !== id));
  };

  const add = () => {
    const title = newTitle.trim();
    if (!title) return;
    onChange([...subtasks, { id: crypto.randomUUID(), title, done: false }]);
    setNewTitle('');
  };

  const doneCount = subtasks.filter((s) => s.done).length;

  return (
    <div className="space-y-2">
      {subtasks.length > 0 && (
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-500">
            {doneCount}/{subtasks.length} 已完成
          </span>
          <div className="h-1.5 flex-1 mx-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all"
              style={{ width: `${subtasks.length ? (doneCount / subtasks.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {subtasks.map((sub) => (
        <div key={sub.id} className="flex items-center gap-2 group">
          <button
            onClick={() => toggle(sub.id)}
            className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors ${
              sub.done
                ? 'bg-indigo-500 border-indigo-500 text-white'
                : 'border-gray-300 hover:border-indigo-400'
            }`}
          >
            {sub.done && <Check size={12} />}
          </button>
          <span className={`flex-1 text-sm ${sub.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>
            {sub.title}
          </span>
          <button
            onClick={() => remove(sub.id)}
            className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}

      <div className="flex items-center gap-2 mt-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="添加子任务…"
          className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
        />
        <button
          onClick={add}
          disabled={!newTitle.trim()}
          className="p-1.5 rounded-lg bg-gray-100 text-gray-600 hover:bg-indigo-100 hover:text-indigo-600 disabled:opacity-40 transition-colors"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
