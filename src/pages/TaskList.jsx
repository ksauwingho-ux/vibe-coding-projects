import { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useTasks } from '../contexts/TasksContext';
import { useAI } from '../hooks/useAI';
import TaskCard from '../components/tasks/TaskCard';
import TaskDetail from '../components/tasks/TaskDetail';
import TaskForm from '../components/tasks/TaskForm';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import { CategoryBadge } from '../components/common/Badge';
import { CATEGORIES } from '../constants/categories';
import { STATUSES } from '../constants/priorities';

export default function TaskList() {
  const { tasks, createTask } = useTasks();
  const ai = useAI();

  const [selectedTask, setSelectedTask] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterPriority, setFilterPriority] = useState('all');
  const [sortBy, setSortBy] = useState('createdAt');

  const filtered = tasks
    .filter((t) => {
      if (filterStatus !== 'all' && t.status !== filterStatus) return false;
      if (filterCategory !== 'all' && t.category !== filterCategory) return false;
      if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
      if (search && !t.title.toLowerCase().includes(search.toLowerCase()) &&
          !t.description?.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'dueDate') {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      }
      if (sortBy === 'priority') {
        const order = { high: 0, medium: 1, low: 2 };
        return (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
      }
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

  const handleCreate = (formData) => {
    createTask(formData);
    setShowForm(false);
  };

  const handleAICategory = async (form) => {
    return await ai.suggestCategory(form);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-800">全部任务</h1>
        <Button onClick={() => setShowForm(true)}>
          <Plus size={16} />
          新建任务
        </Button>
      </div>

      {/* Search + Sort */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索任务…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <option value="createdAt">最新创建</option>
          <option value="dueDate">截止日期</option>
          <option value="priority">优先级</option>
        </select>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-5">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {[{ value: 'all', label: '全部' }, ...STATUSES].map((s) => (
            <button
              key={s.value}
              onClick={() => setFilterStatus(s.value)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                filterStatus === s.value ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <option value="all">所有分类</option>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.icon} {c.label}</option>
          ))}
        </select>

        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <option value="all">所有优先级</option>
          <option value="high">高优先级</option>
          <option value="medium">中优先级</option>
          <option value="low">低优先级</option>
        </select>
      </div>

      {/* Task list */}
      {filtered.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-400 text-sm">
            {tasks.length === 0 ? '还没有任务，点击"新建任务"开始吧！' : '没有符合筛选条件的任务'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((task) => (
            <TaskCard key={task.id} task={task} onClick={() => setSelectedTask(task)} />
          ))}
          <p className="text-xs text-gray-400 text-center pt-2">共 {filtered.length} 条任务</p>
        </div>
      )}

      {selectedTask && (
        <Modal title="任务详情" onClose={() => setSelectedTask(null)} size="lg">
          <TaskDetail
            task={tasks.find((t) => t.id === selectedTask.id) || selectedTask}
            onClose={() => setSelectedTask(null)}
          />
        </Modal>
      )}

      {showForm && (
        <Modal title="新建任务" onClose={() => setShowForm(false)}>
          <TaskForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
            onAICategory={handleAICategory}
          />
        </Modal>
      )}
    </div>
  );
}
