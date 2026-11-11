(() => {
  'use strict';

  const STATE_PREFIX = 'certlab-progress-v1:';
  const PAGE_SIZE = 35;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const manifest = [
    { code: 'CCA-F', title: 'Claude Certified Architect · Foundations', category: 'Kiến trúc · Cơ bản', count: 309 },
    { code: 'CCAO-F', title: 'Claude Certified Associate · Foundations', category: 'Kiến thức tổng quan · Cơ bản', count: 193 },
    { code: 'CCAR-P', title: 'Claude Certified Architect · Professional', category: 'Kiến trúc · Chuyên sâu', count: 160 },
    { code: 'CCD-F', title: 'Claude Certified Developer · Foundations', category: 'Phát triển · Cơ bản', count: 155 },
  ];
  let exam = null;
  let questions = [];
  let progress = { current: 0, items: {} };
  let filter = 'all';
  let mapPage = 0;
  let inlineError = '';
  let encryptionKey = null;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function fromBase64(value) {
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
  }

  async function deriveKey(password, config) {
    const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(config.salt), iterations: config.iterations },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  }
  async function decryptBlob(blob, key) {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(blob.iv) }, key, fromBase64(blob.ciphertext));
    return new TextDecoder().decode(bytes);
  }
  function isAuthenticated() { return !!encryptionKey; }
  function showAuth() {
    $('#login-screen').hidden = false;
    $('#app-screen').hidden = true;
    $('#password').value = '';
  }
  function showApp() {
    $('#login-screen').hidden = true;
    $('#app-screen').hidden = false;
    renderDashboard();
    const code = location.hash.slice(1);
    if (manifest.some(item => item.code === code)) openExam(code);
  }

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    const error = $('#login-error');
    let valid = false;
    if (username === 'admin' && password) try {
      const configResponse = await fetch('data/config.json');
      const checkResponse = await fetch('data/check.enc.json');
      if (!configResponse.ok || !checkResponse.ok) throw new Error('network');
      const config = await configResponse.json();
      const candidateKey = await deriveKey(password, config);
      valid = await decryptBlob(await checkResponse.json(), candidateKey) === 'certlab-v1-auth';
      if (valid) encryptionKey = candidateKey;
    } catch (failure) {
      if (failure.message === 'network') {
        error.textContent = 'Không tải được dữ liệu mã hóa. Kiểm tra kết nối rồi thử lại.';
        error.hidden = false;
        return;
      }
    }
    if (!valid) {
      error.textContent = 'Tên đăng nhập hoặc mật khẩu không đúng.';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    $('#password').value = '';
    showApp();
  });
  $('#logout-button').addEventListener('click', () => {
    encryptionKey = null;
    exam = null;
    location.hash = '';
    showAuth();
  });
  $('#home-link').addEventListener('click', closeExam);
  $('#back-button').addEventListener('click', closeExam);

  function readProgress(code) {
    try {
      const value = JSON.parse(localStorage.getItem(STATE_PREFIX + code) || '{}');
      return { current: Number.isInteger(value.current) ? value.current : 0, items: value.items && typeof value.items === 'object' ? value.items : {} };
    } catch { return { current: 0, items: {} }; }
  }
  function saveProgress() {
    try { localStorage.setItem(STATE_PREFIX + exam.code, JSON.stringify(progress)); }
    catch { inlineError = 'Không lưu được tiến độ trên trình duyệt này.'; }
  }
  function item(index) { return progress.items[questions[index].id] || {}; }
  function selected(index) { return Array.isArray(item(index).selected) ? item(index).selected : []; }
  function checked(index) { return !!item(index).checked; }
  function correct(index) {
    const a = selected(index);
    const b = questions[index].correct;
    return a.length === b.length && a.every(value => b.includes(value));
  }
  function stats() {
    let answered = 0, right = 0, wrong = 0, flagged = 0;
    questions.forEach((_, index) => {
      if (selected(index).length) answered++;
      if (checked(index)) correct(index) ? right++ : wrong++;
      if (item(index).flagged) flagged++;
    });
    return { answered, right, wrong, flagged, unanswered: questions.length - answered };
  }

  function renderDashboard() {
    $('#exam-list').innerHTML = manifest.map(entry => {
      const stored = readProgress(entry.code);
      const done = Object.values(stored.items).filter(value => Array.isArray(value.selected) && value.selected.length).length;
      const percent = Math.round(done * 100 / entry.count);
      return `<article class="exam-card"><div class="exam-card-top"><span class="exam-code">${entry.code}</span><span class="exam-count">${entry.count} câu hỏi</span></div><h2>${escapeHtml(entry.title)}</h2><p>${escapeHtml(entry.category)}</p><div class="exam-card-bottom"><div class="exam-progress"><div class="exam-progress-label"><span>Tiến độ</span><strong>${percent}%</strong></div><div class="exam-progress-track"><div style="width:${percent}%"></div></div></div><button class="card-open" type="button" data-open-exam="${entry.code}">${done ? 'Tiếp tục' : 'Bắt đầu'} →</button></div></article>`;
    }).join('');
  }
  $('#exam-list').addEventListener('click', event => {
    const button = event.target.closest('[data-open-exam]');
    if (button) openExam(button.dataset.openExam);
  });

  async function openExam(code) {
    if (!isAuthenticated()) return showAuth();
    const found = manifest.find(entry => entry.code === code);
    if (!found) return;
    exam = found;
    questions = [];
    $('#dashboard').hidden = true;
    $('#practice').hidden = false;
    $('#practice-title').textContent = found.title;
    $('#practice-category').textContent = found.category.toUpperCase();
    $('#question-panel').innerHTML = '<div class="question-card loading">Đang tải bộ câu hỏi…</div>';
    location.hash = code;
    try {
      const response = await fetch(`data/${encodeURIComponent(code)}.enc.json`);
      if (!response.ok) throw new Error('load');
      const loaded = JSON.parse(await decryptBlob(await response.json(), encryptionKey));
      if (exam.code !== code) return;
      questions = loaded;
      progress = readProgress(code);
      progress.current = Math.min(Math.max(progress.current, 0), questions.length - 1);
      filter = 'all';
      mapPage = Math.floor(progress.current / PAGE_SIZE);
      inlineError = '';
      renderPractice();
    } catch {
      $('#question-panel').innerHTML = '<div class="question-card empty"><h2>Không tải được bộ đề</h2><p>Kiểm tra kết nối rồi thử lại.</p><button class="button primary" type="button" id="retry-load">Thử lại</button></div>';
      $('#retry-load').addEventListener('click', () => openExam(code));
    }
  }
  function closeExam() {
    exam = null;
    questions = [];
    location.hash = '';
    $('#practice').hidden = true;
    $('#dashboard').hidden = false;
    renderDashboard();
  }
  window.addEventListener('hashchange', () => {
    if (!isAuthenticated()) return;
    const code = location.hash.slice(1);
    if (!code && exam) closeExam();
    else if (manifest.some(entry => entry.code === code) && exam?.code !== code) openExam(code);
  });

  function visibleIndices() {
    return questions.map((_, index) => index).filter(index => {
      if (filter === 'incorrect') return checked(index) && !correct(index);
      if (filter === 'flagged') return !!item(index).flagged;
      if (filter === 'unanswered') return !selected(index).length;
      return true;
    });
  }
  function renderPractice() {
    if (!questions.length) return;
    const summary = stats();
    $('#answered-count').textContent = summary.answered;
    $('#total-count').textContent = questions.length;
    $('#correct-count').textContent = summary.right;
    $('#incorrect-count').textContent = summary.wrong;
    $('#progress-fill').style.width = `${summary.answered * 100 / questions.length}%`;
    $('#map-total').textContent = `${questions.length} câu hỏi`;
    $('#filter-all-count').textContent = questions.length;
    $('#filter-incorrect-count').textContent = summary.wrong;
    $('#filter-flagged-count').textContent = summary.flagged;
    $('#filter-unanswered-count').textContent = summary.unanswered;
    $$('.filters [data-filter]').forEach(button => { button.classList.toggle('active', button.dataset.filter === filter); button.setAttribute('aria-pressed', button.dataset.filter === filter); });
    renderMap();
    renderQuestion();
  }
  function renderMap() {
    const indices = visibleIndices();
    const pageCount = Math.max(1, Math.ceil(indices.length / PAGE_SIZE));
    mapPage = Math.min(Math.max(mapPage, 0), pageCount - 1);
    $('#map-status').textContent = `Hiển thị ${indices.length}/${questions.length} câu`;
    $('#map-page').textContent = `${mapPage + 1} / ${pageCount}`;
    $('#map-prev').disabled = mapPage === 0;
    $('#map-next').disabled = mapPage === pageCount - 1;
    $('#question-map').innerHTML = indices.length ? indices.slice(mapPage * PAGE_SIZE, (mapPage + 1) * PAGE_SIZE).map(index => {
      const classes = [index === progress.current ? 'current' : '', checked(index) ? (correct(index) ? 'correct' : 'incorrect') : selected(index).length ? 'answered' : '', item(index).flagged ? 'flagged' : ''].join(' ');
      return `<button type="button" data-index="${index}" class="${classes}" aria-label="Câu ${index + 1}${checked(index) ? correct(index) ? ', đúng' : ', sai' : selected(index).length ? ', đã chọn' : ', chưa trả lời'}" aria-current="${index === progress.current ? 'step' : 'false'}">${index + 1}</button>`;
    }).join('') : '<p class="empty-map">Không có câu phù hợp.</p>';
  }
  function renderQuestion() {
    const index = progress.current;
    const question = questions[index];
    const values = selected(index);
    const result = checked(index);
    const isRight = result && correct(index);
    const rightLabels = question.correct.map(key => question.options.find(option => option.key === key)?.number).join(', ');
    let glossaryHtml = '';
    if (result && window.CertLabVocabulary) {
      const asText = html => new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
      const promptText = asText(question.prompt);
      const optionText = [...question.options.map(option => asText(option.html)), asText(question.explanation)].join(' ');
      const terms = window.CertLabVocabulary.find(promptText, optionText);
      const meaning = window.CertLabVocabulary.intent(promptText, question.correct.length);
      glossaryHtml = `<section class="vocabulary" aria-label="Giải nghĩa từ vựng"><div class="vocabulary-heading"><h3>Từ vựng & cách hiểu câu hỏi</h3><span>EN → VI</span></div><p class="question-intent"><strong>Ý câu hỏi:</strong> ${escapeHtml(meaning)}</p><p class="vocabulary-intro">Những từ và cụm từ này xuất hiện trong câu hỏi, lựa chọn hoặc lời giải:</p><dl class="vocabulary-list">${terms.map(entry => `<div class="vocabulary-item"><dt>${escapeHtml(entry.term)}</dt><dd>${escapeHtml(entry.meaning)}</dd></div>`).join('')}</dl></section>`;
    }
    $('#question-panel').innerHTML = `<article class="question-card"><div class="question-top"><span class="question-kind">${question.limit > 1 ? `Chọn tối đa ${question.limit} đáp án` : 'Chọn một đáp án'}</span><div class="question-tools"><button class="tool-button ${item(index).flagged ? 'flagged' : ''}" id="flag-button" type="button">${item(index).flagged ? '⚑ Bỏ đánh dấu' : '⚑ Đánh dấu'}</button><button class="tool-button" id="reset-question" type="button">↺ Làm lại câu này</button></div></div><div class="question-title-row"><span class="question-number">${index + 1}</span><div class="rich-text">${question.prompt}</div></div><p class="selection-hint">${result ? 'Đã kiểm tra đáp án' : question.limit > 1 ? `Chọn ${question.correct.length} đáp án phù hợp · Đã chọn ${values.length}/${question.limit}` : 'Chọn 1 đáp án rồi kiểm tra'}</p><div class="options" role="group" aria-label="Các lựa chọn">${question.options.map(option => {
      const chosen = values.includes(option.key);
      const good = result && question.correct.includes(option.key);
      const bad = result && chosen && !good;
      const status = good ? 'Đúng' : bad ? 'Sai' : '';
      return `<button type="button" class="option ${question.limit > 1 ? 'multi' : ''} ${chosen ? 'selected' : ''} ${good ? 'correct' : ''} ${bad ? 'wrong' : ''}" data-option="${option.key}" aria-pressed="${chosen}" ${result ? 'disabled' : ''}><span class="option-marker">${chosen || good ? '✓' : ''}</span><span class="option-index">${option.number}</span><span class="option-content rich-text">${option.html}</span><span class="option-status">${status}</span></button>`;
    }).join('')}</div>${result ? `<div class="feedback ${isRight ? '' : 'wrong'}" role="status"><strong>${isRight ? '✓ Chính xác!' : '✕ Chưa đúng.'}</strong><div class="feedback-answer">Đáp án đúng: ${rightLabels}</div><div class="rich-text">${question.explanation}</div></div>` : ''}${glossaryHtml}${inlineError ? `<p class="inline-error" role="alert">${escapeHtml(inlineError)}</p>` : ''}<div class="question-actions"><button id="previous-button" class="button subtle" type="button" ${index === 0 ? 'disabled' : ''}>← Câu trước</button><div class="action-right">${result ? `<button id="next-button" class="button primary" type="button" ${index === questions.length - 1 ? 'disabled' : ''}>Câu tiếp theo →</button>` : `<button id="check-button" class="button primary" type="button">Kiểm tra đáp án</button>`}</div></div></article>`;
  }
  function updateItem(patch) {
    const id = questions[progress.current].id;
    progress.items[id] = { ...item(progress.current), ...patch };
    saveProgress();
    renderPractice();
  }
  function moveTo(index) {
    if (index < 0 || index >= questions.length) return;
    progress.current = index;
    if (filter === 'all') mapPage = Math.floor(index / PAGE_SIZE);
    else mapPage = Math.floor(visibleIndices().indexOf(index) / PAGE_SIZE);
    inlineError = '';
    saveProgress();
    renderPractice();
    $('#question-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#question-panel').addEventListener('click', event => {
    const option = event.target.closest('[data-option]');
    if (option && !checked(progress.current)) {
      const value = option.dataset.option;
      const old = selected(progress.current);
      const limit = questions[progress.current].limit;
      let next;
      if (limit === 1) next = [value];
      else if (old.includes(value)) next = old.filter(item => item !== value);
      else if (old.length < limit) next = [...old, value];
      else { inlineError = `Chỉ chọn tối đa ${limit} đáp án. Bỏ một lựa chọn trước khi chọn đáp án khác.`; renderQuestion(); return; }
      inlineError = '';
      updateItem({ selected: next });
      return;
    }
    if (event.target.closest('#check-button')) {
      if (!selected(progress.current).length) { inlineError = 'Hãy chọn ít nhất một đáp án trước khi kiểm tra.'; renderQuestion(); return; }
      inlineError = '';
      updateItem({ checked: true });
      return;
    }
    if (event.target.closest('#reset-question')) {
      delete progress.items[questions[progress.current].id];
      inlineError = '';
      saveProgress();
      renderPractice();
      return;
    }
    if (event.target.closest('#flag-button')) { updateItem({ flagged: !item(progress.current).flagged }); return; }
    if (event.target.closest('#previous-button')) moveTo(progress.current - 1);
    if (event.target.closest('#next-button')) moveTo(progress.current + 1);
  });
  $('#question-map').addEventListener('click', event => {
    const button = event.target.closest('[data-index]');
    if (button) moveTo(Number(button.dataset.index));
  });
  $$('.filters [data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; mapPage = 0; renderPractice(); }));
  $('#map-prev').addEventListener('click', () => { mapPage--; renderMap(); });
  $('#map-next').addEventListener('click', () => { mapPage++; renderMap(); });
  $('#reset-all-button').addEventListener('click', () => {
    if (!exam || !confirm(`Đặt lại toàn bộ ${questions.length} câu trong bộ đề này? Mọi lựa chọn, kết quả và đánh dấu sẽ bị xóa.`)) return;
    progress = { current: 0, items: {} };
    filter = 'all';
    mapPage = 0;
    inlineError = '';
    saveProgress();
    renderPractice();
  });

  showAuth();
})();
