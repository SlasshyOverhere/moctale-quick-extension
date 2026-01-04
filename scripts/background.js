/**
 * Moctale Extension - Background Service Worker
 *
 * Responsibilities:
 * - Message routing between popup and content scripts
 * - Session state management
 * - Response caching
 * - Tab management for injecting content scripts
 */

// ============================================================================
// Constants
// ============================================================================

const MOCTALE_ORIGINS = ['https://www.moctale.in', 'https://moctale.in'];

const MESSAGE_TYPES = {
  CHECK_SESSION: 'CHECK_SESSION',
  SEARCH_MOVIES: 'SEARCH_MOVIES',
  GET_MOVIE_DETAILS: 'GET_MOVIE_DETAILS',
  OPEN_LOGIN: 'OPEN_LOGIN',
  OPEN_MOCTALE: 'OPEN_MOCTALE',
  GET_PENDING_SEARCH: 'GET_PENDING_SEARCH',
  CLEAR_PENDING_SEARCH: 'CLEAR_PENDING_SEARCH'
};

const CACHE_TTL = {
  searchResults: 5 * 60 * 1000,  // 5 minutes
  movieDetails: 15 * 60 * 1000, // 15 minutes
  sessionState: 60 * 1000       // 1 minute
};

// ============================================================================
// In-Memory Cache
// ============================================================================

class CacheManager {
  constructor() {
    this.cache = new Map();
  }

  generateKey(type, ...args) {
    return `${type}:${args.join(':')}`;
  }

