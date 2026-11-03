import type * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { IconBolt, IconSearch, IconCornerDownLeft } from '@tabler/icons-react';
import { useStore } from '../store';
import { Monogram, StatusDot } from './primitives';
import { STATUS_META } from '../lib/format';

interface Item {
  id: string;
  render: () => React.ReactNode;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const apps = useStore((s) => s.apps);
  const select = useStore((s) => s.select);
  const submitAllReady = useStore((s) => s.submitAllReady);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items: Item[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: Item[] = [];

    if (!q || 'submit all ready'.includes(q)) {
      list.push({
        id: 'act:submit-all',
        render: () => (
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-surface">
              <IconBolt size={15} stroke={1.9} style={{ color: 'var(--color-accent)' }} />
            </div>
            <span className="text-[13px] text-text">Submit all ready</span>
          </div>
        ),
        run: () => {
          submitAllReady();
          onClose();
        },
      });
    }

    apps
      .filter(
        (a) =>
          !q ||
          a.company.toLowerCase().includes(q) ||
          a.role.toLowerCase().includes(q),
      )
      .slice(0, 8)
      .forEach((a) =>
        list.push({
          id: a.id,
          render: () => (
            <div className="flex items-center gap-3">
              <Monogram company={a.company} size={28} />
              <div className="min-w-0">
                <div className="truncate text-[13px] text-text">
                  {a.company}
                </div>
                <div className="truncate text-[11.5px] text-dim">{a.role}</div>
              </div>
              <div className="ml-auto flex items-center gap-1.5 text-[11px] text-faint">
                <StatusDot status={a.status} />
                {STATUS_META[a.status].label}
              </div>
            </div>
          ),
          run: () => {
            select(a.id);
            onClose();
          },
        }),
      );

    return list;
  }, [apps, query, select, submitAllReady, onClose]);

  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items.length, active]);

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[60] flex items-start justify-center bg-black/55 pt-[14vh]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
      >
        <motion.div
          onClick={(e) => e.stopPropagation()}
          initial={{ opacity: 0, scale: 0.97, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          className="w-[520px] overflow-hidden rounded-xl border border-border-strong bg-panel"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              items[active]?.run();
            }
          }}
        >
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <IconSearch size={16} stroke={1.7} className="text-faint" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search applications or run a command…"
              className="w-full bg-transparent py-3.5 text-[13.5px] text-text outline-none placeholder:text-faint"
            />
          </div>
          <div className="max-h-[340px] overflow-y-auto p-1.5">
            {items.length === 0 && (
              <div className="px-3 py-6 text-center text-[12.5px] text-faint">
                No matches
              </div>
            )}
            {items.map((item, i) => (
              <button
                key={item.id}
                onMouseMove={() => setActive(i)}
                onClick={item.run}
                className={`flex w-full items-center rounded-lg px-2.5 py-2 text-left transition-colors ${
                  i === active ? 'bg-surface' : ''
                }`}
              >
                {item.render()}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-faint">
            <span className="flex items-center gap-1">
              <span className="kbd">↑</span>
              <span className="kbd">↓</span>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <IconCornerDownLeft size={11} stroke={1.8} />
              open
            </span>
            <span className="flex items-center gap-1">
              <span className="kbd">esc</span>
              close
            </span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
