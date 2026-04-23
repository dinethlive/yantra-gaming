import { create } from 'zustand';

// Operator portal auth. Persisted in sessionStorage (NOT localStorage) —
// operators often use shared machines and we want the token to die with
// the tab. Token is short-lived anyway.

const STORAGE_KEY = 'yantra-operator-auth';

export interface OperatorUser {
  id: string;
  email: string;
  displayName: string;
  role: 'OPERATOR_ADMIN' | 'OPERATOR_VIEWER' | 'KETAPOLA_STAFF';
}

export interface OperatorSummary {
  id: string;
  slug: string;
  name: string;
  defaultCurrency: string;
  jurisdiction: string;
}

interface AuthState {
  token: string | null;
  operatorUser: OperatorUser | null;
  operator: OperatorSummary | null;
  hydrated: boolean;
  login: (payload: { token: string; operatorUser: OperatorUser; operator: OperatorSummary }) => void;
  logout: () => void;
  hydrate: () => void;
}

interface PersistedAuth {
  token: string;
  operatorUser: OperatorUser;
  operator: OperatorSummary;
}

function loadPersisted(): PersistedAuth | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedAuth;
  } catch {
    return null;
  }
}

function savePersisted(data: PersistedAuth | null): void {
  try {
    if (data === null) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch {
    // storage disabled — fail silently; user will just have to log in again next tab
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  operatorUser: null,
  operator: null,
  hydrated: false,

  login: ({ token, operatorUser, operator }) => {
    savePersisted({ token, operatorUser, operator });
    set({ token, operatorUser, operator, hydrated: true });
  },

  logout: () => {
    savePersisted(null);
    set({ token: null, operatorUser: null, operator: null, hydrated: true });
  },

  hydrate: () => {
    const persisted = loadPersisted();
    if (persisted) {
      set({
        token: persisted.token,
        operatorUser: persisted.operatorUser,
        operator: persisted.operator,
        hydrated: true,
      });
    } else {
      set({ hydrated: true });
    }
  },
}));
