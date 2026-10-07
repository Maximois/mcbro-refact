'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  getPermissionRuleForHost,
  isSitePermissionAllowed,
  resolvePermissionDecision,
  resolveMediaPermissionDecision,
  getAllowlistPolicyForHost,
  isCookieGuardNeeded,
  resolveCookieAction,
  parseGlobalBlockRule,
  isGlobalBlockMatch,
  normalizeSiteHost,
  isWebContentsFrameAlive,
  sanitizeAiConfigForPublic
} = require('../lib/permissions');
const { isSameNavigationSite, siteRootIdentity } = require('../lib/navigation-guard');
const { createBlockHandler, isAggressiveAdNavigation, isGoogleDocumentHost, isGoogleAdHost, isAdblockHostAllowed, isAdblockSiteAllowed, builtInCosmeticSelectors } = require('../modules/adblocker/main');

describe('adblock host allowlist', () => {
  test('permite el dominio guardado y sus subdominios', () => {
    assert.equal(isAdblockHostAllowed('youtube.com', ['youtube.com']), true);
    assert.equal(isAdblockHostAllowed('www.youtube.com', ['youtube.com']), true);
    assert.equal(isAdblockHostAllowed('google.com.py', ['*.google.com.py']), true);
  });

  test('no permite coincidencias parciales de dominios', () => {
    assert.equal(isAdblockHostAllowed('notyoutube.com', ['youtube.com']), false);
    assert.equal(isAdblockHostAllowed('youtube.com.evil.test', ['youtube.com']), false);
    assert.equal(isAdblockHostAllowed('youtube.com', []), false);
  });

  test('permite los recursos de un sitio sin eximir ese host en otros sitios', () => {
    assert.equal(isAdblockSiteAllowed('www.youtube.com', ['youtube.com']), true);
    assert.equal(isAdblockSiteAllowed('youtube.com.evil.test', ['youtube.com']), false);
    assert.equal(isAdblockSiteAllowed('example.com', ['youtube.com']), false);
  });
});

describe('YouTube usa las reglas normales del adblock', () => {
  test('una regla del motor puede bloquear recursos en una página de YouTube', () => {
    const handler = createBlockHandler(
      () => ({ match: () => ({ match: true }) }),
      [],
      () => true,
      category => category === 'ads',
      null,
      true,
      null,
      null,
      null
    );
    let decision = null;
    handler({
      url: 'https://ads.example.test/ad.js',
      documentUrl: 'https://www.youtube.com/watch?v=test',
      resourceType: 'script'
    }, result => { decision = result; });
    assert.deepEqual(decision, { cancel: true });
  });

  test('no aplica filtros cosméticos integrados en YouTube', () => {
    const youtubeSelectors = builtInCosmeticSelectors('https://www.youtube.com/');
    const genericSelectors = builtInCosmeticSelectors('https://example.com/');
    assert.deepEqual(youtubeSelectors, []);
    assert.ok(genericSelectors.includes('iframe[src*="adtng.com"]'));
  });
});

describe('same-site: el dominio de la página nunca es bloqueado por heurísticas', () => {
  const makeHandler = (engineMatch = false) => createBlockHandler(
    () => ({ match: () => ({ match: engineMatch }) }),
    [],
    () => true,
    category => ['ads', 'trackers'].includes(category),
    null, true, null, null, null
  );
  const decide = (url, documentUrl, resourceType, engineMatch) => {
    let decision = null;
    makeHandler(engineMatch)({ url, documentUrl, resourceType }, r => { decision = r; });
    return decision;
  };

  test('permite recursos propios con tokens de ruta de ads (/get/, ad-)', () => {
    assert.deepEqual(decide('https://cdn.wartale.com/api/get/img.webp', 'https://www.wartale.com/', 'xhr', false), { cancel: false });
    assert.deepEqual(decide('https://www.wartale.com/get/thumbnail.jpg', 'https://www.wartale.com/', 'image', false), { cancel: false });
    assert.deepEqual(decide('https://www.wartale.com/uploads/ad-cover.jpg', 'https://www.wartale.com/', 'script', false), { cancel: false });
  });

  test('nunca bloquea el frame principal por tokens de ruta', () => {
    assert.deepEqual(decide('https://wartale.com/get/page', '', 'main_frame', false), { cancel: false });
  });

  test('sigue bloqueando ads y trackers de terceros con los mismos tokens', () => {
    assert.deepEqual(decide('https://a.adtng.com/get/123', 'https://www.wartale.com/', 'script', false), { cancel: true });
    assert.deepEqual(decide('https://cdn.exadtest.net/banner-ads.html', 'https://www.wartale.com/', 'script', false), { cancel: true });
    assert.deepEqual(decide('https://www.google-analytics.com/analytics.js', 'https://www.wartale.com/', 'script', false), { cancel: true });
  });

  test('una regla explícita del motor de listas sigue aplicando mismo sitio', () => {
    assert.deepEqual(decide('https://www.wartale.com/xx.js', 'https://www.wartale.com/', 'script', true), { cancel: true });
  });

  test('las marcas de red (pagead) siguen bloqueando en el mismo sitio', () => {
    assert.deepEqual(decide('https://www.youtube.com/pagead/ads?client=ca', 'https://www.youtube.com/watch?v=1', 'xhr', false), { cancel: true });
    assert.deepEqual(decide('https://www.youtube.com/pagead/iframe?ca=1', 'https://www.youtube.com/watch?v=1', 'subFrame', false), { cancel: true });
  });

  test('los tokens genéricos no cortan subframes same-site (contenido propio)', () => {
    assert.deepEqual(decide('https://www.wartale.com/get/frame', 'https://www.wartale.com/', 'subFrame', false), { cancel: false });
  });
});

