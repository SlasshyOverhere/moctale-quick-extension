/**
 * Moctale Extension - Content Script
 *
 * Responsibilities:
 * - Detect authentication state
 * - Execute fetch() calls with session cookies
 * - DOM scraping fallback
 * - CSRF token extraction if needed
 *
 * This script runs in the context of moctale.in pages,
 * which means fetch() calls automatically include session cookies.
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__MOCTALE_EXTENSION_INJECTED__) {
    return;
  }
  window.__MOCTALE_EXTENSION_INJECTED__ = true;

  // ============================================================================
  // Configuration
  // ============================================================================

  const CONFIG = {
    // Selectors for detecting logged-in state
    authSelectors: {
      // User avatar/profile indicators on moctale.in
      userAvatar: 'img[alt*="avatar"], img[alt*="profile"], [class*="avatar"]',
      userMenu: '[aria-label*="account"], [aria-label*="profile"], [class*="user-menu"]',
      logoutButton: 'button[aria-label*="logout"], a[href*="logout"]',
      profileLink: 'a[href*="/u/"], a[href*="/my-"]'
    },

    // API endpoints (discovered from network analysis)
    api: {
      search: '/api/search',           // GET /api/search?q={query}&page={page}
      content: '/api/content',         // GET /api/content/{slug}
      me: '/api/me'                    // GET /api/me (for auth check)
    },

    // Auth cookie name
    authCookie: 'auth_token',

    // Request configuration
    request: {
      timeout: 10000,
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json'
      }
    }
  };

  // ============================================================================
  // Utility Functions
  // ============================================================================

  /**
   * Make a fetch request with timeout
   */
  async function fetchWithTimeout(url, options = {}, timeout = CONFIG.request.timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        credentials: 'include' // Ensure cookies are sent
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Extract CSRF token from the page if present
   */
  function extractCSRFToken() {
    // Check meta tags
    const metaToken = document.querySelector('meta[name="csrf-token"]')?.content ||
      document.querySelector('meta[name="_csrf"]')?.content ||
      document.querySelector('meta[name="csrf"]')?.content;

    if (metaToken) return metaToken;

    // Check for token in script tags (Next.js often embeds data)
    const scripts = document.querySelectorAll('script[id="__NEXT_DATA__"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data?.props?.csrfToken) return data.props.csrfToken;
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Check window object
    if (window.__NEXT_DATA__?.props?.csrfToken) {
      return window.__NEXT_DATA__.props.csrfToken;
    }

    return null;
  }

  /**
   * Get headers for API requests
   */
  function getRequestHeaders() {
    const headers = { ...CONFIG.request.headers };

    const csrfToken = extractCSRFToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
      headers['csrf-token'] = csrfToken;
    }

    return headers;
  }

  // ============================================================================
  // Authentication Detection
  // ============================================================================

  /**
   * Check if auth_token cookie exists
   */
  function checkAuthFromCookie() {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const [name, value] = cookie.trim().split('=');
      if (name === CONFIG.authCookie && value) {
        return {
          isLoggedIn: true,
          username: null, // Cookie doesn't contain username
          method: 'cookie',
          indicator: 'auth_token'
        };
      }
    }
    return null;
  }

  /**
   * Check if user is logged in by examining DOM elements
   */
  function checkAuthFromDOM() {
    const selectors = CONFIG.authSelectors;

    // Check for any logged-in indicators
    for (const [key, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (element) {
        // Try to extract username
        let username = null;

        if (key === 'userAvatar') {
          username = element.alt || element.title || null;
        } else if (key === 'profileLink') {
          const href = element.getAttribute('href');
          if (href) {
            const match = href.match(/\/u\/([^\/]+)/);
            username = match ? match[1] : null;
          }
        }

        return {
          isLoggedIn: true,
          username,
          method: 'dom',
          indicator: key
        };
      }
    }

    // Check if we're on the login page (means not logged in)
    if (window.location.pathname === '/login' || window.location.pathname === '/signup') {
      return {
        isLoggedIn: false,
        username: null,
        method: 'dom',
        indicator: 'login_page'
      };
    }

    // Unable to determine from DOM alone
    return null;
  }

  /**
   * Check authentication by making an API call
   */
  async function checkAuthFromAPI() {
    try {
      // Try to fetch user profile or a protected endpoint
      const response = await fetchWithTimeout('/api/me', {
        method: 'GET',
        headers: getRequestHeaders()
      });

      if (response.ok) {
        const data = await response.json();
        return {
          isLoggedIn: true,
          username: data.username || data.name || data.user?.username || null,
          method: 'api',
          userData: data
        };
      } else if (response.status === 401 || response.status === 403) {
        return {
          isLoggedIn: false,
          username: null,
          method: 'api',
          indicator: 'unauthorized'
        };
      }
    } catch (error) {
      console.warn('Auth API check failed:', error.message);
    }

    return null;
  }

  /**
   * Main authentication check
   */
  async function checkAuth() {
    // First check for auth_token cookie (fastest, most reliable)
    const cookieResult = checkAuthFromCookie();
    if (cookieResult !== null) {
      return {
        success: true,
        ...cookieResult
      };
    }

    // Then try DOM-based detection
    const domResult = checkAuthFromDOM();
    if (domResult !== null) {
      return {
        success: true,
        ...domResult
      };
    }

    // Fall back to API-based detection
    const apiResult = await checkAuthFromAPI();
    if (apiResult !== null) {
      return {
        success: true,
        ...apiResult
      };
    }

    // No auth_token cookie found - user is not logged in
    return {
      success: true,
      isLoggedIn: false,
      username: null,
      method: 'cookie',
      message: 'No auth_token cookie found. Please log in.'
    };
  }

  // ============================================================================
  // Search Functionality
  // ============================================================================

  /**
   * Search for movies via Moctale API
   * API: GET /api/search?q={query}&page={page}
   * Response: { total_pages, current_page, next_page, previous_page, count, data: [...] }
   */
  async function searchViaAPI(query, page = 1) {
    try {
      const endpoint = `${CONFIG.api.search}?q=${encodeURIComponent(query)}&page=${page}`;

      const response = await fetchWithTimeout(endpoint, {
        method: 'GET',
        headers: getRequestHeaders()
      });

      if (response.ok) {
        const data = await response.json();

        // Moctale API response format:
        // { total_pages, current_page, next_page, previous_page, count, data: [...] }
        const results = data.data || [];

        return {
          success: true,
          method: 'api',
          endpoint,
          results: results.map(normalizeMovieData),
          pagination: {
            totalPages: data.total_pages || 1,
            currentPage: data.current_page || 1,
            nextPage: data.next_page,
            previousPage: data.previous_page,
            count: data.count || results.length
          }
        };
      } else if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Session expired. Please log in again.'
        };
      } else {
        return {
          success: false,
          error: 'API_ERROR',
          message: `Search failed with status ${response.status}`
        };
      }
    } catch (error) {
      console.warn('API search failed:', error.message);
      return {
        success: false,
        error: 'NETWORK_ERROR',
        message: error.message || 'Network error occurred'
      };
    }
  }

  /**
   * Search for movies via DOM scraping
   */
  async function searchViaDOM(query) {
    // This would require navigating to a search page and scraping results
    // For now, we'll return a placeholder indicating this needs implementation
    // after observing the actual site structure

    return {
      success: false,
      method: 'dom',
      error: 'DOM_SCRAPING_NOT_IMPLEMENTED',
      message: 'DOM-based search requires site structure analysis. Please provide API endpoint details.'
    };
  }

  /**
   * Normalize movie data from Moctale API format
   * API Response item format:
   * { name, image, year, is_show, slug, banner }
   */
  function normalizeMovieData(item) {
    return {
      id: item.slug,                    // Use slug as ID (used for URLs)
      title: item.name,                 // Movie/show title
      year: item.year,                  // Release year
      rating: item.rating || null,      // Rating (may need separate API call)
      ratingCount: item.ratingCount || 0,
      poster: item.image,               // Poster image URL
      banner: item.banner,              // Banner image URL
      summary: item.summary || item.description || null,
      type: item.is_show ? 'series' : 'movie',
      slug: item.slug,                  // URL slug
      url: `/content/${item.slug}`      // Full URL path
    };
  }

  /**
   * Extract year from date string
   */
  function extractYear(dateString) {
    if (!dateString) return null;
    const match = dateString.match(/(\d{4})/);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Main search function
   */
  async function search(query, page = 1) {
    // Use the Moctale API directly
    const apiResult = await searchViaAPI(query, page);
    return apiResult;
  }

  // ============================================================================
  // Movie Details
  // ============================================================================

  /**
   * Get movie details via API
   * The slug is used as the identifier (e.g., "salaar-part-1-ceasefire-2023")
   */
  async function getDetailsViaAPI(slug) {
    try {
      // Try the content endpoint with slug
      const endpoint = `${CONFIG.api.content}/${encodeURIComponent(slug)}`;

      const response = await fetchWithTimeout(endpoint, {
        method: 'GET',
        headers: getRequestHeaders()
      });

      if (response.ok) {
        const data = await response.json();
        return {
          success: true,
          method: 'api',
          data: normalizeMovieDetails(data)
        };
      } else if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Session expired. Please log in again.'
        };
      } else if (response.status === 404) {
        return {
          success: false,
          error: 'NOT_FOUND',
          message: 'Movie not found'
        };
      }
    } catch (error) {
      console.warn('API details fetch failed:', error.message);
    }

    return {
      success: false,
      error: 'FETCH_FAILED',
      message: 'Failed to fetch movie details'
    };
  }

  /**
   * Normalize movie details from API response
   */
  function normalizeMovieDetails(data) {
    const movie = data.movie || data.content || data.data || data;

    return {
      ...normalizeMovieData(movie),
      genres: movie.genres || movie.genre || [],
      duration: movie.duration || movie.runtime || null,
      director: movie.director || movie.directors?.[0] || null,
      cast: movie.cast || movie.actors || [],
      reviews: (movie.reviews || movie.userReviews || []).map(normalizeReview),
      userRating: movie.userRating || movie.myRating || null,
      trailer: movie.trailer || movie.trailerUrl || null,
      streamingPlatforms: movie.platforms || movie.streaming || movie.watchOn || []
    };
  }

  /**
   * Normalize review data
   */
  function normalizeReview(review) {
    return {
      id: review.id || review._id,
      author: review.author || review.user || review.username || 'Anonymous',
      rating: review.rating || review.score || null,
      text: review.text || review.content || review.review || review.body || '',
      date: review.date || review.createdAt || review.timestamp || null,
      helpful: review.helpful || review.likes || 0
    };
  }

  /**
   * Main get details function
   * @param {string} slug - The movie slug (e.g., "salaar-part-1-ceasefire-2023")
   */
  async function getDetails(slug) {
    if (!slug) {
      return {
        success: false,
        error: 'INVALID_SLUG',
        message: 'Movie slug is required'
      };
    }

    return await getDetailsViaAPI(slug);
  }

  // ============================================================================
  // Message Listener
  // ============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, ...data } = message;

    // Handle ping for connection check
    if (type === 'PING') {
      sendResponse({ pong: true });
      return true;
    }

    // Handle async operations
    (async () => {
      let response;

      try {
        switch (type) {
          case 'CHECK_AUTH':
            response = await checkAuth();
            break;

          case 'SEARCH':
            response = await search(data.query, data.page || 1);
            break;

          case 'GET_DETAILS':
            response = await getDetails(data.slug || data.movieId);
            break;

          default:
            response = {
              success: false,
              error: 'UNKNOWN_MESSAGE_TYPE',
              message: `Unknown message type: ${type}`
            };
        }
      } catch (error) {
        console.error('Content script error:', error);
        response = {
          success: false,
          error: 'CONTENT_SCRIPT_ERROR',
          message: error.message || 'An unexpected error occurred'
        };
      }

      sendResponse(response);
    })();

    // Return true to indicate async response
    return true;
  });

  // ============================================================================
  // Initialization
  // ============================================================================

  console.log('[Moctale Extension] Content script loaded');

  // Notify that content script is ready
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }).catch(() => {
    // Background may not be listening yet, that's okay
  });

})();
