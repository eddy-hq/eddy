import { create } from 'zustand';

interface UserState {
  userId: string | null;
  displayName: string | null;
  setUser: (userId: string, displayName: string) => void;
}

export const useUserStore = create<UserState>((set) => ({
  userId: null,
  displayName: null,
  setUser: (userId, displayName) => set({ userId, displayName }),
}));
