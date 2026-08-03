(function () {
  "use strict";

  const data = window.AJUSTCAM_HELP;
  if (!data) return;

  const elements = {
    navigation: document.getElementById("help-navigation"),
    article: document.getElementById("article"),
    breadcrumbs: document.getElementById("breadcrumbs"),
    related: document.getElementById("related-content"),
    pageIndex: document.getElementById("page-index"),
    search: document.getElementById("help-search"),
    searchResults: document.getElementById("search-results"),
    menuToggle: document.getElementById("menu-toggle"),
    backdrop: document.getElementById("sidebar-backdrop"),
    main: document.getElementById("main-content"),
    progress: document.getElementById("reading-progress"),
    copyLink: document.getElementById("copy-link"),
    print: document.getElementById("print-button"),
    toast: document.getElementById("toast")
  };

  const icons = {
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.5 2.5 0 1 1 3.6 2.2c-.9.5-1.4 1-1.4 2M12 17h.01"/>'
  };

  const articles = [];
  data.categories.forEach((category) => {
    category.articles.forEach((article) => articles.push({ ...article, category }));
  });

  const articleById = new Map(articles.map((article) => [article.id, article]));

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function textOnly(html) {
    const node = document.createElement("div");
    node.innerHTML = html;
    return node.textContent || "";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderNavigation() {
    elements.navigation.innerHTML = data.categories
      .map(
        (category) => `
          <section class="nav-group">
            <h2 class="nav-group-title">
              <svg viewBox="0 0 24 24" aria-hidden="true">${icons[category.icon] || icons.help}</svg>
              ${escapeHtml(category.title)}
            </h2>
            ${category.articles
              .map(
                (article) =>
                  `<a class="nav-link" href="#${encodeURIComponent(article.id)}" data-article="${escapeHtml(article.id)}">${escapeHtml(article.title)}</a>`
              )
              .join("")}
          </section>`
      )
      .join("");
  }

  function currentArticleId() {
    const requested = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    return articleById.has(requested) ? requested : "inicio";
  }

  function sectionId(title, index) {
    const base = normalize(title)
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    return `${base || "secao"}-${index + 1}`;
  }

  function renderArticle(article, shouldFocus) {
    document.title = `${article.title} — Central de Ajuda AjustCam`;
    elements.article.innerHTML = `
      <header class="article-header">
        <p class="article-kicker">${escapeHtml(article.category.title)}</p>
        <h1>${escapeHtml(article.title)}</h1>
        <p class="article-lead">${escapeHtml(article.summary)}</p>
        <div class="article-meta">
          ${article.roles.map((role) => `<span class="meta-chip">${escapeHtml(role)}</span>`).join("")}
          <span class="meta-chip">Leitura: ${escapeHtml(article.time)}</span>
          <span class="meta-chip">Atualizado em ${escapeHtml(data.updatedAt)}</span>
        </div>
      </header>
      <div class="article-body">${article.body}</div>`;

    elements.breadcrumbs.innerHTML = `
      <a href="#inicio">Central de Ajuda</a>
      <span aria-hidden="true">/</span>
      <span>${escapeHtml(article.category.title)}</span>
      <span aria-hidden="true">/</span>
      <span aria-current="page">${escapeHtml(article.title)}</span>`;

    document.querySelectorAll(".nav-link").forEach((link) => {
      const isActive = link.dataset.article === article.id;
      link.classList.toggle("active", isActive);
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    renderPageIndex();
    renderRelated(article);
    closeMenu();
    closeSearch();
    window.scrollTo({ top: 0, behavior: shouldFocus ? "auto" : "smooth" });
    if (shouldFocus) elements.main.focus({ preventScroll: true });
    updateProgress();
  }

  function renderPageIndex() {
    const headings = [...elements.article.querySelectorAll(".article-body h2, .article-body h3")];
    headings.forEach((heading, index) => {
      if (!heading.id) heading.id = sectionId(heading.textContent, index);
    });
    if (!headings.length) {
      elements.pageIndex.innerHTML = "";
      return;
    }
    elements.pageIndex.innerHTML = `
      <p class="page-index-title">Nesta página</p>
      ${headings
        .map(
          (heading) =>
            `<a class="${heading.tagName === "H3" ? "sub" : ""}" href="#${currentArticleId()}?secao=${encodeURIComponent(heading.id)}" data-section="${escapeHtml(heading.id)}">${escapeHtml(heading.textContent)}</a>`
        )
        .join("")}`;
  }

  function renderRelated(article) {
    const related = (article.related || [])
      .map((id) => articleById.get(id))
      .filter(Boolean)
      .slice(0, 4);
    if (!related.length) {
      elements.related.innerHTML = "";
      return;
    }
    elements.related.innerHTML = `
      <h2>Continue por aqui</h2>
      <div class="related-grid">
        ${related
          .map(
            (item) => `
              <a class="related-card" href="#${encodeURIComponent(item.id)}">
                <strong>${escapeHtml(item.title)}</strong>
                <small>${escapeHtml(item.summary)}</small>
              </a>`
          )
          .join("")}
      </div>`;
  }

  function route(shouldFocus) {
    const raw = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    const [id, query] = raw.split("?");
    const article = articleById.get(id) || articleById.get("inicio");
    renderArticle(article, shouldFocus);
    if (query) {
      const section = new URLSearchParams(query).get("secao");
      if (section) {
        window.requestAnimationFrame(() => {
          const target = document.getElementById(section);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    }
  }

  function search(query) {
    const term = normalize(query.trim());
    if (!term) {
      closeSearch();
      return;
    }
    const terms = term.split(/\s+/).filter(Boolean);
    const matches = articles
      .map((article) => {
        const title = normalize(article.title);
        const haystack = normalize(`${article.title} ${article.summary} ${article.keywords} ${textOnly(article.body)}`);
        if (!terms.every((part) => haystack.includes(part))) return null;
        let score = terms.reduce((sum, part) => sum + (title.includes(part) ? 5 : 1), 0);
        if (title.startsWith(term)) score += 4;
        return { article, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 9);

    elements.searchResults.hidden = false;
    elements.searchResults.innerHTML = matches.length
      ? matches
          .map(
            ({ article }) => `
              <a class="search-result" href="#${encodeURIComponent(article.id)}">
                <strong>${escapeHtml(article.title)}</strong>
                <small>${escapeHtml(article.category.title)} · ${escapeHtml(article.summary)}</small>
              </a>`
          )
          .join("")
      : '<div class="search-empty">Nenhum conteúdo encontrado.<br>Tente palavras mais simples.</div>';
  }

  function closeSearch() {
    elements.searchResults.hidden = true;
  }

  function openMenu() {
    document.body.classList.add("menu-open");
    elements.menuToggle.setAttribute("aria-expanded", "true");
    elements.menuToggle.setAttribute("aria-label", "Fechar menu");
  }

  function closeMenu() {
    document.body.classList.remove("menu-open");
    elements.menuToggle.setAttribute("aria-expanded", "false");
    elements.menuToggle.setAttribute("aria-label", "Abrir menu");
  }

  function updateProgress() {
    const articleTop = elements.article.offsetTop;
    const articleHeight = Math.max(elements.article.offsetHeight - window.innerHeight + 120, 1);
    const value = Math.max(0, Math.min(1, (window.scrollY - articleTop + 100) / articleHeight));
    elements.progress.style.width = `${value * 100}%`;
  }

  let toastTimer;
  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 2200);
  }

  async function copyCurrentLink() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copiado.");
    } catch (_) {
      const field = document.createElement("textarea");
      field.value = url;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      field.remove();
      showToast("Link copiado.");
    }
  }

  renderNavigation();
  route(false);

  window.addEventListener("hashchange", () => route(true));
  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", () => {
    updateProgress();
    if (window.innerWidth > 820) closeMenu();
  });

  elements.search.addEventListener("input", (event) => search(event.target.value));
  elements.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      elements.search.value = "";
      closeSearch();
      elements.search.blur();
    }
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    if (event.key === "/" && !isTyping) {
      event.preventDefault();
      elements.search.focus();
    }
    if (event.key === "Escape") closeMenu();
  });
  document.addEventListener("click", (event) => {
    if (!elements.searchResults.contains(event.target) && event.target !== elements.search) closeSearch();
  });
  elements.pageIndex.addEventListener("click", (event) => {
    const link = event.target.closest("[data-section]");
    if (!link) return;
    event.preventDefault();
    const section = document.getElementById(link.dataset.section);
    if (section) {
      history.replaceState(null, "", link.href);
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  elements.menuToggle.addEventListener("click", () => {
    if (document.body.classList.contains("menu-open")) closeMenu();
    else openMenu();
  });
  elements.backdrop.addEventListener("click", closeMenu);
  elements.copyLink.addEventListener("click", copyCurrentLink);
  elements.print.addEventListener("click", () => window.print());
})();
