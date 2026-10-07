import type { Config } from './types';

export const DEFAULT_CONFIG: Config = {
  version: 1,
  protected: [
    'bash', 'zsh', 'fish', 'sh',
    'konsole', 'gnome-terminal-server', 'kitty', 'alacritty', 'wezterm-gui', 'ghostty', 'warp', 'tmux: server',
    'claude', 'claude-desktop',
    'kwin_wayland', 'kwin_x11', 'plasmashell', 'gnome-shell', 'Xwayland', 'Xorg', 'sddm', 'gdm',
    '/^systemd/',
  ],
  othersThreshold: { memMB: 100, cpuPercent: 1 },
};
