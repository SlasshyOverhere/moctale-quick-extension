/**
 * Moctale Extension - Popup Script
 *
 * Handles UI logic and message passing to the background service worker.
 */

(function () {
  'use strict';

  // ============================================================================
  // Message Types
  // ============================================================================

  const MESSAGE_TYPES = {
    CHECK_SESSION: 'CHECK_SESSION',
    SEARCH_MOVIES: 'SEARCH_MOVIES',
    GET_MOVIE_DETAILS: 'GET_MOVIE_DETAILS',
    OPEN_LOGIN: 'OPEN_LOGIN',
    OPEN_MOCTALE: 'OPEN_MOCTALE',
    GET_PENDING_SEARCH: 'GET_PENDING_SEARCH',
    CLEAR_PENDING_SEARCH: 'CLEAR_PENDING_SEARCH'
  };

  // ============================================================================
  // State Management
  // ============================================================================

  const state = {
    isLoggedIn: false,
    username: null,
    searchQuery: '',
    searchResults: [],
    isSearching: false,
    error: null,
    lastSearchTime: 0
  };

  // Debounce timer
  let searchDebounceTimer = null;
  const DEBOUNCE_DELAY = 300;

  // ============================================================================
  // DOM Elements
  // ============================================================================

  const elements = {
    // States
    stateLoading: document.getElementById('state-loading'),
    stateNotLoggedIn: document.getElementById('state-not-logged-in'),
    stateNoTab: document.getElementById('state-no-tab'),
    stateLoggedIn: document.getElementById('state-logged-in'),

    // Buttons
    refreshBtn: document.getElementById('refresh-btn'),
    loginBtn: document.getElementById('login-btn'),
    openMoctaleBtn: document.getElementById('open-moctale-btn'),
    openTabBtn: document.getElementById('open-tab-btn'),
    retryBtn: document.getElementById('retry-btn'),
    clearSearch: document.getElementById('clear-search'),

    // Search
    searchInput: document.getElementById('search-input'),

    // Results
    resultsContainer: document.getElementById('results-container'),
    emptyState: document.getElementById('empty-state'),
    searchResults: document.getElementById('search-results'),
    searchingState: document.getElementById('searching-state'),
    noResults: document.getElementById('no-results'),
    errorState: document.getElementById('error-state'),
    errorMessage: document.getElementById('error-message'),

    // Footer
    footer: document.getElementById('footer'),
    userStatus: document.getElementById('user-status')
  };

  // ============================================================================
  // Utility Functions
  // ============================================================================

  /**
   * Send message to background service worker
   */
  async function sendMessage(type, data = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: 'COMMUNICATION_ERROR',
            message: chrome.runtime.lastError.message
          });
        } else {
          resolve(response || { success: false, error: 'NO_RESPONSE' });
        }
      });
    });
  }

  /**
   * Show a specific state and hide others
   */
  function showState(stateName) {
    const states = ['loading', 'not-logged-in', 'no-tab', 'logged-in'];

    states.forEach(name => {
      const element = document.getElementById(`state-${name}`);
      if (element) {
        element.classList.toggle('hidden', name !== stateName);
      }
    });

    // Show/hide footer based on state
    elements.footer.classList.toggle('hidden', stateName !== 'logged-in');
  }

  /**
   * Show a specific result state
   */
  function showResultState(stateName) {
    const resultStates = ['empty-state', 'search-results', 'searching-state', 'no-results', 'error-state'];

    resultStates.forEach(name => {
      const element = document.getElementById(name);
      if (element) {
        element.classList.toggle('hidden', name !== stateName);
      }
    });
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Format rating display
   */
  function formatRating(rating) {
    if (rating === null || rating === undefined) return null;
    const num = parseFloat(rating);
    if (isNaN(num)) return null;
    return num.toFixed(1);
  }

  // ============================================================================
  // UI Rendering
  // ============================================================================

  /**
   * Update user status in footer
   */
  function updateUserStatus() {
    if (state.isLoggedIn && state.username) {
      elements.userStatus.innerHTML = `<span class="dot"></span> Logged in as ${escapeHtml(state.username)}`;
    } else if (state.isLoggedIn) {
      elements.userStatus.innerHTML = `<span class="dot"></span> Connected to Moctale`;
    } else {
      elements.userStatus.textContent = 'Not connected';
    }
  }

  /**
   * Render movie card
   */
  function renderMovieCard(movie) {
    const rating = formatRating(movie.rating);
    const posterHtml = movie.poster
      ? `<img src="${escapeHtml(movie.poster)}" alt="${escapeHtml(movie.title)}" loading="lazy">`
      : `<div class="movie-poster-placeholder">M</div>`;

    const ratingHtml = rating
      ? `<div class="movie-rating">
           <span class="rating-star">★</span>
           <span class="rating-value">${rating}</span>
           ${movie.ratingCount ? `<span class="rating-count">(${movie.ratingCount})</span>` : ''}
         </div>`
      : '';

    const typeHtml = movie.type && movie.type !== 'movie'
      ? `<span class="movie-type-badge">${escapeHtml(movie.type)}</span>`
      : '';

    return `
      <div class="movie-card" data-movie-id="${escapeHtml(movie.id)}" data-url="${escapeHtml(movie.url || '')}">
        <div class="movie-poster">
          ${posterHtml}
        </div>
        <div class="movie-info">
          <div class="movie-title">${typeHtml}${escapeHtml(movie.title)}</div>
          ${movie.year ? `<div class="movie-year">${movie.year}</div>` : ''}
          ${ratingHtml}
          ${movie.summary ? `<div class="movie-summary">${escapeHtml(movie.summary)}</div>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render search results
   */
  function renderSearchResults() {
    if (state.isSearching) {
      showResultState('searching-state');
      return;
    }

    if (state.error) {
      elements.errorMessage.textContent = state.error;
      showResultState('error-state');
      return;
    }

    if (!state.searchQuery) {
      showResultState('empty-state');
      return;
    }

    if (state.searchResults.length === 0) {
      showResultState('no-results');
      return;
    }

    elements.searchResults.innerHTML = state.searchResults.map(renderMovieCard).join('');
    showResultState('search-results');

    // Add click handlers to movie cards
    elements.searchResults.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', () => handleMovieClick(card));
    });
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Handle session check
   */
  async function handleCheckSession() {
    showState('loading');

    const response = await sendMessage(MESSAGE_TYPES.CHECK_SESSION);

    if (!response.success) {
      if (response.error === 'NO_MOCTALE_TAB') {
        showState('no-tab');
      } else {
        state.error = response.message || 'Failed to connect';
        showState('not-logged-in');
      }
      return false;
    }

    state.isLoggedIn = response.isLoggedIn;
    state.username = response.username;

    if (state.isLoggedIn) {
      showState('logged-in');
      updateUserStatus();
      elements.searchInput.focus();
      return true;
    } else {
      showState('not-logged-in');
      return false;
    }
  }

  /**
   * Check for pending search from context menu
   */
  async function checkPendingSearch() {
    const response = await sendMessage(MESSAGE_TYPES.GET_PENDING_SEARCH);

    if (response.success && response.query) {
      // Clear the pending search
      await sendMessage(MESSAGE_TYPES.CLEAR_PENDING_SEARCH);

      // Set the search input and trigger search
      state.searchQuery = response.query;
      elements.searchInput.value = response.query;
      elements.clearSearch.classList.remove('hidden');

      // Perform the search
      performSearch(response.query);
    }
  }

  /**
   * Handle search input
   */
  function handleSearchInput(event) {
    const query = event.target.value;
    state.searchQuery = query;

    // Show/hide clear button
    elements.clearSearch.classList.toggle('hidden', query.length === 0);

    // Clear previous debounce
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
    }

    // If query is empty, show empty state
    if (!query.trim()) {
      state.searchResults = [];
      state.error = null;
      renderSearchResults();
      return;
    }

    // Debounce search
    searchDebounceTimer = setTimeout(() => {
      performSearch(query.trim());
    }, DEBOUNCE_DELAY);
  }

  /**
   * Perform search
   */
  async function performSearch(query) {
    if (!query) return;

    state.isSearching = true;
    state.error = null;
    renderSearchResults();

    const response = await sendMessage(MESSAGE_TYPES.SEARCH_MOVIES, { query });

    state.isSearching = false;

    if (response.success) {
      state.searchResults = response.results || [];
    } else {
      state.error = response.message || 'Search failed';
      state.searchResults = [];
    }

    renderSearchResults();
  }

  /**
   * Handle clear search
   */
  function handleClearSearch() {
    state.searchQuery = '';
    state.searchResults = [];
    state.error = null;
    elements.searchInput.value = '';
    elements.clearSearch.classList.add('hidden');
    renderSearchResults();
    elements.searchInput.focus();
  }

  /**
   * Handle movie card click
   */
  function handleMovieClick(card) {
    const url = card.dataset.url;
    if (url) {
      // Open movie page in new tab
      chrome.tabs.create({ url: `https://www.moctale.in${url}` });
    }
  }

  /**
   * Handle refresh button
   */
  async function handleRefresh() {
    elements.refreshBtn.classList.add('spinning');

    // Clear cache and re-check session
    state.searchResults = [];
    state.searchQuery = '';
    state.error = null;
    elements.searchInput.value = '';

    await handleCheckSession();

    elements.refreshBtn.classList.remove('spinning');
  }

  /**
   * Handle login button
   */
  async function handleLogin() {
    await sendMessage(MESSAGE_TYPES.OPEN_LOGIN);
    window.close();
  }

  /**
   * Handle open Moctale button
   */
  async function handleOpenMoctale() {
    await sendMessage(MESSAGE_TYPES.OPEN_MOCTALE);
    // Re-check session after a short delay
    setTimeout(() => handleCheckSession(), 500);
  }

  /**
   * Handle retry button
   */
  function handleRetry() {
    if (state.searchQuery) {
      performSearch(state.searchQuery);
    } else {
      handleCheckSession();
    }
  }

  /**
   * Handle keyboard shortcuts
   */
  function handleKeydown(event) {
    // Escape to clear search
    if (event.key === 'Escape' && state.searchQuery) {
      handleClearSearch();
    }

    // Enter to force search
    if (event.key === 'Enter' && state.searchQuery) {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
      }
      performSearch(state.searchQuery.trim());
    }
  }

  // ============================================================================
  // Event Listeners
  // ============================================================================

  function setupEventListeners() {
    // Buttons
    elements.refreshBtn.addEventListener('click', handleRefresh);
    elements.loginBtn.addEventListener('click', handleLogin);
    elements.openMoctaleBtn.addEventListener('click', handleOpenMoctale);
    elements.openTabBtn.addEventListener('click', handleOpenMoctale);
    elements.retryBtn.addEventListener('click', handleRetry);
    elements.clearSearch.addEventListener('click', handleClearSearch);

    // Search input
    elements.searchInput.addEventListener('input', handleSearchInput);
    elements.searchInput.addEventListener('keydown', handleKeydown);
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  async function init() {
    setupEventListeners();

    // Check session first
    const isLoggedIn = await handleCheckSession();

    // If logged in, check for pending search from context menu
    if (isLoggedIn) {
      await checkPendingSearch();
    }
  }

  // Start the app
  init();

})();
