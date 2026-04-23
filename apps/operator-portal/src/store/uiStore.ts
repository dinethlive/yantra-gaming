import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

export interface DateRange {
  from: string; // ISO date (YYYY-MM-DD)
  to: string;   // ISO date
}

interface UIState {
  toasts: Toast[];
  dateRange: DateRange;
  pushToast: (kind: ToastKind, message: string) => void;
  dismissToast: (id: string) => void;
  setDateRange: (range: DateRange) => void;
}

function defaultRange(): DateRange {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const from = weekAgo.toISOString().slice(0, 10);
  return { from, to };
}

export const useUIStore = create<UIState>((set, get) => ({
  toasts: [],
  dateRange: defaultRange(),

  pushToast: (kind, message) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    setTimeout(() => get().dismissToast(id), 5000);
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  setDateRange: (range) => set({ dateRange: range }),
}));
