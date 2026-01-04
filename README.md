# Moctale Quick Access

A Chrome extension to search movies and view ratings from [Moctale](https://www.moctale.in) without leaving your current tab.

## Features

- **Quick Search**: Search for movies directly from the extension popup
- **Context Menu**: Select any movie name on any webpage, right-click, and search instantly
- **Session Reuse**: Uses your existing Moctale login session (no separate login required)
- **Dark Theme**: Matches Moctale's sleek dark interface
- **Caching**: Fast responses with intelligent caching

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `moctale-extension` folder

## Usage

### Popup Search
1. Make sure you're logged in to [moctale.in](https://www.moctale.in) in a browser tab
2. Click the Moctale extension icon
3. Type a movie name and see results instantly

### Context Menu Search
1. Select any text on any webpage (e.g., "Avengers Doomsday")
2. Right-click → **"Search 'Avengers Doomsday' in Moctale"**
3. Extension popup opens automatically with search results

## Requirements

- Google Chrome (or Chromium-based browser)
- Active login session on moctale.in

## Project Structure

```
moctale-extension/
├── manifest.json           # Extension manifest (MV3)
├── popup/
│   ├── popup.html          # Extension popup UI
│   ├── popup.css           # Dark theme styles
│   └── popup.js            # Popup logic
├── scripts/
│   ├── background.js       # Service worker
│   └── contentScript.js    # Injected on moctale.in
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## Technical Details

- **Manifest Version**: 3 (latest Chrome extension standard)
- **Authentication**: Reuses `auth_token` cookie from moctale.in
- **API**: Uses Moctale's internal search API (`/api/search`)
- **Caching**: 5-minute TTL for search results

## Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Cache search results and pending searches |
| `scripting` | Inject content script on moctale.in |
| `contextMenus` | Right-click "Search in Moctale" option |
| `host_permissions` | Access moctale.in for API calls |

## Limitations

- Requires an active moctale.in tab with logged-in session
- Only works when you're logged in to Moctale
- Search results depend on Moctale's internal API

## License

This project is for personal use only.

---

**Created by Suman Patgiri**
