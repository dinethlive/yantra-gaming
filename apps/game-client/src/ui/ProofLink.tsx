import type React from 'react';
import { useTranslation } from 'react-i18next';
import { proofUrl } from '../api/client';
import { useGameStore } from '../store/gameStore';

/**
 * Small link/button to verify the current round's provably-fair proof.
 * Opens the RGS proof endpoint in a new tab. Disabled when no roundId yet.
 */
export const ProofLink: React.FC = () => {
  const { t } = useTranslation();
  const roundId = useGameStore((s) => s.roundId);

  if (!roundId) return null;

  return (
    <a
      className="proof-link"
      href={proofUrl(roundId)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {t('fairness.verify')}
    </a>
  );
};
