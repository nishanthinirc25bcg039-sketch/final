import React, { useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Building2,
  Edit3,
  Eye,
  Mail,
  MapPin,
  Phone,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { parseCsvRows, validateSupplierInput } from '../shared/inventoryLogic';
import { apiFetch, formatCurrency, formatShortDate } from '../utils/api';
import { ConfirmDialog, EmptyState, Modal, POStatusLabel } from './ui/Common';
import type { Product, PurchaseOrder, Supplier, UserRole } from '../shared/types';

export function SuppliersView({
  suppliers,
  currencySymbol,
  userRole,
  onDataChanged,
  onNotify,
}: {
  suppliers: Supplier[];
  currencySymbol: string;
  userRole: UserRole;
  onDataChanged: () => Promise<void>;
  onNotify: (msg: string, tone?: 'success' | 'error') => void;
}) {
  const isAdmin = userRole === 'admin';
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');

  const [formOpen, setFormOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [form, setForm] = useState({
    companyName: '',
    contactPerson: '',
    email: '',
    phone: '',
    address: '',
    notes: '',
    deliveryStatus: 'On Schedule' as Supplier['deliveryStatus'],
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [detailData, setDetailData] = useState<{
    supplier: Supplier;
    products: Product[];
    purchaseOrders: PurchaseOrder[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suppliers.filter((s) => {
      if (archiveFilter === 'active' && s.archived) return false;
      if (archiveFilter === 'archived' && !s.archived) return false;
      if (
        q &&
        !s.companyName.toLowerCase().includes(q) &&
        !s.contactPerson.toLowerCase().includes(q) &&
        !s.email.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (statusFilter !== 'all' && s.deliveryStatus !== statusFilter) return false;
      return true;
    });
  }, [suppliers, archiveFilter, search, statusFilter]);

  const openCreate = () => {
    setEditingSupplier(null);
    setForm({
      companyName: '',
      contactPerson: '',
      email: '',
      phone: '',
      address: '',
      notes: '',
      deliveryStatus: 'On Schedule',
    });
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier);
    setForm({
      companyName: supplier.companyName,
      contactPerson: supplier.contactPerson,
      email: supplier.email,
      phone: supplier.phone,
      address: supplier.address,
      notes: supplier.notes,
      deliveryStatus: supplier.deliveryStatus,
    });
    setFormError(null);
    setFormOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const errs = validateSupplierInput(form);
    if (Object.keys(errs).length > 0) {
      setFormError(Object.values(errs)[0]);
      return;
    }
    setSaving(true);
    try {
      if (editingSupplier) {
        await apiFetch(`/api/suppliers/${editingSupplier.id}`, {
          method: 'PUT',
          body: JSON.stringify(form),
        });
        onNotify(`Updated supplier "${form.companyName}"`);
      } else {
        await apiFetch('/api/suppliers', {
          method: 'POST',
          body: JSON.stringify(form),
        });
        onNotify(`Added supplier "${form.companyName}"`);
      }
      setFormOpen(false);
      await onDataChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save supplier.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleArchive = async (s: Supplier) => {
    try {
      await apiFetch(`/api/suppliers/${s.id}/archive`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: !s.archived }),
      });
      onNotify(`${s.archived ? 'Restored' : 'Archived'} supplier "${s.companyName}"`);
      await onDataChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to update archive status.', 'error');
    }
  };

  const handleImportCsv = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportError(null);
    const parsed = parseCsvRows(csvText);
    if (parsed.rows.length === 0) {
      setImportError('Paste or upload a valid CSV with a header row and at least one supplier.');
      return;
    }
    setImporting(true);
    try {
      const res = await apiFetch<{ importedCount: number }>('/api/suppliers/import', {
        method: 'POST',
        body: JSON.stringify({ rows: parsed.rows }),
      });
      setImportOpen(false);
      setCsvText('');
      onNotify(`Imported ${res.importedCount} supplier${res.importedCount === 1 ? '' : 's'}.`);
      await onDataChanged();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'CSV import failed.');
    } finally {
      setImporting(false);
    }
  };

  const openDetail = async (supplier: Supplier) => {
    setDetailLoading(true);
    setDetailData({ supplier, products: [], purchaseOrders: [] });
    try {
      const res = await apiFetch<{
        supplier: Supplier;
        products: Product[];
        purchaseOrders: PurchaseOrder[];
      }>(`/api/suppliers/${supplier.id}`);
      setDetailData(res);
    } catch {
      onNotify('Unable to load supplier details.', 'error');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/suppliers/${deleteTarget.id}`, { method: 'DELETE' });
      onNotify(`Removed supplier "${deleteTarget.companyName}"`);
      setDeleteTarget(null);
      await onDataChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to delete supplier.', 'error');
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const statusTone = (status: Supplier['deliveryStatus']) => {
    switch (status) {
      case 'Preferred':
        return 'text-teal-700';
      case 'Transit Delay':
        return 'text-amber-700';
      case 'Inactive':
        return 'text-slate-500';
      default:
        return 'text-emerald-700';
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 flex-1">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search suppliers"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search company, contact, email..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <select
            aria-label="Filter by delivery status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="all">All Delivery Statuses</option>
            <option value="Preferred">Preferred</option>
            <option value="On Schedule">On Schedule</option>
            <option value="Transit Delay">Transit Delay</option>
            <option value="Inactive">Inactive</option>
          </select>

          <select
            aria-label="Filter by archive status"
            value={archiveFilter}
            onChange={(e) => setArchiveFilter(e.target.value as 'active' | 'archived' | 'all')}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="active">Active Suppliers</option>
            <option value="archived">Archived Only</option>
            <option value="all">All Suppliers</option>
          </select>
        </div>

        {isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setImportError(null);
                setImportOpen(true);
              }}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Import CSV</span>
            </button>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>Add Supplier</span>
            </button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={suppliers.length === 0 ? 'Add your first supplier' : 'No matching suppliers'}
          description={
            suppliers.length === 0
              ? 'Add or import your real vendor contacts so you can assign products and create purchase orders.'
              : 'No suppliers match your current search or archive filter.'
          }
          actionLabel={suppliers.length === 0 && isAdmin ? 'Add First Supplier' : undefined}
          onAction={suppliers.length === 0 && isAdmin ? openCreate : undefined}
          secondaryActionLabel={suppliers.length === 0 && isAdmin ? 'Import CSV' : undefined}
          onSecondaryAction={suppliers.length === 0 && isAdmin ? () => setImportOpen(true) : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((s) => (
            <div
              key={s.id}
              className={`bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4 ${s.archived ? 'opacity-65' : ''}`}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <button
                      type="button"
                      onClick={() => openDetail(s)}
                      className="text-base font-semibold text-slate-900 hover:text-teal-700 text-left"
                    >
                      {s.companyName}
                    </button>
                    {s.archived && <span className="ml-2 text-xs font-mono text-slate-500">[Archived]</span>}
                    <div className="mt-0.5 text-xs text-slate-500">
                      Contact: <span className="text-slate-800 font-medium">{s.contactPerson}</span>
                    </div>
                  </div>
                  <span className={`text-xs font-semibold whitespace-nowrap ${statusTone(s.deliveryStatus)}`}>
                    {s.deliveryStatus}
                  </span>
                </div>

                <div className="mt-3 space-y-1 text-xs text-slate-600">
                  <div className="flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                    <span className="truncate">{s.email}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                    <span className="font-mono">{s.phone}</span>
                  </div>
                  {s.address && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                      <span className="truncate">{s.address}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
                <div className="text-slate-500 font-mono tabular-nums">
                  {s.productCount || 0} products · {s.openOrderCount || 0} open POs
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openDetail(s)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200"
                  >
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>View</span>
                  </button>
                  {isAdmin && (
                    <>
                      <button
                        type="button"
                        onClick={() => openEdit(s)}
                        aria-label={`Edit ${s.companyName}`}
                        className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleArchive(s)}
                        aria-label={s.archived ? `Restore ${s.companyName}` : `Archive ${s.companyName}`}
                        title={s.archived ? 'Restore supplier' : 'Archive supplier'}
                        className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                      >
                        {s.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(s)}
                        aria-label={`Delete ${s.companyName}`}
                        className="p-1.5 text-slate-500 hover:text-red-700 hover:bg-red-50 rounded-md"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Supplier Add/Edit Modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editingSupplier ? `Edit ${editingSupplier.companyName}` : 'Add New Supplier'}
        maxWidth="max-w-lg"
      >
        <form onSubmit={handleSave} noValidate className="space-y-4">
          {formError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="sup-company" className="block text-xs font-medium text-slate-700 mb-1">
                Company Name *
              </label>
              <input
                id="sup-company"
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <div>
              <label htmlFor="sup-contact" className="block text-xs font-medium text-slate-700 mb-1">
                Contact Person *
              </label>
              <input
                id="sup-contact"
                value={form.contactPerson}
                onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <div>
              <label htmlFor="sup-email" className="block text-xs font-medium text-slate-700 mb-1">
                Email *
              </label>
              <input
                id="sup-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
            <div>
              <label htmlFor="sup-phone" className="block text-xs font-medium text-slate-700 mb-1">
                Phone *
              </label>
              <input
                id="sup-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="sup-status" className="block text-xs font-medium text-slate-700 mb-1">
                Delivery Status
              </label>
              <select
                id="sup-status"
                value={form.deliveryStatus}
                onChange={(e) =>
                  setForm({ ...form, deliveryStatus: e.target.value as Supplier['deliveryStatus'] })
                }
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              >
                <option value="Preferred">Preferred</option>
                <option value="On Schedule">On Schedule</option>
                <option value="Transit Delay">Transit Delay</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
            <div>
              <label htmlFor="sup-address" className="block text-xs font-medium text-slate-700 mb-1">
                Address
              </label>
              <input
                id="sup-address"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label htmlFor="sup-notes" className="block text-xs font-medium text-slate-700 mb-1">
              Notes & Terms
            </label>
            <textarea
              id="sup-notes"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save Supplier'}
            </button>
          </div>
        </form>
      </Modal>

      {/* CSV Import Modal */}
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import Suppliers via CSV"
        subtitle="Required columns: companyName, contactPerson, email, phone. Optional: address, notes."
        maxWidth="max-w-lg"
      >
        <form onSubmit={handleImportCsv} className="space-y-4">
          {importError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {importError}
            </div>
          )}
          <textarea
            rows={6}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={'companyName,contactPerson,email,phone,address\nHarbor Metals,Sam Rivera,orders@harbormetals.com,+1-503-555-0199,Portland OR'}
            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={importing || !csvText.trim()}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60"
            >
              {importing ? 'Importing...' : 'Validate & Import'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Supplier Detail Modal */}
      <Modal
        open={Boolean(detailData)}
        onClose={() => setDetailData(null)}
        title={detailData?.supplier.companyName || 'Supplier'}
        subtitle={
          detailData
            ? `${detailData.supplier.contactPerson} · ${detailData.supplier.deliveryStatus}`
            : undefined
        }
        maxWidth="max-w-2xl"
      >
        {detailData && (
          <div className="space-y-5 text-sm">
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-slate-500 block">Email & Phone</span>
                <span className="font-medium text-slate-900 block">{detailData.supplier.email}</span>
                <span className="font-mono text-slate-700">{detailData.supplier.phone}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Address</span>
                <span className="text-slate-800">{detailData.supplier.address || '-'}</span>
              </div>
              {detailData.supplier.notes && (
                <div className="sm:col-span-2 pt-2 border-t border-slate-200">
                  <span className="text-slate-500 block">Notes</span>
                  <span className="text-slate-700">{detailData.supplier.notes}</span>
                </div>
              )}
            </div>

            {detailLoading ? (
              <p className="text-xs text-slate-500">Loading linked products and orders...</p>
            ) : (
              <>
                <div>
                  <h3 className="text-xs font-semibold text-slate-800 uppercase tracking-wider mb-2">
                    Supplied Products ({detailData.products.length})
                  </h3>
                  {detailData.products.length === 0 ? (
                    <p className="text-xs text-slate-500">No products assigned to this supplier yet.</p>
                  ) : (
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                      {detailData.products.map((p) => (
                        <div key={p.id} className="p-2.5 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-medium text-slate-900">{p.name}</span>
                            <span className="ml-2 font-mono text-slate-500">{p.sku}</span>
                          </div>
                          <span className="font-mono tabular-nums text-slate-700">
                            {p.quantity} on hand · Cost {formatCurrency(p.unitCost, currencySymbol)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-slate-800 uppercase tracking-wider mb-2">
                    Purchase Order History ({detailData.purchaseOrders.length})
                  </h3>
                  {detailData.purchaseOrders.length === 0 ? (
                    <p className="text-xs text-slate-500">No purchase orders placed with this supplier yet.</p>
                  ) : (
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                      {detailData.purchaseOrders.map((po) => (
                        <div key={po.id} className="p-2.5 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-mono font-semibold text-slate-900">{po.poNumber}</span>
                            <span className="ml-2 text-slate-500">
                              Ordered {formatShortDate(po.orderDate)} · ETA {formatShortDate(po.expectedDeliveryDate)}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono tabular-nums font-medium text-slate-900">
                              {formatCurrency(po.totalAmount, currencySymbol)}
                            </span>
                            <POStatusLabel status={po.status} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove Supplier"
        message={
          deleteTarget
            ? `Delete "${deleteTarget.companyName}" from your directory? Suppliers referenced by products or purchase orders cannot be deleted and should be archived instead.`
            : ''
        }
        confirmLabel="Remove Supplier"
        tone="danger"
        loading={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
