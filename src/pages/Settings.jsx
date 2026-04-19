import { useState } from 'react';
import { Eye, EyeOff, CheckCircle2, AlertCircle, Trash2 } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';
import { storage } from '../utils/storage';
import Button from '../components/common/Button';
import Anthropic from '@anthropic-ai/sdk';
import LoadingSpinner from '../components/common/LoadingSpinner';

export default function Settings() {
  const { settings, updateSettings } = useSettings();
  const [keyInput, setKeyInput] = useState(settings.apiKey || '');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const handleSaveKey = () => {
    updateSettings({ apiKey: keyInput.trim() });
    setTestResult(null);
  };

  const handleTestKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setTesting(true);
    setTestResult(null);
    try {
      const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
      await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      });
      setTestResult({ ok: true, msg: 'API Key 有效，连接成功！' });
      updateSettings({ apiKey: key });
    } catch (e) {
      setTestResult({ ok: false, msg: `连接失败：${e.message}` });
    } finally {
      setTesting(false);
    }
  };

  const handleClearData = () => {
    if (window.confirm('确定清除所有任务数据吗？此操作不可撤销。')) {
      storage.clearAll();
      window.location.reload();
    }
  };

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-xl font-bold text-gray-800 mb-6">设置</h1>

      {/* API Key */}
      <section className="bg-white rounded-2xl border border-gray-100 p-5 mb-4">
        <h2 className="font-semibold text-gray-700 mb-1">Anthropic API Key</h2>
        <p className="text-xs text-gray-400 mb-4">
          AI 功能需要 Anthropic API Key。Key 仅存储在你的浏览器本地，不会发送到任何第三方服务器。
        </p>

        <div className="relative mb-3">
          <input
            type={showKey ? 'text' : 'password'}
            value={keyInput}
            onChange={(e) => { setKeyInput(e.target.value); setTestResult(null); }}
            placeholder="sk-ant-..."
            className="w-full border border-gray-200 rounded-lg px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {testResult && (
          <div className={`flex items-center gap-2 text-sm mb-3 ${testResult.ok ? 'text-green-600' : 'text-red-500'}`}>
            {testResult.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
            {testResult.msg}
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="primary" onClick={handleSaveKey} disabled={!keyInput.trim()}>
            保存
          </Button>
          <Button variant="secondary" onClick={handleTestKey} disabled={testing || !keyInput.trim()}>
            {testing ? <LoadingSpinner size={14} /> : null}
            测试连接
          </Button>
          {settings.apiKey && (
            <Button variant="ghost" onClick={() => { setKeyInput(''); updateSettings({ apiKey: '' }); setTestResult(null); }}>
              清除
            </Button>
          )}
        </div>

        {settings.apiKey && !testResult && (
          <p className="text-xs text-green-600 mt-2 flex items-center gap-1">
            <CheckCircle2 size={12} />
            API Key 已保存
          </p>
        )}
      </section>

      {/* About */}
      <section className="bg-white rounded-2xl border border-gray-100 p-5 mb-4">
        <h2 className="font-semibold text-gray-700 mb-3">关于</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-500">AI 模型</dt>
            <dd className="text-gray-700 font-mono text-xs">claude-haiku-4-5</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">数据存储</dt>
            <dd className="text-gray-700">浏览器本地 (localStorage)</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">支持的工作类型</dt>
            <dd className="text-gray-700">会议、文档、项目管理</dd>
          </div>
        </dl>
      </section>

      {/* Danger zone */}
      <section className="bg-red-50 rounded-2xl border border-red-100 p-5">
        <h2 className="font-semibold text-red-700 mb-1">危险操作</h2>
        <p className="text-xs text-red-400 mb-3">清除全部任务数据，此操作不可撤销。</p>
        <Button variant="danger" onClick={handleClearData}>
          <Trash2 size={14} />
          清除所有数据
        </Button>
      </section>
    </div>
  );
}
