'use strict';

const ENGINES = {
  ddg:       'https://duckduckgo.com/?q=',
  brave:     'https://search.brave.com/search?q=',
  startpage: 'https://www.startpage.com/search?q=',
  google:   'https://www.google.com/search?q=',
};

const UA_LABELS = {
  'win-chrome':'Windows/Chrome', 'win-edge':'Windows/Edge',
  'mac-safari':'macOS/Safari',   'linux-ff':'Linux/Firefox',
  'android':'Android/Chrome',    'iphone':'iPhone/Safari'
};

const DEFAULT_SHORTCUTS = [
  { url: 'https://duckduckgo.com', icon: null, label: 'DuckDuckGo' },
  { url: 'https://proton.me', icon: null, label: 'ProtonMail' },
  { url: 'https://github.com', icon: null, label: 'GitHub' },
  { url: 'https://wikipedia.org', icon: null, label: 'Wikipedia' },
  { url: 'https://archive.org', icon: null, label: 'Archive.org' },
];

const state = {
  currentPanel: 'newtab',
  currentEngine: 'ddg',
  tabs: [{ id: 1, title: 'Nueva pestaña', url: 'mc://newtab' }],
  activeTab: 1,
  tabCounter: 1,
  stats: { blockedAds:0, blockedTrackers:0, blockedThird:0, blockedCrypto:0, detectedMedia:0, totalRequests:0, modifiedHeaders:0, interceptedCookies:0 },
  customBlocks: [],
  siteBlockMap: {}, // se reasigna en syncCfgToUI(); default acá para que un
                    // acceso temprano (ej: webview dom-ready antes de que
                    // cargue la config) no rompa toda la cascada de render
                    // del panel de permisos (scripts/cookies/cosmético).
  cookieRules: {},
  reqLogFilter: 'all',
  reqLog: [],
  cfg: null,
  history: [],
  shortcuts: [],
  bgSettings: null,
  mediaItems: new Map(),
  streamItems: new Map(),
  hlsCaptureItems: new Map(),
  hlsCaptureActive: false,
  blockedScripts: [],
  downloads: [], // historial persistente de descargas
  permissionHostHints: {},
  authReturnUrls: {},
};
