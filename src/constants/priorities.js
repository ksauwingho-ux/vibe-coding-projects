export const PRIORITY_CONFIG = {
  high: {
    label: '高优先级',
    shortLabel: '高',
    color: 'bg-red-100 text-red-700 border-red-200',
    dotColor: 'bg-red-500',
    order: 0,
  },
  medium: {
    label: '中优先级',
    shortLabel: '中',
    color: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    dotColor: 'bg-yellow-500',
    order: 1,
  },
  low: {
    label: '低优先级',
    shortLabel: '低',
    color: 'bg-green-100 text-green-700 border-green-200',
    dotColor: 'bg-green-500',
    order: 2,
  },
};

export const PRIORITIES = Object.entries(PRIORITY_CONFIG).map(([value, cfg]) => ({
  value,
  ...cfg,
}));

export const STATUS_CONFIG = {
  todo: { label: '待办', color: 'bg-gray-100 text-gray-600' },
  'in-progress': { label: '进行中', color: 'bg-blue-100 text-blue-700' },
  done: { label: '已完成', color: 'bg-green-100 text-green-700' },
};

export const STATUSES = Object.entries(STATUS_CONFIG).map(([value, cfg]) => ({
  value,
  ...cfg,
}));
