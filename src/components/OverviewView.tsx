import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Box,
  DollarSign,
  MessageSquare,
  PackageCheck,
  Sparkles,
  Truck,
} from 'lucide-react';
import { formatCurrency, formatShortDate } from '../utils/api';
import {
  MovementBarChart,
  POStatusLabel,
  StockStatusLabel,
  TransactionTypeLabel,
} from './ui/Common';
import type { AIInsightsPayload, DashboardData, LowStockAlert } from '../shared/types';

export function OverviewView({
  data,
  insights,
  days,
  onDaysChange,
  onNavigate,
  onDraftPOFromAlert,
  onOpenChatbot,
  loading,
  error,
  onRetry,
  onSignOut,
}: {
  data: DashboardData | null;
  insights: AIInsightsPayload | null;
  days: number;
  onDaysChange: (days: number) => void;
  onNavigate: (tab: string) => void;
  onDraftPOFromAlert: (alert: LowStockAlert) => void;
  onOpenChatbot: () => void;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSignOut?: () => void;
}) {
  const [showHealthDetails, setShowHealthDetails] = useState(false);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 h-80 bg-white border border-slate-200 rounded-xl animate-pulse" />
          <div className="h-80 bg-white border border-slate-200 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div
        role="alert"
        className="bg-white border border-red-200 rounded-xl p-6 max-w-2xl mx-auto my-6 space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-red-50 border border-red-200 flex items-center justify-center text-red-600 shrink-0">
            <AlertTriangle className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900">Unable to load dashboard workspace</h2>
            <p className="mt-1 text-sm text-slate-600 leading-relaxed">
              {error || 'The dashboard snapshot did not load cleanly from the server.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors"
            >
              Retry Loading Dashboard
            </button>
          )}
          {onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Return to Sign In
            </button>
          )}
        </div>
      </div>
    );
  }

  const { metrics, healthScore, briefing, movementSeries, lowStockItems, recentTransactions, upcomingDeliveries, settings } = data;
  const currency = settings.currencySymbol || '$';

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Active Products</span>
            <Box className="w-4 h-4 text-slate-400" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {metrics.totalProducts}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {metrics.totalUnits.toLocaleString()} units on hand
            {metrics.archivedProducts > 0 ? ` · ${metrics.archivedProducts} archived` : ''}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Inventory Cost Value</span>
            <DollarSign className="w-4 h-4 text-slate-400" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {formatCurrency(metrics.inventoryCostValue, currency)}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums" title="Sum of active quantity × unit cost vs selling price">
            Retail {formatCurrency(metrics.inventoryRetailValue, currency)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Low & Out of Stock</span>
            <AlertTriangle className="w-4 h-4 text-amber-600" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {metrics.lowStockCount + metrics.outOfStockCount}
          </div>
          <div className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
            {metrics.outOfStockCount} empty · {metrics.lowStockCount} low
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Open Purchase Orders</span>
            <Truck className="w-4 h-4 text-teal-700" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {metrics.openPurchaseOrders}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {metrics.incomingUnits} units incoming
          </div>
        </div>

        {/* Transparent Stock Health Score */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Stock Health Score</span>
            <PackageCheck className="w-4 h-4 text-teal-700" aria-hidden="true" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-slate-900 font-mono tabular-nums">
              {healthScore.score !== null ? `${healthScore.score}/100` : '—'}
            </span>
            <span
              className={`text-xs font-medium ${
                healthScore.label === 'Healthy'
                  ? 'text-emerald-700'
                  : healthScore.label === 'Needs Attention'
                    ? 'text-amber-700'
                    : healthScore.label === 'At Risk'
                      ? 'text-red-700'
                      : 'text-slate-500'
              }`}
            >
              {healthScore.label}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowHealthDetails((v) => !v)}
            className="mt-1 text-left text-xs text-teal-700 hover:underline font-medium"
          >
            {showHealthDetails ? 'Hide score inputs' : 'See score inputs'}
          </button>
        </div>
      </div>

      {showHealthDetails && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Stock Health Score Breakdown ({healthScore.score !== null ? `${healthScore.score}/100` : 'No data yet'})
            </h3>
            <p className="text-xs text-slate-500">
              Computed strictly from active catalog reorder thresholds and confirmed inbound purchase orders. Valuation reflects active stock cost basis (qty × unit cost).
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {healthScore.factors.map((f) => (
              <div key={f.name} className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <div className="text-xs font-medium text-slate-500">{f.name}</div>
                <div className="mt-1 text-sm font-semibold text-slate-900 font-mono tabular-nums">
                  {f.impact}
                </div>
                <p className="mt-1 text-xs text-slate-600">{f.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Split: Movement Chart + Operational Briefing */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Inventory Movement</h2>
              <p className="text-xs text-slate-500">Daily units received vs dispatched ({settings.timezone})</p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="Movement date filter">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => onDaysChange(d)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    days === d
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <MovementBarChart data={movementSeries} />
        </div>

        {/* Daily Briefing */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="mb-3">
              <h2 className="text-base font-semibold text-slate-900">Workspace Summary & Actions</h2>
              <p className="text-xs text-slate-500">Live operational checks from saved records</p>
            </div>

            <div className="divide-y divide-slate-100">
              {briefing.map((item, idx) => (
                <div key={idx} className="py-3 first:pt-1 last:pb-1 flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs font-semibold ${
                          item.priority === 'urgent'
                            ? 'text-red-700'
                            : item.priority === 'warning'
                              ? 'text-amber-700'
                              : 'text-teal-700'
                        }`}
                      >
                        {item.priority === 'urgent'
                          ? 'Urgent'
                          : item.priority === 'warning'
                            ? 'Attention'
                            : 'Next Step'}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">·</span>
                      <span className="text-sm font-medium text-slate-900">{item.title}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-600 leading-relaxed">{item.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onNavigate(item.actionTab)}
                    aria-label={`Open ${item.title}`}
                    className="p-1.5 rounded-md text-slate-400 hover:text-slate-800 hover:bg-slate-100 shrink-0"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Honest Gemini AI Card */}
          <div className="mt-4 pt-4 border-t border-slate-200">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <Sparkles className="w-3.5 h-3.5 text-teal-600" aria-hidden="true" />
                <span>Gemini AI Inventory Summary</span>
              </div>
              <button
                type="button"
                onClick={onOpenChatbot}
                className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
              >
                <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Ask Assistant</span>
              </button>
            </div>
            <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
              {!insights
                ? 'Checking Gemini AI availability...'
                : insights.status === 'ready'
                  ? insights.summary
                  : insights.status === 'empty'
                    ? insights.summary
                    : insights.errorMessage}
            </p>
            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
              <span>{insights?.modelLabel || 'Gemini AI'}</span>
              <button
                type="button"
                onClick={() => onNavigate('ai-insights')}
                className="text-teal-700 font-medium hover:underline"
              >
                Open AI Insights
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Low Stock Watchlist + Recent Activity + Upcoming Deliveries */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Low & Out-of-Stock Alerts</h2>
              <p className="text-xs text-slate-500">Active items at or below reorder points</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('products')}
              className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
            >
              View Catalog
            </button>
          </div>

          {lowStockItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              {metrics.totalProducts === 0
                ? 'No products in your catalog yet.'
                : 'No active low-stock alerts. All products exceed reorder points.'}
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {lowStockItems.slice(0, 6).map((alert) => (
                <div
                  key={alert.id}
                  className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-900 truncate">
                        {alert.productName}
                      </span>
                      <StockStatusLabel
                        status={alert.alertType === 'out_of_stock' ? 'out_of_stock' : 'low_stock'}
                      />
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 font-mono tabular-nums">
                      {alert.sku} · On hand: {alert.quantity} / Reorder at {alert.reorderPoint} · {alert.supplierName}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDraftPOFromAlert(alert)}
                    className="px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors whitespace-nowrap self-start sm:self-auto"
                  >
                    Draft PO (+{alert.recommendedQty})
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-6 space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Recent Stock Activity</h2>
                <p className="text-xs text-slate-500">Latest audited ledger movements</p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('transactions')}
                className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
              >
                All Transactions
              </button>
            </div>
            {recentTransactions.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">No stock activity recorded yet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentTransactions.slice(0, 5).map((tx) => (
                  <div key={tx.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">
                        {tx.productName}
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatShortDate(tx.transactionDate)} · {tx.party} · by {tx.userName}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <TransactionTypeLabel type={tx.type} />
                      <span
                        className={`text-sm font-semibold font-mono tabular-nums w-12 text-right ${
                          tx.quantityChange >= 0 ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {tx.quantityChange > 0 ? `+${tx.quantityChange}` : tx.quantityChange}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">Upcoming Supplier Deliveries</h2>
                <p className="text-xs text-slate-500">Confirmed and partially received purchase orders</p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('purchase-orders')}
                className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
              >
                Purchase Orders
              </button>
            </div>
            {upcomingDeliveries.length === 0 ? (
              <p className="py-5 text-center text-sm text-slate-500">No incoming supplier deliveries scheduled.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {upcomingDeliveries.slice(0, 4).map((po) => (
                  <div key={po.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 font-mono">
                        {po.poNumber} · <span className="font-sans">{po.supplierName}</span>
                      </div>
                      <div className="text-xs text-slate-500 font-mono tabular-nums">
                        ETA {formatShortDate(po.expectedDeliveryDate)} · {formatCurrency(po.totalAmount, currency)}
                      </div>
                    </div>
                    <POStatusLabel status={po.status} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
