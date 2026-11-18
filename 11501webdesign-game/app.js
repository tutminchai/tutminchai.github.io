const colors = ['#ccdcae', '#c2cee0', '#e7c39f', '#ccbfdf', '#e4d17e', '#9ac9be'];
const symbols = ['▟▙', '↗', '✦', '⌘', '◈', '▧'];
const filters = document.querySelector('#filters');
const search = document.querySelector('#search');
const ready = document.querySelector('#ready');
let students = [];
let selectedClass = '全部';

function escapeHtml(value) {
  const escapes = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
  return String(value ?? '').replace(/[&<>"']/g, char => escapes[char]);
}

function projectInfo(student) {
  const input = String(student.url ?? '').trim();
  if (!input) return {label: '待補作品', note: '尚未提供作品網址', kind: 'pending'};
  if (/^file:/i.test(input)) {
    return {label: '本機路徑', note: '作品尚待上傳至網路', kind: 'pending'};
  }
  const needsUrl = {label: '網址待確認', note: input, kind: 'pending'};
  if (!/^https?:\/\/[^\s]+$/i.test(input)) return needsUrl;
  try {
    const url = new URL(input);
    if (url.hostname === 'github.com') {
      return {label: '程式碼', note: url.pathname, kind: 'source', url: input.replace(/\.git$/, '')};
    }
    return {label: '網頁作品', note: url.hostname + url.pathname, kind: 'web', url: input};
  } catch {
    return needsUrl;
  }
}

function card(student) {
  const info = projectInfo(student);
  const index = Math.max(0, Number(student.n) - 1) % colors.length;
  const action = info.url
    ? `<a href="${escapeHtml(info.url)}" target="_blank" rel="noopener noreferrer">${info.kind === 'source' ? '查看程式碼' : '開啟作品'} <span>↗</span></a>`
    : '<span>等待作品上線</span>';
  return `<article class="card">
    <div class="cover" style="--tile:${colors[index]}" aria-hidden="true">
      <span class="number">PROJECT ${escapeHtml(String(student.n).padStart(2, '0'))}</span>
      <span class="symbol">${symbols[index]}</span>
      <span class="coverlabel">STUDENT CREATION</span>
    </div>
    <div class="body">
      <div class="meta"><span>班級　${escapeHtml(student.class)}</span>
        <span class="status ${info.kind === 'pending' ? 'warn' : ''}">${info.label}</span>
      </div>
      <h3>${escapeHtml(student.title || student.name + '的作品')}</h3>
      <p class="path" title="${escapeHtml(info.note)}">${escapeHtml(info.note)}</p>
      <div class="cardfoot"><div class="author-details"><span>作者　${escapeHtml(student.name)}</span><span>學號　${escapeHtml(student.studentId)}</span></div>${action}</div>
    </div>
  </article>`;
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function render() {
  const query = normalized(search.value);
  const visible = students.filter(student => {
    if (selectedClass !== '全部' && student.class !== selectedClass) return false;
    if (ready.checked && projectInfo(student).kind !== 'web') return false;
    return [student.title, student.name, student.studentId, student.class, student.url]
      .some(value => normalized(value).includes(query));
  });
  document.querySelector('#count').textContent = `顯示 ${visible.length} / ${students.length} 位同學`;
  document.querySelector('#empty').hidden = visible.length > 0;
  document.querySelector('#cards').innerHTML = visible.map(card).join('');
}

function updateClassFilter(value) {
  selectedClass = value;
  for (const button of filters.querySelectorAll('button')) {
    const active = button.dataset.class === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  render();
}

async function initialize() {
  const response = await fetch('data.json');
  if (!response.ok) throw Error('作品資料載入失敗');
  students = await response.json();
  document.querySelector('#total').textContent = students.length;
  document.querySelector('#links').textContent = students.filter(s => projectInfo(s).kind === 'web').length;
  for (const label of ['全部', ...new Set(students.map(s => s.class))]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.dataset.class = label;
    button.addEventListener('click', () => updateClassFilter(label));
    filters.append(button);
  }
  updateClassFilter('全部');
}

search.addEventListener('input', render);
ready.addEventListener('change', render);
document.querySelector('#reset').addEventListener('click', () => {
  search.value = '';
  ready.checked = false;
  updateClassFilter('全部');
});
initialize().catch(() => {
  document.querySelector('#cards').textContent = '作品資料暫時無法載入，請重新整理頁面。';
});
