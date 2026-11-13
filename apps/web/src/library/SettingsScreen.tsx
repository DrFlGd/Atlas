import { useAtlas } from '../state/store';
import { ProgressTools } from '../touch/DesktopTools';
import { Settings } from '../touch/GamesScreen';
import { ActivityLogSetting, DownloadSpeed, Locations, MapsFolder } from './StorageSettings';

/**
 * Settings, in the desktop app: the app's own (theme, layout, keys) where
 * the layout has no other place for them, where maps are saved, map packs
 * in other folders, how fast downloads go and the activity log. In the
 * standard layout it is a section of its own; in the classic layout, the
 * Library's Settings.
 */
export function SettingsScreen({ general }: { general: boolean }) {
  const app = useAtlas((s) => s.app);
  return (
    <section className="library-settings" aria-label="Settings" data-testid="settings-screen">
      <header className="library-pane-head">
        <div className="library-pane-title">
          <h1>Settings</h1>
          <p className="library-facts">
            What this app looks like, where it keeps maps and how it downloads.
          </p>
        </div>
      </header>
      <div className="library-settings-body touch-scroll" data-scroll-root>
        {general ? (
          <div className="settings-group settings-group-general">
            <Settings withLog={false} />
            <ProgressTools />
          </div>
        ) : null}
        <MapsFolder />
        <Locations />
        <DownloadSpeed />
        <ActivityLogSetting />
        <p className="muted small app-version" data-testid="app-version">
          {app?.name ?? 'Atlas'}
          {app?.version ? ` ${app.version}` : ''}
        </p>
      </div>
    </section>
  );
}
