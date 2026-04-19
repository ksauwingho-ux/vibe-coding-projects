import { createContext, useContext, useState } from 'react';
import { storage } from '../utils/storage';

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => storage.getSettings());

  const updateSettings = (changes) => {
    const next = { ...settings, ...changes };
    setSettings(next);
    storage.setSettings(next);
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
