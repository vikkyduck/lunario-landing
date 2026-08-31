/* Лунарио — фронт: аналитика А/Б, форма, cookie-баннер. Без зависимостей. */
(function () {
  'use strict';
  var V = (window.LUNARIO && window.LUNARIO.variant) || 'A';
  var METRIKA = (window.LUNARIO && window.LUNARIO.metrika) || null;
  // режим предпросмотра варианта (/?ab=A|B): статистику не искажаем
  var PREVIEW = /[?&]ab=(A|B)\b/.test(location.search);

  /* ── UTM: берём из URL, храним на сессию ── */
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var utm = {};
  try {
    var qs = new URLSearchParams(location.search);
    var stored = JSON.parse(sessionStorage.getItem('lunario_utm') || '{}');
    UTM_KEYS.forEach(function (k) {
      var val = qs.get(k) || stored[k];
      if (val) utm[k] = String(val).slice(0, 200);
    });
    if (Object.keys(utm).length) sessionStorage.setItem('lunario_utm', JSON.stringify(utm));
  } catch (e) { /* приватный режим — работаем без сохранения */ }

  /* ── события ── */
  function track(type, extra) {
    if (PREVIEW) return;
    try {
      var payload = JSON.stringify(Object.assign({ t: type, v: V }, extra || {}));
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/event', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
      }
    } catch (e) { /* аналитика не должна ломать сайт */ }
    if (METRIKA && typeof window.ym === 'function') {
      try { window.ym(METRIKA, 'reachGoal', type, { ab_variant: V }); } catch (e) {}
    }
  }

  track('landing_view', { utm_source: utm.utm_source || '' });

  /* ── CTA-клики ── */
  document.querySelectorAll('.js-cta').forEach(function (el) {
    el.addEventListener('click', function () {
      track('cta_click', { cta: el.getAttribute('data-cta') || '' });
    });
  });

  /* ── прокрутка 50 / 90 ── */
  var sent50 = false, sent90 = false;
  window.addEventListener('scroll', function () {
    var h = document.documentElement;
    var depth = (h.scrollTop + window.innerHeight) / h.scrollHeight;
    if (!sent50 && depth >= 0.5) { sent50 = true; track('scroll_50'); }
    if (!sent90 && depth >= 0.9) { sent90 = true; track('scroll_90'); }
  }, { passive: true });

  /* ── FAQ ── */
  document.querySelectorAll('.faq-item').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) track('faq_open', { q: d.getAttribute('data-faq') || '' });
    });
  });

  /* ── форма ── */
  var form = document.getElementById('leadForm');
  if (!form) return;
  var contactInput = document.getElementById('f-contact');
  var nameInput = document.getElementById('f-name');
  var fieldContact = document.getElementById('field-contact');
  var consentPd = document.getElementById('c-pd');
  var consentAds = document.getElementById('c-ads');
  var errConsent = document.getElementById('err-consent');
  var submitBtn = document.getElementById('submitBtn');
  var msg = document.getElementById('formMsg');
  var formStarted = false;
  var interests = [];

  function markFormStart() {
    if (!formStarted) { formStarted = true; track('form_start'); }
  }
  [nameInput, contactInput].forEach(function (inp) {
    inp.addEventListener('focus', markFormStart);
  });

  /* чипы интересов */
  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      markFormStart();
      var val = chip.getAttribute('data-interest');
      var on = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', on ? 'false' : 'true');
      if (on) interests = interests.filter(function (i) { return i !== val; });
      else { interests.push(val); track('interest_select', { interest: val }); }
    });
  });

  function contactLooksValid(s) {
    s = s.trim();
    if (/^@[a-zA-Z0-9_]{4,32}$/.test(s)) return true;                 // @username
    if (/^(https?:\/\/)?(t\.me|telegram\.me)\/[a-zA-Z0-9_]{4,32}$/.test(s)) return true;
    if (/^[^\s@]+@[^\s@]+\.[a-zA-Zа-яА-Я]{2,}$/.test(s)) return true; // email
    return false;
  }
  contactInput.addEventListener('blur', function () {
    if (contactInput.value.trim() && !contactLooksValid(contactInput.value)) {
      fieldContact.classList.add('invalid');
    } else {
      fieldContact.classList.remove('invalid');
    }
  });
  contactInput.addEventListener('input', function () { fieldContact.classList.remove('invalid'); });
  consentPd.addEventListener('change', function () { if (consentPd.checked) errConsent.style.display = 'none'; });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    msg.className = 'form-msg';
    msg.textContent = '';

    var contact = contactInput.value.trim();
    if (!contactLooksValid(contact)) {
      fieldContact.classList.add('invalid');
      contactInput.focus();
      return;
    }
    if (!consentPd.checked) {
      errConsent.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    var oldLabel = submitBtn.textContent;
    submitBtn.textContent = 'Отправляем заявку…';

    var body = {
      name: nameInput.value.trim().slice(0, 120),
      contact: contact,
      interests: interests,
      consent_pd: true,
      consent_ads: !!consentAds.checked,
      variant: V,
      utm: utm,
      website: form.querySelector('[name="website"]').value // honeypot
    };

    fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); })
      .then(function (res) {
        if (res.ok && res.data && res.data.ok) {
          track('lead_sent');
          msg.classList.add('ok');
          msg.textContent = res.data.duplicate
            ? 'Похоже, вы уже оставляли заявку. Мы сохранили ваше место.'
            : 'Вы в списке! Приглашение придёт перед запуском Лунарио.';
          form.querySelectorAll('input, button, .chip').forEach(function (el) { el.disabled = true; });
          submitBtn.textContent = 'Заявка принята';
        } else {
          throw new Error((res.data && res.data.error) || 'send_failed');
        }
      })
      .catch(function () {
        track('form_error');
        msg.classList.add('err');
        msg.textContent = 'Не удалось отправить заявку. Попробуйте ещё раз или напишите нам в Telegram: @eratochka.';
        submitBtn.disabled = false;
        submitBtn.textContent = oldLabel;
      });
  });

  /* ── cookie-баннер ── */
  var bar = document.getElementById('cookiebar');
  var okBtn = document.getElementById('cookieOk');
  try {
    if (!localStorage.getItem('lunario_cookie_ok')) bar.classList.add('show');
  } catch (e) { bar.classList.add('show'); }
  okBtn.addEventListener('click', function () {
    bar.classList.remove('show');
    try { localStorage.setItem('lunario_cookie_ok', '1'); } catch (e) {}
  });
})();
