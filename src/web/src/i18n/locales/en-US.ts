// English (US) translations

import type { Translations } from './zh-CN.js'

export const enUS: Translations = {
  // ── Common ────────────────────────────────────────────────────────────
  common: {
    confirm: 'Confirm',
    cancel: 'Cancel',
    delete: 'Delete',
    save: 'Save',
    reset: 'Reset',
    loading: 'Loading...',
    connecting: 'Connecting...',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    disconnected: 'Disconnected',
    logout: 'Log out',
    settings: 'Settings',
    newSession: 'New Chat',
    noSessions: 'No sessions',
    noMatchSessions: 'No matching sessions',
    recentSessions: 'Recent',
    searchSessions: 'Search sessions...',
    deleteSession: 'Delete session',
    userAvatar: 'User avatar',
    userMenu: 'User menu',
    lightMode: 'Light mode',
    darkMode: 'Dark mode',
    switchToLight: 'Switch to light mode',
    switchToDark: 'Switch to dark mode',
    admin: 'admin',
  },

  // ── Navigation ────────────────────────────────────────────────────────
  nav: {
    zhile: 'Zhile',
    skills: 'Skills',
    automation: 'Automation',
    chat: 'Chat',
    settings: 'Settings',
  },

  // ── Settings page ─────────────────────────────────────────────────────
  settings: {
    title: 'Settings',
    tabs: {
      general: 'General',
      channels: 'Channels',
      config: 'Config',
      logs: 'Logs',
      usage: 'Usage',
    },
    general: {
      title: 'General',
      theme: {
        label: 'Theme',
        desc: 'Switch between light and dark mode',
        light: 'Light',
        dark: 'Dark',
      },
      language: {
        label: 'Language',
        desc: 'Select display language',
        zhCN: '简体中文',
        enUS: 'English',
      },
    },
  },

  // ── Confirm modal ─────────────────────────────────────────────────────
  modal: {
    deleteSession: {
      title: 'Delete Session',
      message: (title: string) => `Are you sure you want to delete "${title}"? This will also delete all workspace files for this session and cannot be undone.`,
    },
  },
}
