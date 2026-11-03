import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { Rail } from './components/Rail';
import { TopBar } from './components/TopBar';
import { AppList } from './components/AppList';
import { MetricsPanel } from './components/MetricsPanel';
import { DetailDrawer } from './components/DetailDrawer';
import { CommandPalette } from './components/CommandPalette';
import { RepliesView, SettingsView } from './components/Views';
import { useStore } from './store';
import { connectLive, disconnectLive } from './live';

export function App() {
  const tick = useStore((s) => s.tick);
  const startDemo = useStore((s) => s.startDemo);
  const view = useStore((s) => s.view);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Connect to the orchestrator's live SSE stream; if it isn't running, fall
  // back to the simulated stream so the dashboard still demos standalone.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    connectLive().then((live) => {
      if (cancelled || live) return;
      startDemo();
      interval = setInterval(tick, 2600);
    });
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      disconnectLive();
    };
  }, [tick, startDemo]);

  // ⌘K / Ctrl-K toggles the command palette; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      <Rail />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenPalette={() => setPaletteOpen(true)} />
        <MetricsPanel />
        {view === 'settings' ? (
          <SettingsView />
        ) : view === 'replies' ? (
          <RepliesView />
        ) : (
          <AppList />
        )}
      </main>

      <DetailDrawer />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Toaster
        theme="dark"
        position="bottom-right"
        gap={8}
        toastOptions={{
          style: {
            background: 'var(--color-panel)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
            borderRadius: '10px',
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
          },
        }}
      />
    </div>
  );
}
