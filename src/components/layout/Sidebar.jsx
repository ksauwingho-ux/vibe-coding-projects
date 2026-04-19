import { LayoutDashboard, ListTodo, Settings } from 'lucide-react';
import { useTasks } from '../../contexts/TasksContext';

const NAV_ITEMS = [
  { id: 'dashboard', label: '今日专注', icon: LayoutDashboard },
  { id: 'tasks', label: '全部任务', icon: ListTodo },
  { id: 'settings', label: '设置', icon: Settings },
];

export default function Sidebar({ activePage, onNavigate }) {
  const { tasks } = useTasks();
  const pendingCount = tasks.filter((t) => t.status !== 'done').length;

  return (
    <aside className="w-56 min-h-screen bg-white border-r border-gray-100 flex flex-col py-6 px-3 shrink-0">
      <div className="px-3 mb-8">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
            <span className="text-white text-sm font-bold">✓</span>
          </div>
          <span className="font-semibold text-gray-800 text-sm">智能待办</span>
        </div>
      </div>

      <nav className="flex-1 space-y-1">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const isActive = activePage === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'
              }`}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === 'tasks' && pendingCount > 0 && (
                <span className="ml-auto bg-indigo-100 text-indigo-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="px-3 mt-4">
        <p className="text-xs text-gray-400">AI 驱动 · 本地存储</p>
      </div>
    </aside>
  );
}