// ── normalizeSiteHost ──────────────────────────────────────────────────
describe('normalizeSiteHost', () => {
  test('extrae el host de una URL normal', () => {
    assert.equal(normalizeSiteHost('https://www.Example.com/path'), 'www.example.com');
  });
  test('devuelve vacío para about:blank o URLs inválidas', () => {
    assert.equal(normalizeSiteHost('about:blank'), '');
    assert.equal(normalizeSiteHost('no-es-una-url'), '');
    assert.equal(normalizeSiteHost(''), '');
  });
});

// ── getPermissionRuleForHost / herencia por subdominio ───────────────────
describe('getPermissionRuleForHost', () => {
  test('aplica la regla del dominio exacto', () => {
    const cfg = { permissions: { 'example.com': { camera: 'allow' } } };
    assert.equal(getPermissionRuleForHost('example.com', 'camera', cfg), 'allow');
  });
  test('hereda la regla a subdominios', () => {
    const cfg = { permissions: { 'example.com': { camera: 'allow' } } };
    assert.equal(getPermissionRuleForHost('chat.example.com', 'camera', cfg), 'allow');
  });
  test('no aplica la regla de un dominio no relacionado', () => {
    const cfg = { permissions: { 'example.com': { camera: 'allow' } } };
    assert.equal(getPermissionRuleForHost('otherexample.com', 'camera', cfg), null);
  });
  test('sin reglas configuradas devuelve null', () => {
    assert.equal(getPermissionRuleForHost('example.com', 'camera', { permissions: {} }), null);
  });
});

// ── resolvePermissionDecision: deny-by-default ────────────────────────────
describe('resolvePermissionDecision', () => {
  test('permiso explícito "allow" se otorga', () => {
    const cfg = { permissions: { 'example.com': { notifications: 'allow' } } };
    assert.equal(resolvePermissionDecision('example.com', 'notifications', cfg), true);
  });
  test('sin regla, tipos sensibles conocidos se deniegan por defecto', () => {
    const cfg = { permissions: {} };
    for (const key of ['notifications', 'geolocation', 'camera', 'microphone']) {
      assert.equal(resolvePermissionDecision('example.com', key, cfg), false, key);
    }
  });
  test('clipboard-read/clipboard-write/clipboard-sanitized-write deben pasar por la política de permisos del panel de IA web', () => {
    const cfg = { permissions: {} };
    assert.equal(resolvePermissionDecision('example.com', 'clipboard-read', cfg), true);
    assert.equal(resolvePermissionDecision('example.com', 'clipboard-write', cfg), true);
    assert.equal(resolvePermissionDecision('example.com', 'clipboard-sanitized-write', cfg), true);
  });
  test('fullscreen se otorga por defecto (regresión: pantalla completa HTML5)', () => {
    const cfg = { permissions: {} };
    assert.equal(resolvePermissionDecision('perchance.org', 'fullscreen', cfg), true);
    assert.equal(resolvePermissionDecision('youtube.com', 'fullscreen', cfg), true);
    // Una regla explícita "deny" sí debe poder bloquearlo.
    const cfgDeny = { permissions: { 'example.com': { fullscreen: 'deny' } } };
    assert.equal(resolvePermissionDecision('example.com', 'fullscreen', cfgDeny), false);
  });
});

