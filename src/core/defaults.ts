import type { ClassifyConfig, Config, RecorderConfig, UiConfig } from './types';

export const DEFAULT_RECORDER: RecorderConfig = {
  enabled: true,
  intervalSec: 5,
  detailHours: 24,
  summaryDays: 30,
  procMinMemMB: 50,
  procMinCpuPercent: 1,
  groupMinMemMB: 20,
  leakMinMinutes: 60,
  leakMinGrowthMB: 300,
};

export const DEFAULT_UI: UiConfig = { reducedEffects: false };

export const DEFAULT_CLASSIFY: ClassifyConfig = { detectPorts: true, overrides: {} };

export const DEFAULT_CONFIG: Config = {
  version: 1,
  protected: [
    'bash', 'zsh', 'fish', 'sh',
    'konsole', 'gnome-terminal-', 'kitty', 'alacritty', 'wezterm-gui', 'ghostty', 'warp', 'tmux: server',
    'claude', 'claude-desktop',
    'kwin_wayland', 'kwin_x11', 'plasmashell', 'gnome-shell', 'Xwayland', 'Xorg', 'sddm', 'gdm',
    '/^systemd/',
  ],
  othersThreshold: { memMB: 100, cpuPercent: 1 },
  recorder: DEFAULT_RECORDER,
  ui: DEFAULT_UI,
  classify: { ...DEFAULT_CLASSIFY, overrides: {} },
};
