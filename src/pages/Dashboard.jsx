import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Sparkles, RefreshCw, Plus } from 'lucide-react';
import { useTasks } from '../contexts/TasksContext';
import { useSettings } from '../contexts/SettingsContext';
import { useAI } from '../hooks/useAI';
import { storage } from '../utils/storage';
import TaskCard from '../components/tasks/TaskCard';
import TaskDetail from '../components/tasks/TaskDetail';
import TaskForm from '../components/tasks/TaskForm';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import LoadingSpinner from '../components/common/LoadingSpinner';

function getGreeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export default function Dashboard() {
  const { tasks, createTask } = useTasks();
  const { settings } = useSettings();
  const ai = useAI();
  const today = format(new Date(), 'yyyy-MM-dd');

  const [focusData, setFocusData] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const pendingTasks = tasks.filter((t) => t.status !== 'done');
  const todayTasks = tasks.filter(
    (t) => t.dueDate === today && t.status !== 'done'
  );
  const inProgressCount = tasks.filter((t) => t.status === 'in-progress').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;

  useEffect(() => {
    const cached = storage.getFocusCache();
    if (cached?.date === today) {
      setFocusData(cached);
      return;
    }
    if (settings.apiKey && pendingTasks.length > 0) {
      generateFocus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateFocus = async () => {
    const result = await ai.generateFocusList(pendingTasks, today);
    if (result) {
      const cache = { date: today, ...result };
      storage.setFocusCache(cache);
      setFocusData(cache);
    }
  };

  const focusTasks = focusData
    ? focusData.taskIds.map((id) => tasks.find((t) => t.id === id)).filter(Boolean)
    : [];

  const handleCreateTask = (formData) => {
    createTask(formData);
    setShowForm(false);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <p className="text-sm text-gray-400">{format(new Date(), 'yyyy年M月d日 EEEE', { locale: zhCN })}</p>
        <h1 className="text-2xl font-bold text-gray-800 mt-1">{getGreeting()}，今天有什么计划？</h1>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: '待办任务', value: pendingTasks.length, color: 'text-indigo-600', bg: 'bg-indigo-50' },
          { label: '进行中', value: inProgressCount, color: 'text-amber-600', bg: 'bg-amber-50' },
          { label: '今日截止', value: todayTasks.length, color: 'text-red-600', bg: 'bg-red-50' },
        ].map((stat) => (
          <div key={stat.label} className={`${stat.bg} rounded-xl p-4`}>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-gray-500 mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Daily Focus */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-700 flex items-center gap-2">
            <Sparkles size={16} className="text-violet-500" />
            每日专注清单
          </h2>
          {settings.apiKey && (
            <Button
              variant="ghost"
              size="sm"
              onClick={generateFocus}
              disabled={ai.loading.focus}
            >
              {ai.loading.focus ? <LoadingSpinner size={14} /> : <RefreshCw size={14} />}
              重新生成
            </Button>
          )}
        </div>

        {!settings.apiKey && (
          <div className="bg-gray-50 rounded-xl p-4 text-center border border-dashed border-gray-200">
            <p className="text-sm text-gray-500">在设置中添加 Anthropic API Key 以启用 AI 专注清单</p>
          </div>
        )}

        {settings.apiKey && ai.loading.focus && (
          <div className="bg-violet-50 rounded-xl p-6 flex items-center justify-center gap-3 text-violet-600">
            <LoadingSpinner size={18} />
            <span className="text-sm">AI 正在分析你的任务…</span>
          </div>
        )}

        {settings.apiKey && !ai.loading.focus && focusTasks.length === 0 && pendingTasks.length === 0 && (
          <div className="bg-green-50 rounded-xl p-4 text-center">
            <p className="text-sm text-green-700 font-medium">🎉 所有任务已完成！</p>
          </div>
        )}

        {focusTasks.length > 0 && (
          <div className="space-y-2">
            {focusData?.reasoning && (
              <p className="text-xs text-gray-400 mb-3 italic">"{focusData.reasoning}"</p>
            )}
            {focusTasks.map((task) => (
              <TaskCard key={task.id} task={task} onClick={() => setSelectedTask(task)} />
            ))}
          </div>
        )}
      </div>

      {/* Today's due tasks */}
      {todayTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            今日截止
          </h2>
          <div className="space-y-2">
            {todayTasks.map((task) => (
              <TaskCard key={task.id} task={task} onClick={() => setSelectedTask(task)} />
            ))}
          </div>
        </div>
      )}

      {/* Quick add */}
      <Button variant="secondary" className="w-full justify-center" onClick={() => setShowForm(true)}>
        <Plus size={16} />
        快速新建任务
      </Button>

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
            onSubmit={handleCreateTask}
            onCancel={() => setShowForm(false)}
          />
        </Modal>
      )}
    </div>
  );
}
