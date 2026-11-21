import React, { useEffect, useState } from 'react';
import { Download, Info } from 'lucide-react';
import { getStockStatus, getStockStatusLabel } from '../shared/inventoryLogic';
import { apiFetch, exportCsv, formatCurrency, formatShortDate } from '../utils/api';
import { MovementBarChart, POStatusLabel, StockStatusLabel, TransactionTypeLabel } from './ui/Common';
import type {
  DemandTrendItem,
  Product,
  PurchaseOrder,
  StockTransaction,
  Supplier,
} from '../shared/types';

interface ReportPayload {
  days: number;
  cutoffIso: string;
  category: string;
  categories: string[];
  valuation: {
    totalProducts: number;
    archivedProducts: number;
    totalUnits: number;
    inventoryCostValue: number;
    inventoryRetailValue: number;
    potentialMargin: number;
    lowStockCount: number;
    outOfStockCount: number;
  };
  products: Product[];
  transactions: StockTransaction[];
  purchaseOrders: PurchaseOrder[];
  suppliers: Supplier[];
  trends: DemandTrendItem[];
  movementSeries: Array<{ date: string; stockIn: number; stockOut: number }>;
  categoryBreakdown: Array<{
    category: string;
    skus: number;
    units: number;
    costValue: number;
    retailValue: number;
  }>;
}

type ReportTab = 'valuation' | 'low_stock' | 'activity' | 'trends' | 'suppliers';