// ── resolveMediaPermissionDecision: el bug de cámara/micrófono ───────────
// Electron entrega getUserMedia como un único tipo 'media', nunca como
// 'camera' ni 'microphone'. Si esta traducción se rompe (p.ej. alguien
// vuelve a comparar 'media' directo contra las claves camera/microphone),
// estos tests fallan.
describe('resolveMediaPermissionDecision (regresión: permiso fantasma de cámara/mic)', () => {
  test('cámara permitida explícitamente habilita un pedido solo-video', () => {
    const cfg = { permissions: { 'meet.example.com': { camera: 'allow' } } };
    assert.equal(resolveMediaPermissionDecision('meet.example.com', ['video'], cfg), true);
  });
  test('cámara permitida NO habilita un pedido de solo-audio', () => {
    const cfg = { permissions: { 'meet.example.com': { camera: 'allow' } } };
    assert.equal(resolveMediaPermissionDecision('meet.example.com', ['audio'], cfg), false);
  });
  test('pedido combinado video+audio exige que AMBOS estén permitidos', () => {
    const cfg = { permissions: { 'meet.example.com': { camera: 'allow' } } };
    assert.equal(resolveMediaPermissionDecision('meet.example.com', ['video', 'audio'], cfg), false);
    cfg.permissions['meet.example.com'].microphone = 'allow';
    assert.equal(resolveMediaPermissionDecision('meet.example.com', ['video', 'audio'], cfg), true);
  });
  test('sin ninguna regla, todo pedido de media se deniega', () => {
    assert.equal(resolveMediaPermissionDecision('example.com', ['video'], { permissions: {} }), false);
  });
});

// ── getAllowlistPolicyForHost / resolveCookieAction: el bug de "block" ────
describe('resolveCookieAction (regresión: cookies "block" que no bloqueaban)', () => {
  test('política "block" en dominio de 1ra parte bloquea la cookie', () => {
    const cfg = { allowlist: { 'tracker.example.com': 'block' } };
    const action = resolveCookieAction({ host: 'tracker.example.com', thirdParty: false, cfg });
    assert.equal(action, 'block');
  });
  test('sin regla en la lista blanca, la cookie se bloquea por defecto', () => {
    const cfg = { allowlist: {} };
    const action = resolveCookieAction({ host: 'example.com', thirdParty: false, cfg });
    assert.equal(action, 'block');
  });
  test('3ra parte con aislamiento estricto siempre bloquea', () => {
    const cfg = { allowlist: {} };
    const action = resolveCookieAction({ host: 'ads.example.net', thirdParty: true, cfg });
    assert.equal(action, 'block');
  });
  test('política "session" degrada la cookie en vez de bloquearla', () => {
    const cfg = { allowlist: { 'example.com': 'session' } };
    const action = resolveCookieAction({ host: 'example.com', thirdParty: false, cfg });
    assert.equal(action, 'session');
  });
  test('la whitelist define la única excepción: sin entrar en ella, la cookie queda bloqueada aunque cookiePolicy sea "session"', () => {
    const cfgSinExcepcion = { allowlist: {}, cookiePolicy: 'session' };
    assert.equal(resolveCookieAction({ host: 'example.com', thirdParty: false, cfg: cfgSinExcepcion }), 'block');

    const cfgConExcepcion = { allowlist: { 'example.com': 'allow' }, cookiePolicy: 'session' };
    assert.equal(resolveCookieAction({ host: 'example.com', thirdParty: false, cfg: cfgConExcepcion }), 'allow');
  });
  test('regla "block" pesa incluso si cookiePolicy global es "allow-all"', () => {
    const cfg = { allowlist: { 'tracker.example.com': 'block' }, cookiePolicy: 'allow-all' };
    assert.equal(resolveCookieAction({ host: 'tracker.example.com', thirdParty: false, cfg }), 'block');
  });
});

describe('isCookieGuardNeeded', () => {
  test('no requiere CDP con allow-all y sin reglas restrictivas', () => {
    assert.equal(isCookieGuardNeeded({ cookiePolicy: 'allow-all', allowlist: {} }), false);
    assert.equal(isCookieGuardNeeded({ cookiePolicy: 'allow-all', allowlist: { 'example.com': 'allow' } }), false);
  });
  test('requiere CDP con política global de sesión o reglas restrictivas', () => {
    assert.equal(isCookieGuardNeeded({ cookiePolicy: 'session', allowlist: {} }), true);
    assert.equal(isCookieGuardNeeded({ cookiePolicy: 'allow-all', allowlist: { 'example.com': 'block' } }), true);
    assert.equal(isCookieGuardNeeded({ cookiePolicy: 'allow-all', allowlist: { 'example.com': 'session' } }), true);
  });
});

