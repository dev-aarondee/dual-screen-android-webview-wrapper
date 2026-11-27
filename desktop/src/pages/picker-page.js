'use strict';
let done = false;
function finish(id) {
  if (done) return;
  done = true;
  window.ultrapos.invoke('picker:done', id).finally(() => window.close());
}

async function init() {
  const { title, items } = await window.ultrapos.invoke('picker:get');
  document.getElementById('title').textContent = title;
  document.title = title;
  const list = document.getElementById('list');
  for (const item of items) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.label;
    if (item.detail) {
      const small = document.createElement('small');
      small.textContent = item.detail;
      b.appendChild(small);
    }
    b.addEventListener('click', () => finish(item.id));
    li.appendChild(b);
    list.appendChild(li);
  }
  const first = list.querySelector('button');
  if (first) first.focus();
}

document.getElementById('cancel').addEventListener('click', () => finish(null));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
init();