  get(type, ...args) {
    const key = this.generateKey(type, ...args);
    const entry = this.cache.get(key);

    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(type, data, ...args) {
    const key = this.generateKey(type, ...args);
    const ttl = CACHE_TTL[type] || CACHE_TTL.searchResults;

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttl
    });
  }

  clear() {
    this.cache.clear();
  }

  clearType(type) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${type}:`)) {
        this.cache.delete(key);
      }
    }
  }
}

const cacheManager = new CacheManager();

// ============================================================================
// Tab Management
// ============================================================================

/**
 * Find an existing Moctale tab or create one
 */
async function findMoctaleTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find(tab =>
    tab.url && MOCTALE_ORIGINS.some(origin => tab.url.startsWith(origin))
  );
}

/**
 * Ensure content script is injected in a tab
 */
async function ensureContentScriptInjected(tabId) {
  try {
    // Try to ping the content script first
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return response?.pong === true;
  } catch (e) {
    // Content script not ready, try to inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['scripts/contentScript.js']
      });
      // Wait a moment for script to initialize
      await new Promise(resolve => setTimeout(resolve, 100));
      return true;
    } catch (injectError) {
      console.error('Failed to inject content script:', injectError);
      return false;
    }
  }
}

/**
 * Send message to content script in Moctale tab
 */
async function sendToContentScript(message) {
  const moctaleTab = await findMoctaleTab();

  if (!moctaleTab) {
    return {
      success: false,
      error: 'NO_MOCTALE_TAB',
      message: 'Please open moctale.in in a browser tab first'
    };
  }

  const injected = await ensureContentScriptInjected(moctaleTab.id);
  if (!injected) {
    return {
      success: false,
      error: 'INJECTION_FAILED',
      message: 'Failed to connect to Moctale tab'
    };
  }

  try {
    const response = await chrome.tabs.sendMessage(moctaleTab.id, message);
    return response;
  } catch (e) {
    console.error('Error sending message to content script:', e);
    return {
      success: false,
      error: 'COMMUNICATION_ERROR',
      message: 'Failed to communicate with Moctale tab'
    };
  }
}

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Check if user is logged in on Moctale
 */
async function handleCheckSession() {
  // Check cache first
  const cachedSession = cacheManager.get('sessionState', 'status');
  if (cachedSession !== null) {
    return cachedSession;
  }

  const response = await sendToContentScript({ type: 'CHECK_AUTH' });

  if (response.success) {
    cacheManager.set('sessionState', response, 'status');
  }

  return response;
}

/**
 * Search for movies
 */
async function handleSearchMovies(query) {
  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: 'INVALID_QUERY',
      message: 'Please enter a search term'
    };
  }

  const normalizedQuery = query.trim().toLowerCase();

  // Check cache first
  const cachedResults = cacheManager.get('searchResults', normalizedQuery);
  if (cachedResults !== null) {
    return { ...cachedResults, cached: true };
  }

  const response = await sendToContentScript({
    type: 'SEARCH',
    query: normalizedQuery
  });

  if (response.success) {
    cacheManager.set('searchResults', response, normalizedQuery);
  }

  return response;
}

/**
 * Get details for a specific movie
 */
async function handleGetMovieDetails(movieId) {
  if (!movieId) {
    return {
      success: false,
      error: 'INVALID_ID',
      message: 'Movie ID is required'
    };
  }

  // Check cache first
  const cachedDetails = cacheManager.get('movieDetails', movieId);
  if (cachedDetails !== null) {
    return { ...cachedDetails, cached: true };
  }

  const response = await sendToContentScript({
    type: 'GET_DETAILS',
    movieId
  });

  if (response.success) {
    cacheManager.set('movieDetails', response, movieId);
  }

  return response;
}

/**
 * Open Moctale login page
 */
async function handleOpenLogin() {
  await chrome.tabs.create({ url: 'https://www.moctale.in/login' });
  return { success: true };
}

/**
 * Open Moctale homepage
 */
async function handleOpenMoctale() {
  const existingTab = await findMoctaleTab();

  if (existingTab) {
    await chrome.tabs.update(existingTab.id, { active: true });
    await chrome.windows.update(existingTab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://www.moctale.in/' });
  }

  return { success: true };
}

/**
 * Get pending search from context menu
 */
async function handleGetPendingSearch() {
  const result = await chrome.storage.local.get('pendingSearch');
  const pendingSearch = result.pendingSearch;

  if (pendingSearch) {
    // Check if pending search is not too old (5 minutes max)
    const age = Date.now() - pendingSearch.timestamp;
    if (age < 5 * 60 * 1000) {
      return {
        success: true,
        query: pendingSearch.query
      };
    }
  }

  return { success: false };
}

/**
 * Clear pending search after it's been used
 */
async function handleClearPendingSearch() {
  await chrome.storage.local.remove('pendingSearch');
  return { success: true };
}

// ============================================================================
// Message Listener
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, ...data } = message;

  // Handle async operations
  (async () => {
    let response;

    try {
      switch (type) {
        case MESSAGE_TYPES.CHECK_SESSION:
          response = await handleCheckSession();
          break;

        case MESSAGE_TYPES.SEARCH_MOVIES:
          response = await handleSearchMovies(data.query);
          break;

        case MESSAGE_TYPES.GET_MOVIE_DETAILS:
          response = await handleGetMovieDetails(data.movieId);
          break;

        case MESSAGE_TYPES.OPEN_LOGIN:
          response = await handleOpenLogin();
          break;

        case MESSAGE_TYPES.OPEN_MOCTALE:
          response = await handleOpenMoctale();
          break;

        case MESSAGE_TYPES.GET_PENDING_SEARCH:
          response = await handleGetPendingSearch();
          break;

        case MESSAGE_TYPES.CLEAR_PENDING_SEARCH:
          response = await handleClearPendingSearch();
          break;

        default:
          response = {
            success: false,
            error: 'UNKNOWN_MESSAGE_TYPE',
            message: `Unknown message type: ${type}`
          };
      }
    } catch (error) {
      console.error('Error handling message:', error);
      response = {
        success: false,
        error: 'INTERNAL_ERROR',
        message: error.message || 'An unexpected error occurred'
      };
    }

    sendResponse(response);
  })();

  // Return true to indicate we will send response asynchronously
  return true;
});

// ============================================================================
// Extension Lifecycle
// ============================================================================

// Context menu ID
const CONTEXT_MENU_ID = 'moctale-search-selection';

/**
 * Create context menu on install/update
 */
function createContextMenu() {
  // Remove existing menu first to avoid duplicates
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Search "%s" in Moctale',
      contexts: ['selection']
    });
  });
}

/**
 * Handle context menu click
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID && info.selectionText) {
    const selectedText = info.selectionText.trim();

    if (selectedText) {
      // Store the pending search query
      await chrome.storage.local.set({
        pendingSearch: {
          query: selectedText,
          timestamp: Date.now()
        }
      });

      // Open popup as a new window (workaround since chrome.action.openPopup doesn't work from context menu)
      const popupURL = chrome.runtime.getURL('popup/popup.html');

      // Create a popup window
      chrome.windows.create({
        url: popupURL,
        type: 'popup',
        width: 400,
        height: 520,
        focused: true
      });
    }
  }
});

// Clear session cache when extension starts
chrome.runtime.onStartup.addListener(() => {
  cacheManager.clear();
  createContextMenu();
});

// Create context menu and clear cache when installed/updated
chrome.runtime.onInstalled.addListener(() => {
  cacheManager.clear();
  createContextMenu();
  console.log('Moctale Extension installed/updated');
});

// Export for testing (if needed)
// export { CacheManager, cacheManager, MESSAGE_TYPES };
