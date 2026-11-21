import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Package,
  SlidersHorizontal,
  Truck,
  X,
  XCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { PurchaseOrderStatus, StockStatus, TransactionType } from '../../shared/types';

export function StockStatusLabel({ status }: { status: StockStatus }) {
  if (status === 'out_of_stock') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 whitespace-nowrap">
        <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Out of Stock</span>
      </span>
    );
  }
  if (status === 'low_stock') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Low Stock</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap">
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>In Stock</span>
    </span>
  );
}

export function TransactionTypeLabel({ type }: { type: TransactionType }) {
  if (type === 'stock_in') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800 whitespace-nowrap">
        <ArrowDownLeft className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Stock In</span>
      </span>
    );
  }
  if (type === 'adjustment') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-100 border border-slate-300 text-xs font-medium text-slate-800 whitespace-nowrap">
        <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Adjustment</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-xs font-medium text-amber-800 whitespace-nowrap">
      <ArrowUpRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>Stock Out</span>
    </span>
  );
}

export function POStatusLabel({ status }: { status: PurchaseOrderStatus }) {
  switch (status) {
    case 'Received':
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800 whitespace-nowrap">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Received</span>
        </span>
      );
    case 'Partially Received':
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-xs font-medium text-amber-800 whitespace-nowrap">
          <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Partially Received</span>
        </span>
      );
    case 'Ordered':
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-teal-50 border border-teal-200 text-xs font-medium text-teal-800 whitespace-nowrap">
          <Truck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Ordered</span>
        </span>
      );
    case 'Cancelled':
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-50 border border-red-200 text-xs font-medium text-red-700 whitespace-nowrap">
          <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Cancelled</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-xs font-medium text-slate-700 whitespace-nowrap">
          <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Draft</span>
        </span>
      );
  }
}

export function ProductThumbnail({
  src,
  alt,
  size = 'md',
}: {
  src?: string;
  alt: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [failed, setFailed] = useState(false);
  const sizeClass =
    size === 'sm' ? 'w-9 h-9 rounded-md' : size === 'lg' ? 'w-24 h-24 rounded-lg' : 'w-11 h-11 rounded-md';

  if (!src || failed) {
    return (
      <div
        className={`${sizeClass} bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 shrink-0`}
        aria-label={alt}
      >
        <Package className={size === 'lg' ? 'w-8 h-8' : 'w-4 h-4'} aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${sizeClass} object-cover border border-slate-200 bg-slate-100 shrink-0`}
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = 'max-w-xl',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/45 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className={`w-full ${maxWidth} bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]`}
          >
            <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200">
              <div>
                <h2 id="modal-title" className="text-base font-semibold text-slate-900">
                  {title}
                </h2>
                {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close modal"
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'primary',
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} maxWidth="max-w-md">
      <p className="text-sm text-slate-600 leading-relaxed">{message}</p>
      <div className="mt-5 flex items-center justify-end gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors whitespace-nowrap disabled:opacity-60 ${
            tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-teal-600 hover:bg-teal-700'
          }`}
        >
          {loading ? 'Processing...' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}) {
  return (
    <div className="py-12 px-6 text-center bg-white border border-slate-200 rounded-xl">
      <div className="w-11 h-11 mx-auto rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500">
        <Icon className="w-5 h-5" />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-500 max-w-md mx-auto">{description}</p>
      {(actionLabel || secondaryActionLabel) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={onAction}
              className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors"
            >
              {actionLabel}
            </button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <button
              type="button"
              onClick={onSecondaryAction}
              className="inline-flex items-center px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              {secondaryActionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function PaginationBar({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (nextPage: number) => void;
}) {
  if (totalItems <= pageSize) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(totalItems, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-white border border-slate-200 rounded-xl text-xs text-slate-600">
      <span className="font-mono tabular-nums">
        Showing {start}–{end} of {totalItems} records
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40"
        >
          <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Previous</span>
        </button>
        <span className="px-2 font-mono tabular-nums">
          Page {page} / {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40"
        >
          <span>Next</span>
          <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function MovementBarChart({
  data,
}: {
  data: Array<{ date: string; stockIn: number; stockOut: number }>;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const hasAnyMovement = data.some((d) => d.stockIn > 0 || d.stockOut > 0);
  const maxVal = Math.max(10, ...data.map((d) => Math.max(d.stockIn, d.stockOut)));

  if (data.length === 0 || !hasAnyMovement) {
    return (
      <div className="h-52 flex items-center justify-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg bg-slate-50/40 px-4 text-center">
        No stock movements recorded in this date range yet.
      </div>
    );
  }

  return (
    <div className="w-full min-w-0">
      <div className="flex flex-wrap items-center justify-end gap-3 sm:gap-4 text-xs text-slate-600 mb-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-xs bg-teal-600 inline-block" aria-hidden="true" />
          Stock In / +Adj
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" aria-hidden="true" />
          Stock Out / -Adj
        </span>
      </div>

      <div className="relative h-52 flex items-end gap-0.5 sm:gap-1.5 border-b border-slate-200 pb-6 pt-4 overflow-hidden">
        {data.map((item, idx) => {
          const inPct = Math.round((item.stockIn / maxVal) * 100);
          const outPct = Math.round((item.stockOut / maxVal) * 100);
          const step = data.length <= 7 ? 1 : data.length <= 14 ? 3 : Math.ceil(data.length / 6);
          const showLabel = idx === 0 || idx === data.length - 1 || idx % step === 0;
          return (
            <div
              key={item.date}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="relative flex-1 min-w-0 h-full flex items-end justify-center gap-px sm:gap-0.5 group cursor-default"
            >
              {hoveredIdx === idx && (
                <div className="absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full z-10 bg-slate-900 text-white text-[11px] rounded-md px-2.5 py-1.5 shadow-md whitespace-nowrap pointer-events-none font-mono tabular-nums">
                  <div className="font-sans font-medium text-slate-200 mb-0.5">{item.date}</div>
                  <div>In: +{item.stockIn} · Out: -{item.stockOut}</div>
                </div>
              )}
              <div
                style={{ height: `${Math.max(item.stockIn > 0 ? 4 : 0, inPct)}%` }}
                className="flex-1 max-w-3 bg-teal-600 rounded-t-xs transition-opacity group-hover:opacity-85"
              />
              <div
                style={{ height: `${Math.max(item.stockOut > 0 ? 4 : 0, outPct)}%` }}
                className="flex-1 max-w-3 bg-amber-500 rounded-t-xs transition-opacity group-hover:opacity-85"
              />
              {showLabel && (
                <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] text-slate-500 font-mono tabular-nums whitespace-nowrap">
                  {item.date.slice(5)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
