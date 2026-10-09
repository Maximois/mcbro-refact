'use strict';
/**
 * Dialogos propios (confirmar / pedir texto) en lugar de window.confirm,
 * window.prompt y window.alert.
 *
 * Por que: en Electron/Windows el dialogo nativo deja a la pagina sin foco de
 * teclado al cerrarse (hay que reiniciar el navegador para volver a escribir),
 * y window.prompt directamente no existe en Electron. Estos son DOM puro,
 * asincronos, con foco y teclado (Enter acepta, Escape cancela).
 *
 *   if (!await mcDialog.confirm('¿Borrar todo?', { ok: 'Borrar', danger: true })) return;
 *   const name = await mcDialog.prompt('Nombre:', actual);   // null si cancela
 */
(function () {
  function build(opts) {
    const back = document.createElement('div');
    back.className = 'mc-dialog-back';
    back.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.style.cssText = 'min-width:320px;max-width:min(520px,90vw);background:var(--surface2,#1e2028);color:var(--text,#e6e8ee);' +
      'border:1px solid var(--border2,#34394a);border-radius:10px;padding:16px 18px;box-shadow:0 12px 36px rgba(0,0,0,.6);font:inherit;';
    const msg = document.createElement('div');
    msg.style.cssText = 'white-space:pre-line;line-height:1.4;margin-bottom:12px;';
    msg.textContent = opts.message;
    box.appendChild(msg);
    let input = null;
    if (opts.input) {
      input = document.createElement('input');
      input.type = 'text';
      input.value = opts.value || '';
      input.style.cssText = 'display:block;width:100%;box-sizing:border-box;height:32px;padding:4px 8px;margin-bottom:12px;' +
        'background:var(--surface,#14161c);color:inherit;border:1px solid var(--border2,#34394a);border-radius:6px;font:inherit;';
      box.appendChild(input);
    }
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const mk = (label, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:6px 14px;border-radius:6px;cursor:pointer;font:inherit;border:1px solid var(--border2,#34394a);' +
        (primary ? 'background:' + (opts.danger ? '#d9534f' : 'var(--accent,#00d4aa)') + ';color:#fff;border-color:transparent;'
          : 'background:transparent;color:inherit;');
      return b;
    };
    const cancel = mk(opts.cancel || 'Cancelar', false);
    const ok = mk(opts.ok || 'Aceptar', true);
    if (opts.cancel !== false) row.appendChild(cancel);
    row.appendChild(ok);
    box.appendChild(row);
    back.appendChild(box);
    return { back, box, input, ok, cancel };
  }

  function open(opts) {
    return new Promise((resolve) => {
      const d = build(opts);
      const prev = document.activeElement;
      let finished = false;
      const close = (value) => {
        if (finished) return;
        finished = true;
        d.back.remove();
        try { if (prev && prev.focus && document.contains(prev)) prev.focus(); } catch { /* sin foco previo */ }
        resolve(value);
      };
      const accept = () => close(opts.input ? d.input.value : true);
      const dismiss = () => close(opts.input ? null : false);
      d.ok.addEventListener('click', accept);
      d.cancel.addEventListener('click', dismiss);
      d.back.addEventListener('mousedown', (e) => { if (e.target === d.back) dismiss(); });
      d.box.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); accept(); }
      });
      document.body.appendChild(d.back);
      if (d.input) { d.input.focus(); d.input.select(); } else d.ok.focus();
    });
  }

  window.mcDialog = {
    confirm: (message, o) => open(Object.assign({ message: String(message) }, o)),
    prompt: (message, value, o) => open(Object.assign({ message: String(message), input: true, value: value == null ? '' : String(value) }, o)),
    alert: (message, o) => open(Object.assign({ message: String(message), cancel: false }, o))
  };
})();
