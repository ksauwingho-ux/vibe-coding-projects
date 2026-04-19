import { useState } from 'react';
import { TasksProvider } from './contexts/TasksContext';
import { SettingsProvider } from './contexts/SettingsContext';
import Sidebar from './components/layout/Sidebar';
import Dashboard from './pages/Dashboard';
import TaskList from './pages/TaskList';
import Settings from './pages/Settings';

function AppContent() {
  const [page, setPage] = useState('dashboard');

  const pages = {
    dashboard: <Dashboard />,
    tasks: <TaskList />,
    settings: <Settings />,
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar activePage={page} onNavigate={setPage} />
      <main className="flex-1 overflow-y-auto">
        {pages[page]}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <TasksProvider>
        <AppContent />
      </TasksProvider>
    </SettingsProvider>
  );
}