export function ReportsView({
  currencySymbol,
}: {
  currencySymbol: string;
}) {
  const [days, setDays] = useState(30);
  const [category, setCategory] = useState('all');
  const [activeTab, setActiveTab] = useState<ReportTab>('valuation');
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ReportPayload>(`/api/reports?days=${days}&category=${encodeURIComponent(category)}`)
      .then((res) => {
        if (!cancelled) setReport(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load reports.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, category]);

  const handleExportCsv = () => {
    if (!report) return;
    if (activeTab === 'valuation') {
      exportCsv(
        `inventory-valuation-${days}d.csv`,
        ['SKU', 'Product', 'Category', 'Supplier', 'Quantity', 'Unit Cost', 'Cost Value', 'Selling Price', 'Retail Value', 'Status'],
        report.products.map((p) => [
          p.sku,
          p.name,
          p.category,
          p.supplierName || '',
          p.quantity,
          p.unitCost,
          (p.quantity * p.unitCost).toFixed(2),
          p.sellingPrice,
          (p.quantity * p.sellingPrice).toFixed(2),
          getStockStatusLabel(getStockStatus(p.quantity, p.reorderPoint)),
        ])
      );
    } else if (activeTab === 'low_stock') {
      const lowItems = report.products.filter(
        (p) => getStockStatus(p.quantity, p.reorderPoint) !== 'in_stock'
      );
      exportCsv(
        'low-out-of-stock-report.csv',
        ['SKU', 'Product', 'Supplier', 'Quantity', 'Reorder Point', 'Status'],
        lowItems.map((p) => [
          p.sku,
          p.name,
          p.supplierName || '',
          p.quantity,
          p.reorderPoint,
          getStockStatusLabel(getStockStatus(p.quantity, p.reorderPoint)),
        ])
      );
    } else if (activeTab === 'activity') {
      exportCsv(
        `stock-activity-${days}d.csv`,
        ['Date', 'Product', 'SKU', 'Type', 'Qty Change', 'Previous', 'Resulting', 'Party', 'Reference', 'Reason', 'User'],
        report.transactions.map((t) => [
          t.transactionDate,
          t.productName || '',
          t.productSku || '',
          t.type,
          t.quantityChange,
          t.previousQuantity,
          t.resultingQuantity,
          t.party,
          t.referenceNumber,
          t.reason,
          t.userName,
        ])
      );
    } else if (activeTab === 'trends') {
      exportCsv(
        `demand-trends-${days}d.csv`,
        ['SKU', 'Product', 'On Hand', 'Outbound Period', 'Prior Period', 'Change %', 'Direction'],
        report.trends.map((t) => [
          t.sku,
          t.name,
          t.currentQty,
          t.recentOutbound,
          t.previousOutbound,
          t.changePercent !== null ? `${t.changePercent}%` : 'Insufficient prior data',
          t.direction,
        ])
      );
    } else {
      exportCsv(
        `supplier-po-activity-${days}d.csv`,
        ['PO Number', 'Supplier', 'Status', 'Order Date', 'ETA', 'Total Amount'],
        report.purchaseOrders.map((po) => [
          po.poNumber,
          po.supplierName || '',
          po.status,
          po.orderDate,
          po.expectedDeliveryDate,
          po.totalAmount.toFixed(2),
        ])
      );
    }
  };

  if (loading && !report) {
    return (
      <div className="space-y-4">
        <div className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
        <div className="h-72 bg-white border border-slate-200 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="p-6 bg-white border border-red-200 rounded-xl text-sm text-red-700">
        {error || 'Unable to load reports.'}
      </div>
    );
  }

  const lowStockProducts = report.products.filter(
    (p) => getStockStatus(p.quantity, p.reorderPoint) !== 'in_stock'
  );
  const maxCatVal = Math.max(1, ...report.categoryBreakdown.map((c) => c.costValue));

  return (
    <div className="space-y-6">
      {/* Filters & Export */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  days === d ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Last {d}d
              </button>
            ))}
          </div>

          <select
            aria-label="Filter report by category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="all">All Categories</option>
            {report.categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={handleExportCsv}
          disabled={report.products.length === 0 && report.transactions.length === 0 && report.purchaseOrders.length === 0}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap disabled:opacity-50"
        >
          <Download className="w-4 h-4" aria-hidden="true" />
          <span>Export Active Tab CSV</span>
        </button>
      </div>

      {/* Documented Calculation Rules Banner */}
      <div className="flex items-start gap-2.5 px-4 py-2.5 bg-slate-100 border border-slate-200 rounded-lg text-xs text-slate-700">
        <Info className="w-4 h-4 text-teal-700 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          <strong>Calculation rules:</strong> Active non-archived SKUs only · Cost valuation = <code className="font-mono">sum(on_hand × unit_cost)</code> · Retail = <code className="font-mono">sum(on_hand × selling_price)</code> · Activity window since <span className="font-mono">{report.cutoffIso}</span> · Demand % change is shown only when the prior {days}-day comparison period contains recorded outbound movements.
        </span>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Inventory Cost Valuation</div>
          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
            {formatCurrency(report.valuation.inventoryCostValue, currencySymbol)}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {report.valuation.totalUnits} units across {report.valuation.totalProducts} SKUs
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Estimated Retail & Margin</div>
          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
            {formatCurrency(report.valuation.inventoryRetailValue, currencySymbol)}
          </div>
          <div className="mt-1 text-xs text-emerald-700 font-mono tabular-nums">
            +{formatCurrency(report.valuation.potentialMargin, currencySymbol)} gross margin
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Stock Exceptions</div>
          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
            {report.valuation.outOfStockCount + report.valuation.lowStockCount}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {report.valuation.outOfStockCount} out · {report.valuation.lowStockCount} low
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Movements ({days}d)</div>
          <div className="mt-1 text-xl font-bold font-mono tabular-nums text-slate-900">
            {report.transactions.length}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {report.purchaseOrders.length} POs in period
          </div>
        </div>
      </div>

      {/* Report Tabs */}
      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
        {(
          [
            { id: 'valuation', label: 'Inventory & Value' },
            { id: 'low_stock', label: 'Low & Out of Stock' },
            { id: 'activity', label: 'Stock Activity' },
            { id: 'trends', label: 'Demand Trends' },
            { id: 'suppliers', label: 'Suppliers & POs' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'valuation' && (
        report.products.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">
            No active products in this filter to compute valuation.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-slate-900 mb-3">Value by Category</h3>
              <div className="space-y-3">
                {report.categoryBreakdown.map((c) => {
                  const pct = Math.round((c.costValue / maxCatVal) * 100);
                  return (
                    <div key={c.category}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-medium text-slate-800">{c.category}</span>
                        <span className="font-mono tabular-nums text-slate-600">
                          {formatCurrency(c.costValue, currencySymbol)} ({c.units} units)
                        </span>
                      </div>
                      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-teal-600 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                      <th className="py-2.5 px-4">Product</th>
                      <th className="py-2.5 px-3 text-right">Qty</th>
                      <th className="py-2.5 px-3 text-right">Cost Value</th>
                      <th className="py-2.5 px-4 text-right">Retail Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.products.map((p) => (
                      <tr key={p.id}>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-slate-900">{p.name}</div>
                          <div className="font-mono text-slate-500">{p.sku}</div>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">{p.quantity}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                          {formatCurrency(p.quantity * p.unitCost, currencySymbol)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums font-medium text-slate-900">
                          {formatCurrency(p.quantity * p.sellingPrice, currencySymbol)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )
      )}

      {activeTab === 'low_stock' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {lowStockProducts.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500">
              No low-stock or out-of-stock products in this filter.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Product</th>
                    <th className="py-3 px-3">SKU</th>
                    <th className="py-3 px-3">Supplier</th>
                    <th className="py-3 px-3 text-right">On Hand</th>
                    <th className="py-3 px-3 text-right">Reorder Point</th>
                    <th className="py-3 px-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lowStockProducts.map((p) => (
                    <tr key={p.id}>
                      <td className="py-3 px-4 font-medium text-slate-900">{p.name}</td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-500">{p.sku}</td>
                      <td className="py-3 px-3 text-slate-600">{p.supplierName}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold">
                        {p.quantity}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-500">
                        {p.reorderPoint}
                      </td>
                      <td className="py-3 px-4">
                        <StockStatusLabel status={getStockStatus(p.quantity, p.reorderPoint)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Stock-In vs Stock-Out Activity ({days}d)
            </h3>
            <MovementBarChart data={report.movementSeries} />
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {report.transactions.length === 0 ? (
              <p className="p-8 text-center text-sm text-slate-500">No stock movements recorded in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                      <th className="py-2.5 px-4">Date</th>
                      <th className="py-2.5 px-3">Product</th>
                      <th className="py-2.5 px-3">Type</th>
                      <th className="py-2.5 px-3 text-right">Change</th>
                      <th className="py-2.5 px-3">Party</th>
                      <th className="py-2.5 px-4">User</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.transactions.map((t) => (
                      <tr key={t.id}>
                        <td className="py-2.5 px-4 font-mono text-slate-600">{formatShortDate(t.transactionDate)}</td>
                        <td className="py-2.5 px-3 font-medium text-slate-900">{t.productName}</td>
                        <td className="py-2.5 px-3"><TransactionTypeLabel type={t.type} /></td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold">
                          {t.quantityChange > 0 ? `+${t.quantityChange}` : t.quantityChange}
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">{t.party}</td>
                        <td className="py-2.5 px-4 text-slate-600">{t.userName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'trends' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {report.trends.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500">Add products and record outbound stock movements to compute demand comparisons.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                    <th className="py-3 px-4">Product</th>
                    <th className="py-3 px-3 text-right">On Hand</th>
                    <th className="py-3 px-3 text-right">Outbound ({days}d)</th>
                    <th className="py-3 px-3 text-right">Prior ({days}d)</th>
                    <th className="py-3 px-3 text-right">Change</th>
                    <th className="py-3 px-4">Comparison Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.trends.map((t) => (
                    <tr key={t.productId}>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{t.name}</div>
                        <div className="font-mono text-slate-500">{t.sku}</div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums">{t.currentQty}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold">
                        {t.recentOutbound}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-500">
                        {t.previousOutbound}
                      </td>
                      <td
                        className={`py-3 px-3 text-right font-mono tabular-nums font-semibold ${
                          t.direction === 'rising'
                            ? 'text-emerald-700'
                            : t.direction === 'falling'
                              ? 'text-amber-700'
                              : 'text-slate-500'
                        }`}
                      >
                        {t.changePercent !== null
                          ? `${t.changePercent > 0 ? `+${t.changePercent}` : t.changePercent}%`
                          : '—'}
                      </td>
                      <td className="py-3 px-4 text-slate-600">{t.explanation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'suppliers' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {report.purchaseOrders.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500">No purchase orders created within this date window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                    <th className="py-3 px-4">PO Number</th>
                    <th className="py-3 px-3">Supplier</th>
                    <th className="py-3 px-3">Order Date</th>
                    <th className="py-3 px-3">Expected Delivery</th>
                    <th className="py-3 px-3 text-right">Total</th>
                    <th className="py-3 px-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.purchaseOrders.map((po) => (
                    <tr key={po.id}>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">{po.poNumber}</td>
                      <td className="py-3 px-3 text-slate-800">{po.supplierName}</td>
                      <td className="py-3 px-3 font-mono text-slate-600">{formatShortDate(po.orderDate)}</td>
                      <td className="py-3 px-3 font-mono text-slate-600">
                        {formatShortDate(po.expectedDeliveryDate)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold">
                        {formatCurrency(po.totalAmount, currencySymbol)}
                      </td>
                      <td className="py-3 px-4">
                        <POStatusLabel status={po.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
