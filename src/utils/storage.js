const TASKS_KEY = 'smart-todo-tasks';
const SETTINGS_KEY = 'smart-todo-settings';
const FOCUS_KEY = 'smart-todo-focus-cache';

export const storage = {
  getTasks: () => {
    try {
      const data = localStorage.getItem(TASKS_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },
  setTasks: (tasks) => {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  },
  getSettings: () => {
    try {
      const data = localStorage.getItem(SETTINGS_KEY);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  },
  setSettings: (settings) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  },
  getFocusCache: () => {
    try {
      const data = localStorage.getItem(FOCUS_KEY);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },
  setFocusCache: (cache) => {
    localStorage.setItem(FOCUS_KEY, JSON.stringify(cache));
  },
  clearAll: () => {
    localStorage.removeItem(TASKS_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(FOCUS_KEY);
  },
};
