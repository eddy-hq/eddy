import React, { Ref, useState } from 'react';
import { motion } from 'framer-motion';

interface VideoPlayerProps {
  src: string;
  title: string;
  videoRef?: Ref<HTMLVideoElement>;
  onPlay?: () => void;
  onTimeUpdate?: () => void;
  onEnded?: () => void;
}

export function VideoPlayer({ src, title, videoRef, onPlay, onTimeUpdate, onEnded }: VideoPlayerProps) {
  const [error, setError] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      style={{
        width: '100%',
        background: '#000',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-modal)',
      }}
    >
      {error ? (
        <div style={{
          aspectRatio: '16/9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          fontSize: 'var(--text-sm)',
        }}>
          Could not load video
        </div>
      ) : (
        <video
          ref={videoRef}
          src={src}
          controls
          autoPlay
          playsInline
          onError={() => setError(true)}
          onPlay={onPlay}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          aria-label={title}
          style={{ width: '100%', display: 'block', maxHeight: '80dvh' }}
        />
      )}
    </motion.div>
  );
}
