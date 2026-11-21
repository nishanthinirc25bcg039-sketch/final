import React, { useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Info,
  RefreshCw,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { ConfirmDialog } from './ui/Common';
import { InventoryChatbot } from './InventoryChatbot';
import type {
  AIInsightsPayload,
  ChatSuggestedAction,
} from '../shared/types';
import type { PODraftSeed } from './PurchaseOrdersView';

export function AIInsightsView({
  insights,
  periodDays,
  loading,
  onPeriodChange,
  onRefresh,
  onDraftPO,
}: {
  insights: AIInsightsPayload | null;
  periodDays: number;
  loading: boolean;
  onPeriodChange: (days: number) => void;
  onRefresh: () => void;
  onDraftPO: (seed: PODraftSeed) => void;
}) {
  const [confirmDraft, setConfirmDraft] = useState<(PODraftSeed & { title: string }) | null>(null);

  const handleChatAction = (action: ChatSuggestedAction) => {
    if (action.type === 'create_po' && action.productId && action.supplierId) {
      onDraftPO({
        productId: action.productId,
        supplierId: action.supplierId,
        quantity: action.quantity || 10,
        note: 'Prepared from Gemini Inventory Assistant recommendation.',
      });
    }
  };

  const highlightIcon = (type: AIInsightsPayload['highlights'][number]['type']) => {
    switch (type) {
      case 'demand_rising':
        return <TrendingUp className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />;
      case 'demand_falling':
        return <TrendingDown className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />;
      default:
        return <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Controls & Attribution */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="AI analysis window">
            {[7, 14, 30, 60].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onPeriodChange(d)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  periodDays === d
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {d} Days
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh Analysis</span>
          </button>
        </div>

        {insights && (
          <div className="flex items-center gap-2 text-xs text-slate-500 font-mono">
            <span>{insights.modelLabel}</span>
          </div>
        )}
      </div>

      {/* Transparency Banner */}
      <div className="flex items-start gap-2.5 px-4 py-3 bg-slate-100 border border-slate-200 rounded-lg text-xs text-slate-700">
        <Info className="w-4 h-4 text-teal-700 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <strong className="font-semibold text-slate-900">Server-Side Gemini Analysis:</strong> Summaries and recommendations are generated exclusively from your non-PII catalog and movement figures via Gemini ({insights?.dataScopeLabel || `Last ${periodDays} days`}). SmartStock AI never auto-modifies stock or submits purchase orders without your explicit confirmation.
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Gemini Summary, Recommendations & Deterministic Demand Comparison */}
        <div className="lg:col-span-7 space-y-6">
          {/* Summary Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 mb-2.5">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-teal-600 shrink-0" aria-hidden="true" />
                <h2 className="text-base font-semibold text-slate-900">
                  Period Inventory Summary ({periodDays} Days)
                </h2>
              </div>
              {insights?.status === 'ready' && (
                <span className="text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-md">
                  AI-generated via Gemini
                </span>
              )}
            </div>

            {loading && !insights ? (
              <p className="text-sm text-slate-500">Requesting Gemini AI analysis for your inventory...</p>
            ) : !insights ? (
              <p className="text-sm text-slate-500">Select a timeframe or click Refresh Analysis to run Gemini insights.</p>
            ) : insights.status === 'empty' ? (
              <p className="text-sm text-slate-600 leading-relaxed">{insights.summary}</p>
            ) : insights.status === 'unavailable' ? (
              <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-2">
                <div className="font-semibold flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Gemini AI Service Not Configured</span>
                </div>
                <p className="leading-relaxed">{insights.errorMessage}</p>
              </div>
            ) : insights.status === 'error' ? (
              <div role="alert" className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 space-y-2">
                <div className="font-semibold flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>Unable to Generate Gemini Summary</span>
                </div>
                <p>{insights.errorMessage}</p>
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={loading}
                  className="px-3 py-1.5 text-xs font-semibold text-red-800 bg-white border border-red-300 rounded-md hover:bg-red-100"
                >
                  Retry Analysis
                </button>
              </div>
            ) : (
              <p className="text-sm text-slate-700 leading-relaxed">{insights.summary}</p>
            )}
          </div>

          {/* Recommendations & Anomalies */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-base font-semibold text-slate-900">
                Recommendations & Anomalies
              </h2>
              {insights?.status === 'ready' && (
                <span className="text-[11px] text-slate-500 font-mono">{insights.dataScopeLabel}</span>
              )}
            </div>

            {!insights || insights.status !== 'ready' ? (
              <p className="text-sm text-slate-500 py-3">
                {insights?.status === 'empty'
                  ? 'Add products and record stock movements to unlock AI recommendations.'
                  : insights?.status === 'unavailable' || insights?.status === 'error'
                    ? 'AI recommendations are paused until Gemini AI responds. Your deterministic demand metrics remain visible below.'
                    : 'Waiting for analysis...'}
              </p>
            ) : insights.highlights.length === 0 ? (
              <p className="text-sm text-slate-500 py-3">
                Gemini did not detect urgent reorder risks or demand anomalies in this period.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {insights.highlights.map((h, i) => (
                  <div
                    key={i}
                    className="py-3.5 first:pt-1 last:pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="mt-0.5">{highlightIcon(h.type)}</div>
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{h.title}</div>
                        <p className="mt-0.5 text-xs text-slate-600 leading-relaxed">{h.detail}</p>
                      </div>
                    </div>
                    {h.type === 'reorder' && h.productId && h.supplierId && (
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmDraft({
                            title: h.title,
                            productId: h.productId!,
                            supplierId: h.supplierId!,
                            quantity: h.recommendedQty || 10,
                            note: `Prepared from Gemini AI Insights (${periodDays}d analysis).`,
                          })
                        }
                        className="px-3 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 whitespace-nowrap self-start sm:self-center shrink-0"
                      >
                        Draft PO (+{h.recommendedQty || 10})
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Deterministic Demand Changes Table */}
          {insights && insights.trends.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200">
                <h2 className="text-base font-semibold text-slate-900">
                  Demand Change Indicators
                </h2>
                <p className="text-xs text-slate-500">
                  Calculated directly from saved outbound ledger records (last {periodDays} days vs prior {periodDays} days; "—" when prior period had zero outbound volume).
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                      <th className="py-2.5 px-4">Product</th>
                      <th className="py-2.5 px-2 text-right">Stock</th>
                      <th className="py-2.5 px-2 text-right">Moved</th>
                      <th className="py-2.5 px-2 text-right">Change</th>
                      <th className="py-2.5 px-4">Movement Summary</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {insights.trends.map((t) => (
                      <tr key={t.productId}>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-900">{t.name}</div>
                          <div className="font-mono text-slate-500">{t.sku}</div>
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums">{t.currentQty}</td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums font-semibold">
                          {t.recentOutbound}
                        </td>
                        <td
                          className={`py-2.5 px-2 text-right font-mono tabular-nums font-semibold ${
                            t.direction === 'rising'
                              ? 'text-emerald-700'
                              : t.direction === 'falling'
                                ? 'text-amber-700'
                                : 'text-slate-500'
                          }`}
                        >
                          {t.changePercent !== null
                            ? t.changePercent > 0
                              ? `+${t.changePercent}%`
                              : `${t.changePercent}%`
                            : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-slate-600">{t.explanation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right: Embedded Inventory Chatbot */}
        <div className="lg:col-span-5">
          <InventoryChatbot onConfirmAction={handleChatAction} />
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDraft)}
        title="Prepare Purchase Order Draft"
        message={
          confirmDraft
            ? `Open the Purchase Order builder for "${confirmDraft.title}" (${confirmDraft.quantity} units)? Nothing is saved until you review quantities and submit.`
            : ''
        }
        confirmLabel="Open PO Form"
        onConfirm={() => {
          if (confirmDraft) {
            onDraftPO({
              productId: confirmDraft.productId,
              supplierId: confirmDraft.supplierId,
              quantity: confirmDraft.quantity,
              note: confirmDraft.note,
            });
            setConfirmDraft(null);
          }
        }}
        onCancel={() => setConfirmDraft(null)}
      />
    </div>
  );
}
