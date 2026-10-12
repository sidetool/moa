(function () {
  'use strict';
  // This page is served directly, outside Vite's browser compatibility build.
  var reveal = document.querySelector('.reveal');
  var password = document.getElementById('password');
  if (reveal && password) reveal.addEventListener('click', function () {
    var visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    reveal.setAttribute('aria-label', visible ? '비밀번호 숨기기' : '비밀번호 보기');
    reveal.setAttribute('aria-pressed', String(visible));
  });
  var joining = /\/join$/.test(location.pathname);
  var settingUp = /\/setup$/.test(location.pathname);
  var idle = settingUp ? '관리자 만들고 시작하기' : joining ? '가입하고 시작하기' : '로그인';
  var code = document.getElementById('code');
  if (code) code.addEventListener('input', function () {
    var raw = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    var groups = raw.match(/.{1,4}/g);
    code.value = groups ? groups.join('-') : '';
  });
  var confirmation = document.getElementById('confirm');
  var mismatch = document.querySelector('.mismatch');
  function checkMatch() {
    var bad = confirmation.value.length > 0 && confirmation.value !== password.value;
    mismatch.hidden = !bad;
    confirmation.setCustomValidity(bad ? '비밀번호가 서로 달라요.' : '');
  }
  if (confirmation && mismatch && password) {
    confirmation.addEventListener('input', checkMatch);
    password.addEventListener('input', checkMatch);
  }
  if ((joining || settingUp) && code) {
    var initial = code.value ? document.getElementById('username') : code;
    if (initial) initial.focus();
  }
  // :has() is not available in older TV engines. Use the submit control's form.
  var button = document.querySelector('button.submit');
  var form = button && button.form;
  if (form) form.addEventListener('submit', function () {
    // Keep the native submit control enabled while the browser submits the form.
    button.setAttribute('aria-busy', 'true');
    button.textContent = settingUp ? '만드는 중…' : joining ? '가입 중…' : '로그인 중…';
  });
  window.addEventListener('pageshow', function () {
    if (!button) return;
    button.removeAttribute('aria-busy');
    button.textContent = idle;
  });
}());
