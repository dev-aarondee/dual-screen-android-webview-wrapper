'use strict';
const $ = (id) => document.getElementById(id);

async function init() {
  const s = await window.ultrapos.invoke('settings:get');
  $('main').value = s.main_url;
  $('customer').value = s.customer_url;
  $('startup').checked = s.start_with_windows;
  $('fullscreen').checked = s.fullscreen;
  $('now').textContent = `Customer screen now: ${s.effectiveCustomerUrl || '(black until a store opens)'}`;
  $('displays').textContent = `Customer displays found: ${s.customerDisplays}`;
  $('main').focus();
  $('main').select();
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  window.ultrapos.invoke('settings:save', {
    main_url: $('main').value,
    customer_url: $('customer').value,
    start_with_windows: $('startup').checked,
    fullscreen: $('fullscreen').checked,
  }).then(() => window.close());
});
$('reload').addEventListener('click', () => window.ultrapos.invoke('settings:reload').then(() => window.close()));
$('cancel').addEventListener('click', () => window.close());
$('quit').addEventListener('click', () => window.ultrapos.invoke('settings:quit'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

init();
