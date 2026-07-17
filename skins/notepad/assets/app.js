// notepad skin client JS: theme toggle + code copy buttons + live search box
// (calls the engine's /search JSON API). Ported verbatim from v1.
(function () {
  var root = document.documentElement;
  var stored = localStorage.getItem('theme');
  if (stored) root.setAttribute('data-theme', stored);
  var toggle = document.getElementById('themeToggle');
  if (toggle) toggle.addEventListener('click', function () {
    var current = root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  });
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var pre = btn.closest('.code-block').querySelector('pre.shiki');
      if (navigator.clipboard && pre) navigator.clipboard.writeText(pre.textContent).catch(function () {});
      var svg = btn.querySelector('svg');
      var original = svg.innerHTML;
      svg.innerHTML = '<path d="M20 6L9 17l-5-5"/>';
      setTimeout(function () { svg.innerHTML = original; }, 1200);
    });
  });
  var searchInput = document.getElementById('search');
  var resultsBox = document.getElementById('searchResults');
  if (searchInput && resultsBox) {
    var timer = null;
    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function run(term) {
      fetch('/search?q=' + encodeURIComponent(term)).then(function (r) { return r.json(); }).then(function (items) {
        if (searchInput.value.trim() !== term) return; // stale
        resultsBox.hidden = false;
        if (!items.length) {
          resultsBox.innerHTML = '<div class="search-empty">No results for &ldquo;' + escapeHtml(term) + '&rdquo;</div>';
          return;
        }
        resultsBox.innerHTML = items.map(function (item) {
          return '<a class="search-result" href="' + escapeHtml(item.url) + '">' +
            '<span class="search-result-title">' + escapeHtml(item.title || item.url) + '</span>' +
            // excerpt is server-built: text escaped, matches wrapped in <mark>.
            '<span class="search-result-excerpt">' + item.excerpt + '</span>' +
            '</a>';
        }).join('');
      }).catch(function (e) { console.error('Search failed', e); });
    }
    searchInput.addEventListener('input', function () {
      var term = searchInput.value.trim();
      if (timer) clearTimeout(timer);
      if (!term) { resultsBox.hidden = true; resultsBox.innerHTML = ''; return; }
      timer = setTimeout(function () { run(term); }, 120);
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.widget')) resultsBox.hidden = true;
    });
  }
})();
