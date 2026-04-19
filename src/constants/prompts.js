export function buildPriorityPrompt(task) {
  const today = new Date().toISOString().slice(0, 10);
  return `你是一个任务管理助手。根据以下任务信息，建议合适的优先级。

任务标题：${task.title}
任务描述：${task.description || '（无描述）'}
截止日期：${task.dueDate || '（未设置）'}
当前日期：${today}

请以JSON格式返回，包含以下字段：
- priority: "high"、"medium" 或 "low"
- reason: 简短说明（不超过50字）

只返回JSON，不要其他文字。`;
}

export function buildCategoryPrompt(task) {
  return `你是一个任务分类助手。根据任务描述，将任务分类到以下类别之一：
- meeting: 会议、沟通、讨论、评审、汇报
- docs: 文档、写作、报告、方案、需求、分析
- project: 项目管理、开发、计划、执行、测试、发布
- other: 不属于以上类别

任务标题：${task.title}
任务描述：${task.description || '（无描述）'}

请以JSON格式返回：
- category: "meeting"、"docs"、"project" 或 "other"
- reason: 简短说明（不超过30字）

只返回JSON。`;
}

export function buildFocusPrompt(tasks, today) {
  const pending = tasks
    .filter(t => t.status !== 'done')
    .map(t => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      dueDate: t.dueDate || '未设置',
      status: t.status,
      category: t.category,
    }));

  return `你是一个工作效率助手。从以下任务列表中，选出今天（${today}）最应该专注的3-5个任务。

任务列表：
${JSON.stringify(pending, null, 2)}

选择标准：截止日期紧迫性（尤其是今天或明天截止的）、优先级（高>中>低）、避免重复选已完成任务。

请以JSON格式返回：
- taskIds: 选中任务的id数组（按优先顺序，最多5个）
- reasoning: 推荐理由（不超过80字）

只返回JSON。`;
}

export function buildBreakdownPrompt(task) {
  return `你是一个项目管理助手。将以下任务拆解为3-6个可执行的子任务。

任务标题：${task.title}
任务描述：${task.description || '（无描述）'}

要求：子任务要具体、可操作、单人可完成，每个子任务描述不超过30字。

请以JSON格式返回：
- subtasks: 子任务数组，每项包含 title（子任务标题）

只返回JSON。`;
}