describe('isWebContentsFrameAlive', () => {
  test('marca como muerto un webContents ya destruido o con frame descartado', () => {
    assert.equal(isWebContentsFrameAlive({ isDestroyed: () => true }), false);
    assert.equal(isWebContentsFrameAlive({ isDestroyed: () => false, mainFrame: { isDestroyed: () => true } }), false);
  });
  test('rechaza un webContents sin mainFrame usable o en estado de frame descartado', () => {
    assert.equal(isWebContentsFrameAlive({ isDestroyed: () => false }), false);
    assert.equal(isWebContentsFrameAlive({ isDestroyed: () => false, mainFrame: null }), false);
  });
  test('acepta un webContents vivo sin frame roto', () => {
    assert.equal(isWebContentsFrameAlive({ isDestroyed: () => false, mainFrame: { isDestroyed: () => false } }), true);
  });
});

describe('isSitePermissionAllowed', () => {
  test('true solo cuando la regla "site" es exactamente "allow"', () => {
    assert.equal(isSitePermissionAllowed('example.com', { permissions: { 'example.com': { site: 'allow' } } }), true);
    assert.equal(isSitePermissionAllowed('example.com', { permissions: { 'example.com': { site: 'deny' } } }), false);
    assert.equal(isSitePermissionAllowed('example.com', { permissions: {} }), false);
  });
});

describe('sanitizeAiConfigForPublic', () => {
  test('enmascara claves sensibles antes de exponer la configuración', () => {
    const cfg = {
      provider: 'openai',
      openaiKey: 'sk-real-key',
      groqKey: 'groq-secret',
      geminiKey: 'gemini-secret',
      opencodeKey: 'opencode-secret',
      openaiModel: 'gpt-4o'
    };

    const publicCfg = sanitizeAiConfigForPublic(cfg);

    assert.equal(publicCfg.provider, 'openai');
    assert.equal(publicCfg.openaiKey, '***');
    assert.equal(publicCfg.groqKey, '***');
    assert.equal(publicCfg.geminiKey, '***');
    assert.equal(publicCfg.opencodeKey, '***');
    assert.equal(publicCfg.openaiModel, 'gpt-4o');
  });
});

// ── reglas globales de bloqueo (adblock/tracker) ──────────────────────────
describe('parseGlobalBlockRule / isGlobalBlockMatch', () => {
  test('"*.dominio" genera una regla de subdominio', () => {
    const rule = parseGlobalBlockRule('*.ads.example.com');
    assert.deepEqual(rule, { host: 'ads.example.com', subdomainOnly: true });
    assert.equal(isGlobalBlockMatch('x.ads.example.com', '', rule), true);
    assert.equal(isGlobalBlockMatch('ads.example.com', '', rule), true);
    assert.equal(isGlobalBlockMatch('example.com', '', rule), false);
  });
  test('dominio simple también matchea sus subdominios', () => {
    const rule = parseGlobalBlockRule('tracker.com');
    assert.equal(isGlobalBlockMatch('sub.tracker.com', '', rule), true);
    assert.equal(isGlobalBlockMatch('nottracker.com', '', rule), false);
  });
  test('valor vacío no genera regla', () => {
    assert.equal(parseGlobalBlockRule(''), null);
    assert.equal(parseGlobalBlockRule('   '), null);
  });
});

