'use strict';
// Shown when the POS can't be loaded and nothing is saved on this computer yet
// (first start with no internet). Once the web app has loaded one time, it
// opens from this computer's saved copy instead and this page isn't needed.
const params = new URLSearchParams(location.search);
const target = params.get('url') || '';
const customer = params.get('mode') === 'customer';
const reason = params.get('reason') || '';

if (customer) {
  document.body.classList.add('customer');
  document.getElementById('title').textContent = 'Waiting for the internet…';
} else if (navigator.onLine) {
  // Connected, but the site didn't answer.
  document.getElementById('title').textContent = "Can't reach Ultra POS right now";
  document.getElementById('body').textContent =
    "This computer is online but the POS didn't answer. Please check the internet connection so Ultra POS can download your store's data.";
}
document.getElementById('where').textContent = [target, reason].filter(Boolean).join(' · ');

function retry() {
  if (/^https?:\/\//i.test(target)) location.replace(target);
}
document.getElementById('retry').addEventListener('click', retry);
window.addEventListener('online', () => setTimeout(retry, 1000));
// Some networks come back without an "online" event (router restarts).
setInterval(() => { if (navigator.onLine) retry(); }, 15000);
