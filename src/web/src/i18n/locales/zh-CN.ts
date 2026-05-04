// 简体中文翻译

export interface Translations {
  common: {
    confirm: string
    cancel: string
    delete: string
    save: string
    reset: string
    loading: string
    connecting: string
    connected: string
    reconnecting: string
    disconnected: string
    logout: string
    settings: string
    newSession: string
    noSessions: string
    noMatchSessions: string
    recentSessions: string
    searchSessions: string
    deleteSession: string
    userAvatar: string
    userMenu: string
    lightMode: string
    darkMode: string
    switchToLight: string
    switchToDark: string
    admin: string
  }
  nav: {
    zhile: string
    skills: string
    automation: string
    chat: string
    settings: string
  }
  settings: {
    title: string
    tabs: {
      general: string
      channels: string
      config: string
      logs: string
      usage: string
    }
    general: {
      title: string
      theme: {
        label: string
        desc: string
        light: string
        dark: string
      }
      language: {
        label: string
        desc: string
        zhCN: string
        enUS: string
      }
    }
  }
  modal: {
    deleteSession: {
      title: string
      message: (title: string) => string
    }
  }
}

export const zhCN: Translations = {
  // ── 通用 ──────────────────────────────────────────────────────────────
  common: {
    confirm: '确认',
    cancel: '取消',
    delete: '删除',
    save: '保存',
    reset: '重置',
    loading: '加载中...',
    connecting: '连接中...',
    connected: '已连接',
    reconnecting: '重连中',
    disconnected: '已断开',
    logout: '退出登录',
    settings: '系统设置',
    newSession: '新对话',
    noSessions: '暂无会话',
    noMatchSessions: '无匹配会话',
    recentSessions: '最近会话',
    searchSessions: '搜索会话...',
    deleteSession: '删除会话',
    userAvatar: '用户头像',
    userMenu: '用户菜单',
    lightMode: '日间模式',
    darkMode: '夜间模式',
    switchToLight: '切换到日间模式',
    switchToDark: '切换到夜间模式',
    admin: 'admin',
  },

  // ── 导航 ──────────────────────────────────────────────────────────────
  nav: {
    zhile: '知了',
    skills: '技能',
    automation: '自动化',
    chat: '对话',
    settings: '设置',
  },

  // ── 设置页面 ──────────────────────────────────────────────────────────
  settings: {
    title: '设置',
    tabs: {
      general: '通用',
      channels: '渠道',
      config: '配置',
      logs: '日志',
      usage: '用量',
    },
    general: {
      title: '通用',
      theme: {
        label: '界面主题',
        desc: '切换日间 / 夜间模式',
        light: '日间',
        dark: '夜间',
      },
      language: {
        label: '界面语言',
        desc: '选择显示语言',
        zhCN: '简体中文',
        enUS: 'English',
      },
    },
  },

  // ── 确认弹窗 ──────────────────────────────────────────────────────────
  modal: {
    deleteSession: {
      title: '删除会话',
      message: (title: string) => `确定要删除「${title}」吗？此操作将同时删除该会话的所有工作区文件，且无法恢复。`,
    },
  },
}
