import { create } from 'zustand';

const STORAGE_KEY = 'yantra-platform-auth';

export interface PlatformUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface LoginPayload {
  token: string;
  operatorUser: PlatformUser;
  operator: { id: string; name: string; slug: string };
}

interface AuthState {
  token: string | null;
  user: PlatformUser | null;
  hydrated: boolean;
  login(payload: LoginPayload): void;
  logout(): void;
  hydrate(): void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  hydrated: false,
  login(payload) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    set({ token: payload.token, user: payload.operatorUser, hydrated: true });
  },
  logout() {
    sessionStorage.removeItem(STORAGE_KEY);
    set({ token: null, user: null, hydrated: true });
  },
  hydrate() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) {
        set({ hydrated: true });
        return;
      }
      const parsed = JSON.parse(raw) as LoginPayload;
      set({ token: parsed.token, user: parsed.operatorUser, hydrated: true });
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
      set({ hydrated: true });
    }
  },
}));
