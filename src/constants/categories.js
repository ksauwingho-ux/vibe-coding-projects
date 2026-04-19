export const CATEGORY_CONFIG = {
  meeting: {
    label: '会议/沟通',
    color: 'bg-blue-100 text-blue-700 border-blue-200',
    dotColor: 'bg-blue-500',
    icon: '💬',
  },
  docs: {
    label: '文档/写作',
    color: 'bg-purple-100 text-purple-700 border-purple-200',
    dotColor: 'bg-purple-500',
    icon: '📝',
  },
  project: {
    label: '项目管理',
    color: 'bg-orange-100 text-orange-700 border-orange-200',
    dotColor: 'bg-orange-500',
    icon: '📊',
  },
  other: {
    label: '其他',
    color: 'bg-gray-100 text-gray-600 border-gray-200',
    dotColor: 'bg-gray-400',
    icon: '📌',
  },
};

export const CATEGORIES = Object.entries(CATEGORY_CONFIG).map(([value, cfg]) => ({
  value,
  ...cfg,
}));
