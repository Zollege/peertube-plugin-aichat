# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a PeerTube plugin project for AI chat functionality. It's built on the PeerTube plugin quickstart template and follows the standard PeerTube plugin architecture.

## Development Commands

```bash
# Install dependencies and build automatically
npm install

# Build the plugin manually (uses esbuild)
npm run build
```

The build process uses esbuild (configured in scripts/build.js) to bundle client-side code from `/client` to `/dist`.

## Architecture

### Plugin Structure

The plugin has two main components that PeerTube loads:

1. **Server Component** (`main.js`): Exports `register()` and `unregister()` functions. Has access to server-side PeerTube APIs including:
   - `registerHook` - Hook into server events
   - `registerSetting` - Define plugin settings
   - `settingsManager` - Read/write settings
   - `storageManager` - Persist plugin data
   - Video metadata managers (category, license, language)

2. **Client Component** (`client/common-client-plugin.js`): Runs on all PeerTube pages (scope: "common"). Built to `dist/common-client-plugin.js`. Has access to:
   - `registerHook` - Hook into client events
   - `peertubeHelpers` - Utility functions for UI and API interaction

### File Organization

- `/client/` - Client-side source code (pre-build)
- `/dist/` - Built client bundles (generated, gitignored)
- `/assets/style.css` - Global CSS injected by PeerTube
- `/public/images/` - Static images served at `/plugins/{name}/images/`
- `/languages/` - Translation files (currently has fr.json)
- `/scripts/build.js` - esbuild configuration

### PeerTube Integration Points

The plugin integrates via `package.json` configuration:
- `clientScripts`: Defines which client scripts to load and their scopes
- `css`: CSS files automatically injected
- `staticDirs`: Maps directories to public URLs
- `translations`: Localization support
- `library`: Server-side entry point (main.js)

### Build System

Uses esbuild with these settings (scripts/build.js):
- Target: Safari 11+ for broad compatibility
- Format: ESM modules
- Minification enabled
- Bundles all dependencies into single file

## Key Development Patterns

### Adding Client-Side Features

Client code in `client/common-client-plugin.js` receives:
```javascript
function register({ registerHook, peertubeHelpers }) {
  // Use peertubeHelpers for UI components and API calls
  // Register hooks to respond to PeerTube events
}
```

### Adding Server-Side Features

Server code in `main.js` receives:
```javascript
async function register({
  registerHook,
  registerSetting,
  settingsManager,
  storageManager,
  // ... other APIs
}) {
  // Register settings, hooks, and API routes
}
```

### Plugin Lifecycle

- `register()` called when plugin is enabled
- `unregister()` called when plugin is disabled (cleanup)

## PeerTube Requirements

- PeerTube version >= 1.3.0
- Plugin must be built before installation (`npm run build`)

## Additional Documentation

### Plugin API Reference
- Full plugin documentation available in PLUGIN_DOCS.md
- Comprehensive guide to hooks, settings, storage, routes, and WebSocket support
- Client-side helpers for modals, notifications, translations, and custom UI

### Reference Implementation
- `peertube-plugin-livechat/` - Official livechat plugin for reference
- Uses TypeScript, advanced build system with esbuild
- Implements chat rooms with federation, moderation tools, OBS integration
- Good example of:
  - Complex client/server architecture
  - WebSocket integration
  - Multiple client scripts with different scopes
  - Extensive use of settings and storage
  - Custom routes and static directories
  - Professional build pipeline with TypeScript

### Key Patterns from LiveChat Plugin
- TypeScript setup with @peertube/peertube-types
- Multiple client scripts for different scopes (common, admin-plugin)
- Comprehensive build system with separate client/server builds
- Static directories for serving custom UI assets
- Extensive translations support
- Professional tooling (ESLint, Stylelint, lit-analyzer)