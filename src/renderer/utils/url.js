'use strict';

// ── lista rápida de dominios de ads para filtrar barra URL ──
const AD_HOSTS_QUICK = [
  'propellerads','popads','popcash','adsterra','hilltopads','exoclick','exosrv',
  'juicyads','tsyndicate','trafficstars','trafficjunky','clickadu','onclkds',
  'onclickads','adcash','admaven','monetag','doubleclick','googlesyndication',
  'amazon-adsystem','adnxs','advertising.com','media.net','outbrain','taboola',
  'criteo','rubiconproject','openx.net','pubmatic','appnexus','adsrvr',
  'adcolony','demdex','2mdn','galaksion','zeropark','revcontent','mgid',
  'go.oclasrv','go.onclasrv','syndicateads','plugrush','runative','revenuehits',
  'smartadx','beautifulpopups','popmagic','smartpopads','mobtrk','vidoomy',
];

function isAdUrl(url) {
  if (!url || url.startsWith('about:') || url.startsWith('mc://')) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AD_HOSTS_QUICK.some(d => host.includes(d));
  } catch { return false; }
}

// Dominio base (sin subdominios) para comparar si dos URLs pertenecen al mismo sitio
const MULTI_LABEL_SUFFIXES = new Set(['co.uk','org.uk','ac.uk','com.au','net.au','org.au','co.jp','co.kr','com.br','com.cn','com.mx','co.in']);
function baseDomain(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
  const parts = normalized.split('.');
  if (parts.length <= 2) return normalized;
  const suffix = parts.slice(-2).join('.');
  return parts.slice(-(MULTI_LABEL_SUFFIXES.has(suffix) ? 3 : 2)).join('.');
}
