import { createContext, useContext, useState } from 'react';
import { storage } from '../utils/storage';

const TasksContext = createContext(null);

export function TasksProvider({ children }) {
  const [tasks, setTasks] = useState(() => storage.getTasks());

  const persist = (newTasks) => {
    setTasks(newTasks);
    storage.setTasks(newTasks);
  };

  const createTask = (data) => {
    const task = {
      id: crypto.randomUUID(),
      title: '',
      description: '',
      category: 'other',
      priority: 'medium',
      dueDate: '',
      status: 'todo',
      subtasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    };
    persist([...tasks, task]);
    return task;
  };

  const updateTask = (id, changes) => {
    persist(
      tasks.map((t) =>
        t.id === id ? { ...t, ...changes, updatedAt: new Date().toISOString() } : t
      )
    );
  };

  const deleteTask = (id) => {
    persist(tasks.filter((t) => t.id !== id));
  };

  return (
    <TasksContext.Provider value={{ tasks, createTask, updateTask, deleteTask }}>
      {children}
    </TasksContext.Provider>
  );
}

export function useTasks() {
  return useContext(TasksContext);
}
