import { useState } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import { useSettings } from '../contexts/SettingsContext';
import {
  buildPriorityPrompt,
  buildCategoryPrompt,
  buildFocusPrompt,
  buildBreakdownPrompt,
} from '../constants/prompts';
import { parseAIJson } from '../utils/aiHelpers';

const MODEL = 'claude-haiku-4-5-20251001';

export function useAI() {
  const { settings } = useSettings();
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});

  const callClaude = async (prompt) => {
    const client = new Anthropic({
      apiKey: settings.apiKey,
      dangerouslyAllowBrowser: true,
    });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content[0].text;
  };

  const withLoading = async (key, fn) => {
    setLoading((prev) => ({ ...prev, [key]: true }));
    setErrors((prev) => ({ ...prev, [key]: null }));
    try {
      return await fn();
    } catch (e) {
      setErrors((prev) => ({ ...prev, [key]: e.message }));
      return null;
    } finally {
      setLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const suggestPriority = (task) =>
    withLoading('priority', async () => {
      const raw = await callClaude(buildPriorityPrompt(task));
      return parseAIJson(raw);
    });

  const suggestCategory = (task) =>
    withLoading('category', async () => {
      const raw = await callClaude(buildCategoryPrompt(task));
      return parseAIJson(raw);
    });

  const generateFocusList = (tasks, today) =>
    withLoading('focus', async () => {
      const raw = await callClaude(buildFocusPrompt(tasks, today));
      return parseAIJson(raw);
    });

  const breakdownTask = (task) =>
    withLoading('breakdown', async () => {
      const raw = await callClaude(buildBreakdownPrompt(task));
      return parseAIJson(raw);
    });

  return { suggestPriority, suggestCategory, generateFocusList, breakdownTask, loading, errors };
}
