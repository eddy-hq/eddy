import { useState } from 'react';
import type { CardData } from '../components/Card';
import type { WatchSource } from '../lib/watchEvents';

interface Selection { card: CardData; source: WatchSource; }

export function useVideoSheet() {
  const [selection, setSelection] = useState<Selection | null>(null);
  return {
    selectedCard: selection?.card ?? null,
    selectedSource: selection?.source ?? null,
    onSelect: (card: CardData, source: WatchSource) => setSelection({ card, source }),
    onClose: () => setSelection(null),
  };
}
