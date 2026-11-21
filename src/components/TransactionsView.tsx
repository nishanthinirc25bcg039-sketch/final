import React, { useMemo, useState } from 'react';
import { ArrowLeftRight, Plus, RotateCcw, Search } from 'lucide-react';
import { validateStockMovement } from '../shared/inventoryLogic';
import { apiFetch, formatShortDate } from '../utils/api';
import {
  ConfirmDialog,
  EmptyState,
  Modal,
  PaginationBar,
  TransactionTypeLabel,
} from './ui/Common';
import type { Product, StockTransaction, TransactionType, UserRole } from '../shared/types';

const PAGE_SIZE = 15;

export interface StockAdjustmentSeed {
  productId: string;
  type: TransactionType;
  quantity: number;
  party: string;
  referenceNumber: string;
  reason: string;
  note?: string;
}

export function StockMovementModal({
  open,
  onClose,
  products,
  userRole,
  initialProductId,
  initialSeed,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  products: Product[];
  userRole: UserRole;
  initialProductId?: string;
  initialSeed?: StockAdjustmentSeed | null;
  onSuccess: (message: string) => Promise<void>;
}) {
  const isAdmin = userRole === 'admin';
  const activeProducts = useMemo(() => products.filter((p) => !p.archived), [products]);

  const [productId, setProductId] = useState(initialProductId || activeProducts[0]?.id || '');
  const [type, setType] = useState<TransactionType>('stock_in');
  const [quantity, setQuantity] = useState('1');
  const [transactionDate, setTransactionDate] = useState(new Date().toISOString().slice(0, 10));
  const [party, setParty] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [allowNegativeOverride, setAllowNegativeOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (open) {
      if (initialSeed) {
        setProductId(initialSeed.productId);
        setType(initialSeed.type);
        setQuantity(String(initialSeed.quantity));
        setTransactionDate(new Date().toISOString().slice(0, 10));
        setParty(initialSeed.party);
        setReferenceNumber(initialSeed.referenceNumber);
        setReason(initialSeed.reason);
        setNote(initialSeed.note || '');
      } else {
        setProductId(initialProductId || activeProducts[0]?.id || '');
        setType('stock_in');
        setQuantity('1');
        setTransactionDate(new Date().toISOString().slice(0, 10));
        setParty('');
        setReferenceNumber('');
        setReason('');
        setNote('');
      }
      setAllowNegativeOverride(false);
      setError(null);
      setConfirmOpen(false);
    }
  }, [open, initialProductId, initialSeed, activeProducts]);

  const selectedProduct = activeProducts.find((p) => p.id === productId);
  const qtyNum = Math.trunc(Number(quantity) || 0);
  const validation = selectedProduct
    ? validateStockMovement({
        currentQty: selectedProduct.quantity,
        type,
        quantity: qtyNum,
        reason,
        isAdmin,
        allowNegativeOverride,
      })
    : { valid: false, delta: 0, expectedQty: 0, error: 'Select an active product.' };

  const handleRequestConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!selectedProduct) {
      setError('Add an active product before recording stock movements.');
      return;
    }
    if (!validation.valid) {
      setError(validation.error || 'Invalid stock movement.');
      return;
    }
    if (!party.trim()) {
      setError(
        type === 'stock_in'
          ? 'Enter the supplier or source for this stock-in.'
          : type === 'stock_out'
            ? 'Enter the destination or channel for this stock-out.'
            : 'Enter the warehouse/location or reference entity for this adjustment.'
      );
      return;
    }
    setConfirmOpen(true);
  };

  const handleSubmit = async () => {
    if (!selectedProduct) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/transactions', {
        method: 'POST',
        body: JSON.stringify({
          productId: selectedProduct.id,
          type,
          quantity: qtyNum,
          transactionDate,
          party: party.trim(),
          referenceNumber: referenceNumber.trim(),
          reason: reason.trim(),
          note: note.trim(),
          allowNegativeOverride: type === 'adjustment' && isAdmin ? allowNegativeOverride : false,
        }),
      });
      setConfirmOpen(false);
      onClose();
      const signedDelta = validation.delta > 0 ? `+${validation.delta}` : `${validation.delta}`;
      await onSuccess(`Recorded ${signedDelta} units on ${selectedProduct.name}`);
    } catch (err) {
      setConfirmOpen(false);
      setError(err instanceof Error ? err.message : 'Failed to record stock movement.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Record Stock Movement"
        subtitle="Audit-logged inventory movement. Negative stock requires an explicit Admin adjustment."
        maxWidth="max-w-lg"
      >
        {activeProducts.length === 0 ? (
          <p className="text-sm text-slate-600 py-4">
            You do not have any active products yet. Add a product first before recording stock movements.
          </p>
        ) : (
          <form onSubmit={handleRequestConfirm} noValidate className="space-y-4">
            {error && (
              <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Movement Type</label>
              <div className={`grid gap-2 ${isAdmin ? 'grid-cols-3' : 'grid-cols-2'}`}>
                <button
                  type="button"
                  onClick={() => {
                    setType('stock_in');
                    setAllowNegativeOverride(false);
                  }}
                  className={`py-2 px-2.5 text-xs sm:text-sm font-medium rounded-lg border transition-colors ${
                    type === 'stock_in'
                      ? 'bg-emerald-50 border-emerald-600 text-emerald-800'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Stock In
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setType('stock_out');
                    setAllowNegativeOverride(false);
                  }}
                  className={`py-2 px-2.5 text-xs sm:text-sm font-medium rounded-lg border transition-colors ${
                    type === 'stock_out'
                      ? 'bg-amber-50 border-amber-600 text-amber-800'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Stock Out
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setType('adjustment')}
                    className={`py-2 px-2.5 text-xs sm:text-sm font-medium rounded-lg border transition-colors ${
                      type === 'adjustment'
                        ? 'bg-slate-900 border-slate-900 text-white'
                        : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Adjustment
                  </button>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="tx-product" className="block text-xs font-medium text-slate-700 mb-1">
                Product *
              </label>
              <select
                id="tx-product"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                {activeProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku}) — On hand: {p.quantity}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="tx-qty" className="block text-xs font-medium text-slate-700 mb-1">
                  {type === 'adjustment' ? 'Signed Quantity Delta (e.g. +5 or -3) *' : 'Quantity *'}
                </label>
                <input
                  id="tx-qty"
                  type="number"
                  min={type === 'adjustment' ? undefined : 1}
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div>
                <label htmlFor="tx-date" className="block text-xs font-medium text-slate-700 mb-1">
                  Date *
                </label>
                <input
                  id="tx-date"
                  type="date"
                  value={transactionDate}
                  onChange={(e) => setTransactionDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            {selectedProduct && (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between text-xs">
                <span className="text-slate-600">Expected Stock After Save</span>
                <span
                  className={`font-mono font-bold text-sm tabular-nums ${
                    !validation.valid ? 'text-red-700' : 'text-slate-900'
                  }`}
                >
                  {selectedProduct.quantity} → {validation.valid ? validation.expectedQty : 'Invalid'}
                </span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="tx-party" className="block text-xs font-medium text-slate-700 mb-1">
                  {type === 'stock_in'
                    ? 'Supplier / Source *'
                    : type === 'stock_out'
                      ? 'Destination / Channel *'
                      : 'Location / Audit Source *'}
                </label>
                <input
                  id="tx-party"
                  value={party}
                  onChange={(e) => setParty(e.target.value)}
                  placeholder={
                    type === 'stock_in'
                      ? 'e.g. Supplier delivery'
                      : type === 'stock_out'
                        ? 'e.g. Retail Counter'
                        : 'e.g. Main Warehouse Count'
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>

              <div>
                <label htmlFor="tx-ref" className="block text-xs font-medium text-slate-700 mb-1">
                  Reference Number
                </label>
                <input
                  id="tx-ref"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="e.g. SO-104 or REV-REF"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            </div>

            <div>
              <label htmlFor="tx-reason" className="block text-xs font-medium text-slate-700 mb-1">
                Reason {type === 'adjustment' ? '*' : '(Optional)'}
              </label>
              <input
                id="tx-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  type === 'adjustment'
                    ? 'Required: e.g. Reversal of miscounted entry or damaged write-off'
                    : 'e.g. Customer shipment, supplier restock'
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            {type === 'adjustment' && isAdmin && (
              <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowNegativeOverride}
                  onChange={(e) => setAllowNegativeOverride(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-teal-600"
                />
                <span>Explicitly authorize negative stock balance if adjustment drops below 0</span>
              </label>
            )}

            <div>
              <label htmlFor="tx-note" className="block text-xs font-medium text-slate-700 mb-1">
                Note (Optional)
              </label>
              <textarea
                id="tx-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Additional batch details or inspection notes..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700"
              >
                Review & Confirm
              </button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        title="Confirm Immutable Stock Entry"
        message={
          selectedProduct
            ? `Record ${type === 'stock_in' ? 'Stock In' : type === 'stock_out' ? 'Stock Out' : 'Admin Adjustment'} (${validation.delta > 0 ? `+${validation.delta}` : validation.delta} units) for "${selectedProduct.name}" (${selectedProduct.quantity} → ${validation.expectedQty} units)?`
            : ''
        }
        confirmLabel="Confirm & Save"
        loading={saving}
        onConfirm={handleSubmit}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

export function TransactionsView({
  transactions,
  products,
  userRole,
  onOpenStockModal,
  onOpenReversalModal,
}: {
  transactions: StockTransaction[];
  products: Product[];
  userRole: UserRole;
  onOpenStockModal: () => void;
  onOpenReversalModal: (seed: StockAdjustmentSeed) => void;
}) {
  const isAdmin = userRole === 'admin';
  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [userFilter, setUserFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [selectedTx, setSelectedTx] = useState<StockTransaction | null>(null);

  const users = useMemo(
    () => Array.from(new Set(transactions.map((t) => t.userName))).sort(),
    [transactions]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (
        q &&
        !(tx.productName || '').toLowerCase().includes(q) &&
        !(tx.productSku || '').toLowerCase().includes(q) &&
        !tx.party.toLowerCase().includes(q) &&
        !tx.referenceNumber.toLowerCase().includes(q) &&
        !(tx.reason || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      if (productFilter !== 'all' && tx.productId !== productFilter) return false;
      if (typeFilter !== 'all' && tx.type !== typeFilter) return false;
      if (userFilter !== 'all' && tx.userName !== userFilter) return false;
      if (dateFrom && tx.transactionDate < dateFrom) return false;
      if (dateTo && tx.transactionDate > dateTo) return false;
      return true;
    });
  }, [transactions, search, productFilter, typeFilter, userFilter, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  return (
    <div className="space-y-5">
      {/* Filter Toolbar */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 flex-1">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search transactions"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search SKU, party, ref, reason..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <select
            aria-label="Filter by product"
            value={productFilter}
            onChange={(e) => {
              setProductFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="all">All Products</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <select
            aria-label="Filter by transaction type"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="all">All Types</option>
            <option value="stock_in">Stock In</option>
            <option value="stock_out">Stock Out</option>
            <option value="adjustment">Adjustment</option>
          </select>

          <select
            aria-label="Filter by user"
            value={userFilter}
            onChange={(e) => {
              setUserFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="all">All Users</option>
            {users.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>

          <input
            type="date"
            aria-label="From date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
            className="px-2.5 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg"
          />
          <input
            type="date"
            aria-label="To date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
            className="px-2.5 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg"
          />
        </div>

        <button
          type="button"
          onClick={onOpenStockModal}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          <span>Record Stock Movement</span>
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title={transactions.length === 0 ? 'No stock transactions recorded yet' : 'No matching stock transactions'}
          description={
            transactions.length === 0
              ? 'Every stock-in, stock-out, purchase order receipt, and admin adjustment is logged here in an immutable audit trail.'
              : 'Clear one or more filters to view your transaction history.'
          }
          actionLabel={products.some((p) => !p.archived) ? 'Record Stock Movement' : undefined}
          onAction={products.some((p) => !p.archived) ? onOpenStockModal : undefined}
        />
      ) : (
        <>
          <div className="hidden lg:block bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-3">Product</th>
                    <th className="py-3 px-3">SKU</th>
                    <th className="py-3 px-3">Type</th>
                    <th className="py-3 px-3 text-right">Change</th>
                    <th className="py-3 px-3 text-right">Previous</th>
                    <th className="py-3 px-3 text-right">Resulting</th>
                    <th className="py-3 px-3">Reference</th>
                    <th className="py-3 px-4">User</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {paginated.map((tx) => (
                    <tr
                      key={tx.id}
                      onClick={() => setSelectedTx(tx)}
                      className="hover:bg-slate-50 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-mono text-xs text-slate-600 whitespace-nowrap">
                        {formatShortDate(tx.transactionDate)}
                      </td>
                      <td className="py-3 px-3 font-medium text-slate-900">{tx.productName}</td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-500 whitespace-nowrap">{tx.productSku}</td>
                      <td className="py-3 px-3">
                        <TransactionTypeLabel type={tx.type} />
                      </td>
                      <td
                        className={`py-3 px-3 text-right font-mono tabular-nums font-semibold ${
                          tx.quantityChange >= 0 ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {tx.quantityChange > 0 ? `+${tx.quantityChange}` : tx.quantityChange}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-500">
                        {tx.previousQuantity}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                        {tx.resultingQuantity}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-600">
                        {tx.referenceNumber || '-'}
                      </td>
                      <td className="py-3 px-4 text-slate-600">{tx.userName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="lg:hidden space-y-3">
            {paginated.map((tx) => (
              <button
                key={tx.id}
                type="button"
                onClick={() => setSelectedTx(tx)}
                className="w-full text-left bg-white border border-slate-200 rounded-xl p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{tx.productName}</div>
                    <div className="text-xs text-slate-500 font-mono">
                      {tx.productSku} · {formatShortDate(tx.transactionDate)}
                    </div>
                  </div>
                  <TransactionTypeLabel type={tx.type} />
                </div>
                <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-100">
                  <span className="text-slate-600">
                    {tx.party} · {tx.referenceNumber || 'No ref'}
                  </span>
                  <span className="font-mono tabular-nums font-semibold text-slate-900">
                    {tx.quantityChange > 0 ? `+${tx.quantityChange}` : tx.quantityChange} ({tx.previousQuantity} → {tx.resultingQuantity})
                  </span>
                </div>
              </button>
            ))}
          </div>

          <PaginationBar
            page={safePage}
            totalPages={totalPages}
            totalItems={filtered.length}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        </>
      )}

      {/* Transaction Detail Modal */}
      <Modal
        open={Boolean(selectedTx)}
        onClose={() => setSelectedTx(null)}
        title="Immutable Audit Record"
        subtitle={selectedTx ? `${selectedTx.productName} (${selectedTx.productSku})` : undefined}
        maxWidth="max-w-md"
      >
        {selectedTx && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Type</span>
              <TransactionTypeLabel type={selectedTx.type} />
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Quantity Change</span>
              <span className="font-mono font-semibold tabular-nums text-slate-900">
                {selectedTx.quantityChange > 0 ? `+${selectedTx.quantityChange}` : selectedTx.quantityChange}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Stock Impact</span>
              <span className="font-mono tabular-nums text-slate-900">
                {selectedTx.previousQuantity} → {selectedTx.resultingQuantity} units
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Source / Destination</span>
              <span className="font-medium text-slate-900">{selectedTx.party}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Reference</span>
              <span className="font-mono text-slate-900">{selectedTx.referenceNumber || '-'}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Recorded By</span>
              <span className="text-slate-900">{selectedTx.userName}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <span className="text-slate-500">Date & Timestamp</span>
              <span className="font-mono text-xs text-slate-700">
                {selectedTx.transactionDate} ({new Date(selectedTx.createdAt).toLocaleString()})
              </span>
            </div>
            {selectedTx.reason && (
              <div>
                <span className="text-xs text-slate-500 block mb-1">Reason</span>
                <p className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800">
                  {selectedTx.reason}
                </p>
              </div>
            )}
            {selectedTx.note && (
              <div>
                <span className="text-xs text-slate-500 block mb-1">Note</span>
                <p className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                  {selectedTx.note}
                </p>
              </div>
            )}
            {isAdmin && (
              <div className="pt-2 border-t border-slate-200 flex items-center justify-between gap-2">
                <span className="text-xs text-slate-500">Past entries are immutable.</span>
                <button
                  type="button"
                  onClick={() => {
                    const tx = selectedTx;
                    setSelectedTx(null);
                    onOpenReversalModal({
                      productId: tx.productId,
                      type: 'adjustment',
                      quantity: -tx.quantityChange,
                      party: tx.party || 'Audit Reversal',
                      referenceNumber: `REV-${tx.referenceNumber || tx.id.slice(-5)}`,
                      reason: `Reversal of entry ${tx.referenceNumber || tx.id}`,
                      note: `Offsetting adjustment for ${tx.transactionDate} (${tx.quantityChange > 0 ? `+${tx.quantityChange}` : tx.quantityChange})`,
                    });
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Record Reversal</span>
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
