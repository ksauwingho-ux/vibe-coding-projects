import { Calendar, CheckCircle2, Circle } from 'lucide-react';
import { CategoryBadge, PriorityBadge } from '../common/Badge';
import { useTasks } from '../../contexts/TasksContext';
import { format, isPast, isToday, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';

export default function TaskCard({ task, onClick }) {
  const { updateTask } = useTasks();
  const isDone = task.status === 'done';

  const toggleDone = (e) => {
    e.stopPropagation();
    updateTask(task.id, { status: isDone ? 'todo' : 'done' });
  };

  const isOverdue =
    task.dueDate && !isDone && isPast(parseISO(task.dueDate)) && !isToday(parseISO(task.dueDate));
  const isDueToday = task.dueDate && isToday(parseISO(task.dueDate));

  const subtaskDone = task.subtasks?.filter((s) => s.done).length || 0;
  const subtaskTotal = task.subtasks?.length || 0;

  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl border p-4 cursor-pointer hover:shadow-md transition-all group ${
        isDone ? 'opacity-60 border-gray-100' : isOverdue ? 'border-red-200' : 'border-gray-100 hover:border-indigo-200'
      }`}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={toggleDone}
          className={`mt-0.5 shrink-0 transition-colors ${
            isDone ? 'text-indigo-500' : 'text-gray-300 hover:text-indigo-400'
          }`}
        >
          {isDone ? <CheckCircle2 size={20} /> : <Circle size={20} />}
        </button>

        <div className="flex-1 min-w-0">
          <p className={`font-medium text-sm leading-snug ${isDone ? 'line-through text-gray-400' : 'text-gray-800'}`}>
            {task.title}
          </p>

          {task.description && (
            <p className="text-xs text-gray-400 mt-1 truncate">{task.description}</p>
          )}

          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <CategoryBadge category={task.category} />
            <PriorityBadge priority={task.priority} />
          </div>

          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-3">
              {task.dueDate && (
                <span
                  className={`flex items-center gap-1 text-xs ${
                    isOverdue ? 'text-red-500' : isDueToday ? 'text-amber-500' : 'text-gray-400'
                  }`}
                >
                  <Calendar size={11} />
                  {isOverdue ? '已逾期 ' : isDueToday ? '今日截止 ' : ''}
                  {format(parseISO(task.dueDate), 'M月d日', { locale: zhCN })}
                </span>
              )}
              {subtaskTotal > 0 && (
                <span className="text-xs text-gray-400">
                  {subtaskDone}/{subtaskTotal} 子任务
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
