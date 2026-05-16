import React, { useEffect, useRef } from 'react';
import { motion, useDragControls } from 'framer-motion';
import { X } from 'lucide-react';

// Motion vocabulary kept in lock-step with VideoDetailSheet so the two
// sheets feel like the same surface family.
const EASE: [number, number, number, number] = [0.33, 1, 0.68, 1];
const DUR = 0.3;
const DISMISS_OFFSET = 80;
const DISMISS_VELOCITY = 500;

interface Props {
  why: string;
  onClose: () => void;
}

// Partial-height bottom sheet that reveals the one-sentence Gemma
// explanation for a discovery pick. Brief §9a: tap-to-see only — the
// sheet is the reveal surface, not always-visible card chrome.
export function WhyThisSheet({ why, onClose }: Props) {
  const dragControls = useDragControls();
  const sheetRef = useRef<HTMLDivElement>(null);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Escape closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus the sheet on open so screen readers and keyboard users land here.
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  function handleDragEnd(_: unknown, info: { offset: { y: number }; velocity: { y: number } }) {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onClose();
  }

  function startDrag(e: React.PointerEvent) {
    dragControls.start(e.nativeEvent);
  }

  return (
    <>
      {/* Scrim */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: DUR, ease: 'easeOut' }}
        onClick={onClose}
        aria-hidden
        style={{ position: 'fixed', inset: 0, zIndex: 49, background: 'rgba(0,0,0,0.45)' }}
      />

      {/* Sheet — partial-height, anchored to bottom */}
      <motion.div
        ref={sheetRef}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ duration: DUR, ease: EASE }}
        drag="y"
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.4 }}
        onDragEnd={handleDragEnd}
        role="dialog"
        aria-modal="true"
        aria-label="Why this?"
        tabIndex={-1}
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50,
          background: 'var(--bg-primary)',
          borderTopLeftRadius: 20, borderTopRightRadius: 20,
          boxShadow: 'var(--shadow-modal)',
          paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
          outline: 'none',
        }}
      >
        {/* Drag handle — also the drag-init zone */}
        <div
          onPointerDown={startDrag}
          aria-hidden
          style={{
            display: 'flex', justifyContent: 'center',
            paddingTop: 10, paddingBottom: 6,
            cursor: 'grab', touchAction: 'none',
          }}
        >
          <div style={{
            width: 36, height: 4, borderRadius: 2,
            background: 'var(--border-subtle)',
          }} />
        </div>

        {/* Close button — small, top-right, doesn't fight the handle */}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 10, right: 10,
            width: 32, height: 32, borderRadius: '50%',
            background: 'var(--bg-elevated)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-secondary)', border: 'none', cursor: 'pointer',
          }}
        >
          <X size={15} strokeWidth={2.4} />
        </button>

        <div style={{ padding: '8px 24px 24px' }}>
          <p style={{
            margin: '0 0 10px',
            fontSize: 11, fontWeight: 700, letterSpacing: '0.07em',
            textTransform: 'uppercase', color: 'var(--text-tertiary)',
          }}>
            Why this?
          </p>
          <p style={{
            margin: 0,
            fontFamily: 'var(--font-serif)',
            fontSize: 18, fontWeight: 400, lineHeight: 1.4,
            letterSpacing: '-0.005em',
            color: 'var(--text-primary)',
          }}>
            {why}
          </p>
        </div>
      </motion.div>
    </>
  );
}
