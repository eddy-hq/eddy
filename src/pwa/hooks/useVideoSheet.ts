import { useState } from 'react';
import type { CardData } from '../components/Card';

export function useVideoSheet() {
  const [selectedCard, setSelectedCard] = useState<CardData | null>(null);
  return {
    selectedCard,
    onSelect: (card: CardData) => setSelectedCard(card),
    onClose: () => setSelectedCard(null),
  };
}