describe('adblock banners / adtng', () => {
  test('bloquea hosts de anuncios y banners inline', () => {
    assert.equal(isAggressiveAdNavigation('https://a.adtng.com/get/10016594?time=1769790006402'), true);
    assert.equal(isAggressiveAdNavigation('https://example.com/banner-ads.html'), true);
    assert.equal(isAggressiveAdNavigation('https://example.com/article'), false);
  });

  test('en páginas Google solo reconoce la lista explícita de dominios de anuncios', () => {
    assert.equal(isGoogleDocumentHost('gemini.google.com'), true);
    assert.equal(isGoogleDocumentHost('www.google.com.py'), true);
    assert.equal(isGoogleDocumentHost('example.com'), false);
    assert.equal(isGoogleAdHost('adservice.google.com'), true);
    assert.equal(isGoogleAdHost('sub.pagead2.googlesyndication.com'), true);
    assert.equal(isGoogleAdHost('googleadservices.com'), true);
    assert.equal(isGoogleAdHost('tag.googletagmanager.com'), true);
    assert.equal(isGoogleAdHost('googletagservices.com'), true);
    assert.equal(isGoogleAdHost('www.google-analytics.com'), true);
    assert.equal(isGoogleAdHost('doubleclick.net'), false);
    assert.equal(isGoogleAdHost('cdn.googlesyndication.com'), false);
    assert.equal(isGoogleAdHost('www.google.com'), false);
  });

  test('Gemini solo bloquea dominios Google enumerados y otras páginas conservan el adblock', () => {
    const makeDecision = (url, documentUrl, topFrameUrl) => {
      const handler = createBlockHandler(
        () => ({ match: true }),
        [],
        () => true,
        category => category === 'ads',
        null,
        true,
        () => {},
        null,
        null
      );
      let decision = null;
      const details = { url, documentUrl, resourceType: 'script' };
      if (topFrameUrl) details.frame = { top: { url: topFrameUrl } };
      handler(details, result => { decision = result; });
      return decision;
    };

    assert.deepEqual(makeDecision('https://adservice.google.com/pagead/id', 'https://gemini.google.com/app/'), { cancel: true });
    assert.deepEqual(makeDecision('https://adservice.google.com/pagead/id', 'https://third-party-frame.example/', 'https://gemini.google.com/app/'), { cancel: true });
    assert.deepEqual(makeDecision('https://doubleclick.net/ad.js', 'https://gemini.google.com/app/'), { cancel: false });
    assert.deepEqual(makeDecision('https://doubleclick.net/ad.js', 'https://third-party-frame.example/', 'https://gemini.google.com/app/'), { cancel: false });
    assert.deepEqual(makeDecision('https://cdn.googlesyndication.com/script.js', 'https://gemini.google.com/app/'), { cancel: false });
    assert.deepEqual(makeDecision('https://doubleclick.net/ad.js', 'https://example.com/'), { cancel: true });
  });
});

describe('navigation guard redirects', () => {
  test('identifica el dominio registrable aunque el subdominio no sea común', () => {
    assert.equal(siteRootIdentity('accounts.google.com'), 'google');
    assert.equal(siteRootIdentity('shop.amazon.co.jp'), 'amazon');
    assert.equal(isSameNavigationSite('https://accounts.google.com/login', 'https://mail.google.com/inbox'), true);
    assert.equal(isSameNavigationSite('https://shop.amazon.co.jp/cart', 'https://checkout.amazon.co.jp/pay'), true);
  });

  test('trata como mismo sitio un dominio migrado al canónico correcto', () => {
    assert.equal(siteRootIdentity('vww.monoschinos2.net'), 'monoschinos');
    assert.equal(siteRootIdentity('monoschinos.st'), 'monoschinos');
    assert.equal(isSameNavigationSite('https://monoschinos2.net/anime', 'https://vww.monoschinos2.net/anime'), true);
    assert.equal(isSameNavigationSite('https://monoschinos2.net/anime', 'https://monoschinos.st/anime'), true);
    assert.equal(isSameNavigationSite('https://monoschinos.st/anime', 'https://vww.monoschinos2.net/anime'), true);
    assert.equal(isSameNavigationSite('https://example.com/anime', 'https://example.net/anime'), true);
  });

  test('mantiene permitida la transición interna aunque la ruta parezca publicitaria', () => {
    assert.equal(isSameNavigationSite(
      'https://vww.monoschinos2.net/anime',
      'https://monoschinos.st/ads/continue'
    ), true);
  });

  test('mantiene bloqueadas redirecciones a subdominios publicitarios del mismo dominio', () => {
    assert.equal(isSameNavigationSite('https://example.com/a', 'https://ads.example.com/click'), false);
    assert.equal(isSameNavigationSite('https://example.com/a', 'https://redirect.example.com/?ad=1'), false);
  });

  test('no trata como publicitarios subdominios legítimos como go./promo./offers.', () => {
    assert.equal(isSameNavigationSite('https://www.microsoft.com/', 'https://go.microsoft.com/fwlink/?linkid=1'), true);
    assert.equal(isSameNavigationSite('https://go.microsoft.com/fwlink/?linkid=1', 'https://learn.microsoft.com/es-es/'), true);
    assert.equal(isSameNavigationSite('https://www.amazon.com/', 'https://offers.amazon.com/'), true);
    assert.equal(isSameNavigationSite('https://www.nike.com/', 'https://promo.nike.com/'), true);
  });

  test('mantiene bloqueadas redirecciones entre sitios distintos', () => {
    assert.equal(isSameNavigationSite('https://example.com/a', 'https://evil-example.com/b'), false);
    assert.equal(isSameNavigationSite('https://example.com/a', 'https://blog.example.net/b'), false);
  });
});
