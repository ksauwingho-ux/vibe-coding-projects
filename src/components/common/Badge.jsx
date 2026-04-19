import { CATEGORY_CONFIG } from '../../constants/categories';
import { PRIORITY_CONFIG, STATUS_CONFIG } from '../../constants/priorities';

export function CategoryBadge({ category }) {
  const cfg = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.other;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.color}`}>
      <span>{cfg.icon}</span>
      {cfg.label}
    </span>
  );
}

export function PriorityBadge({ priority }) {
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.medium;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dotColor}`} />
      {cfg.shortLabel}
    </span>
  );
}

export function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.todo;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}
