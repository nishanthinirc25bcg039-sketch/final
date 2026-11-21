import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardList, Plus, Printer, Trash2, Truck } from 'lucide-react';
import { apiFetch, formatCurrency, formatShortDate } from '../utils/api';
import { ConfirmDialog, EmptyState, Modal, POStatusLabel } from './ui/Common';
import type { Product, PurchaseOrder, PurchaseOrderStatus, Supplier } from '../shared/types';

export interface PODraftSeed {
  supplierId: string;
  productId: string;
  quantity: number;
  note?: string;
}

export function PurchaseOrdersView({
  purchaseOrders,
  suppliers,
  products,
  currencySymbol,
  draftSeed,
  onClearDraftSeed,
  onDataChanged,
  onNotify,
}: {
  purchaseOrders: PurchaseOrder[];
  suppliers: Supplier[];
  products: Product[];
  currencySymbol: string;
  draftSeed: PODraftSeed | null;
  onClearDraftSeed: () => void;
  onDataChanged: () => Promise<void>;
  onNotify: (msg: string, tone?: 'success' | 'error') => void;
}) {
  const activeSuppliers = useMemo(() => suppliers.filter((s) => !s.archived), [suppliers]);
  const activeProducts = useMemo(() => products.filter((p) => !p.archived), [products]);

  const [statusFilter, setStatusFilter] = useState<'all' | PurchaseOrderStatus>('all');
  const [createOpen, setCreateOpen] = useState(false);

  const [poSupplierId, setPoSupplierId] = useState('');
  const [poStatus, setPoStatus] = useState<'Draft' | 'Ordered'>('Ordered');
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState(
    new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  const [poNotes, setPoNotes] = useState('');
  const [lines, setLines] = useState<Array<{ productId: string; quantityOrdered: string; unitCost: string }>>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [activePO, setActivePO] = useState<PurchaseOrder | null>(null);
  const [receiveInputs, setReceiveInputs] = useState<Record<string, string>>({});
  const [confirmReceiveOpen, setConfirmReceiveOpen] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);

  useEffect(() => {
    if (draftSeed) {
      const prod = activeProducts.find((p) => p.id === draftSeed.productId);
      setPoSupplierId(draftSeed.supplierId || prod?.supplierId || activeSuppliers[0]?.id || '');
      setPoStatus('Draft');
      setOrderDate(new Date().toISOString().slice(0, 10));
      setExpectedDate(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
      setPoNotes(draftSeed.note || 'Created from low-stock reorder.');
      setLines([
        {
          productId: draftSeed.productId,
          quantityOrdered: String(Math.max(1, draftSeed.quantity)),
          unitCost: String(prod?.unitCost ?? 0),
        },
      ]);
      setFormError(null);
      setCreateOpen(true);
      onClearDraftSeed();
    }
  }, [draftSeed, activeProducts, activeSuppliers, onClearDraftSeed]);

  const openCreateModal = () => {
    if (activeSuppliers.length === 0 || activeProducts.length === 0) {
      onNotify('Add at least one active supplier and one active product before creating a purchase order.', 'error');
      return;
    }
    const defaultSupId = activeSuppliers[0]?.id || '';
    const firstProd = activeProducts.find((p) => p.supplierId === defaultSupId) || activeProducts[0];
    setPoSupplierId(defaultSupId);
    setPoStatus('Ordered');
    setOrderDate(new Date().toISOString().slice(0, 10));
    setExpectedDate(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    setPoNotes('');
    setLines(
      firstProd
        ? [{ productId: firstProd.id, quantityOrdered: '10', unitCost: String(firstProd.unitCost) }]
        : []
    );
    setFormError(null);
    setCreateOpen(true);
  };

  const addLine = () => {
    const supProducts = activeProducts.filter((p) => p.supplierId === poSupplierId);
    const candidate = supProducts[0] || activeProducts[0];
    if (!candidate) return;
    setLines((prev) => [
      ...prev,
      { productId: candidate.id, quantityOrdered: '10', unitCost: String(candidate.unitCost) },
    ]);
  };

  const updateLine = (idx: number, patch: Partial<{ productId: string; quantityOrdered: string; unitCost: string }>) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const next = { ...l, ...patch };
        if (patch.productId) {
          const p = activeProducts.find((x) => x.id === patch.productId);
          if (p) next.unitCost = String(p.unitCost);
        }
        return next;
      })
    );
  };

  const draftTotal = useMemo(() => {
    return lines.reduce((sum, l) => {
      const q = Math.max(0, Number(l.quantityOrdered) || 0);
      const c = Math.max(0, Number(l.unitCost) || 0);
      return sum + q * c;
    }, 0);
  }, [lines]);

  const handleCreatePO = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!poSupplierId) {
      setFormError('Select a supplier.');
      return;
    }
    if (lines.length === 0) {
      setFormError('Add at least one product line.');
      return;
    }
    const formatted = lines.map((l) => ({
      productId: l.productId,
      quantityOrdered: Math.trunc(Number(l.quantityOrdered)),
      unitCost: Number(l.unitCost),
    }));
    if (
      formatted.some(
        (l) => !l.productId || !Number.isInteger(l.quantityOrdered) || l.quantityOrdered <= 0 || l.unitCost < 0
      )
    ) {
      setFormError('All lines require a valid product, positive quantity, and nonnegative cost.');
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch<{ purchaseOrder: PurchaseOrder }>('/api/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poSupplierId,
          status: poStatus,
          orderDate,
          expectedDeliveryDate: expectedDate,
          notes: poNotes,
          items: formatted,
        }),
      });
      setCreateOpen(false);
      await onDataChanged();
      onNotify(`Created ${res.purchaseOrder.poNumber}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to create purchase order.');
    } finally {
      setSaving(false);
    }
  };

  const openPODetail = (po: PurchaseOrder) => {
    setActivePO(po);
    const initial: Record<string, string> = {};
    for (const item of po.items) {
      const remaining = Math.max(0, item.quantityOrdered - item.quantityReceived);
      initial[item.id] = remaining > 0 ? String(remaining) : '0';
    }
    setReceiveInputs(initial);
    setConfirmReceiveOpen(false);
  };

  const handleStatusChange = async (newStatus: PurchaseOrderStatus) => {
    if (!activePO) return;
    setStatusUpdating(true);
    try {
      const res = await apiFetch<{ purchaseOrder: PurchaseOrder }>(
        `/api/purchase-orders/${activePO.id}/status`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        }
      );
      setActivePO(res.purchaseOrder);
      await onDataChanged();
      onNotify(`${res.purchaseOrder.poNumber} marked as ${newStatus}`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update order status.', 'error');
    } finally {
      setStatusUpdating(false);
    }
  };

  const pendingReceipts = useMemo(() => {
    if (!activePO) return [];
    return activePO.items
      .map((item) => ({
        itemId: item.id,
        productName: item.productName || 'Product',
        quantityToReceive: Math.trunc(Number(receiveInputs[item.id] || 0)),
      }))
      .filter((r) => r.quantityToReceive > 0);
  }, [activePO, receiveInputs]);

  const handleRequestReceiveConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePO) return;
    if (pendingReceipts.length === 0) {
      onNotify('Enter at least one quantity greater than 0 to receive.', 'error');
      return;
    }
    for (const r of pendingReceipts) {
      const line = activePO.items.find((i) => i.id === r.itemId);
      const remaining = line ? line.quantityOrdered - line.quantityReceived : 0;
      if (r.quantityToReceive > remaining) {
        onNotify(`Receive quantity for ${r.productName} cannot exceed ${remaining} remaining units.`, 'error');
        return;
      }
    }
    setConfirmReceiveOpen(true);
  };

  const handleConfirmReceiveStock = async () => {
    if (!activePO) return;
    setReceiving(true);
    try {
      const res = await apiFetch<{ purchaseOrder: PurchaseOrder }>(
        `/api/purchase-orders/${activePO.id}/receive`,
        {
          method: 'POST',
          body: JSON.stringify({
            receipts: pendingReceipts.map(({ itemId, quantityToReceive }) => ({ itemId, quantityToReceive })),
          }),
        }
      );
      setConfirmReceiveOpen(false);
      setActivePO(res.purchaseOrder);
      const nextInputs: Record<string, string> = {};
      for (const item of res.purchaseOrder.items) {
        const rem = Math.max(0, item.quantityOrdered - item.quantityReceived);
        nextInputs[item.id] = rem > 0 ? String(rem) : '0';
      }
      setReceiveInputs(nextInputs);
      await onDataChanged();
      onNotify(`Confirmed receipt for ${res.purchaseOrder.poNumber}. Inventory quantities updated.`);
    } catch (err) {
      setConfirmReceiveOpen(false);
      onNotify(err instanceof Error ? err.message : 'Unable to receive items.', 'error');
    } finally {
      setReceiving(false);
    }
  };

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return purchaseOrders;
    return purchaseOrders.filter((po) => po.status === statusFilter);
  }, [purchaseOrders, statusFilter]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          {(['all', 'Draft', 'Ordered', 'Partially Received', 'Received', 'Cancelled'] as const).map(
            (st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  statusFilter === st
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {st === 'all' ? 'All Orders' : st}
              </button>
            )
          )}
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          <span>New Purchase Order</span>
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={purchaseOrders.length === 0 ? 'No purchase orders created yet' : 'No purchase orders in this view'}
          description="Create a purchase order from an active supplier and product to track expected deliveries and receive incoming inventory."
          actionLabel={activeSuppliers.length > 0 && activeProducts.length > 0 ? 'Create Purchase Order' : undefined}
          onAction={activeSuppliers.length > 0 && activeProducts.length > 0 ? openCreateModal : undefined}
        />
      ) : (
        <>
          <div className="hidden lg:block bg-white border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">PO Number</th>
                  <th className="py-3 px-3">Supplier</th>
                  <th className="py-3 px-3">Order Date</th>
                  <th className="py-3 px-3">Expected Delivery</th>
                  <th className="py-3 px-3 text-right">Received</th>
                  <th className="py-3 px-3 text-right">Order Total</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filtered.map((po) => {
                  const totalOrdered = po.items.reduce((s, i) => s + i.quantityOrdered, 0);
                  const totalReceived = po.items.reduce((s, i) => s + i.quantityReceived, 0);
                  return (
                    <tr key={po.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                        {po.poNumber}
                      </td>
                      <td className="py-3 px-3 text-slate-800">{po.supplierName}</td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-600">
                        {formatShortDate(po.orderDate)}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-600">
                        {formatShortDate(po.expectedDeliveryDate)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-xs tabular-nums text-slate-600">
                        {totalReceived}/{totalOrdered} units
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {formatCurrency(po.totalAmount, currencySymbol)}
                      </td>
                      <td className="py-3 px-3">
                        <POStatusLabel status={po.status} />
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => openPODetail(po)}
                          className="px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 whitespace-nowrap"
                        >
                          {po.status === 'Ordered' || po.status === 'Partially Received'
                            ? 'Manage / Receive'
                            : 'View Details'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="lg:hidden space-y-3">
            {filtered.map((po) => (
              <div key={po.id} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-sm font-semibold text-slate-900">{po.poNumber}</div>
                    <div className="text-xs text-slate-600">{po.supplierName}</div>
                  </div>
                  <POStatusLabel status={po.status} />
                </div>
                <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-100">
                  <span className="text-slate-500 font-mono">
                    ETA {formatShortDate(po.expectedDeliveryDate)}
                  </span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {formatCurrency(po.totalAmount, currencySymbol)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => openPODetail(po)}
                  className="w-full py-2 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg"
                >
                  Open Purchase Order
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Create PO Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create Purchase Order"
        subtitle="Stock levels only increase after ordered items are explicitly confirmed received."
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleCreatePO} noValidate className="space-y-4">
          {formError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="po-supplier" className="block text-xs font-medium text-slate-700 mb-1">
                Supplier *
              </label>
              <select
                id="po-supplier"
                value={poSupplierId}
                onChange={(e) => setPoSupplierId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              >
                {activeSuppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.companyName}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="po-initial-status" className="block text-xs font-medium text-slate-700 mb-1">
                Initial Status
              </label>
              <select
                id="po-initial-status"
                value={poStatus}
                onChange={(e) => setPoStatus(e.target.value as 'Draft' | 'Ordered')}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              >
                <option value="Draft">Draft (Save for review)</option>
                <option value="Ordered">Ordered (Confirmed with supplier)</option>
              </select>
            </div>

            <div>
              <label htmlFor="po-order-date" className="block text-xs font-medium text-slate-700 mb-1">
                Order Date
              </label>
              <input
                id="po-order-date"
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="po-eta" className="block text-xs font-medium text-slate-700 mb-1">
                Expected Delivery Date
              </label>
              <input
                id="po-eta"
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-800">Order Line Items</span>
              <button
                type="button"
                onClick={addLine}
                className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Add Line</span>
              </button>
            </div>
            <div className="space-y-2">
              {lines.map((line, idx) => {
                const lineTotal =
                  Math.max(0, Number(line.quantityOrdered) || 0) * Math.max(0, Number(line.unitCost) || 0);
                return (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="col-span-12 sm:col-span-5">
                      <select
                        aria-label={`Line ${idx + 1} product`}
                        value={line.productId}
                        onChange={(e) => updateLine(idx, { productId: e.target.value })}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-md"
                      >
                        {activeProducts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.sku})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <input
                        type="number"
                        min="1"
                        aria-label={`Line ${idx + 1} quantity`}
                        value={line.quantityOrdered}
                        onChange={(e) => updateLine(idx, { quantityOrdered: e.target.value })}
                        className="w-full px-2 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md"
                      />
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        aria-label={`Line ${idx + 1} unit cost`}
                        value={line.unitCost}
                        onChange={(e) => updateLine(idx, { unitCost: e.target.value })}
                        className="w-full px-2 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md"
                      />
                    </div>
                    <div className="col-span-3 sm:col-span-2 text-right font-mono text-xs font-semibold text-slate-800 tabular-nums">
                      {formatCurrency(lineTotal, currencySymbol)}
                    </div>
                    <div className="col-span-1 text-right">
                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                          aria-label={`Remove line ${idx + 1}`}
                          className="p-1 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex justify-end text-sm font-semibold text-slate-900 font-mono tabular-nums">
              Order Total: {formatCurrency(draftTotal, currencySymbol)}
            </div>
          </div>

          <div>
            <label htmlFor="po-notes" className="block text-xs font-medium text-slate-700 mb-1">
              Notes
            </label>
            <textarea
              id="po-notes"
              rows={2}
              value={poNotes}
              onChange={(e) => setPoNotes(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60"
            >
              {saving ? 'Creating...' : 'Create Purchase Order'}
            </button>
          </div>
        </form>
      </Modal>

      {/* PO Detail & Receive Modal */}
      <Modal
        open={Boolean(activePO)}
        onClose={() => setActivePO(null)}
        title={activePO ? `${activePO.poNumber} — ${activePO.supplierName}` : 'Purchase Order'}
        subtitle={
          activePO
            ? `Ordered ${formatShortDate(activePO.orderDate)} · Expected ${formatShortDate(activePO.expectedDeliveryDate)}`
            : undefined
        }
        maxWidth="max-w-2xl"
      >
        {activePO && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="flex items-center gap-3">
                <POStatusLabel status={activePO.status} />
                <span className="font-mono text-xs text-slate-600">
                  Total: <strong className="text-slate-900">{formatCurrency(activePO.totalAmount, currencySymbol)}</strong>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 no-print">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Print</span>
                </button>
                {activePO.status === 'Draft' && (
                  <button
                    type="button"
                    disabled={statusUpdating}
                    onClick={() => handleStatusChange('Ordered')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700"
                  >
                    <Truck className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Mark Ordered</span>
                  </button>
                )}
                {(activePO.status === 'Draft' || activePO.status === 'Ordered') && (
                  <button
                    type="button"
                    disabled={statusUpdating}
                    onClick={() => handleStatusChange('Cancelled')}
                    className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
                  >
                    Cancel Order
                  </button>
                )}
              </div>
            </div>

            {activePO.notes && (
              <p className="text-xs text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200">
                {activePO.notes}
              </p>
            )}

            <form onSubmit={handleRequestReceiveConfirm} className="space-y-3">
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
                      <th className="py-2.5 px-3">Product</th>
                      <th className="py-2.5 px-2 text-right">Ordered</th>
                      <th className="py-2.5 px-2 text-right">Received</th>
                      <th className="py-2.5 px-2 text-right">Unit Cost</th>
                      <th className="py-2.5 px-2 text-right">Line Total</th>
                      {(activePO.status === 'Ordered' || activePO.status === 'Partially Received') && (
                        <th className="py-2.5 px-3 text-right">Receive Now</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activePO.items.map((item) => {
                      const remaining = Math.max(0, item.quantityOrdered - item.quantityReceived);
                      const canReceiveLine =
                        (activePO.status === 'Ordered' || activePO.status === 'Partially Received') &&
                        remaining > 0;
                      return (
                        <tr key={item.id}>
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-slate-900">{item.productName}</div>
                            <div className="font-mono text-[11px] text-slate-500">{item.productSku}</div>
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                            {item.quantityOrdered}
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono tabular-nums text-emerald-700 font-semibold">
                            {item.quantityReceived}
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono tabular-nums">
                            {formatCurrency(item.unitCost, currencySymbol)}
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono tabular-nums font-medium">
                            {formatCurrency(item.quantityOrdered * item.unitCost, currencySymbol)}
                          </td>
                          {(activePO.status === 'Ordered' || activePO.status === 'Partially Received') && (
                            <td className="py-2.5 px-3 text-right">
                              {canReceiveLine ? (
                                <input
                                  type="number"
                                  min="0"
                                  max={remaining}
                                  aria-label={`Receive quantity for ${item.productName}`}
                                  value={receiveInputs[item.id] ?? '0'}
                                  onChange={(e) =>
                                    setReceiveInputs((prev) => ({ ...prev, [item.id]: e.target.value }))
                                  }
                                  className="w-20 px-2 py-1 text-right font-mono bg-white border border-slate-300 rounded-md"
                                />
                              ) : (
                                <span className="text-emerald-700 font-medium">Complete</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {(activePO.status === 'Ordered' || activePO.status === 'Partially Received') && (
                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-xs text-slate-500">
                    Receiving adds units to stock and logs a Stock-In ledger entry.
                  </span>
                  <button
                    type="submit"
                    disabled={receiving}
                    className="px-4 py-2 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap disabled:opacity-60"
                  >
                    Review & Receive Stock
                  </button>
                </div>
              )}
            </form>

            <div>
              <h3 className="text-xs font-semibold text-slate-800 uppercase tracking-wider mb-2">
                Status & Receipt Audit Trail
              </h3>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                {(activePO.events || []).map((ev) => (
                  <div key={ev.id} className="p-2.5 text-xs flex items-start justify-between gap-3">
                    <div>
                      <span className="font-semibold text-slate-900">{ev.eventType}:</span>{' '}
                      <span className="text-slate-700">{ev.description}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 whitespace-nowrap font-mono">
                      {ev.userName} · {new Date(ev.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmReceiveOpen}
        title="Confirm Purchase Order Receipt"
        message={`Add ${pendingReceipts.map((r) => `${r.quantityToReceive}× ${r.productName}`).join(', ')} into inventory for ${activePO?.poNumber}? This updates on-hand stock immediately and records immutable Stock-In entries.`}
        confirmLabel="Confirm Received Stock"
        loading={receiving}
        onConfirm={handleConfirmReceiveStock}
        onCancel={() => setConfirmReceiveOpen(false)}
      />
    </div>
  );
}
