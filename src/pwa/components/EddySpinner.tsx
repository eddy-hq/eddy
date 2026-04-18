import React from 'react';
import { motion } from 'framer-motion';

interface Props {
  size?: number;
}

// 1.5-turn Archimedean spiral, centre 20,20, outer r=14 → inner r=2
const SPIRAL = 'M 34 20 C 34 12.3,26.6 8,20 8 C 13.4 8,10 14.5,10 20 C 10 25.5,15.6 28,20 28 C 24.4 28,26 23.3,26 20 C 26 16.7,22.2 16,20 16 C 17.8 16,18 18.9,18 20';

export function EddySpinner({ size = 52 }: Props) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      style={{ originX: '50%', originY: '50%' }}
      animate={{ rotate: 360 }}
      transition={{ duration: 5, repeat: Infinity, ease: 'linear' }}
      aria-hidden
    >
      <motion.path
        d={SPIRAL}
        stroke="rgba(255,255,255,0.9)"
        strokeWidth="1.8"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: [0, 1, 1, 0], opacity: [0, 1, 1, 0] }}
        transition={{
          duration: 2.8,
          times: [0, 0.42, 0.58, 1],
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
    </motion.svg>
  );
}
