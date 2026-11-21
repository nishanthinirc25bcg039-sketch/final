import React, { useState } from 'react';
import { Bot, Send, Sparkles } from 'lucide-react';
import { apiFetch } from '../utils/api';
import { ConfirmDialog } from './ui/Common';
import type { ChatResponsePayload, ChatSuggestedAction } from '../shared/types';

interface MessageItem {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  meta?: string;
  suggestedAction?: ChatSuggestedAction | null;
}

const SUGGESTED_QUESTIONS = [
  'What needs reordering?',
  'Which products are out of stock?',
  'What is my inventory value?',
  'Which items moved fastest this month?',
  'What purchase orders are still open?',
];

export function InventoryChatbot({
  onConfirmAction,
  compact = false,
}: {
  onConfirmAction: (action: ChatSuggestedAction) => void;
  compact?: boolean;
}) {
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      text: 'Ask me about stock levels, low-stock reorders, inventory valuation, fast-moving items, or open purchase orders.',
      meta: 'Powered by server-side Gemini AI · Grounded in live workspace records',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ChatSuggestedAction | null>(null);

  const sendQuestion = async (questionText: string) => {
    const trimmed = questionText.trim();
    if (!trimmed || loading) return;

    const userMsg: MessageItem = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: trimmed,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setError(null);
    setLoading(true);

    try {
      const res = await apiFetch<{ reply: ChatResponsePayload }>('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ question: trimmed }),
      });
      const r = res.reply;

      if (r.status === 'unavailable' || r.status === 'error') {
        setError(r.errorMessage || 'Inventory Assistant is currently unavailable.');
        return;
      }

      const meta =
        r.status === 'empty'
          ? 'No active catalog records yet'
          : `AI-generated via Gemini · Data: ${r.dataUsed}`;

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          sender: 'assistant',
          text: r.answer,
          meta,
          suggestedAction: r.suggestedAction || null,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to answer inventory question.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendQuestion(input);
  };

  return (
    <div className={`flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden ${compact ? 'h-[520px]' : 'h-[560px]'}`}>
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2 bg-slate-50/70">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-teal-600 text-white flex items-center justify-center shrink-0">
            <Bot className="w-4 h-4" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Inventory Assistant</h3>
            <p className="text-[11px] text-slate-500">Gemini AI grounded in live database state</p>
          </div>
        </div>
      </div>

      {/* Suggested Question Chips */}
      <div className="px-4 py-2.5 border-b border-slate-100 flex flex-wrap items-center gap-1.5 bg-white">
        {SUGGESTED_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={loading}
            onClick={() => sendQuestion(q)}
            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md whitespace-nowrap transition-colors disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Message Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/40">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[88%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
                m.sender === 'user'
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-800'
              }`}
            >
              <p>{m.text}</p>
              {m.suggestedAction && (
                <div className="mt-2.5 pt-2.5 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setPendingAction(m.suggestedAction!)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{m.suggestedAction.label}</span>
                  </button>
                </div>
              )}
            </div>
            {m.meta && (
              <span className="mt-1 text-[11px] text-slate-500 px-1">{m.meta}</span>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-start">
            <div className="bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs text-slate-500">
              Querying Gemini AI with current inventory snapshot...
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 leading-relaxed">
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-slate-200 bg-white flex items-center gap-2">
        <input
          type="text"
          aria-label="Ask an inventory question"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about reorders, value, or open POs..."
          className="flex-1 px-3 py-2 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:bg-white"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          aria-label="Send question"
          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50"
        >
          <Send className="w-4 h-4" aria-hidden="true" />
          <span className="hidden sm:inline">Ask</span>
        </button>
      </form>

      <ConfirmDialog
        open={Boolean(pendingAction)}
        title="Confirm Draft Purchase Order"
        message={
          pendingAction
            ? `Open the Purchase Order builder pre-filled for "${pendingAction.label}"? Nothing will be submitted until you review and save it.`
            : ''
        }
        confirmLabel="Open Draft Builder"
        onConfirm={() => {
          if (pendingAction) {
            onConfirmAction(pendingAction);
            setPendingAction(null);
          }
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
